import { spawn, type ChildProcess } from "node:child_process";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type {
  ScannerEngine, ScanConfig, EngineState, EngineEvent, EngineListener, ScanChannel,
  SpeakerAgcConfig,
} from "./ScannerEngine.js";
import {
  type Channel, DEFAULT_LANES_PER_GROUP, DEFAULT_SAMPLE_RATE_HZ, DEFAULT_WINDOW_BANDWIDTH_HZ, DEFAULT_FLAT_BANDWIDTH_HZ,
} from "../config/schema.js";
import { groupChannels, sweepCenters, type ChannelGroup, type GroupingOptions } from "./grouping.js";
import { setVolume as amixerVolume, setMuted as amixerMuted } from "../audio.js";
import { TxStatsLog } from "./txStats.js";
import {
  ActivityTracker, dwellFactor, resolveAutoDwell, scaledDwellMs, type AutoDwellConfig,
  nextRevisitTarget, resolvePriorityRevisit, type PriorityRevisitConfig,
} from "./scanSchedule.js";

/** config.audio speaker-loudness knob -> kerchunk-dsp flag (AGC + limiter). */
export const SPEAKER_AGC_FLAGS: ReadonlyArray<readonly [keyof SpeakerAgcConfig, string]> = [
  ["agcTargetDb", "--agc-target-db"],
  ["agcMaxGainDb", "--agc-max-gain-db"],
  ["agcMinGainDb", "--agc-min-gain-db"],
  ["agcAttackMs", "--agc-attack-ms"],
  ["agcReleaseMs", "--agc-release-ms"],
  ["agcHoldBelowDb", "--agc-hold-below-db"],
  ["limiterCeiling", "--limiter-ceiling"],
  ["limiterReleaseMs", "--limiter-release-ms"],
];

// Wideband group-hop scanner.
//
// ONE persistent native DSP helper (kerchunk-dsp, C++, kiosk/native/) owns the
// SDR for the engine's whole lifetime. It samples a ~2.4 MHz I/Q window
// (config.scan.sampleRateHz), runs a channelizer with config.scan.lanesPerGroup
// slots (default 12) that demodulates every channel in the window
// simultaneously, does squelch detection against an
// adaptive noise floor, picks the audible channel (first-active-wins), and
// plays audio straight to ALSA. Node owns grouping + group-hop timing and
// talks line-JSON over the helper's stdin/stdout. Hopping = writing a "tune"
// line — the device is NEVER re-opened (the fix for the rtl_fm USB-thrash
// class of failures; see bench/RESULTS-2026-06-04-wideband-spike.md).

export interface WidebandEngineOptions {
  /** Helper argv override (tests point this at a fake). Default: the
   *  kerchunk-dsp binary next to this file in dist/. */
  helperCmd?: string[];
  /** Extra env for the helper (tests drive fake scenarios through this). */
  helperEnv?: Record<string, string>;
  /** RTL-SDR EEPROM serial (multi-SDR). Preferred over rtlIndex: the helper
   *  resolves it to the exact dongle regardless of enumeration order. */
  rtlSerial?: string;
  /** Front-end sample rate (Hz). Overrides config.sampleRateHz (the scanner's
   *  knob). A narrow rate (e.g. 250 kHz) makes a single-channel radio cheap —
   *  the front-end is the dominant cost. Must be a multiple of 50 kHz. */
  sampleRateHz?: number;
  /** Fixed helper lane-slot count. Overrides config.lanesPerGroup (the
   *  scanner's knob) — the weather radio pins its own small count. */
  lanes?: number;
  /** Shift the window center this many Hz off the group center so a lone
   *  channel doesn't sit on the RTL DC spike (the channel filter then scrubs
   *  the spike). Needed for a dedicated single-channel radio at a narrow rate. */
  centerOffsetHz?: number;
  /** Spawn the helper at this `nice` value (CPU scheduling priority). The
   *  weather radio (decode-only, latency-tolerant) runs LOW priority so it
   *  keeps the scanner's real-time audio thread first — equal priority caused
   *  choppy scanner audio. New threads inherit the process nice at creation,
   *  so this covers every helper thread. */
  niceness?: number;
  /** Resolve the librtlsdr device index at spawn time (multi-SDR fallback when
   *  no serial: devnums change on every replug, so this runs fresh per spawn).
   *  null = first. Ignored when rtlSerial is set. */
  rtlIndex?: () => number | null;
  autoRestart?: boolean;
  /** Delay before the FIRST respawn after an unexpected exit. Each consecutive
   *  failure doubles it, up to maxRestartDelayMs. */
  restartDelayMs?: number;
  /** Ceiling on the respawn backoff (default 30 s). A helper that can't open
   *  its device must not respawn at a fixed 1 Hz — the weather SDR being absent
   *  at boot once did exactly that for 2.5 minutes of pointless device churn on
   *  a box that runs close to its thermal trip. Capped rather than given up on:
   *  an SDR the operator replugs later has to be picked up without a service
   *  restart. */
  maxRestartDelayMs?: number;
  /** Per-group dwell override; otherwise config.groupDwellMs, else 3000. */
  groupDwellMs?: number;
  /** Max continuous hold-through before the sweep force-hops off a window even
   *  while a lane reads open. Bounds the "stuck-open lane" failure: a dropped
   *  helper "close" leaves an id in openIds forever, and unbounded hold-through
   *  then parks the scanner on that one window until a reboot (the 28h airband
   *  wedge). Default 3 min — far longer than any real transmission, short enough
   *  to self-heal. */
  maxHoldMs?: number;
  /** Diagnostic sink for rare operational notices (e.g. a forced hop off a
   *  stuck lane). Injected so tests can assert without console noise; defaults
   *  to console.warn so the breadcrumb lands in the journal on the appliance. */
  log?: (msg: string) => void;
  now?: () => number;
  /** Treat the helper as dead if it hasn't said "ready" this long
   *  after spawn (device/ALSA wedged before ready). Default 10 s. */
  readyTimeoutMs?: number;
  /** Treat the helper as dead if it prints nothing for this long
   *  after "ready" (it emits power every 200 ms once tuned). Default 5 s. */
  silenceTimeoutMs?: number;
  /** Squelch-calibration log: append each helper `txstat` event (one carrier
   *  episode) as a JSON line here, rotating to `<path>.1` past 20 MB. Unset =
   *  txstat events are ignored. The scanner engine only (index.ts). Never
   *  forwarded as an EngineEvent / over WS. */
  txStatsPath?: string;
}

