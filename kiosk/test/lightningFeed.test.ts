import { describe, it, expect, vi } from "vitest";
import { LightningFeed, type LightningFetchResponse } from "../src/backend/lightning/LightningFeed.js";
import { keyFloor, stamp } from "../src/backend/lightning/keys.js";
import type { Box, Flash } from "../src/backend/lightning/types.js";

const T0 = Date.parse("2026-10-14T02:30:00Z");
const keyAt = (ms: number) => `${keyFloor(ms, 19)}_e${stamp(ms + 20_000)}_c${stamp(ms + 21_000)}.nc`;
const flashAt = (t: number): Flash => ({ t, lat: 39.3, lon: -94.5, energyFj: 50, areaKm2: 200 });

/** A fake S3: prefix + start-after + paging (pageSize keys per page). */
function fakeS3(keys: () => string[], opts: { pageSize?: number; failGet?: Set<string>; failList?: { on: boolean } } = {}) {
  const pageSize = opts.pageSize ?? 1000;
  const fetcher = vi.fn(async (url: string): Promise<LightningFetchResponse> => {
    const u = new URL(url);
    if (u.searchParams.get("list-type") === "2") {
      if (opts.failList?.on) return { ok: false, status: 503, text: async () => "", arrayBuffer: async () => new ArrayBuffer(0) };
      const prefix = u.searchParams.get("prefix") ?? "";
      const after = u.searchParams.get("start-after") ?? "";
      const token = Number(u.searchParams.get("continuation-token") ?? "0");
      const all = keys().filter((k) => k.startsWith(prefix) && k > after).sort();
      const page = all.slice(token, token + pageSize);
      const more = token + pageSize < all.length;
      const xml = `<ListBucketResult><IsTruncated>${more}</IsTruncated>${more ? `<NextContinuationToken>${token + pageSize}</NextContinuationToken>` : ""}`
        + page.map((k) => `<Contents><Key>${k}</Key></Contents>`).join("") + "</ListBucketResult>";
      return { ok: true, status: 200, text: async () => xml, arrayBuffer: async () => new ArrayBuffer(0) };
    }
    const key = decodeURIComponent(u.pathname.slice(1));
    if (opts.failGet?.has(key)) return { ok: false, status: 503, text: async () => "", arrayBuffer: async () => new ArrayBuffer(0) };
    const bytes = new TextEncoder().encode(key);   // the parse stub reads the key back out
    return { ok: true, status: 200, text: async () => "", arrayBuffer: async () => bytes.buffer as ArrayBuffer };
  });
  return fetcher;
}

function makeFeed(o: {
  keys: () => string[]; now: () => number; pageSize?: number; failGet?: Set<string>; failList?: { on: boolean };
  parse?: (key: string, box: Box) => Flash[]; windowMs?: number; maxCatchupFiles?: number;
}) {
  const fetcher = fakeS3(o.keys, { pageSize: o.pageSize, failGet: o.failGet, failList: o.failList });
  const parsed: string[] = [];
  const parse = vi.fn(async (bytes: Uint8Array, box: Box) => {
    const key = new TextDecoder().decode(bytes);
    parsed.push(key);
    return o.parse ? o.parse(key, box) : [];
  });
  const feed = new LightningFeed({
    center: { lat: 39.29, lon: -94.5 }, span: { w: 4, h: 3 }, satellite: "goes19",
    pollMs: 20_000, bufferMs: 300_000, staleMs: 180_000, fetchTimeoutMs: 30_000,
    maxCatchupFiles: o.maxCatchupFiles ?? 6, windowMs: o.windowMs ?? 120_000,
    baseUrl: "https://s3.test", fetcher, parse, now: o.now,
  });
  return { feed, fetcher, parse, parsed };
}

/** Files every 20 s, starting at `from`, ending before `to`. */
const filesBetween = (from: number, to: number) => {
  const out: string[] = [];
  for (let t = from; t < to; t += 20_000) out.push(keyAt(t));
  return out;
};

