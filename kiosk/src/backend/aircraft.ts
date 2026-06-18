import type { AircraftTarget } from "./engine/ScannerEngine.js";
import { distKm } from "./powerEstimator.js";

// Airplanes.live network ADS-B feed → airborne targets near the QTH. No SDR,
// no DSP: a plain HTTP poll. Off unless config.aircraft.enabled. The endpoint
// is non-commercial-use only and rate limited to 1 req/sec (the 5s default
// poll stays well under). See the design spec for the thermal rationale
// (snap-on-poll, no per-frame animation).

export interface AircraftSource {
  onUpdate(cb: (targets: AircraftTarget[]) => void): void;
  start(): void;
  stop(): void;
}

export interface AircraftFeedOpts {
  home: { lat: number; lon: number };
  radiusKm?: number;        // default 75 (≈ 40 nm)
  pollIntervalMs?: number;  // default 5000
  maxTargets?: number;      // default 60 (nearest-N cap)
  url?: string;             // default http://api.airplanes.live/v2/point
  /** Retain the last good snapshot for this many consecutive failed polls
   *  before clearing the map. Default 2. */
  maxStaleTicks?: number;
  /** Injected for tests; defaults to global fetch. */
  fetcher?: (url: string) => Promise<{ json(): Promise<unknown> }>;
}

// Only the airplanes.live fields we read. alt_baro is a number while airborne
// and the string "ground" on the ramp.
interface RawAc {
  hex?: string;
  flight?: string;
  r?: string;
  lat?: number;
  lon?: number;
  track?: number;
  alt_baro?: number | string;
}

/** Map a /v2/point body to airborne targets, nearest `maxTargets` from home. */
export function parseAircraft(
  body: unknown,
  home: { lat: number; lon: number },
  maxTargets: number,
): AircraftTarget[] {
  const ac = (body as { ac?: unknown } | null)?.ac;
  if (!Array.isArray(ac)) return [];
  const out: AircraftTarget[] = [];
  for (const raw of ac as RawAc[]) {
    // Airborne only: a grounded target reports alt_baro === "ground". A missing
    // or numeric altitude is treated as airborne.
    if (raw.alt_baro === "ground") continue;
    if (typeof raw.lat !== "number" || typeof raw.lon !== "number") continue;
    const hex = (raw.hex ?? "").trim();
    if (!hex) continue;
    const callsign =
      (raw.flight ?? "").trim() || (raw.r ?? "").trim() || hex.toUpperCase();
    out.push({
      hex,
      callsign,
      lat: raw.lat,
      lon: raw.lon,
      heading: typeof raw.track === "number" ? raw.track : null,
    });
  }
  // Nearest-first, then cap. Distance is a sort key only — never stored on the
  // target — so it never leaks into the WS payload.
  return out
    .map((t) => ({ t, d: distKm(home, { lat: t.lat, lon: t.lon }) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, maxTargets)
    .map((s) => s.t);
}

export class AircraftFeed implements AircraftSource {
  private readonly home: { lat: number; lon: number };
  private readonly radiusNm: number;
  private readonly pollIntervalMs: number;
  private readonly maxTargets: number;
  private readonly maxStaleTicks: number;
  private readonly url: string;
  private readonly fetcher: NonNullable<AircraftFeedOpts["fetcher"]>;
  private cb: ((t: AircraftTarget[]) => void) | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private last: AircraftTarget[] = [];
  private failStreak = 0;

  constructor(opts: AircraftFeedOpts) {
    this.home = opts.home;
    this.radiusNm = Math.max(1, Math.round((opts.radiusKm ?? 75) / 1.852));
    this.pollIntervalMs = opts.pollIntervalMs ?? 5000;
    this.maxTargets = opts.maxTargets ?? 60;
    this.maxStaleTicks = opts.maxStaleTicks ?? 2;
    this.url = opts.url ?? "http://api.airplanes.live/v2/point";
    this.fetcher = opts.fetcher ?? ((u) => fetch(u));
  }

  onUpdate(cb: (t: AircraftTarget[]) => void): void {
    this.cb = cb;
  }

  start(): void {
    this.stopped = false;
    void this.loop();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** One fetch + emit cycle. Public for deterministic tests. */
  async pollOnce(): Promise<void> {
    const endpoint = `${this.url}/${this.home.lat}/${this.home.lon}/${this.radiusNm}`;
    try {
      const res = await this.fetcher(endpoint);
      const targets = parseAircraft(await res.json(), this.home, this.maxTargets);
      this.failStreak = 0;
      this.last = targets;
      this.emit(targets);
    } catch (err) {
      this.failStreak++;
      if (this.failStreak === 1) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[aircraft] feed error: ${msg}`.slice(0, 200));
      }
      // Retain the last good snapshot briefly so a single network blip doesn't
      // blank the map; after maxStaleTicks consecutive failures, clear it.
      this.emit(this.failStreak <= this.maxStaleTicks ? this.last : []);
    }
  }

  private emit(targets: AircraftTarget[]): void {
    this.cb?.(targets);
  }

  private async loop(): Promise<void> {
    if (this.stopped) return;
    await this.pollOnce();
    if (this.stopped) return;
    // Back off when the feed is failing (cap 6×) so an offline feed doesn't
    // hammer the endpoint; healthy cadence (failStreak 0 → 1×) resumes on success.
    const delay = this.pollIntervalMs * Math.min(2 ** this.failStreak, 6);
    this.timer = setTimeout(() => void this.loop(), delay);
    this.timer.unref?.();
  }
}