// Defaults when config omits scan.windowBandwidthHz / lanesPerGroup /
// sampleRateHz (config/schema.ts). The lane count is passed to kerchunk-dsp as
// --lanes, and grouping splits oversized clusters at the same count so the
// helper never truncates.
const DEFAULT_WINDOW_HZ = DEFAULT_WINDOW_BANDWIDTH_HZ;
const DEFAULT_GROUP_DWELL_MS = 3000;
// Hop-timer tick ceiling while activity-weighted dwell or priority revisit is
// on: scaled dwells and 700 ms priority looks
// aren't multiples of dwell/3, so the old dwell/3 tick (1 s at the 3 s
// default) would round a 1.5 s dwell up to 2 s. A 100 ms no-op tick is free.
const SCHED_TICK_MS = 100;
// Signal events drive the dashboard meter; the helper's power telemetry
// arrives ~5 Hz, pass it through at up to 4 Hz for a live-feeling needle.
const SIGNAL_THROTTLE_MS = 250;
const QUIT_GRACE_MS = 500;
// A helper alive this long is considered healthy; its eventual death starts
// a fresh failure-escalation window instead of compounding an old one.
const HEALTHY_AFTER_MS = 10_000;
// Helper log forwarding: at most HELPER_LOG_BURST lines per window, so a
// flapping condition can't flood the journal; the overflow is summarized.
const HELPER_LOG_BURST = 10;
const HELPER_LOG_WINDOW_MS = 60_000;
// Keep <= HEALTHY_AFTER_MS: handleHelperEvent resets exitFailures once the
// spawn is older than HEALTHY_AFTER_MS, on ANY event (ready included). A ready
// timeout longer than that window would let a helper that's merely slow (not
// wedged) get treated as freshly healthy right as its own watchdog is about
// to fire, defeating the backoff escalation on repeat failures.
const DEFAULT_READY_TIMEOUT_MS = 10_000;
const DEFAULT_SILENCE_TIMEOUT_MS = 5_000;

// The helper (kerchunk-dsp) is a standalone binary built by build:native:dist
// and copied next to this file in dist/.
function defaultHelperCmd(): string[] {
  return [fileURLToPath(new URL("./kerchunk-dsp", import.meta.url))];
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
  ctcssHz?: number;
  dcs?: string;
}

// Fields of a helper txstat event copied verbatim into the JSONL record.
const TXSTAT_FIELDS = [
  "mode", "opened", "polls", "quietP10", "quietP50", "quietP90", "aboveFloorP50",
] as const;

