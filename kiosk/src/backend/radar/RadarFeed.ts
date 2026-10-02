// Live NEXRAD for the kiosk's Weather Glass layer (spec 2026-10-01). Polls
// IEM's tiny n0q_0.json for the scan time and downloads the 4.6 MB national
// composite only when it advances, decoding just the crop around the QTH. A
// failure of any kind keeps the last good scan: staleness (not an error) is
// what makes the frontend fade radar out, so old weather is never shown as
// current. Lifecycle mirrors AircraftFeed: start/stop + an injectable fetcher.
import { gzip } from "node:zlib";
import { promisify } from "node:util";
import { cropWindow, IEM_USCOMP, type Bounds, type CropWindow, type WorldGrid } from "./crop.js";
import { decodeIndexedCrop } from "./pngIndexed.js";

const gzipAsync = promisify(gzip);
const FETCH_TIMEOUT_MS = 60_000;
// A scan time this far past our clock is bogus (or our clock is wrong at
// boot): accepting it would pin that frame as "current" — never stale, and
// every later real scan would look older and be skipped.
const FUTURE_SLACK_MS = 10 * 60_000;

export const IEM_N0Q_BASE = "https://mesonet.agron.iastate.edu/data/gis/images/4326/USCOMP/n0q_0";

export interface RadarScan {
  scanTime: number;
  fetchedAt: number;
  bounds: Bounds;
  width: number;
  height: number;
  /** Raw n0q indices, row-major, north row first. */
  bytes: Uint8Array;
  /** `bytes`, gzip'd once per scan for /api/radar/frame. */
  gz: Buffer;
}

export interface RadarSource {
  latest(): RadarScan | null;
  isStale(now?: number): boolean;
  onScan(cb: (scan: RadarScan) => void): void;
  start(): void;
  stop(): void;
}

export interface RadarFetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface RadarFeedOpts {
  center: { lat: number; lon: number };
  span: { w: number; h: number };
  refreshMs: number;
  staleMs: number;
  baseUrl?: string;
  fetcher?: (url: string) => Promise<RadarFetchResponse>;
  now?: () => number;
  /** Test hook: the source grid (defaults to IEM USCOMP). */
  grid?: WorldGrid;
}

export class RadarFeed implements RadarSource {
  private readonly win: CropWindow | null;
  private readonly grid: WorldGrid;
  private readonly base: string;
  private readonly refreshMs: number;
  private readonly staleMs: number;
  private readonly fetcher: (url: string) => Promise<RadarFetchResponse>;
  private readonly now: () => number;
  private scan: RadarScan | null = null;
  private cb: ((scan: RadarScan) => void) | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;
  private failStreak = 0;

  constructor(opts: RadarFeedOpts) {
    this.grid = opts.grid ?? IEM_USCOMP;
    this.win = cropWindow(this.grid, opts.center, opts.span);
    if (!this.win) console.error("[radar] crop box is outside the radar grid; radar disabled");
    this.base = opts.baseUrl ?? IEM_N0Q_BASE;
    this.refreshMs = opts.refreshMs;
    this.staleMs = opts.staleMs;
    this.fetcher = opts.fetcher ?? ((u) => fetch(u, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }));
    this.now = opts.now ?? Date.now;
  }

  latest(): RadarScan | null { return this.scan; }

  isStale(now = this.now()): boolean {
    return !this.scan || now - this.scan.scanTime > this.staleMs;
  }

  onScan(cb: (scan: RadarScan) => void): void { this.cb = cb; }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.loop();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  }

  /** One meta check (+ download when the scan advanced). Public for tests. */
  async pollOnce(): Promise<void> {
    const win = this.win;
    if (!win) return;
    try {
      const metaRes = await this.fetcher(`${this.base}.json`);
      if (!metaRes.ok) throw new Error(`meta HTTP ${metaRes.status}`);
      const body = await metaRes.json() as { meta?: { valid?: unknown } };
      const scanTime = typeof body?.meta?.valid === "string" ? Date.parse(body.meta.valid) : NaN;
      if (!Number.isFinite(scanTime)) throw new Error("meta.valid missing or unparseable");
      if (scanTime > this.now() + FUTURE_SLACK_MS) throw new Error(`meta.valid ${body.meta?.valid} is in the future`);
      // Any CHANGE is a new scan (not only an increase), so a corrected
      // backwards timestamp can't freeze the feed either.
      if (this.scan && scanTime === this.scan.scanTime) { this.failStreak = 0; return; }

      const imgRes = await this.fetcher(`${this.base}.png`);
      if (!imgRes.ok) throw new Error(`image HTTP ${imgRes.status}`);
      const crop = await decodeIndexedCrop(new Uint8Array(await imgRes.arrayBuffer()), win);
      if (crop.imageWidth !== this.grid.width || crop.imageHeight !== this.grid.height) {
        throw new Error(`image is ${crop.imageWidth}x${crop.imageHeight}, grid expects ${this.grid.width}x${this.grid.height}`);
      }
      const gz = await gzipAsync(crop.bytes);
      this.scan = {
        scanTime, fetchedAt: this.now(), bounds: win.bounds,
        width: crop.width, height: crop.height, bytes: crop.bytes, gz,
      };
      this.failStreak = 0;
      this.cb?.(this.scan);
    } catch (err) {
      this.failStreak++;
      if (this.failStreak === 1) {
        console.error(`[radar] feed error: ${err instanceof Error ? err.message : String(err)}`.slice(0, 200));
      }
    }
  }

  private async loop(): Promise<void> {
    if (this.stopped) return;
    await this.pollOnce();
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.loop(), this.refreshMs);
    this.timer.unref?.();
  }
}
