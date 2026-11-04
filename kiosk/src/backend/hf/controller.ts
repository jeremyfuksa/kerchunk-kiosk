// Drives HfSweep from real time and engine events. It only decides; `apply` does the tuning.
import type { EngineEvent } from "../engine/ScannerEngine.js";
import { HF_BANDS_DEFAULT, HF_DEFAULTS, HfSweep, hfWindows, type HfBand, type HfCarrier, type HfOpts, type HfTune } from "./sweep.js";

const TICK_MS = 1_000;

export type HfConfig = Partial<Omit<HfOpts, "isMatched">> & { bands?: HfBand[] };

export interface HfControllerDeps {
  config: () => HfConfig | undefined;
  apply: (tune: HfTune) => void;
  /** Every survey, for the reception log. */
  onSurvey?: (tune: HfTune, carriers: readonly HfCarrier[], floorDb: number) => void;
  isMatched?: (hz: number) => boolean;
  now?: () => number;
}

export class HfController {
  private sweep: HfSweep | null = null;
  private timer: NodeJS.Timeout | null = null;
  private readonly now: () => number;

  constructor(private readonly deps: HfControllerDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  private opts(): HfOpts {
    const { bands: _bands, ...knobs } = this.deps.config() ?? {};
    return { ...HF_DEFAULTS, ...knobs, ...(this.deps.isMatched ? { isMatched: this.deps.isMatched } : {}) };
  }

  /** Starts over on the first window. The caller tunes to current(). */
  start(): void {
    this.sweep = new HfSweep(this.opts(), hfWindows(this.deps.config()?.bands ?? HF_BANDS_DEFAULT), this.now());
    this.arm();
  }

  stop(): void {
    this.disarm();
    this.sweep = null;
  }

  /** A SAME break-in has the radio. */
  pause(): void { this.disarm(); }

  /** Same window, timer restarted. The caller tunes to current(). */
  resume(): void {
    this.sweep?.resume(this.now());
    this.arm();
  }

  current(): HfTune | null { return this.sweep?.current() ?? null; }

  listenIsCarrier(): boolean { return this.sweep?.listenIsCarrier() ?? false; }

  /** First window, for callers that need a tune before the sweep starts. */
  firstTune(): HfTune {
    return new HfSweep(this.opts(), hfWindows(this.deps.config()?.bands ?? HF_BANDS_DEFAULT), this.now()).current();
  }

  skip(): void {
    if (this.sweep && this.timer) this.deps.apply(this.sweep.skip(this.now()));
  }

  onEngineEvent(ev: EngineEvent): void {
    if (!this.sweep || !this.timer) return;
    if (ev.type !== "carriers") return;
    this.sweep.setOpts(this.opts());   // live knobs
    const live = this.sweep.current();
    if (live.centerHz === ev.centerHz) this.deps.onSurvey?.(live, this.sweep.inWindow(ev.carriers), ev.floorDb);
    const tune = this.sweep.onCarriers(this.now(), ev.centerHz, ev.carriers);
    if (tune) this.deps.apply(tune);
  }

  private arm(): void {
    this.disarm();
    this.timer = setInterval(() => {
      if (!this.sweep) return;
      const tune = this.sweep.tick(this.now());
      if (tune) this.deps.apply(tune);
    }, TICK_MS);
    this.timer.unref?.();
  }

  private disarm(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