export class WidebandEngine implements ScannerEngine {
  private readonly helperCmd: string[];
  private readonly helperEnv: Record<string, string>;
  private readonly autoRestart: boolean;
  private readonly restartDelayMs: number;
  private readonly maxRestartDelayMs: number;
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
  // When the current continuous hold-through began (0 = not holding). Distinct
  // from groupStartedAt, which the hold path re-arms every tick; this one is
  // NOT re-armed, so it measures true continuous hold against the max-hold cap.
  private holdStartedAt = 0;
  private dwellTimer: NodeJS.Timeout | null = null;
  // Activity-weighted dwell (config.scan.autoDwell): decayed open counts per
  // group, keyed by the group's center so it survives a same-shape retune.
  private readonly activity = new ActivityTracker();
  // Priority revisit (config.scan.priorityRevisit). While `revisit` is set the
  // radio is peeking at a priority channel's group; returnIndex/elapsedMs say
  // where to go back to and how much of that group's dwell was already spent.
  // revisitCreditMs accrues quiet non-priority dwell toward the next peek.
  private revisit: { returnIndex: number; elapsedMs: number } | null = null;
  private revisitCreditMs = 0;
  private revisitCursor = 0;
  private lastTickAt = 0;
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
  private readonly lanesOverride: number | undefined;
  // Lane count + rate the LIVE helper was spawned with: a retune whose config
  // needs different ones must respawn (both are spawn-time helper args).
  private spawnedShape: { lanes: number; rate: number } | null = null;
  private readonly centerOffsetHz: number;
  private readonly niceness: number | undefined;
  private readonly maxHoldMs: number;
  private readonly log: (msg: string) => void;
  private readonly readyTimeoutMs: number;
  private readonly silenceTimeoutMs: number;
  private logWindowStart = 0;
  private logCount = 0;
  private logSuppressed = 0;
  private readyTimer: NodeJS.Timeout | null = null;
  private silenceTimer: NodeJS.Timeout | null = null;
  private readonly txStats: TxStatsLog | null;

  constructor(opts: WidebandEngineOptions = {}) {
    this.rtlIndexResolver = opts.rtlIndex;
    this.rtlSerial = opts.rtlSerial;
    this.sampleRateHz = opts.sampleRateHz;
    this.lanesOverride = opts.lanes;
    this.centerOffsetHz = opts.centerOffsetHz ?? 0;
    this.niceness = opts.niceness;
    this.readyTimeoutMs = opts.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
    this.silenceTimeoutMs = opts.silenceTimeoutMs ?? DEFAULT_SILENCE_TIMEOUT_MS;
    this.helperCmd = opts.helperCmd ?? defaultHelperCmd();
    this.helperEnv = opts.helperEnv ?? {};
    this.autoRestart = opts.autoRestart ?? true;
    // The thrash lesson: the DEFAULT restart delay must be >=1s. Tests may
    // pass a smaller explicit value (honored, like RtlFmEngine.hopIntervalMs).
    this.restartDelayMs = opts.restartDelayMs ?? 1000;
    this.maxRestartDelayMs = opts.maxRestartDelayMs ?? 30_000;
    this.groupDwellOverride = opts.groupDwellMs;
    this.maxHoldMs = opts.maxHoldMs ?? 180_000;
    this.log = opts.log ?? ((m) => console.warn(m));
    this.now = opts.now ?? Date.now;
    this.txStats = opts.txStatsPath
      ? new TxStatsLog(opts.txStatsPath, { log: this.log, now: this.now })
      : null;
  }

  /** Resolves once every txstat line so far has been written (tests). */
  flushTxStats(): Promise<void> { return this.txStats?.flush() ?? Promise.resolve(); }

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

  private lanesFor(config: ScanConfig): number {
    return this.lanesOverride ?? config.lanesPerGroup ?? DEFAULT_LANES_PER_GROUP;
  }

  private rateFor(config: ScanConfig): number {
    return this.sampleRateHz ?? config.sampleRateHz ?? DEFAULT_SAMPLE_RATE_HZ;
  }

  private groupDwellMs(): number {
    return this.groupDwellOverride ?? this.config?.groupDwellMs ?? DEFAULT_GROUP_DWELL_MS;
  }

  private autoDwell(): Required<AutoDwellConfig> {
    return resolveAutoDwell(this.config?.autoDwell);
  }

  private static groupKey(group: ChannelGroup<ScanChannel>): string {
    return String(group.centerHz);
  }

  /**
   * How long the rotation parks on a quiet group before hopping. BASE =
   * groupDwellMs x the max bank dwellWeight among its channels (ROADMAP Idea
   * 7: the busiest bank in a mixed window dominates; default weight 1). With
   * autoDwell on, the base is then scaled by the group's recent activity
   * (scanSchedule.dwellFactor) and floored at MIN_AUTO_DWELL_MS. Hold-through
   * and the maxHoldMs cap are separate: this governs quiet windows only.
   */
  private effectiveDwellMs(index: number): number {
    const group = this.groups[index];
    if (!group) return this.groupDwellMs();
    const weight = Math.max(...group.channels.map((c) => c.dwellWeight ?? 1));
    const base = this.groupDwellMs() * weight;
    const auto = this.autoDwell();
    if (!auto.enabled || this.groups.length <= 1) return base;
    const halfLifeMs = auto.halfLifeMin * 60_000;
    const now = this.now();
    const values = this.groups.map((g) => this.activity.value(WidebandEngine.groupKey(g), now, halfLifeMs));
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const factor = dwellFactor(values[index] ?? 0, mean, auto.minFactor, auto.maxFactor);
    return scaledDwellMs(base, factor);
  }

