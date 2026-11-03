// HF mode's decisions, free of timers and I/O (spec 2026-11-02-hf-mode): which window and which
// station. The sweep sets the pace; the speaker takes what's in the window.

export interface HfBand { name: string; loHz: number; hiHz: number }
export interface HfWindow { centerHz: number; band: string; loHz: number; hiHz: number }
export interface HfCarrier { hz: number; db: number }
export interface HfTune { centerHz: number; listenHz: number | null; band: string; loHz: number; hiHz: number }

export interface HfOpts {
  windowMs: number;       // time on each shortwave window
  minListenDb: number;    // a carrier needs this over the floor to reach the speaker
  cooldownMs: number;     // before a station may play again
  fadeMs: number;         // the playing station gone this long = next station
  isMatched?: (hz: number) => boolean;   // has a schedule entry: plays ahead of the unidentified
}

export const HF_DEFAULTS: HfOpts = {
  windowMs: 60_000, minListenDb: 15, cooldownMs: 30 * 60_000, fadeMs: 15_000,
};

// Broadcast bands, 120 m to 13 m.
export const HF_BANDS_DEFAULT: HfBand[] = [
  { name: "120m", loHz: 2_300_000, hiHz: 2_495_000 },
  { name: "90m", loHz: 3_200_000, hiHz: 3_400_000 },
  { name: "75m", loHz: 3_900_000, hiHz: 4_000_000 },
  { name: "60m", loHz: 4_750_000, hiHz: 5_060_000 },
  { name: "49m", loHz: 5_800_000, hiHz: 6_200_000 },
  { name: "41m", loHz: 7_200_000, hiHz: 7_800_000 },
  { name: "31m", loHz: 9_260_000, hiHz: 9_990_000 },
  { name: "25m", loHz: 11_600_000, hiHz: 12_180_000 },
  { name: "22m", loHz: 13_570_000, hiHz: 13_870_000 },
  { name: "19m", loHz: 15_100_000, hiHz: 15_800_000 },
  { name: "16m", loHz: 17_480_000, hiHz: 17_900_000 },
  { name: "15m", loHz: 18_900_000, hiHz: 19_020_000 },
  { name: "13m", loHz: 21_450_000, hiHz: 21_850_000 },
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
  private readonly playedAt = new Map<number, number>();

  constructor(private opts: HfOpts, private readonly windows: readonly HfWindow[], now: number) {
    this.windowAt = now;
  }

  setOpts(opts: HfOpts): void { this.opts = opts; }

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
    const carriers = this.inWindow(seen);

    if (this.listenHz !== null) {
      const heard = carriers.some((c) => Math.abs(c.hz - this.listenHz!) <= RASTER_HZ && c.db >= this.opts.minListenDb);
      if (heard) { this.listenSeenAt = now; return null; }
      if (now - this.listenSeenAt < this.opts.fadeMs) return null;
    }
    const next = this.choose(now, carriers);
    if (next === this.listenHz) return null;
    this.listenHz = next;
    if (next !== null) { this.playedAt.set(next, now); this.listenSeenAt = now; }
    return this.current();
  }

  /** Time passing. Returns the new tune when the window ends. */
  tick(now: number): HfTune | null {
    return now - this.windowAt >= this.opts.windowMs ? this.next(now) : null;
  }

  skip(now: number): HfTune { return this.next(now); }

  /** After a break-in: the same window, with its timer restarted. */
  resume(now: number): HfTune {
    this.windowAt = now;
    this.listenSeenAt = now;
    return this.current();
  }

  private next(now: number): HfTune {
    this.listenHz = null;
    this.windowAt = now;
    this.index = (this.index + 1) % this.windows.length;
    return this.current();
  }

  private choose(now: number, carriers: readonly HfCarrier[]): number | null {
    const ready = carriers
      .filter((c) => c.db >= this.opts.minListenDb)
      .filter((c) => {
        const at = this.playedAt.get(c.hz);
        return at === undefined || now - at >= this.opts.cooldownMs;
      })
      .sort((a, b) => {
        const m = Number(this.opts.isMatched?.(b.hz) ?? false) - Number(this.opts.isMatched?.(a.hz) ?? false);
        return m || b.db - a.db;
      });
    return ready[0]?.hz ?? null;
  }
}