describe("LightningFeed", () => {
  it("boot: only files inside the window, oldest first", async () => {
    const keys = filesBetween(T0 - 600_000, T0 - 20_000);         // 10 min of files
    const { feed, parsed } = makeFeed({ keys: () => keys, now: () => T0 });
    await feed.pollOnce();
    expect(parsed).toEqual(keys.filter((k) => k >= keyFloor(T0 - 120_000, 19)));
    expect(parsed).toHaveLength(5);
  });

  it("resumes after the last key: a second poll parses only the new file", async () => {
    let now = T0;
    const keys = filesBetween(T0 - 120_000, T0 - 20_000);
    const { feed, parsed } = makeFeed({ keys: () => keys, now: () => now });
    await feed.pollOnce();
    const before = parsed.length;
    keys.push(keyAt(T0));
    now = T0 + 40_000;
    await feed.pollOnce();
    expect(parsed.slice(before)).toEqual([keyAt(T0)]);
  });

  it("lists both hours across the hour boundary", async () => {
    const now = Date.parse("2026-10-14T03:00:30Z");
    const keys = filesBetween(now - 110_000, now - 10_000);         // 02:58:40 … 03:00:20
    const { feed, parsed, fetcher } = makeFeed({ keys: () => keys, now: () => now });
    await feed.pollOnce();
    expect(parsed).toEqual(keys);
    const prefixes = fetcher.mock.calls.map(([u]) => new URL(u).searchParams.get("prefix")).filter(Boolean);
    expect(prefixes).toEqual(["GLM-L2-LCFA/2026/287/02/", "GLM-L2-LCFA/2026/287/03/"]);
  });

  it("follows continuation tokens", async () => {
    const keys = filesBetween(T0 - 120_000, T0 - 20_000);
    const { feed, parsed } = makeFeed({ keys: () => keys, now: () => T0, pageSize: 2 });
    await feed.pollOnce();
    expect(parsed).toEqual(keys);
  });

  it("after an outage it takes only the newest maxCatchupFiles", async () => {
    const keys = filesBetween(T0 - 600_000, T0 - 20_000);
    const { feed, parsed } = makeFeed({ keys: () => keys, now: () => T0, windowMs: 600_000, maxCatchupFiles: 6 });
    await feed.pollOnce();
    expect(parsed).toEqual(keys.slice(-6));
  });

  it("resuming after an outage longer than the window skips anything older than the floor", async () => {
    let now = T0;
    const keys = filesBetween(T0 - 60_000, T0 - 20_000);
    const { feed, parsed } = makeFeed({ keys: () => keys, now: () => now, windowMs: 120_000, maxCatchupFiles: 6 });
    await feed.pollOnce();
    const before = parsed.length;
    now = T0 + 600_000;                                      // 10 min dark; files kept arriving
    keys.push(...filesBetween(T0, now));
    await feed.pollOnce();
    const floor = keyFloor(now - 120_000, 19);
    const got = parsed.slice(before);
    expect(got.length).toBeGreaterThan(0);
    expect(got.length).toBeLessThanOrEqual(6);
    expect(got.every((k) => k >= floor)).toBe(true);
  });

  it("a list failure logs once, doesn't throw, and heals on the next good poll", async () => {
    const keys = filesBetween(T0 - 60_000, T0 - 20_000);
    const failList = { on: true };
    const { feed, parsed } = makeFeed({ keys: () => keys, now: () => T0, failList });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(feed.pollOnce()).resolves.toBeUndefined();
      await feed.pollOnce();
      expect(err).toHaveBeenCalledTimes(1);                  // warn-once
      expect(parsed).toEqual([]);
      failList.on = false;
      await feed.pollOnce();
      expect(parsed).toEqual(keys);
      failList.on = true;
      await feed.pollOnce();
      expect(err).toHaveBeenCalledTimes(2);                  // healed, so it logs again
    } finally { err.mockRestore(); }
  });

  it("a failed download is retried on the next poll", async () => {
    const keys = filesBetween(T0 - 60_000, T0 - 20_000);   // 2 files
    const failGet = new Set([keys[0]!]);
    const { feed, parsed } = makeFeed({ keys: () => keys, now: () => T0, failGet });
    await feed.pollOnce();
    expect(parsed).toEqual([]);                              // stops at the failure, keeps order
    failGet.clear();
    await feed.pollOnce();
    expect(parsed).toEqual(keys);
  });

  it("a file that fails to parse is skipped for good", async () => {
    const keys = filesBetween(T0 - 60_000, T0 - 20_000);
    const parse = (key: string) => { if (key === keys[0]) throw new Error("not HDF5"); return []; };
    const { feed, parsed } = makeFeed({ keys: () => keys, now: () => T0, parse });
    await feed.pollOnce();
    await feed.pollOnce();
    expect(parsed).toEqual(keys);                            // keys[0] attempted once only
  });

  it("buffers flashes, serves since(), prunes past bufferMs, and announces only fresh ones", async () => {
    let now = T0;
    const keys = [keyAt(T0 - 40_000)];
    const parse = (key: string) => [flashAt(key === keys[0] ? T0 - 39_000 : T0 + 390_000)];
    const { feed } = makeFeed({ keys: () => keys, now: () => now, parse });
    const seen: Flash[][] = [];
    feed.onFlashes((f) => seen.push(f));
    await feed.pollOnce();
    expect(feed.since(0).map((f) => f.t)).toEqual([T0 - 39_000]);
    expect(seen).toHaveLength(1);
    await feed.pollOnce();                                   // nothing new: no announcement
    expect(seen).toHaveLength(1);
    now = T0 + 400_000;                                      // past bufferMs
    keys.push(keyAt(T0 + 380_000));
    await feed.pollOnce();
    expect(feed.since(0).map((f) => f.t)).toEqual([T0 + 390_000]);       // the first flash pruned
    expect(feed.since(T0 + 390_000)).toEqual([]);                         // since() is strictly after
    expect(seen).toHaveLength(2);
  });

  it("a throwing onFlashes subscriber can't break the poll", async () => {
    const keys = [keyAt(T0 - 40_000)];
    const { feed } = makeFeed({ keys: () => keys, now: () => T0, parse: () => [flashAt(T0 - 39_000)] });
    feed.onFlashes(() => { throw new Error("ws down"); });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(feed.pollOnce()).resolves.toBeUndefined();
      expect(feed.since(0)).toHaveLength(1);
    } finally { err.mockRestore(); }
  });

  it("is stale until a file lands, then fresh until staleMs past its end", async () => {
    let now = T0;
    const keys = [keyAt(T0 - 40_000)];
    const { feed } = makeFeed({ keys: () => keys, now: () => now });
    expect(feed.isStale()).toBe(true);
    expect(feed.latestEnd()).toBeNull();
    await feed.pollOnce();
    expect(feed.latestEnd()).toBe(T0 - 20_000);
    expect(feed.isStale()).toBe(false);
    now = T0 - 20_000 + 180_001;                             // > staleMs past the file's end
    expect(feed.isStale()).toBe(true);
  });

  it("counts files, bytes and flashes for the hourly log", async () => {
    const keys = filesBetween(T0 - 60_000, T0 - 20_000);
    const { feed } = makeFeed({ keys: () => keys, now: () => T0, parse: () => [flashAt(T0 - 30_000)] });
    await feed.pollOnce();
    const s = feed.stats();
    expect(s.files).toBe(2);
    expect(s.flashes).toBe(2);
    expect(s.parseFailures).toBe(0);
    expect(s.bytes).toBe(keys.reduce((n, k) => n + new TextEncoder().encode(k).length, 0));
  });

  it("start() polls and stop() halts", async () => {
    vi.useFakeTimers();
    try {
      const { feed, fetcher } = makeFeed({ keys: () => [], now: () => T0 });
      feed.start();
      await vi.advanceTimersByTimeAsync(0);
      const n = fetcher.mock.calls.length;
      expect(n).toBeGreaterThan(0);
      feed.stop();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(fetcher.mock.calls.length).toBe(n);
    } finally { vi.useRealTimers(); }
  });
});
