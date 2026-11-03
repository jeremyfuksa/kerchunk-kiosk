// HF mode's decisions, free of timers and I/O (spec 2026-11-02-hf-mode): which window, which
// station, and when CB takes over. The sweep sets the pace; the speaker takes what's in the window.
import { CB_FREQ_HZ } from "../config/cb.js";

export interface HfBand { name: string; loHz: number; hiHz: number }
export interface HfWindow { centerHz: number; band: string; loHz: number; hiHz: number }
export interface HfCarrier { hz: number; db: number }
export type HfStage = "sweep" | "cbStop" | "cb";
export interface HfTune { stage: HfStage; centerHz: number; listenHz: number | null; band: string; loHz?: number; hiHz?: number }

export interface HfOpts {
  windowMs: number;       // time on each shortwave window
  cbStopMs: number;       // time on the CB band each pass
  minListenDb: number;    // a carrier needs this over the floor to reach the speaker
  cooldownMs: number;     // before a station may play again
  fadeMs: number;         // the playing station gone this long = next station
  cbOpenDb: number;       // a CB carrier needs this over the floor to count
  cbOpenMs: number;       // ... continuously this long, to hold on CB
  cbQuietMs: number;      // CB silent this long = back to the sweep
  isMatched?: (hz: number) => boolean;   // has a schedule entry: plays ahead of the unidentified
  isCbChannel?: (hz: number) => boolean; // a channel a CB hold would tune. Absent = all 40.
}

export const HF_DEFAULTS: HfOpts = {
  windowMs: 60_000, cbStopMs: 30_000, minListenDb: 15, cooldownMs: 30 * 60_000, fadeMs: 15_000,
  cbOpenDb: 15, cbOpenMs: 10_000, cbQuietMs: 20 * 60_000,
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
// The empty slot in the CB band: 10 kHz from its neighbours, as CB mode's own grouping picks.
const CB_CENTER_HZ = 27_195_000;
const CB_HZ = new Set(Object.values(CB_FREQ_HZ));

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
  private index = 0;              // windows.length = the CB stop
  private stage: HfStage = "sweep";
  private stageAt: number;
  private listenHz: number | null = null;
  private listenSeenAt = 0;
  private readonly playedAt = new Map<number, number>();
  private cbSince: number | null = null;
  private cbLastActive = 0;

  constructor(private opts: HfOpts, private readonly windows: readonly HfWindow[], now: number) {
    this.stageAt = now;
  }

  setOpts(opts: HfOpts): void { this.opts = opts; }

  current(): HfTune {
    if (this.stage !== "sweep") {
      return { stage: this.stage, centerHz: CB_CENTER_HZ, listenHz: null, band: "CB" };
    }
    const w = this.windows[this.index]!;
    return { stage: "sweep", centerHz: w.centerHz, listenHz: this.listenHz, band: w.band, loHz: w.loHz, hiHz: w.hiHz };
  }

  /** A window sees past its band's edges, onto ham and utility signals. Those aren't this sweep's. */
  inWindow(carriers: readonly HfCarrier[]): HfCarrier[] {
    const w = this.windows[this.index];
    return this.stage === "sweep" && w ? carriers.filter((c) => c.hz >= w.loHz && c.hz <= w.hiHz) : [...carriers];
  }

  /** A survey for the live window. Returns the new tune when the station changes. */
  onCarriers(now: number, centerHz: number, seen: readonly HfCarrier[]): HfTune | null {
    if (this.stage === "cb" || centerHz !== this.current().centerHz) return null;
    if (this.stage === "cbStop") return this.cbSurvey(now, seen);
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

  /** Time passing. Returns the new tune when the window or the CB hold ends. */
  tick(now: number): HfTune | null {
    if (this.stage === "cb") {
      return now - this.cbLastActive >= this.opts.cbQuietMs ? this.next(now) : null;
    }
    const span = this.stage === "cbStop" ? this.opts.cbStopMs : this.opts.windowMs;
    return now - this.stageAt >= span ? this.next(now) : null;
  }

  skip(now: number): HfTune { return this.next(now); }

  onCbActivity(now: number): void { this.cbLastActive = now; }

  /** After a break-in: the same window, with its timer restarted. */
  resume(now: number): HfTune {
    this.stageAt = now;
    this.cbLastActive = now;
    this.listenSeenAt = now;
    this.cbSince = null;
    return this.current();
  }

  private next(now: number): HfTune {
    this.listenHz = null;
    this.cbSince = null;
    this.stageAt = now;
    if (this.stage === "cb") {
      // The CB stop was the end of a pass.
      this.index = 0;
      this.stage = "sweep";
      return this.current();
    }
    this.index = (this.index + 1) % (this.windows.length + 1);
    this.stage = this.index === this.windows.length ? "cbStop" : "sweep";
    return this.current();
  }

  private cbSurvey(now: number, carriers: readonly HfCarrier[]): HfTune | null {
    const tuned = this.opts.isCbChannel ?? ((hz: number) => CB_HZ.has(hz));
    const open = carriers.some((c) => CB_HZ.has(c.hz) && tuned(c.hz) && c.db >= this.opts.cbOpenDb);
    if (!open) { this.cbSince = null; return null; }
    this.cbSince ??= now;
    if (now - this.cbSince < this.opts.cbOpenMs) return null;
    this.stage = "cb";
    this.cbLastActive = now;
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