  /** Effective quiet-window dwell per group right now, in rotation order
   *  (diagnostics + tests). */
  groupDwellPlan(): number[] {
    return this.groups.map((_, i) => this.effectiveDwellMs(i));
  }

  /** Live scheduling update (config.scan.autoDwell / priorityRevisit):
   *  Node-side only, so no tune, no respawn — the next tick simply uses the
   *  new numbers (a look already in progress finishes normally). */
  updateScheduling(s: { autoDwell?: AutoDwellConfig; priorityRevisit?: PriorityRevisitConfig }): void {
    if (!this.config) return;
    this.config = { ...this.config, autoDwell: s.autoDwell, priorityRevisit: s.priorityRevisit };
    // Re-arm only a live timer (the tick rate depends on autoDwell.enabled);
    // groupStartedAt is untouched, so the current dwell just continues.
    if (this.dwellTimer) this.startDwellTimer();
  }

  // Credit one transmission to the group being dwelt on. Only a NEW open of
  // an audible, configured channel of the current group counts: Close Call
  // lanes and background decoder feeds aren't the group's traffic, a muted
  // carrier would inflate it, and sweep stops aren't groups.
  private recordActivity(id: string): void {
    // A priority look is not the group's own turn: revisits don't count.
    if (this.sweeping || this.revisit || this.openIds.has(id)) return;
    const group = this.groups[this.groupIndex];
    const channel = group?.channels.find((c) => c.id === id);
    if (!group || !channel || channel.audible === false || channel.background) return;
    this.activity.record(WidebandEngine.groupKey(group), this.now(), this.autoDwell().halfLifeMin * 60_000);
  }

  async start(config: ScanConfig): Promise<void> {
    if (this._state !== "stopped") {
      await this.stop();
    }

    this.config = config;
    this.groups = groupChannels(
      config.channels,
      config.windowBandwidthHz ?? DEFAULT_WINDOW_HZ,
      this.lanesFor(config),
      this.groupingOpts(config),
    );
    this.groupIndex = 0;
    this.resetRevisit();
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
   * Re-point the LIVE helper at a new config — a hop, not a restart. Used
   * for mode switches (weather break-in ⇄ scan) and channel edits so the
   * operator never sees the warm-up overlay or hears a cold-start chop. The
   * helper's `tune` command re-centers the SDR and re-assigns the EXISTING
   * lanes; no respawn, no `booting`/`warmup` events.
   *
   * kerchunk-dsp's lane slots (--lanes) are built at spawn and fit any group
   * the grouping makes, so ANY topology change (more channels, an AM lane, …)
   * just re-points. Respawns: an emptied channel set (the helper must be torn
   * down to release the SDR, not left hot on a deleted window), and a config
   * whose lane count or sample rate differs from the live helper's (both are
   * spawn-time args). If the helper isn't live there is nothing to re-point —
   * also a full start.
   */
  // Edge-aware placement (grouping.ts): keep channels in the flat passband and
  // off the DC spike. An engine with a fixed center offset (the weather radio,
  // parked 60 kHz off NWR) already dodges DC, so it skips the DC shift.
  private groupingOpts(config: ScanConfig): GroupingOptions {
    return {
      flatHz: config.flatBandwidthHz ?? DEFAULT_FLAT_BANDWIDTH_HZ,
      ...(this.centerOffsetHz !== 0 ? { dcClearHz: 0 } : {}),
    };
  }

