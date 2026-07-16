import type { AircraftTarget, AircraftKind } from "./engine/ScannerEngine.js";
import { distKm } from "./powerEstimator.js";
import { AIRPLANES_LIVE_URL } from "./config/schema.js";

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
  url?: string;             // default https://api.airplanes.live/v2/point
  /** Retain the last good snapshot for this many consecutive failed polls
   *  before clearing the map. Default 2. */
  maxStaleTicks?: number;
  /** Injected for tests; defaults to global fetch (with a request timeout). */
  fetcher?: (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
}

// airplanes.live is a shared free feed; a bare fetch with no timeout can hang
// for minutes on a black-holed connection, and this poll loop is strictly
// serial — one stuck request would freeze the overlay. Bound every request.
const FETCH_TIMEOUT_MS = 8_000;

/** undici collapses every network-level failure into the bare message "fetch
 *  failed" and hangs the real reason (ECONNRESET, EAI_AGAIN, a TLS error, ...)
 *  off `cause`. Unwrap it: logging only `message` made a DNS blip, a reset
 *  socket and a dead route all read identically in the journal. */
function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause: unknown = err.cause;
  if (!(cause instanceof Error)) return err.message;
  const code = (cause as { code?: unknown }).code;
  return `${err.message} (${typeof code === "string" ? code : cause.message})`;
}

// Only the airplanes.live fields we read. alt_baro is a number while airborne
// and the string "ground" on the ramp; category is the ADS-B emitter class.
interface RawAc {
  hex?: string;
  flight?: string;
  r?: string;
  lat?: number;
  lon?: number;
  track?: number;
  alt_baro?: number | string;
  category?: string;
}

/** Visual class from the ADS-B emitter category (airplanes.live `category`):
 *    A1 light            -> prop        A5 heavy             -> airliner
 *    A2 small            -> airliner    A6 high-performance  -> military
 *    A3 large            -> airliner    A7 rotorcraft        -> helicopter
 *    A4 high-vortex large-> airliner    A0 / B* / C* / none  -> unknown
 *  A2 still classes as an airliner (a small/regional/biz jet); the glyph
 *  renders smaller off the raw category, so it reads distinct from a heavy. */
export function classifyKind(category: string | null | undefined): AircraftKind {
  switch ((category ?? "").toUpperCase()) {
    case "A7": return "helicopter";
    case "A6": return "military";
    case "A2": case "A3": case "A4": case "A5": return "airliner";
    case "A1": return "prop";
    default: return "unknown";
  }
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
    const category = (raw.category ?? "").trim() || null;
    out.push({
      hex,
      callsign,
      lat: raw.lat,
      lon: raw.lon,
      heading: typeof raw.track === "number" ? raw.track : null,
      kind: classifyKind(category),
      category,
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
    this.url = opts.url ?? AIRPLANES_LIVE_URL;
    this.fetcher = opts.fetcher ?? ((u) => fetch(u, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }));
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
      // A non-2xx (e.g. 429 rate-limit, 5xx) must NOT be treated as an empty
      // sky: parsing its error body would blank the map and reset the fail
      // streak, defeating both stale-retention and backoff. Route it through
      // the catch path like any other failure.
      if (!res.ok) throw new Error(`aircraft feed HTTP ${res.status}`);
      const targets = parseAircraft(await res.json(), this.home, this.maxTargets);
      this.failStreak = 0;
      this.last = targets;
      this.emit(targets);
    } catch (err) {
      this.failStreak++;
      if (this.failStreak === 1) {
        console.error(`[aircraft] feed error: ${describeError(err)}`.slice(0, 200));
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
