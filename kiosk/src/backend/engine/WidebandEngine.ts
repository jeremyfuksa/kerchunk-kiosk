import { spawn, type ChildProcess } from "node:child_process";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type {
  ScannerEngine, ScanConfig, EngineState, EngineEvent, EngineListener, ScanChannel,
} from "./ScannerEngine.js";
import type { Channel } from "../config/schema.js";
import { groupChannels, sweepCenters, type ChannelGroup } from "./grouping.js";
import { computeLanePlan, lanePlanArgs } from "./lanePlan.js";
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
  /** RTL-SDR EEPROM serial (multi-SDR). Preferred over rtlIndex: SoapySDR
   *  resolves it to the exact dongle regardless of enumeration order. */
  rtlSerial?: string;
  /** Front-end sample rate (Hz). Omitted = the helper's wideband default. A
   *  narrow rate (e.g. 240 kHz) makes a single-channel radio cheap — the
   *  2.4 MHz front-end is the dominant cost. Must be a multiple of 48 kHz. */
  sampleRateHz?: number;
  /** Shift the window center this many Hz off the group center so a lone
   *  channel doesn't sit on the RTL DC spike (the channel filter then scrubs
   *  the spike). Needed for a dedicated single-channel radio at a narrow rate. */
  centerOffsetHz?: number;
  /** Spawn the helper at this `nice` value (CPU scheduling priority). The
   *  weather radio (decode-only, latency-tolerant) runs LOW priority so its
   *  ~300 GR threads can't steal scheduling from the scanner's real-time audio
   *  thread — equal priority caused choppy scanner audio. New threads inherit
   *  the process nice at creation, so this covers the whole flowgraph. */
  niceness?: number;
  /** Resolve the librtlsdr device index at spawn time (multi-SDR fallback when
   *  no serial: devnums change on every replug, so this runs fresh per spawn).
   *  null = first. Ignored when rtlSerial is set. */
  rtlIndex?: () => number | null;
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
// A helper alive this long is considered healthy; its eventual death starts
// a fresh failure-escalation window instead of compounding an old one.
const HEALTHY_AFTER_MS = 10_000;

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
  raw?: string;
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
  private groups: Array<ChannelGroup<ScanChannel>> = [];
  private sweeps: number[] = [];
  private audioListeners = new Set<(chunk: Buffer) => void>();
  private sweepIndex = 0;
  private sweeping = false;
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

  // Warm-up milestones (drive the kiosk "WARMING UP" overlay). One-shot per
  // start(): "ready" fires once the first tuned window has settled, since the
  // scanner only ever detects on the window it is currently parked on (a full
  // 13-group sweep would take ~20-30s — that's coverage, not warm-up).
  private firstTunedSeen = false;
  private warmReadySeen = false;
  private warmupReadyTimer: NodeJS.Timeout | null = null;

  private stopping = false;
  // Exit-failure escalation: ONE failed spawn is expected during rapid
  // reconfiguration (bank toggles = overlapping stop/start; the dying helper
  // can still hold the SDR for up to the grace period). The first failure is
  // a soft restart; repetition is a real error.
  private exitFailures = 0;
  private lastSpawnAt = 0;

  private readonly rtlIndexResolver: (() => number | null) | undefined;
  private readonly rtlSerial: string | undefined;
  private readonly sampleRateHz: number | undefined;
  private readonly centerOffsetHz: number;
  private readonly niceness: number | undefined;

  constructor(opts: WidebandEngineOptions = {}) {
    this.rtlIndexResolver = opts.rtlIndex;
    this.rtlSerial = opts.rtlSerial;
    this.sampleRateHz = opts.sampleRateHz;
    this.centerOffsetHz = opts.centerOffsetHz ?? 0;
    this.niceness = opts.niceness;
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
  /** The DSP helper's pid (system-health diagnostics). */
  get helperPid(): number | null { return this.child?.pid ?? null; }

  on(l: EngineListener): void { this.listeners.add(l); }
  off(l: EngineListener): void { this.listeners.delete(l); }

  private emit(ev: EngineEvent): void { for (const l of this.listeners) l(ev); }

  private setState(state: EngineState): void {
    this._state = state;
    this.emit({ type: "status", state, ts: this.now() });
  }

  private emitWarmup(phase: "booting" | "spawning" | "tuned" | "ready", step: number): void {
    this.emit({ type: "warmup", phase, step, of: 4, ts: this.now() });
  }

  /** First real tune after a fresh start: graph is up and the helper is acked. */
  private markFirstTune(): void {
    if (this.firstTunedSeen) return;
    this.firstTunedSeen = true;
    this.emitWarmup("tuned", 3);
    // Detection is trustworthy for the live window once its lanes settle (~the
    // floor EMA time constant). The scanner only detects on the CURRENT window,
    // so the settled window — not a full multi-group sweep (~20-30s on a
    // many-group config) — is the right "ready" gate.
    this.clearWarmupReadyTimer();
    this.warmupReadyTimer = setTimeout(() => {
      this.warmupReadyTimer = null;
      this.markWarmReady();
    }, 1500);
    this.warmupReadyTimer.unref?.();
  }

  /** The first tuned window has settled — detection on the live window is trusted. */
  private markWarmReady(): void {
    if (this.warmReadySeen) return;
    this.warmReadySeen = true;
    this.emitWarmup("ready", 4);
  }

  private clearWarmupReadyTimer(): void {
    if (this.warmupReadyTimer) {
      clearTimeout(this.warmupReadyTimer);
      this.warmupReadyTimer = null;
    }
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
    // Band-sweep stops: empty windows Close Call hunts in, one per rotation.
    this.sweeps = sweepCenters(
      config.sweepRanges ?? [],
      config.windowBandwidthHz ?? DEFAULT_WINDOW_HZ,
      this.groups,
    );
    this.sweepIndex = 0;
    this.sweeping = false;
    this.stopping = false;
    // Reset warm-up per fresh start so a config-edit restart re-runs the
    // overlay sequence: booting → spawning → tuned → ready.
    this.firstTunedSeen = false;
    this.warmReadySeen = false;
    this.clearWarmupReadyTimer();

    this.setState("starting");
    this.emitWarmup("booting", 1);

    if (this.groups.length === 0) {
      // Nothing to scan; running with no helper (parity with RtlFmEngine).
      this.setState("running");
      this.markWarmReady(); // no DSP to warm — ready at once
      return;
    }

    this.setState("running");
    this.emitWarmup("spawning", 2);
    this.spawnHelper();
  }

  /**
   * Re-point the LIVE flowgraph at a new config — a hop, not a restart. Used
   * for mode switches (weather break-in ⇄ scan) so the operator never sees the
   * warm-up overlay or hears the 300-thread cold-start chop. The helper's
   * `tune` command re-centers the SDR and re-assigns the existing lanes; no
   * respawn, no `booting`/`warmup` events (markFirstTune/markWarmReady already
   * latched). If the helper isn't live (stopped, or never spawned), there is no
   * graph to re-point — fall back to a full start.
   */
  async retune(config: ScanConfig): Promise<void> {
    if (this._state !== "running" || !this.child?.stdin?.writable) {
      return this.start(config);
    }
    this.config = config;
    this.groups = groupChannels(
      config.channels,
      config.windowBandwidthHz ?? DEFAULT_WINDOW_HZ,
      MAX_CHANNELS_PER_GROUP,
    );
    this.groupIndex = 0;
    this.sweeps = sweepCenters(
      config.sweepRanges ?? [],
      config.windowBandwidthHz ?? DEFAULT_WINDOW_HZ,
      this.groups,
    );
    this.sweepIndex = 0;
    this.sweeping = false;
    if (this.groups.length === 0) {
      // Nothing to tune (config with no channels): hold the graph quiet rather
      // than hop a phantom group.
      this.clearDwellTimer();
      return;
    }
    this.sendTune();         // re-point now (emits "tuned", not "booting")
    this.startDwellTimer();  // re-arm the hop cadence (single group ⇒ parks)
  }

  private helperArgs(): string[] {
    const cfg = this.config!;
    const args = [
      "--sink", cfg.audioSink,
      "--hang-ms", String(cfg.dwellMs),
      // Prefer serial (deterministic); fall back to index resolved at spawn.
      ...(this.rtlSerial
        ? ["--rtl-serial", this.rtlSerial]
        : this.rtlIndexResolver
          ? (() => { const i = this.rtlIndexResolver!(); return i === null ? [] : ["--rtl-index", String(i)]; })()
          : []),
      "--open-db", String(cfg.openAboveFloorDb ?? 9),
    ];
    // Narrow front-end for a single-channel radio (weather): 10x cheaper than
    // the 2.4 MHz wideband default — the front-end dominates the helper's cost.
    if (this.sampleRateHz !== undefined) args.push("--rate", String(this.sampleRateHz));
    if (cfg.detectVia !== undefined) args.push("--detect-via", cfg.detectVia);
    // Close Call FFT: built on unless explicitly disabled (matches the per-tune
    // `closeCall ?? true`). Off => the helper skips the 2048-pt FFT entirely.
    // A closeCall config change respawns the helper, so this stays in sync.
    if (cfg.closeCall !== false) args.push("--close-call");
    // Remote-listening PCM tee: only ask the helper to build it when the
    // feature is on. Off => the helper's --audio-fd default (-1) builds no tee,
    // skipping the continuous float->s16 + fd-write. A change respawns the
    // helper (toScanConfig diff), so the tee appears/disappears in lockstep.
    if (cfg.remoteListening) args.push("--audio-fd", "3");
    if (cfg.gain !== "auto") args.push("--gain", String(cfg.gain));
    // Quieting squelch threshold: only passed when configured — the helper's
    // default is bench-calibrated for this hardware.
    if (cfg.noiseQuietDb !== undefined) args.push("--quiet-db", String(cfg.noiseQuietDb));
    // Lane-fit (spec 2026-06-09): size the helper's channelizer to this config
    // — N = busiest group's channel count (<= MAX), each lane built with only
    // the demod path it needs. `this.groups` is set before every spawn (start/
    // reconfigure); an empty config yields a safe 1-lane plan. The weather
    // engine rides the same path: its lone NWR channel collapses to one lane.
    const plan = computeLanePlan(this.groups, MAX_CHANNELS_PER_GROUP);
    args.push(...lanePlanArgs(plan));
    return args;
  }

  private spawnHelper(): void {
    if (!this.config) return;

    this.lastSpawnAt = this.now();
    const base = [...this.helperCmd, ...this.helperArgs()];
    // Low-priority spawn (weather radio): `nice` execs the helper so all of its
    // GR threads inherit the nice value from birth. Lowering own priority needs
    // no privilege.
    const argv = this.niceness !== undefined
      ? ["nice", "-n", String(this.niceness), ...base]
      : base;
    const child = spawn(argv[0]!, argv.slice(1), {
      // fd 3: the helper tees the speaker feed (s16 PCM) for remote
      // listening. The engine ALWAYS drains it — an unread pipe would
      // stall the GR audio thread.
      stdio: ["pipe", "pipe", "pipe", "pipe"],
      env: { ...process.env, ...this.helperEnv },
    });
    child.stdio[3]?.on("data", (chunk: Buffer) => {
      if (this.child !== child) return;
      for (const l of this.audioListeners) l(chunk);
    });
    child.stdio[3]?.on("error", () => { /* tee is best-effort */ });
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
    // Escalation resets on PROVEN health (alive for a while), not on mere
    // startup — a crash-looping helper also says "ready" before each death.
    if (this.exitFailures > 0 && this.now() - this.lastSpawnAt > HEALTHY_AFTER_MS) {
      this.exitFailures = 0;
    }
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
        this.emit({ type: "release", channelId: ev.id, ts: this.now() });
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
      case "rf":
        if (typeof ev.id === "string" && typeof ev.db === "number") {
          this.emit({ type: "rf", channelId: ev.id, db: ev.db, ts: this.now() });
        }
        break;
      case "same":
        if (typeof ev.raw === "string") {
          this.emit({ type: "same", raw: ev.raw, ts: this.now() });
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

  private sendSweepTune(centerHz: number): void {
    if (!this.child?.stdin?.writable) return;
    this.openIds.clear();
    this.audibleId = null;
    this.groupStartedAt = this.now();
    this.child.stdin.write(JSON.stringify({
      cmd: "tune", centerHz, channels: [],
      monitor: false, closeCall: true,
      closeCallDb: this.config?.closeCallDb ?? 15,
      knownHz: this.config?.knownHz ?? [],
    }) + "\n");
    this.emit({ type: "tuned", freqHz: centerHz, channelIds: [], ts: this.now() });
  }

  private sendTune(): void {
    const group = this.groups[this.groupIndex];
    if (!group || !this.child?.stdin?.writable) return;
    this.openIds.clear();
    this.audibleId = null;
    this.groupStartedAt = this.now();
    const cmd = {
      cmd: "tune",
      // Offset the RTL tune off the cluster center so a lone channel isn't on
      // the DC spike (the helper derives each lane's baseband offset from this).
      // The "tuned" event below still reports the logical center for the UI.
      centerHz: group.centerHz + this.centerOffsetHz,
      channels: group.channels.map((c) => ({
        id: c.id, freqHz: c.freq, priority: c.priority ?? false,
        levelDb: c.levelTrimDb ?? 0,
        mode: c.mode,
        audible: c.audible !== false,
        ...(c.background ? { background: true } : {}),
        // Per-channel squelch profile (ROADMAP Idea 7) — omitted = the
        // helper's global defaults. Resolved from banks by the server.
        ...(c.openAboveFloorDb !== undefined ? { openDb: c.openAboveFloorDb } : {}),
        ...(c.noiseQuietDb !== undefined ? { quietDb: c.noiseQuietDb } : {}),
        ...(c.hangMs !== undefined ? { hangMs: c.hangMs } : {}),
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
    // Tell the UIs where the radio is parked (bank indicator).
    this.emit({
      type: "tuned", freqHz: group.centerHz,
      channelIds: group.channels.map((c) => c.id), ts: this.now(),
    });
    this.markFirstTune();
  }

  private startDwellTimer(): void {
    this.clearDwellTimer();
    if (this.groups.length <= 1 && this.sweeps.length === 0) return; // single group: park forever
    const dwell = this.groupDwellMs();
    this.dwellTimer = setInterval(() => {
      if (this.openIds.size > 0) {
        // Hold-through: a channel is active — never tune away from it.
        this.groupStartedAt = this.now();
        return;
      }
      // Weighted dwell (ROADMAP Idea 7): a window's park time scales by
      // the max dwellWeight among its channels — the busiest bank in a
      // mixed window dominates. Default weight 1 = the global dwell.
      const group = this.groups[this.groupIndex];
      const weight = group
        ? Math.max(...group.channels.map((c) => c.dwellWeight ?? 1))
        : 1;
      if (this.sweeping) {
        // A sweep stop lasts one plain dwell, then the rotation resumes.
        if (this.now() - this.groupStartedAt >= dwell) {
          this.sweeping = false;
          this.groupIndex = 0;
          this.sendTune();
        }
        return;
      }
      if (this.now() - this.groupStartedAt >= dwell * weight) {
        const wrapped = this.groupIndex === this.groups.length - 1;
        if (wrapped && this.sweeps.length > 0) {
          // Full pass done: spend one stop hunting in the sweep ranges.
          this.sweeping = true;
          this.sendSweepTune(this.sweeps[this.sweepIndex % this.sweeps.length]!);
          this.sweepIndex++;
          return;
        }
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
    // Cancel any pending warm-up settle timer: without this it would survive a
    // crash and fire a false "ready" (clearing the overlay + marking warmed)
    // while no helper is live. A successful respawn re-arms a real one.
    this.clearWarmupReadyTimer();
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
      // make sure after a grace period. The timer is PER CHILD on purpose:
      // a shared class slot let an overlapping teardown (rapid bank toggles
      // = stop/start cycles) CANCEL the previous helper's pending SIGKILL —
      // a helper wedged in GNU Radio teardown then held the SDR forever and
      // every respawn errored on-screen until timing luck freed it
      // (operator-replicated).
      try { child.stdin?.write('{"cmd":"quit"}\n'); } catch { /* ignore */ }
      try { child.stdin?.end(); } catch { /* ignore */ }
      const graceKill = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* ignore */ }
      }, QUIT_GRACE_MS);
      graceKill.unref?.();
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

    this.exitFailures += 1;
    if (this.autoRestart && this.exitFailures === 1) {
      // Soft path: expected during reconfiguration. The dashboard renders
      // state "starting" as "retuning…" instead of a red error.
      this.emit({ type: "status", state: "starting", ts: this.now() });
    } else {
      this.emit({ type: "error", code, message, ts: this.now() });
    }

    if (this.autoRestart) {
      // Let the respawned helper re-run the warm-up gate: its first real tune
      // re-arms a genuine settle. (warmReadySeen is left as-is — if we were
      // already warm, the overlay stays cleared; if we crashed mid-warm it is
      // still false, so the respawn emits a real "ready" once it settles.)
      this.firstTunedSeen = false;
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

  /** Subscribe to the live speaker feed (48 kHz mono s16le). Returns an
   *  unsubscribe. Used by the /stream.wav route for remote listening. */
  onAudio(listener: (chunk: Buffer) => void): () => void {
    this.audioListeners.add(listener);
    return () => this.audioListeners.delete(listener);
  }

  alertUnmute(channelId: string, holdSeconds: number): void {
    // Alert pull-in (ROADMAP Idea 6): the helper opens the chain's audio for
    // the hold. If the channel's window isn't tuned right now the command
    // finds no chain and is a no-op — the kiosk banner still fires; only the
    // audio break-in is best-effort (same coverage truth as detection).
    if (this.child?.stdin?.writable) {
      this.child.stdin.write(JSON.stringify(
        { cmd: "alert_unmute", id: channelId, holdS: Math.max(1, holdSeconds) }) + "\n");
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
    this.clearWarmupReadyTimer();
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
