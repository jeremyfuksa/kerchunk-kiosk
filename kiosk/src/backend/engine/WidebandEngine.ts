import { spawn, type ChildProcess } from "node:child_process";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type {
  ScannerEngine, ScanConfig, EngineState, EngineEvent, EngineListener,
} from "./ScannerEngine.js";
import type { Channel } from "../config/schema.js";
import { groupChannels, type ChannelGroup } from "./grouping.js";
import { setVolume as amixerVolume, setMuted as amixerMuted } from "../audio.js";

// Wideband group-hop scanner.
//
// ONE persistent GNU Radio helper (wideband_helper.py) owns the SDR for the
// engine's whole lifetime. It samples a ~2.4 MHz I/Q window, demodulates every
// channel in the window simultaneously, does squelch detection against an
// adaptive noise floor, picks the audible channel (first-active-wins), and
// plays audio straight to ALSA. Node owns grouping + group-hop timing and
// talks line-JSON over the helper's stdin/stdout. Hopping = writing a "tune"
// line — the device is NEVER re-opened (the fix for the rtl_fm USB-thrash
// class of failures; see bench/RESULTS-2026-06-04-wideband-spike.md).

export interface WidebandEngineOptions {
  /** Helper argv override (tests point this at a fake). Default: system python + dist helper. */
  helperCmd?: string[];
  /** Extra env for the helper (tests drive fake scenarios through this). */
  helperEnv?: Record<string, string>;
  autoRestart?: boolean;
  restartDelayMs?: number;
  /** Per-group dwell override; otherwise config.groupDwellMs, else 3000. */
  groupDwellMs?: number;
  now?: () => number;
}

const DEFAULT_WINDOW_HZ = 2_000_000;
// Must match MAX_CHANS in wideband_helper.py (its channelizer lane count).
// Grouping splits oversized clusters so the helper never truncates.
const MAX_CHANNELS_PER_GROUP = 12;
const DEFAULT_GROUP_DWELL_MS = 3000;
// Signal events drive the dashboard meter; the helper's power telemetry
// arrives ~5 Hz, pass it through at up to 4 Hz for a live-feeling needle.
const SIGNAL_THROTTLE_MS = 250;
const QUIT_GRACE_MS = 500;

// GNU Radio is only importable from the system python; mise/pyenv interpreters
// shadow it. The helper ships next to this file in dist/ (build copy step).
function defaultHelperCmd(): string[] {
  return ["/usr/bin/python3", fileURLToPath(new URL("./wideband_helper.py", import.meta.url))];
}

interface HelperEvent {
  ev: string;
  id?: string | null;
  db?: number;
  freqHz?: number;
  levels?: Record<string, number>;
  centerHz?: number;
  msg?: string;
}

export class WidebandEngine implements ScannerEngine {
  private readonly helperCmd: string[];
  private readonly helperEnv: Record<string, string>;
  private readonly autoRestart: boolean;
  private readonly restartDelayMs: number;
  private readonly groupDwellOverride: number | undefined;
  private readonly now: () => number;

  private listeners = new Set<EngineListener>();
  private _state: EngineState = "stopped";

  private config: ScanConfig | null = null;
  private groups: ChannelGroup[] = [];
  private groupIndex = 0;

  private child: ChildProcess | null = null;
  private childStdout: ReadlineInterface | null = null;
  private childStderr: ReadlineInterface | null = null;
  private lastStderrLine = "";

  private openIds = new Set<string>();
  private audibleId: string | null = null;
  private lastSignalTs = 0;

  private groupStartedAt = 0;
  private dwellTimer: NodeJS.Timeout | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private killTimer: NodeJS.Timeout | null = null;

  private stopping = false;