  async retune(config: ScanConfig): Promise<void> {
    if (this._state !== "running" || !this.child?.stdin?.writable) {
      return this.start(config);
    }
    const shape = this.spawnedShape;
    if (!shape || shape.lanes !== this.lanesFor(config) || shape.rate !== this.rateFor(config)) {
      return this.start(config);
    }
    const newGroups = groupChannels(
      config.channels,
      config.windowBandwidthHz ?? DEFAULT_WINDOW_HZ,
      this.lanesFor(config),
      this.groupingOpts(config),
    );
    // Slots fit every group: only an emptied channel set (release the SDR)
    // takes the full start() path.
    if (newGroups.length === 0) return this.start(config);
    this.config = config;
    this.groups = newGroups;
    this.groupIndex = 0;
    this.sweeps = sweepCenters(
      config.sweepRanges ?? [],
      config.windowBandwidthHz ?? DEFAULT_WINDOW_HZ,
      this.groups,
    );
    this.sweepIndex = 0;
    this.sweeping = false;
    this.resetRevisit();
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
    // Front-end rate + lane slots, always explicit. The weather radio pins a
    // narrow rate (10x cheaper — the front-end dominates the helper's cost)
    // and 2 lanes; the scanner takes config.scan.sampleRateHz / lanesPerGroup.
    args.push("--rate", String(this.rateFor(cfg)), "--lanes", String(this.lanesFor(cfg)));
    // Close Call FFT: built on unless explicitly disabled (matches the per-tune
    // `closeCall ?? true`). Off => the helper skips the 2048-pt FFT entirely.
    // A closeCall config change respawns the helper, so this stays in sync.
    if (cfg.closeCall !== false) args.push("--close-call");
    // PCM tee: only ask the helper to build it when a consumer wants it.
    // Off => the helper's --audio-fd default (-1) builds no tee, skipping the
    // continuous float->s16 + fd-write. A change respawns the helper
    // (toScanConfig diff), so the tee appears/disappears in lockstep.
    // Either consumer wants the tee: remote listening drains it live over
    // /api/stream.wav, Close Call recording drains it into clips. One tee
    // serves both — the helper has no notion of who is listening.
    if (cfg.remoteListening || cfg.recordCloseCalls) args.push("--audio-fd", "3");
    // SAME decoder: spawn it only on a helper that carries NWR (derived in
    // toScanConfig; set true on the dedicated weather engine). Off => no
    // multimon-ng process and no last-lane tap.
    if (cfg.sameEnable) args.push("--same-enable");
    if (cfg.gain !== "auto") args.push("--gain", String(cfg.gain));
    // Quieting squelch threshold on kerchunk-dsp's own dB scale (default -6).
    if (cfg.nativeQuietDb !== undefined) args.push("--quiet-db", String(cfg.nativeQuietDb));
    // AM vs FM loudness balance (airband ran hot vs FM, 2026-09-26).
    if (cfg.nativeAmGainDb !== undefined) args.push("--am-gain-db", String(cfg.nativeAmGainDb));
    // FM speaker audio low-pass (weak-signal hiss vs voice brightness).
    if (cfg.fmAudioLpfHz !== undefined) args.push("--audio-lpf-hz", String(cfg.fmAudioLpfHz));
    // FM speaker high-pass (CTCSS hum), 0 = off.
    if (cfg.fmAudioHpfHz !== undefined) args.push("--audio-hpf-hz", String(cfg.fmAudioHpfHz));
    // Speaker AGC + limiter (config.audio). Omitted knobs = the helper's defaults.
    const agc = cfg.speakerAgc;
    if (agc) {
      for (const [key, flag] of SPEAKER_AGC_FLAGS) {
        const v = agc[key];
        if (v !== undefined) args.push(flag, String(v));
      }
    }
    return args;
  }

