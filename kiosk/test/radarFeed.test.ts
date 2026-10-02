import { describe, it, expect, vi } from "vitest";
import { deflateSync, gunzipSync } from "node:zlib";
import { RadarFeed, type RadarFetchResponse } from "../src/backend/radar/RadarFeed.js";

// A full-size-header fixture would be 66 MB; instead the feed is pointed at a
// small grid via the `grid` test hook so a 40x30 PNG stands in for USCOMP.
const GRID = { ulLon: -100, ulLat: 42, deg: 0.1, width: 40, height: 30 };

function png(w: number, h: number, fillIndex: number): Buffer {
  const raw = Buffer.alloc(h * (w + 1));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw[y * (w + 1) + 1 + x] = fillIndex;
  const chunk = (t: string, d: Buffer) => { const b = Buffer.alloc(12 + d.length); b.writeUInt32BE(d.length, 0); b.write(t, 4, "ascii"); d.copy(b, 8); return b; };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 3;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("PLTE", Buffer.alloc(768)), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
const meta = (valid: string): RadarFetchResponse => ({ ok: true, status: 200, json: async () => ({ meta: { valid } }), arrayBuffer: async () => new ArrayBuffer(0) });
const image = (b: Buffer): RadarFetchResponse => ({ ok: true, status: 200, json: async () => ({}), arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer });

function makeFeed(responses: Record<string, () => RadarFetchResponse | Promise<RadarFetchResponse>>, now = () => Date.parse("2026-10-01T20:00:00Z")) {
  const fetcher = vi.fn(async (url: string) => {
    const key = url.endsWith(".json") ? "json" : "png";
    const r = responses[key];
    if (!r) throw new Error(`no fixture for ${key}`);
    return r();
  });
  const feed = new RadarFeed({
    center: { lat: 40.5, lon: -98 }, span: { w: 1, h: 1 }, refreshMs: 300_000, staleMs: 1_200_000,
    fetcher, now, grid: GRID,
  });
  return { feed, fetcher };
}

describe("RadarFeed", () => {
  it("fetches meta then the image, crops, and emits one scan", async () => {
    const { feed, fetcher } = makeFeed({ json: () => meta("2026-10-01T19:55:00Z"), png: () => image(png(40, 30, 120)) });
    const seen: number[] = [];
    feed.onScan((s) => seen.push(s.scanTime));
    await feed.pollOnce();
    const s = feed.latest()!;
    expect(s.scanTime).toBe(Date.parse("2026-10-01T19:55:00Z"));
    expect(s.width * s.height).toBe(s.bytes.length);
    expect(s.bytes.every((v) => v === 120)).toBe(true);
    expect(gunzipSync(s.gz).equals(Buffer.from(s.bytes))).toBe(true);
    expect(seen).toEqual([s.scanTime]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("an unchanged meta.valid skips the image download and emits nothing", async () => {
    const { feed, fetcher } = makeFeed({ json: () => meta("2026-10-01T19:55:00Z"), png: () => image(png(40, 30, 120)) });
    const seen: number[] = [];
    feed.onScan((s) => seen.push(s.scanTime));
    await feed.pollOnce();
    await feed.pollOnce();
    expect(fetcher.mock.calls.filter(([u]) => String(u).endsWith(".png"))).toHaveLength(1);
    expect(seen).toHaveLength(1);
  });

  it("malformed meta keeps the last scan and does not download", async () => {
    let body: unknown = { meta: { valid: "2026-10-01T19:55:00Z" } };
    const { feed, fetcher } = makeFeed({
      json: () => ({ ok: true, status: 200, json: async () => body, arrayBuffer: async () => new ArrayBuffer(0) }),
      png: () => image(png(40, 30, 120)),
    });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await feed.pollOnce();
    body = { nope: true };
    await feed.pollOnce();
    expect(feed.latest()!.scanTime).toBe(Date.parse("2026-10-01T19:55:00Z"));
    expect(fetcher.mock.calls.filter(([u]) => String(u).endsWith(".png"))).toHaveLength(1);
    err.mockRestore();
  });

  it("an image whose dimensions no longer match the grid keeps the previous scan", async () => {
    let valid = "2026-10-01T19:55:00Z", img = png(40, 30, 120);
    const { feed } = makeFeed({ json: () => meta(valid), png: () => image(img) });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await feed.pollOnce();
    valid = "2026-10-01T20:00:00Z"; img = png(50, 30, 200);
    await feed.pollOnce();
    expect(feed.latest()!.scanTime).toBe(Date.parse("2026-10-01T19:55:00Z"));
    expect(feed.latest()!.bytes[0]).toBe(120);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it("HTTP errors and throws keep the last scan; logs once per failure streak", async () => {
    let fail = false;
    const { feed } = makeFeed({
      json: () => (fail ? { ok: false, status: 503, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) } : meta("2026-10-01T19:55:00Z")),
      png: () => image(png(40, 30, 120)),
    });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await feed.pollOnce();
    fail = true;
    await feed.pollOnce();
    await feed.pollOnce();
    expect(feed.latest()).not.toBeNull();
    expect(err).toHaveBeenCalledTimes(1);
    err.mockRestore();
  });

  it("isStale: true with no scan, flips true past staleMs after scanTime", async () => {
    let t = Date.parse("2026-10-01T20:00:00Z");
    const { feed } = makeFeed({ json: () => meta("2026-10-01T19:55:00Z"), png: () => image(png(40, 30, 1)) }, () => t);
    expect(feed.isStale()).toBe(true);
    await feed.pollOnce();
    expect(feed.isStale()).toBe(false);
    t = Date.parse("2026-10-01T19:55:00Z") + 1_200_001;
    expect(feed.isStale()).toBe(true);
  });

  it("a crop box that misses the grid never fetches", async () => {
    const fetcher = vi.fn();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const feed = new RadarFeed({ center: { lat: 0, lon: 0 }, span: { w: 1, h: 1 }, refreshMs: 1, staleMs: 1, fetcher, grid: GRID });
    await feed.pollOnce();
    expect(fetcher).not.toHaveBeenCalled();
    expect(feed.latest()).toBeNull();
    err.mockRestore();
  });
});
