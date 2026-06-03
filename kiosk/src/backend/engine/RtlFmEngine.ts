import { spawn, type ChildProcess } from "node:child_process";
import type {
  ScannerEngine, ScanConfig, EngineState, EngineEvent, EngineListener,
} from "./ScannerEngine.js";
import type { Channel } from "../config/schema.js";
import { rmsAmplitude, amplitudeToDbfs, SquelchDetector } from "./pcmEnergy.js";
import { setVolume as amixerVolume, setMuted as amixerMuted } from "../audio.js";

// Node-driven sequential-dwell scanner.
//
// Real rtl_fm (2.0.2) emits no per-event stderr while scanning, so we cannot
// learn the active channel from its output. Instead Node owns the scan loop: it
// runs rtl_fm on ONE enabled channel at a time, pipes its stdout to the audio
// sink while tapping it to measure PCM energy. Energy above threshold => the
// channel is active and we dwell; sustained silence => we hop to the next
// enabled channel. Because Node picks the frequency, it always knows exactly
// which channel is active.

export interface RtlFmEngineOptions {
  rtlFmCmd?: string;
  sinkCmd?: string[] | null;
  autoRestart?: boolean;
  restartDelayMs?: number;
  openThreshold?: number;
  hangMs?: number;
  hopIntervalMs?: number;
  now?: () => number;
}

const DEFAULT_SINK = ["aplay", "-r", "12000", "-f", "S16_LE", "-t", "raw", "-c", "1"];

export class RtlFmEngine implements ScannerEngine {
  private readonly rtlFmCmd: string;
  private readonly sinkCmd: string[] | null;
  private readonly autoRestart: boolean;
  private readonly restartDelayMs: number;
  private readonly openThreshold: number;
  private readonly hangMs: number;
  private readonly hopIntervalMs: number;
  private readonly now: () => number;

  private listeners = new Set<EngineListener>();
  private _state: EngineState = "stopped";

  private config: ScanConfig | null = null;
  private enabled: Channel[] = [];
  private index = 0;

  private rtl: ChildProcess | null = null;
  private sink: ChildProcess | null = null;
  private detector: SquelchDetector | null = null;
  private holding = false;            // true while squelch is open on current channel
  private channelStartedAt = 0;       // now() when we began listening on current channel
  private hopTimer: NodeJS.Timeout | null = null;
  private restartTimer: NodeJS.Timeout | null = null;

  // These flags let the rtl_fm exit handler distinguish intentional kills
  // (stop/hop) from genuine crashes.
  private stopping = false;
  private hopping = false;

  constructor(opts: RtlFmEngineOptions = {}) {
    this.rtlFmCmd = opts.rtlFmCmd ?? "rtl_fm";
    this.sinkCmd = opts.sinkCmd === undefined ? DEFAULT_SINK : opts.sinkCmd;
    this.autoRestart = opts.autoRestart ?? true;
    this.restartDelayMs = opts.restartDelayMs ?? 1000;
    this.openThreshold = opts.openThreshold ?? 2000;
    this.hangMs = opts.hangMs ?? 1500;
    this.hopIntervalMs = opts.hopIntervalMs ?? 400;
    this.now = opts.now ?? Date.now;
  }

  get state(): EngineState { return this._state; }

  on(l: EngineListener): void { this.listeners.add(l); }
  off(l: EngineListener): void { this.listeners.delete(l); }

  private emit(ev: EngineEvent): void { for (const l of this.listeners) l(ev); }

  private setState(state: EngineState): void {
    this._state = state;
    this.emit({ type: "status", state, ts: this.now() });
  }

  // Builds the rtl_fm argv for a SINGLE channel. Squelch is `-l 0` (open)
  // because Node does squelch detection from PCM energy now.
  buildArgs(channel: Channel, config: ScanConfig): string[] {
    const args = [
      "-f", String(channel.freq),
      "-M", "fm",
      "-s", String(config.sampleRate),
      "-l", "0",
      "-t", "5",
    ];
    if (config.gain !== "auto") {
      args.push("-g", String(config.gain));
    }
    args.push("-");
    return args;
  }

  async start(config: ScanConfig): Promise<void> {
    // Calling start() while already running would orphan the existing pipeline;
    // tear it down first.
    if (this._state !== "stopped") {
      await this.stop();
    }

    this.config = config;
    this.enabled = config.channels.filter((c) => c.enabled);
    this.index = 0;
    this.stopping = false;
    this.hopping = false;

    this.setState("starting");

    if (this.enabled.length === 0) {
      // Nothing to scan; still consider ourselves running so the rest of the
      // system behaves normally — there's just no pipeline.
      this.setState("running");
      return;
    }

    this.setState("running");
    this.spawnForChannel(this.enabled[this.index]!);
  }