  constructor(opts: WidebandEngineOptions = {}) {
    this.helperCmd = opts.helperCmd ?? defaultHelperCmd();
    this.helperEnv = opts.helperEnv ?? {};
    this.autoRestart = opts.autoRestart ?? true;
    // The thrash lesson: the DEFAULT restart delay must be >=1s. Tests may
    // pass a smaller explicit value (honored, like RtlFmEngine.hopIntervalMs).
    this.restartDelayMs = opts.restartDelayMs ?? 1000;
    this.groupDwellOverride = opts.groupDwellMs;
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

  private groupDwellMs(): number {
    return this.groupDwellOverride ?? this.config?.groupDwellMs ?? DEFAULT_GROUP_DWELL_MS;
  }

  async start(config: ScanConfig): Promise<void> {
    if (this._state !== "stopped") {
      await this.stop();
    }

    this.config = config;
    this.groups = groupChannels(
      config.channels,
      config.windowBandwidthHz ?? DEFAULT_WINDOW_HZ,
      MAX_CHANNELS_PER_GROUP,
    );
    this.groupIndex = 0;
    this.stopping = false;

    this.setState("starting");

    if (this.groups.length === 0) {
      // Nothing to scan; running with no helper (parity with RtlFmEngine).
      this.setState("running");
      return;
    }

    this.setState("running");
    this.spawnHelper();
  }

  private helperArgs(): string[] {
    const cfg = this.config!;
    const args = [
      "--sink", cfg.audioSink,
      "--hang-ms", String(cfg.dwellMs),
      "--open-db", String(cfg.openAboveFloorDb ?? 9),
    ];
    if (cfg.gain !== "auto") args.push("--gain", String(cfg.gain));
    // Quieting squelch threshold: only passed when configured — the helper's
    // default is bench-calibrated for this hardware.
    if (cfg.noiseQuietDb !== undefined) args.push("--quiet-db", String(cfg.noiseQuietDb));
    return args;
  }

  private spawnHelper(): void {
    if (!this.config) return;

    const argv = [...this.helperCmd, ...this.helperArgs()];
    const child = spawn(argv[0]!, argv.slice(1), {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...this.helperEnv },
    });
    this.child = child;
    this.openIds.clear();
    this.audibleId = null;
    this.lastStderrLine = "";

    const out = createInterface({ input: child.stdout! });
    this.childStdout = out;
    out.on("line", (line: string) => {
      if (this.child !== child) return; // superseded spawn; ignore
      let ev: HelperEvent;
      try { ev = JSON.parse(line) as HelperEvent; } catch { return; }
      this.handleHelperEvent(ev);
    });
    out.on("error", () => { /* non-fatal */ });

    const err = createInterface({ input: child.stderr! });
    this.childStderr = err;
    err.on("line", (line: string) => {
      if (this.child !== child) return;
      const trimmed = line.trim();
      if (trimmed.length > 0) this.lastStderrLine = trimmed;
    });
    err.on("error", () => { /* non-fatal */ });

    child.on("error", (e) => {
      if (this.child !== child) return;
      this.emit({ type: "error", code: "SPAWN_FAILED", message: e.message, ts: this.now() });
      this.handleUnexpectedExit();
    });

    // "close" (not "exit") so stderr is fully drained before we read the reason.
    child.on("close", (code) => {
      if (this.child !== child) return;
      if (this.stopping) return;
      this.handleUnexpectedExit(code);
    });
  }

  private handleHelperEvent(ev: HelperEvent): void {
    switch (ev.ev) {
      case "ready":
        this.sendTune();
        this.startDwellTimer();
        break;
      case "open": {
        if (typeof ev.id !== "string") return;
        this.openIds.add(ev.id);
        const channel = this.findChannel(ev.id);
        const ts = this.now();
        if (channel) this.emit({ type: "active", channel, freq: channel.freq, ts });
        if (typeof ev.db === "number") this.emit({ type: "signal", dbfs: ev.db, ts });
        break;
      }
      case "close":
        if (typeof ev.id !== "string") return;
        this.openIds.delete(ev.id);
        if (this.openIds.size === 0) {
          this.emit({ type: "idle", ts: this.now() });
          // Idle again: dwell restarts from now, so a long hold doesn't cause
          // an instant hop the moment the channel closes.
          this.groupStartedAt = this.now();
        }
        break;
      case "level":
        if (typeof ev.id === "string" && typeof ev.db === "number") {
          this.emit({ type: "level", channelId: ev.id, db: ev.db, ts: this.now() });
        }
        break;
      case "closecall":
        if (typeof ev.freqHz === "number") {
          this.emit({ type: "closecall", freqHz: ev.freqHz, ts: this.now() });
        }
        break;
      case "audible": {
        this.audibleId = typeof ev.id === "string" ? ev.id : null;
        // Surface speaker ownership: the dashboard's now-playing follows
        // THIS, not "active" (any of the group's channels opening), so the
        // banner can't hop away from what is actually playing.
        const channel = this.audibleId ? this.findChannel(this.audibleId) : null;
        this.emit({ type: "audible", channel, ts: this.now() });
        break;
      }
      case "power": {
        if (!this.audibleId || !ev.levels) return;
        const db = ev.levels[this.audibleId];
        if (typeof db !== "number") return;
        const ts = this.now();
        if (ts - this.lastSignalTs >= SIGNAL_THROTTLE_MS) {
          this.lastSignalTs = ts;
          this.emit({ type: "signal", dbfs: db, ts });
        }
        break;
      }
      default:
        break; // tuned/log are informational
    }
  }

  private findChannel(id: string): Channel | null {
    // Close Call lanes aren't in any group: synthesize a channel so the
    // dashboard banner / Recent log / activity all work unchanged.
    const cc = /^cc_(\d+)$/.exec(id);
    if (cc) {
      return {
        id, freq: Number(cc[1]), alphaTag: "CLOSE CALL",
        mode: "nfm", enabled: true, priority: true,
      };
    }
    const group = this.groups[this.groupIndex];
    return group?.channels.find((c) => c.id === id) ?? null;
  }

