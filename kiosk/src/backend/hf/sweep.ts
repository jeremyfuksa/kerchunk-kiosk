// HF mode's decisions, free of timers and I/O (spec 2026-11-02-hf-mode): which window and which
// station. The sweep sets the pace; the speaker takes what's in the window.

export interface HfBand { name: string; loHz: number; hiHz: number }
export interface HfWindow { centerHz: number; band: string; loHz: number; hiHz: number }
export interface HfCarrier {
  hz: number;           // snapped to the raster
  db: number;
  peakHz?: number;      // where the peak really is
  steadyDb?: number;    // about 0 for a steady carrier, higher for voice that comes and goes
}
export interface HfTune { centerHz: number; listenHz: number | null; band: string; loHz: number; hiHz: number }

export interface HfOpts {
  windowMs: number;       // time on each shortwave window
  emptyWindowMs?: number; // nothing playable for this long ends the window early. Absent = every window runs its full time
  minListenDb: number;    // a carrier needs this over the floor to reach the speaker
  cooldownMs: number;     // before a station may play again
  fadeMs: number;         // the playing station gone this long = next station
  carrierSteadyDb: number;   // a carrier is steadier than this...
  carrierRasterHz: number;   // ...and this close to the raster. Nothing else gets a station name
  isMatched?: (hz: number) => boolean;   // has a schedule entry: plays ahead of the unidentified
}

export const HF_DEFAULTS: HfOpts = {
  windowMs: 60_000, minListenDb: 15, cooldownMs: 30 * 60_000, fadeMs: 15_000,
  carrierSteadyDb: 5, carrierRasterHz: 300,   // docs/bench/2026-11-hf-proofs.md
};

/** A broadcast has a steady carrier on the raster. SSB voice comes and goes, and sits anywhere. */
export function hasCarrier(c: HfCarrier, o: Pick<HfOpts, "carrierSteadyDb" | "carrierRasterHz">): boolean {
  return (c.steadyDb ?? 0) < o.carrierSteadyDb && Math.abs((c.peakHz ?? c.hz) - c.hz) <= o.carrierRasterHz;
}

// Broadcast bands, 120 m to 13 m, minus where they overlap US ham bands: hams overlap each other there,
// and SSB has no carrier or raster for the survey to find. That drops all of 75 m and 41 m up to 7300 kHz,
// and the edge channels of both 41 m and 13 m (a ham peak can snap to them).
export const HF_BANDS_DEFAULT: HfBand[] = [
  { name: "120m", loHz: 2_300_000, hiHz: 2_495_000 },
  { name: "90m", loHz: 3_200_000, hiHz: 3_400_000 },
  { name: "60m", loHz: 4_750_000, hiHz: 5_060_000 },
  { name: "49m", loHz: 5_800_000, hiHz: 6_200_000 },
  { name: "41m", loHz: 7_305_000, hiHz: 7_800_000 },
  { name: "31m", loHz: 9_260_000, hiHz: 9_990_000 },
  { name: "25m", loHz: 11_600_000, hiHz: 12_180_000 },
  { name: "22m", loHz: 13_570_000, hiHz: 13_870_000 },
  { name: "19m", loHz: 15_100_000, hiHz: 15_800_000 },
  { name: "16m", loHz: 17_480_000, hiHz: 17_900_000 },
  { name: "15m", loHz: 18_900_000, hiHz: 19_020_000 },
  { name: "13m", loHz: 21_455_000, hiHz: 21_850_000 },
];

const WINDOW_HZ = 600_000;
const RASTER_HZ = 5_000;

/** Centers sit between raster channels: the survey can't see the exact center. */
export function hfWindows(bands: readonly HfBand[]): HfWindow[] {
  const out: HfWindow[] = [];
  for (const b of bands) {
    const n = Math.ceil((b.hiHz - b.loHz) / WINDOW_HZ);
    const step = (b.hiHz - b.loHz) / n;
    for (let i = 0; i < n; i++) {
      const c = b.loHz + step * (i + 0.5);
      out.push({ centerHz: Math.floor(c / RASTER_HZ) * RASTER_HZ + RASTER_HZ / 2, band: b.name, loHz: b.loHz, hiHz: b.hiHz });
    }
  }
  return out.sort((a, b) => a.centerHz - b.centerHz);
}