  private spawnHelper(): void {
    if (!this.config) return;

    this.clearWatchdogs(); // cheap insurance: no stale timer from a prior child
    this.lastSpawnAt = this.now();
    this.spawnedShape = { lanes: this.lanesFor(this.config), rate: this.rateFor(this.config) };
    const base = [...this.helperCmd, ...this.helperArgs()];
    // Low-priority spawn (weather radio): `nice` execs the helper so all of its
    // threads inherit the nice value from birth. Lowering own priority needs
    // no privilege.
    const argv = this.niceness !== undefined
      ? ["nice", "-n", String(this.niceness), ...base]
      : base;
    const child = spawn(argv[0]!, argv.slice(1), {
      // fd 3: the helper tees the speaker feed (s16 PCM) for remote
      // listening. The engine ALWAYS drains it — an unread pipe would
      // stall the helper's audio thread.
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
    this.holdStartedAt = 0;
    this.lastStderrLine = "";
    this.readyTimer = setTimeout(
      () => this.watchdogFire(child, `no "ready" within ${this.readyTimeoutMs} ms`), this.readyTimeoutMs);

    const out = createInterface({ input: child.stdout! });
    this.childStdout = out;
    out.on("line", (line: string) => {
      if (this.child !== child) return; // superseded spawn; ignore
      let ev: HelperEvent;
      try { ev = JSON.parse(line) as HelperEvent; } catch { return; }
      // A helper that's merely logging isn't proven alive — a wedged DSP
      // thread can still emit periodic log lines forever, which would starve
      // the silence watchdog of the timeout it exists to enforce. Only a
      // non-"log" event (tune/open/close/etc.) counts as liveness.
      if (this.silenceTimer && ev.ev !== "log") this.armSilence(child);
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
    // stdin writes (tune/known/skip/quit) are guarded on .writable, but the
    // pipe can break before the stream object knows — the write's async EPIPE
    // then lands as an 'error' event here. Uncaught, it kills the backend; the
    // child 'close' handler already owns recovery.
    child.stdin?.on("error", () => {});

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
        if (this.readyTimer) { clearTimeout(this.readyTimer); this.readyTimer = null; }
        if (this.child) this.armSilence(this.child);
        this.resetRevisit();
        this.sendTune();
        this.startDwellTimer();
        break;
      case "log":
        if (typeof ev.msg === "string") this.forwardHelperLog(ev.msg);
        break;
      case "open": {
        if (typeof ev.id !== "string") return;
        this.recordActivity(ev.id);
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
          this.holdStartedAt = 0; // hold ended cleanly; next hold clocks fresh
          this.emit({ type: "idle", ts: this.now() });
          // Idle again: dwell restarts from now, so a long hold doesn't cause
          // an instant hop the moment the channel closes.
          this.groupStartedAt = this.now();
        }
        break;
      case "rf":
        if (typeof ev.id === "string" && typeof ev.db === "number") {
          this.emit({ type: "rf", channelId: ev.id, db: ev.db, ts: this.now() });
        }
        break;
      case "tone": {
        const ctcssHz = typeof ev.ctcssHz === "number" ? ev.ctcssHz : undefined;
        const dcs = typeof ev.dcs === "string" ? ev.dcs : undefined;
        if (typeof ev.id === "string" && (ctcssHz !== undefined || dcs !== undefined)) {
          this.emit({
            type: "tone", channelId: ev.id,
            ...(ctcssHz !== undefined ? { ctcssHz } : {}), ...(dcs !== undefined ? { dcs } : {}),
            ts: this.now(),
          });
        }
        break;
      }
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
      case "txstat":
        if (this.txStats && typeof ev.id === "string") this.recordTxStat(ev);
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
        break; // tuned is informational
    }
  }

  // Is any currently-open lane one the operator can actually hear? Unknown ids
  // count as audible: Close Call lanes (cc_*) aren't in any group and DO speak,
  // so a CC hit must still hold the window.
  private hasAudibleOpen(): boolean {
    for (const id of this.openIds) {
      const channel = this.findChannel(id);
      if (!channel || channel.audible !== false) return true;
    }
    return false;
  }

  // One squelch-calibration line. The helper emits a retune-cut episode under
  // its OLD id just before the new group's "tuned", so resolve the freq
  // against the whole configured channel list, not the current group.
  private recordTxStat(ev: HelperEvent): void {
    const id = ev.id as string;
    const rec: Record<string, unknown> = { t: new Date(this.now()).toISOString(), id };
    const cc = /^cc_(\d+)$/.exec(id);
    const freqHz = cc ? Number(cc[1]) : this.config?.channels.find((c) => c.id === id)?.freq;
    if (freqHz !== undefined) rec.freqHz = freqHz;
    const raw = ev as unknown as Record<string, unknown>;
    for (const k of TXSTAT_FIELDS) if (raw[k] !== undefined) rec[k] = raw[k];
    this.txStats!.append(rec);
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
    this.holdStartedAt = 0;
    this.groupStartedAt = this.now();
    this.child.stdin.write(JSON.stringify({
      cmd: "tune", centerHz, channels: [],
      // Honor the configured Close Call flag: sweep stops exist to hunt with
      // Close Call, but if the operator disabled it the empty-window stop must
      // not silently re-enable detection.
      monitor: false, closeCall: this.config?.closeCall ?? true,
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
    this.holdStartedAt = 0;
    this.groupStartedAt = this.now();
    const cmd = {
      cmd: "tune",
      // Offset the RTL tune off the cluster center so a lone channel isn't on
      // the DC spike (the helper derives each lane's baseband offset from this).
      // The "tuned" event below still reports the logical center for the UI.
      centerHz: group.centerHz + this.centerOffsetHz,
      channels: group.channels.map((c) => ({
        id: c.id, freqHz: c.freq, priority: c.priority ?? false,
        mode: c.mode,
        audible: c.audible !== false,
        ...(c.background ? { background: true } : {}),
        // Per-channel squelch profile (ROADMAP Idea 7) — omitted = the
        // helper's global defaults. Resolved from banks by the server.
        ...(c.openAboveFloorDb !== undefined ? { openDb: c.openAboveFloorDb } : {}),
        ...(c.hangMs !== undefined ? { hangMs: c.hangMs } : {}),
        // CTCSS tone squelch (omitted = carrier squelch only, as before).
        ...(c.ctcssHz !== undefined ? { ctcssHz: c.ctcssHz } : {}),
        // DCS squelch ("023N"); the schema keeps it exclusive with ctcssHz.
        ...(c.dcsCode !== undefined ? { dcs: c.dcsCode } : {}),
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

  /** Rotation indices of groups holding an enabled, audible priority channel. */
  private priorityGroups(): number[] {
    const out: number[] = [];
    this.groups.forEach((g, i) => {
      if (g.channels.some((c) => c.priority && c.enabled !== false && c.audible !== false && !c.background)) {
        out.push(i);
      }
    });
    return out;
  }

  // Forget any in-flight look and accrued credit: a (re)spawn or a retune
  // re-points the radio at groupIndex, which is now simply the current group.
  private resetRevisit(): void {
    this.revisit = null;
    this.revisitCreditMs = 0;
    this.lastTickAt = this.now();
  }

  /**
   * Priority revisit: after every `everyMs` of QUIET dwell on non-priority
   * groups, peek at the next priority group (round-robin) for `lookMs`, then
   * return to the interrupted group with its remaining dwell. Never while
   * holding on an open (the tick returns before this), during a sweep stop,
   * in monitor mode (weather break-in / direct tune — also a single group, so
   * the hop timer is parked anyway), or while the current group IS a priority
   * group (it is being heard; that resets the credit). Returns true if it hopped.
   */
  private maybeStartRevisit(deltaMs: number): boolean {
    const pr = resolvePriorityRevisit(this.config?.priorityRevisit);
    const targets = this.priorityGroups();
    if (!pr.enabled || this.config?.monitor || targets.length === 0) return false;
    if (targets.includes(this.groupIndex)) {
      this.revisitCreditMs = 0;
      return false;
    }
    this.revisitCreditMs += deltaMs;
    if (this.revisitCreditMs < pr.everyMs) return false;
    const pick = nextRevisitTarget(targets, this.revisitCursor);
    if (!pick) return false;
    this.revisitCursor = pick.cursor;
    this.revisitCreditMs = 0;
    this.revisit = { returnIndex: this.groupIndex, elapsedMs: this.now() - this.groupStartedAt };
    this.groupIndex = pick.index;
    this.sendTune();
    return true;
  }

  private endRevisit(): void {
    const r = this.revisit;
    if (!r) return;
    this.revisit = null;
    this.groupIndex = r.returnIndex;
    this.sendTune();
    // Resume, don't restart: the interrupted group keeps only what was left.
    this.groupStartedAt = this.now() - r.elapsedMs;
  }

  private startDwellTimer(): void {
    this.clearDwellTimer();
    if (this.groups.length <= 1 && this.sweeps.length === 0) return; // single group: park forever
    const dwell = this.groupDwellMs();
    this.lastTickAt = this.now();
    this.dwellTimer = setInterval(() => {
      const tickAt = this.now();
      const deltaMs = Math.max(0, tickAt - this.lastTickAt);
      this.lastTickAt = tickAt;
      // Only an AUDIBLE open has a claim on the radio. A muted channel reading
      // open — a continuously-keyed business carrier, say — would otherwise
      // park the scanner in SILENCE for the whole max-hold cap, which sounds
      // exactly like a lockup (463.5625 held group 14 for 180s a time).
      if (this.hasAudibleOpen()) {
        if (this.holdStartedAt === 0) this.holdStartedAt = this.now();
        if (this.now() - this.holdStartedAt < this.maxHoldMs) {
          // Hold-through: a channel is active — never tune away from it.
          this.groupStartedAt = this.now();
          return;
        }
        // Cap breached: a lane has read open continuously past maxHoldMs —
        // almost certainly a stuck-open lane (a dropped helper "close"). Abandon
        // it so one wedged window can't silence the whole scanner for hours.
        this.log(
          `[wideband] max-hold ${this.maxHoldMs}ms exceeded on group ${this.groupIndex} ` +
          `(${this.openIds.size} open); forcing hop`,
        );
        this.openIds.clear();
        this.audibleId = null;
        this.holdStartedAt = 0;
        this.groupStartedAt = 0; // fall through and let the advance below fire now
      } else {
        // Nothing audible is open: the window gets its plain dwell, no hold.
        this.holdStartedAt = 0;
      }
      if (this.sweeping) {
        // A sweep stop lasts one plain dwell, then the rotation resumes.
        if (this.now() - this.groupStartedAt >= dwell) {
          this.sweeping = false;
          this.groupIndex = 0;
          this.sendTune();
        }
        return;
      }
      if (this.revisit) {
        // Priority look: an open there held above like any open (and the
        // close re-armed groupStartedAt, so the look runs on lookMs past it).
        const lookMs = resolvePriorityRevisit(this.config?.priorityRevisit).lookMs;
        if (this.now() - this.groupStartedAt >= lookMs) this.endRevisit();
        return;
      }
      // Quiet window: bank-weighted, activity-scaled dwell (effectiveDwellMs).
      if (this.now() - this.groupStartedAt >= this.effectiveDwellMs(this.groupIndex)) {
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
        return;
      }
      this.maybeStartRevisit(deltaMs);
    }, Math.max(20, this.autoDwell().enabled || resolvePriorityRevisit(this.config?.priorityRevisit).enabled
      ? Math.min(Math.floor(dwell / 3), SCHED_TICK_MS)
      : Math.floor(dwell / 3)));
  }

  private clearDwellTimer(): void {
    if (this.dwellTimer) {
      clearInterval(this.dwellTimer);
      this.dwellTimer = null;
    }
  }

  private forwardHelperLog(msg: string): void {
    const t = this.now();
    if (t - this.logWindowStart >= HELPER_LOG_WINDOW_MS) {
      if (this.logSuppressed > 0) this.log(`[helper] ${this.logSuppressed} more log lines suppressed`);
      this.logWindowStart = t;
      this.logCount = 0;
      this.logSuppressed = 0;
    }
    if (this.logCount < HELPER_LOG_BURST) {
      this.logCount++;
      this.log(`[helper] ${msg}`);
    } else {
      this.logSuppressed++;
    }
  }

  private clearWatchdogs(): void {
    if (this.readyTimer) { clearTimeout(this.readyTimer); this.readyTimer = null; }
    if (this.silenceTimer) { clearTimeout(this.silenceTimer); this.silenceTimer = null; }
  }

  // A wedged helper (ALSA/USB stuck before "ready", or a hung DSP
  // thread afterwards) stays alive and silent -- no exit, so the normal
  // escalation never fires. These timers turn that into an exit.
  private watchdogFire(child: ChildProcess, why: string): void {
    if (this.child !== child || this.stopping) return;
    // Don't clobber real stderr the helper already printed (e.g. "failed to
    // open RTL-SDR…") — that's the operator's only diagnostic and also what
    // the NO_DEVICE classifier regex matches against below.
    this.lastStderrLine = this.lastStderrLine ? `${why}; last stderr: ${this.lastStderrLine}` : why;
    this.handleUnexpectedExit(null);
  }

  private armSilence(child: ChildProcess): void {
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    this.silenceTimer = setTimeout(
      () => this.watchdogFire(child, `helper silent for ${this.silenceTimeoutMs} ms`), this.silenceTimeoutMs);
  }

  private clearRestartTimer(): void {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
  }

  private killChild(): void {
    this.clearWatchdogs();
    // Flush any pending suppression summary rather than losing it silently —
    // a stop/respawn mid-burst must not drop "N more log lines suppressed".
    if (this.logSuppressed > 0) {
      this.log(`[helper] ${this.logSuppressed} more log lines suppressed`);
      this.logSuppressed = 0;
    }
    this.logWindowStart = 0;
    this.logCount = 0;
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
      // Ask nicely (the helper shuts down cleanly on "quit"/EOF), then
      // make sure after a grace period. The timer is PER CHILD on purpose:
      // a shared class slot let an overlapping teardown (rapid bank toggles
      // = stop/start cycles) CANCEL the previous helper's pending SIGKILL —
      // a helper wedged in teardown then held the SDR forever and
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
    // Journal every unexpected exit with its reason, soft path included: the
    // soft path emits only a "starting" status, so a one-off helper death used
    // to leave no trace of WHY (seen live 2026-09-26: an unexplained native
    // respawn with nothing in the journal).
    this.log(`[wideband] ${message}`);
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
      // Exponential backoff on CONSECUTIVE failures (exitFailures resets once a
      // spawn proves healthy). Without it a helper that cannot open its device
      // respawned at a flat 1 Hz forever — pure device churn with no chance of
      // a different outcome.
      const delay = Math.min(
        this.restartDelayMs * 2 ** Math.max(0, this.exitFailures - 1),
        this.maxRestartDelayMs,
      );
      if (this.exitFailures > 1) {
        this.log(`[wideband] respawn in ${delay}ms (consecutive failure #${this.exitFailures})`);
      }
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null;
        if (this.stopping) return;
        this.spawnHelper(); // retunes to the current group on its "ready"
      }, delay);
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
    this.holdStartedAt = 0;
    this.setState("stopped");
  }

  async setVolume(percent: number): Promise<void> {
    await amixerVolume(percent);
  }
  async setMuted(muted: boolean): Promise<void> {
    await amixerMuted(muted);
  }
}
