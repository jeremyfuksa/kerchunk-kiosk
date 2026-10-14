// GOES-19 GLM lightning for the Weather Glass (spec 2026-10-13 glass
// lightning). Lifecycle mirrors RadarFeed: start/stop, injectable fetcher,
// and a poll never throws. Every pollMs it lists NOAA's public S3 bucket for
// files newer than the last processed key, but never older than windowMs (so
// boot and an outage both replay at most the replay window, never a backlog),
// downloads each whole (~400 KB / 20 s; range reads were measured and not
// worth it), keeps the flashes inside the QTH box, and announces the fresh
// ones. Staleness (no new file for staleMs), not an error, is what the
// route reports.
import { parseGlm } from "./glm.js";
import { hourPrefixes, keyFloor, keyTimes, parseListing } from "./keys.js";
import type { Box, Flash } from "./types.js";

export interface LightningSource {
  since(ms: number): Flash[];
  isStale(now?: number): boolean;
  latestEnd(): number | null;
  onFlashes(cb: (flashes: Flash[]) => void): void;
  start(): void;
  stop(): void;
}

export interface LightningFetchResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface LightningFeedOpts {
  center: { lat: number; lon: number };
  span: { w: number; h: number };
  /** "goes19" → bucket noaa-goes19, keys …_G19_… */
  satellite: string;
  pollMs: number;
  bufferMs: number;
  staleMs: number;
  fetchTimeoutMs: number;
  maxCatchupFiles: number;
  /** How far back a poll looks: the wall's replayDelayMs + 45 s. */
  windowMs: number;
  baseUrl?: string;
  fetcher?: (url: string) => Promise<LightningFetchResponse>;
  parse?: (bytes: Uint8Array, box: Box) => Promise<Flash[]>;
  now?: () => number;
}

const HOUR_MS = 3_600_000;

export class LightningFeed implements LightningSource {
  private readonly box: Box;
  private readonly base: string;
  private readonly sat: number;
  private readonly fetcher: (url: string) => Promise<LightningFetchResponse>;
  private readonly parse: (bytes: Uint8Array, box: Box) => Promise<Flash[]>;
  private readonly now: () => number;
  private lastKey: string | null = null;
  private buf: Flash[] = [];
  private end: number | null = null;
  private cb: ((flashes: Flash[]) => void) | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;
  private readonly failing = new Set<string>();
  private readonly totals = { files: 0, bytes: 0, flashes: 0 };
  private hourMark = { at: 0, files: 0, bytes: 0, flashes: 0 };

  constructor(private readonly o: LightningFeedOpts) {
    const { lat, lon } = o.center;
    this.box = { n: lat + o.span.h / 2, s: lat - o.span.h / 2, e: lon + o.span.w / 2, w: lon - o.span.w / 2 };
    this.base = o.baseUrl ?? `https://noaa-${o.satellite}.s3.amazonaws.com`;
    this.sat = Number(/(\d+)$/.exec(o.satellite)?.[1] ?? "19");
    this.fetcher = o.fetcher ?? ((u) => fetch(u, { signal: AbortSignal.timeout(o.fetchTimeoutMs) }));
    this.parse = o.parse ?? parseGlm;
    this.now = o.now ?? Date.now;
  }

  since(ms: number): Flash[] { return this.buf.filter((f) => f.t > ms); }
  latestEnd(): number | null { return this.end; }
  isStale(now = this.now()): boolean { return this.end === null || now - this.end > this.o.staleMs; }
  onFlashes(cb: (flashes: Flash[]) => void): void { this.cb = cb; }
  stats(): { files: number; bytes: number; flashes: number } { return { ...this.totals }; }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.hourMark = { at: this.now(), ...this.totals };
    void this.loop();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  }

  /** One list + download/parse of each new file. Public for tests. */
  async pollOnce(): Promise<void> {
    const now = this.now();
    const fresh: Flash[] = [];
    try {
      const from = now - this.o.windowMs;
      const floor = keyFloor(from, this.sat);
      const after = this.lastKey !== null && this.lastKey > floor ? this.lastKey : floor;
      const keys = (await this.list(from, now, after)).filter((k) => k > after).sort();
      this.ok("list");
      for (const key of keys.slice(-this.o.maxCatchupFiles)) {
        let bytes: Uint8Array;
        try {
          bytes = await this.download(key);
          this.ok("download");
        } catch (err) {
          this.warn("download", err, key);
          break;                       // keep order: retry from here next poll
        }
        this.lastKey = key;
        this.totals.files++;
        this.totals.bytes += bytes.length;
        try {
          const got = await this.parse(bytes, this.box);
          fresh.push(...got);
          this.totals.flashes += got.length;
          const end = keyTimes(key)?.end;
          if (end !== undefined) this.end = Math.max(this.end ?? end, end);
          this.ok("parse");
        } catch (err) {
          this.warn("parse", err, key); // a bad file never heals: lastKey already moved past it
        }
      }
    } catch (err) {
      this.warn("list", err);
    }
    const cut = now - this.o.bufferMs;
    this.buf = [...this.buf, ...fresh].filter((f) => f.t > cut).sort((a, b) => a.t - b.t);
    if (fresh.length > 0) this.cb?.(fresh);
  }

  private async list(from: number, to: number, after: string): Promise<string[]> {
    const keys: string[] = [];
    for (const prefix of hourPrefixes(from, to)) {
      let token: string | null = null;
      do {
        const q = new URLSearchParams({ "list-type": "2", prefix, "start-after": after });
        if (token) q.set("continuation-token", token);
        const res = await this.fetcher(`${this.base}/?${q.toString()}`);
        if (!res.ok) throw new Error(`list HTTP ${res.status}`);
        const page = parseListing(await res.text());
        keys.push(...page.keys);
        token = page.next;
      } while (token);
    }
    return keys;
  }

  private async download(key: string): Promise<Uint8Array> {
    const res = await this.fetcher(`${this.base}/${key}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  /** Log the first failure of each kind; quiet until that kind succeeds again. */
  private warn(kind: string, err: unknown, key?: string): void {
    if (this.failing.has(kind)) return;
    this.failing.add(kind);
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[lightning] ${kind} failed${key ? ` (${key.split("/").pop()})` : ""}: ${msg}`.slice(0, 240));
  }

  private ok(kind: string): void { this.failing.delete(kind); }

  private logHour(): void {
    const now = this.now();
    if (now - this.hourMark.at < HOUR_MS) return;
    const t = this.totals, m = this.hourMark;
    const mb = (t.bytes - m.bytes) / 1e6;
    console.log(`[lightning] last hour: ${t.files - m.files} files, ${mb.toFixed(1)} MB (${(mb * 1e3 / ((now - m.at) / 1000)).toFixed(1)} KB/s), ${t.flashes - m.flashes} flashes in box`);
    this.hourMark = { at: now, ...t };
  }

  private async loop(): Promise<void> {
    if (this.stopped) return;
    await this.pollOnce();
    this.logHour();
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.loop(), this.o.pollMs);
    this.timer.unref?.();
  }
}
