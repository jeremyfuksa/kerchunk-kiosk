import type {
  ScannerEngine, ScanConfig, EngineState, EngineEvent, EngineListener,
} from "./ScannerEngine.js";
import type { Channel } from "../config/schema.js";

// Deterministic timestamp source so tests never depend on the clock.
let seq = 0;
const nextTs = () => ++seq;

export class FakeEngine implements ScannerEngine {
  private listeners = new Set<EngineListener>();
  private _state: EngineState = "stopped";

  get state(): EngineState { return this._state; }

  on(l: EngineListener): void { this.listeners.add(l); }
  off(l: EngineListener): void { this.listeners.delete(l); }

  private emit(ev: EngineEvent): void { for (const l of this.listeners) l(ev); }

  // Test hooks: tests assert HOW a mode switch was applied (light retune vs
  // full restart) by counting these. `tunes` is the union — every config the
  // engine was handed via either path — so a test can assert WHAT it tuned to
  // without caring WHICH path applied it.
  starts: ScanConfig[] = [];
  retunes: ScanConfig[] = [];
  tunes: ScanConfig[] = [];

  async start(config: ScanConfig): Promise<void> {
    this.starts.push(config);
    this.tunes.push(config);
    this.emit({ type: "warmup", phase: "booting", step: 1, of: 4, ts: nextTs() });
    this._state = "running";
    this.emit({ type: "status", state: "running", ts: nextTs() });
    // No real DSP to warm — declare ready immediately so the kiosk overlay
    // clears (and tests can assert the warm-up contract on the fake path).
    this.emit({ type: "warmup", phase: "ready", step: 4, of: 4, ts: nextTs() });
  }

  async stop(): Promise<void> {
    this._state = "stopped";
    this.emit({ type: "status", state: "stopped", ts: nextTs() });
  }

  // Mirrors WidebandEngine: re-point the live graph with NO warm-up/status
  // churn. A stopped fake falls back to a fresh start, same as the real one.
  async retune(config: ScanConfig): Promise<void> {
    if (this._state !== "running") { await this.start(config); return; }
    this.retunes.push(config);
    this.tunes.push(config);
    this.config = config;
    this.emit({ type: "tuned", freqHz: config.channels[0]?.freq ?? 0,
      channelIds: config.channels.map((c) => c.id), ts: nextTs() });
  }
  config: ScanConfig | null = null;

  async setVolume(_percent: number): Promise<void> {}
  async setMuted(_muted: boolean): Promise<void> {}

  // Test/dev hooks — not part of the interface.
  emitActive(channel: Channel): void {
    this.emit({ type: "active", channel, freq: channel.freq, ts: nextTs() });
  }
  emitIdle(): void { this.emit({ type: "idle", ts: nextTs() }); }
  emitRelease(channelId: string): void {
    this.emit({ type: "release", channelId, ts: nextTs() });
  }
  skips = 0;
  knownHzUpdates: number[][] = [];
  updateKnownHz(knownHz: number[]): void { this.knownHzUpdates.push(knownHz); }
  lastHoldoff: number | undefined;
  skip(holdoffSeconds?: number): void { this.skips++; this.lastHoldoff = holdoffSeconds; }
  emitLevel(channelId: string, db: number): void {
    this.emit({ type: "level", channelId, db, ts: nextTs() });
  }
  emitSame(raw: string): void {
    this.emit({ type: "same", raw, ts: nextTs() });
  }
  emitCloseCall(freqHz: number): void {
    this.emit({ type: "closecall", freqHz, ts: nextTs() });
  }
}