export class HfSweep {
  private index = 0;
  private windowAt: number;
  private listenHz: number | null = null;
  private listenSeenAt = 0;
  private listenCarrier = false;
  private surveyed = false;
  private readonly playedAt = new Map<number, number>();

  constructor(private opts: HfOpts, private readonly windows: readonly HfWindow[], now: number) {
    this.windowAt = now;
  }

  setOpts(opts: HfOpts): void { this.opts = opts; }

  /** What's playing has shown a carrier. A fade can hide one for a survey, so it stays true until the next station. */
  listenIsCarrier(): boolean { return this.listenCarrier; }

  current(): HfTune {
    const w = this.windows[this.index]!;
    return { centerHz: w.centerHz, listenHz: this.listenHz, band: w.band, loHz: w.loHz, hiHz: w.hiHz };
  }

  /** A window sees past its band's edges, onto ham and utility signals. Those aren't this sweep's. */
  inWindow(carriers: readonly HfCarrier[]): HfCarrier[] {
    const w = this.windows[this.index]!;
    return carriers.filter((c) => c.hz >= w.loHz && c.hz <= w.hiHz);
  }

  /** A survey for the live window. Returns the new tune when the station changes. */
  onCarriers(now: number, centerHz: number, seen: readonly HfCarrier[]): HfTune | null {
    if (centerHz !== this.current().centerHz) return null;
    this.surveyed = true;
    const carriers = this.inWindow(seen);

    if (this.listenHz !== null) {
      const heard = carriers.filter((c) => Math.abs(c.hz - this.listenHz!) <= RASTER_HZ && c.db >= this.opts.minListenDb);
      if (heard.length > 0) {
        this.listenSeenAt = now;
        if (heard.some((c) => hasCarrier(c, this.opts))) this.listenCarrier = true;
        return null;
      }
      if (now - this.listenSeenAt < this.opts.fadeMs) return null;
    }
    const next = this.choose(now, carriers);
    this.listenCarrier = next !== null && hasCarrier(next, this.opts);
    if ((next?.hz ?? null) === this.listenHz) return null;
    this.listenHz = next?.hz ?? null;
    if (next) { this.playedAt.set(next.hz, now); this.listenSeenAt = now; }
    return this.current();
  }

  /** Time passing. Returns the new tune when the window ends. */
  tick(now: number): HfTune | null {
    return now - this.windowAt >= this.opts.windowMs || this.isDead(now) ? this.next(now) : null;
  }

  /** Only a survey can say a window is empty, and the first one can take 5 s to arrive after a retune.
   *  Stations in cooldown don't count: playing nothing here for a full window gains nothing. */
  private isDead(now: number): boolean {
    const wait = this.opts.emptyWindowMs;
    return wait !== undefined && this.surveyed && this.listenHz === null && now - Math.max(this.windowAt, this.listenSeenAt) >= wait;
  }

  skip(now: number): HfTune { return this.next(now); }

  /** After a break-in: the same window, with its timer restarted. */
  resume(now: number): HfTune {
    this.windowAt = now;
    this.listenSeenAt = now;
    this.surveyed = false;
    return this.current();
  }

  private next(now: number): HfTune {
    this.listenHz = null;
    this.listenCarrier = false;
    this.surveyed = false;
    this.windowAt = now;
    this.index = (this.index + 1) % this.windows.length;
    return this.current();
  }

  private choose(now: number, carriers: readonly HfCarrier[]): HfCarrier | null {
    const ready = carriers
      .filter((c) => c.db >= this.opts.minListenDb)
      .filter((c) => {
        const at = this.playedAt.get(c.hz);
        return at === undefined || now - at >= this.opts.cooldownMs;
      })
      .sort((a, b) => this.rank(b) - this.rank(a) || b.db - a.db);
    return ready[0] ?? null;
  }

  /** A carrier plays first, and one with a schedule match ahead of that. */
  private rank(c: HfCarrier): number {
    if (!hasCarrier(c, this.opts)) return 0;
    return this.opts.isMatched?.(c.hz) ? 2 : 1;
  }
}