  private sendTune(): void {
    const group = this.groups[this.groupIndex];
    if (!group || !this.child?.stdin?.writable) return;
    this.openIds.clear();
    this.audibleId = null;
    this.groupStartedAt = this.now();
    const cmd = {
      cmd: "tune",
      centerHz: group.centerHz,
      channels: group.channels.map((c) => ({
        id: c.id, freqHz: c.freq, priority: c.priority ?? false,
        levelDb: c.levelTrimDb ?? 0,
        mode: c.mode,
      })),
      monitor: this.config?.monitor ?? false,
      // Close Call: ON by default for this engine; knownHz carries EVERY
      // configured channel (enabled or not) so disabled discoveries and
      // benched channels never re-trigger detection.
      closeCall: (this.config?.closeCall ?? true) && !(this.config?.monitor ?? false),
      closeCallDb: this.config?.closeCallDb ?? 15,
      knownHz: this.config?.knownHz ?? [
        ...(this.config?.channels ?? []).map((c) => c.freq),
        ...(this.config?.lockoutHz ?? []),
      ],
    };
    this.child.stdin.write(JSON.stringify(cmd) + "\n");
  }

  private startDwellTimer(): void {
    this.clearDwellTimer();
    if (this.groups.length <= 1) return; // single group: park forever
    const dwell = this.groupDwellMs();
    this.dwellTimer = setInterval(() => {
      if (this.openIds.size > 0) {
        // Hold-through: a channel is active — never tune away from it.
        this.groupStartedAt = this.now();
        return;
      }
      if (this.now() - this.groupStartedAt >= dwell) {
        this.groupIndex = (this.groupIndex + 1) % this.groups.length;
        this.sendTune();
      }
    }, Math.max(20, Math.floor(dwell / 3)));
  }

  private clearDwellTimer(): void {
    if (this.dwellTimer) {
      clearInterval(this.dwellTimer);
      this.dwellTimer = null;
    }
  }

  private clearRestartTimer(): void {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
  }

  private killChild(): void {
    this.clearDwellTimer();
    if (this.killTimer) {
      clearTimeout(this.killTimer);
      this.killTimer = null;
    }
    if (this.childStdout) {
      try { this.childStdout.close(); } catch { /* ignore */ }
      this.childStdout = null;
    }
    if (this.childStderr) {
      try { this.childStderr.close(); } catch { /* ignore */ }
      this.childStderr = null;
    }
    if (this.child) {
      const child = this.child;
      this.child = null; // null first: its own exit hits the stale-guard
      // Ask nicely (the helper tears the flowgraph down on "quit"/EOF), then
      // make sure after a grace period.
      try { child.stdin?.write('{"cmd":"quit"}\n'); } catch { /* ignore */ }
      try { child.stdin?.end(); } catch { /* ignore */ }
      this.killTimer = setTimeout(() => {
        this.killTimer = null;
        try { child.kill("SIGKILL"); } catch { /* ignore */ }
      }, QUIT_GRACE_MS);
      this.killTimer.unref?.();
    }
  }

  private handleUnexpectedExit(exitCode: number | null = null): void {
    const reason = this.lastStderrLine;
    this.killChild();

    const isNoDevice = /failed to open|SoapySDR device|No supported devices|usb_claim_interface/i
      .test(reason);
    const code = isNoDevice ? "NO_DEVICE" : "HELPER_EXITED";
    const exited = exitCode === null ? "wideband helper exited" : `wideband helper exited (code ${exitCode})`;
    const message = reason
      ? `${exited}: ${reason}${this.autoRestart ? "; restarting" : ""}`
      : `${exited}${this.autoRestart ? "; restarting" : ""}`;

    this.emit({ type: "error", code, message, ts: this.now() });

    if (this.autoRestart) {
      this.clearRestartTimer();
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null;
        if (this.stopping) return;
        this.spawnHelper(); // retunes to the current group on its "ready"
      }, this.restartDelayMs);
    } else {
      this.setState("stopped");
    }
  }

  updateKnownHz(knownHz: number[]): void {
    // Live suppression update: the helper swaps its known set without
    // touching any chain — zero audio impact, unlike a tune or restart.
    if (this.config) this.config = { ...this.config, knownHz };
    if (this.child?.stdin?.writable) {
      this.child.stdin.write(JSON.stringify({ cmd: "known", knownHz }) + "\n");
    }
  }

  skip(holdoffSeconds?: number): void {
    // Scanner SKIP key: the helper force-closes the audible channel (a cc
    // lane parks; a regular channel gets a re-open holdoff). With a long
    // holdoff this is TEMP LOCKOUT — suppressed for the duration, cleared
    // by an engine restart (hardware-scanner semantics).
    if (this.child?.stdin?.writable) {
      const cmd = holdoffSeconds !== undefined
        ? `{"cmd":"skip","holdoffS":${Math.max(1, Math.round(holdoffSeconds))}}`
        : '{"cmd":"skip"}';
      this.child.stdin.write(cmd + "\n");
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.clearRestartTimer();
    this.killChild();
    this.openIds.clear();
    this.audibleId = null;
    this.setState("stopped");
  }

  async setVolume(percent: number): Promise<void> {
    await amixerVolume(percent);
  }
  async setMuted(muted: boolean): Promise<void> {
    await amixerMuted(muted);
  }
}