  private currentChannel(): Channel | null {
    return this.enabled[this.index] ?? null;
  }

  private spawnForChannel(channel: Channel): void {
    if (!this.config) return;

    this.holding = false;
    this.detector = new SquelchDetector({
      openThreshold: this.openThreshold,
      hangMs: this.hangMs,
    });
    this.channelStartedAt = this.now();

    // Audio sink (optional).
    if (this.sinkCmd) {
      this.sink = spawn(this.sinkCmd[0]!, this.sinkCmd.slice(1), {
        stdio: ["pipe", "ignore", "ignore"],
      });
      this.sink.on("error", () => { /* sink failure is non-fatal for scanning */ });
    } else {
      this.sink = null;
    }

    const args = this.buildArgs(channel, this.config);
    const rtl = spawn(this.rtlFmCmd, args, { stdio: ["ignore", "pipe", "ignore"] });
    this.rtl = rtl;

    rtl.stdout!.on("data", (chunk: Buffer) => {
      if (this.sink && this.sink.stdin && this.sink.stdin.writable) {
        this.sink.stdin.write(chunk);
      }
      if (!this.detector) return;
      const rms = rmsAmplitude(chunk);
      const transition = this.detector.push(rms, this.now());
      if (transition === "opened") {
        this.holding = true;
        const ts = this.now();
        this.emit({ type: "active", channel, freq: channel.freq, ts });
        this.emit({ type: "signal", dbfs: amplitudeToDbfs(rms), ts });
      } else if (transition === "closed") {
        this.holding = false;
        this.emit({ type: "idle", ts: this.now() });
        this.hop();
      }
    });

    rtl.on("error", (err) => {
      this.emit({ type: "error", code: "SPAWN_FAILED", message: err.message, ts: this.now() });
      this.handleUnexpectedExit(channel);
    });

    rtl.on("exit", () => {
      if (this.rtl !== rtl) return; // superseded by a newer spawn
      if (this.stopping || this.hopping) return; // intentional kill
      this.handleUnexpectedExit(channel);
    });

    this.startHopTimer();
  }

  private startHopTimer(): void {
    this.clearHopTimer();
    if (this.enabled.length <= 1) return; // nothing to hop to
    this.hopTimer = setInterval(() => {
      if (this.holding) return; // never hop while active
      if (this.now() - this.channelStartedAt >= this.hopIntervalMs) {
        this.hop();
      }
    }, Math.max(20, Math.floor(this.hopIntervalMs / 3))); // poll at ~3x the hop rate, min 20ms
  }

  private clearHopTimer(): void {
    if (this.hopTimer) {
      clearInterval(this.hopTimer);
      this.hopTimer = null;
    }
  }

  private clearRestartTimer(): void {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
  }

  private killChildren(): void {
    this.clearHopTimer();
    if (this.rtl) {
      const rtl = this.rtl;
      this.rtl = null;
      rtl.stdout?.removeAllListeners("data");
      try { rtl.kill("SIGKILL"); } catch { /* ignore */ }
    }
    if (this.sink) {
      const sink = this.sink;
      this.sink = null;
      try { sink.stdin?.end(); } catch { /* ignore */ }
      try { sink.kill("SIGKILL"); } catch { /* ignore */ }
    }
  }

  private hop(): void {
    if (this.enabled.length === 0) return;
    this.hopping = true;
    this.killChildren();
    this.index = (this.index + 1) % this.enabled.length;
    this.hopping = false;
    const next = this.currentChannel();
    if (next) this.spawnForChannel(next);
  }

  private handleUnexpectedExit(channel: Channel): void {
    // Tear down BOTH children (rtl_fm and sink) and remove listeners before we
    // (maybe) respawn. Without this the dead rtl_fm's sink is orphaned when
    // spawnForChannel later overwrites this.sink. killChildren() nulls this.rtl
    // first, so any exit event fired by its own SIGKILL hits the
    // `this.rtl !== rtl` stale-guard in the rtl.on("exit") handler and is
    // ignored — no recursive unexpected-exit, no double restart.
    this.killChildren();
    if (this.autoRestart) {
      this.emit({
        type: "error", code: "RTL_EXITED",
        message: "rtl_fm exited; restarting", ts: this.now(),
      });
      this.clearRestartTimer();
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null;
        if (this.stopping) return;
        this.spawnForChannel(channel);
      }, this.restartDelayMs);
    } else {
      this.setState("stopped");
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.clearRestartTimer();
    this.killChildren();
    this.detector = null;
    this.holding = false;
    this.setState("stopped");
  }

  async setVolume(percent: number): Promise<void> {
    await amixerVolume(percent);
  }
  async setMuted(muted: boolean): Promise<void> {
    await amixerMuted(muted);
  }
}
