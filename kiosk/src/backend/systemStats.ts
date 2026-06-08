import { readFileSync, readdirSync, statfsSync } from "node:fs";
import os from "node:os";

// Host health (ROADMAP Idea 16): the machine under stress, made visible.
// The motivating symptom was "it sometimes spikes and nothing says why" —
// so the headline stat is the DSP HELPER's own CPU, correlated with what
// the radio was doing (open channels), not just generic gauges. Sampled
// every few seconds into a short ring so spikes survive long enough to be
// seen; everything platform-specific degrades to null, never throws.

export interface SystemSample {
  ts: number;
  cpuPct: number;            // whole-machine, all cores normalized to 100
  helperCpuPct: number | null; // the DSP helper process (the usual suspect)
  helperRssMb: number | null;
  load1: number;
  memUsedPct: number;
  backendRssMb: number;
  tempC: number | null;      // hottest thermal zone
  throttled: boolean | null; // cpu0 running well under its max clock
  diskFreeMb: number | null; // the writable partition (history.db lives here)
  openCount: number;         // channels open at sample time (the correlation)
}

export interface SystemAlert {
  id: string;
  severity: "attention" | "severe";
  title: string;
  message: string;
  help: string;
}

// Alert thresholds, calibrated to THIS appliance's reality. The box is
// thermally saturated by design: steady-state runs ~82-83°C, so the old 82°C
// "running hot" line sat on top of normal and fired around the clock. The
// engine's safetyMode (server.ts) trips at 90°C and clears at 78°C — we align
// the critical alert with that trip and place attention a few degrees below,
// clear of the normal band.
const TEMP_HIGH_C = 87;
const TEMP_CRITICAL_C = 90;
// Debounce: a load-driven metric must breach across this many consecutive
// samples (~7.5s at the 2.5s cadence) before it raises, so a single hot
// reading or a cold-start burst can't flap the banner on and off.
const SUSTAIN_SAMPLES = 3;

/** True only if `pred` holds across the whole recent debounce window. */
function sustained(recent: SystemSample[], pred: (s: SystemSample) => boolean): boolean {
  if (recent.length === 0) return false;
  return recent.slice(-SUSTAIN_SAMPLES).every(pred);
}

/**
 * Turn raw host telemetry into operator-facing, self-clearing alerts.
 *
 * `recent` is the trailing telemetry window (oldest→newest, `now` last); the
 * fast, load-driven signals (temperature, CPU) only fire when the breach is
 * *sustained* across it. Slow-moving signals (disk, memory) read `now`
 * directly. Defaulting `recent` to `[now]` keeps single-sample callers working.
 */
export function classifySystemAlerts(
  now: SystemSample | null,
  recent: SystemSample[] = now ? [now] : [],
): SystemAlert[] {
  if (!now) return [];
  const alerts: SystemAlert[] = [];

  // Temperature is driven purely by the reading. Throttling is NOT a trigger —
  // an idle Intel core dropping its clock is normal power management, not heat —
  // it only annotates the message when the temperature is independently high.
  if (sustained(recent, (s) => s.tempC !== null && s.tempC >= TEMP_CRITICAL_C)) alerts.push({
    id: "temperature-critical", severity: "severe", title: "Machine temperature critical",
    message: `${now.tempC?.toFixed(1) ?? "Unknown"}°C; hardware is at risk.`,
    help: "Check airflow immediately. Stop Close Call or shut down the machine if temperature keeps rising.",
  });
  else if (sustained(recent, (s) => s.tempC !== null && s.tempC >= TEMP_HIGH_C)) alerts.push({
    id: "temperature-high", severity: "attention", title: "Machine is running hot",
    message: `${now.tempC?.toFixed(1) ?? "Unknown"}°C${now.throttled ? " and CPU throttling detected" : ""}.`,
    help: "Check vents and fans. Consider disabling Close Call sweeps until it cools.",
  });
  if (now.diskFreeMb !== null && now.diskFreeMb < 512) alerts.push({
    id: "disk-critical", severity: "severe", title: "Storage almost full",
    message: `${now.diskFreeMb} MB remains; history writes may fail.`,
    help: "Remove old files or expand storage immediately.",
  });
  else if (now.diskFreeMb !== null && now.diskFreeMb < 2048) alerts.push({
    id: "disk-low", severity: "attention", title: "Storage running low",
    message: `${(now.diskFreeMb / 1024).toFixed(1)} GB remains.`,
    help: "Review retained history and free space before recording stops.",
  });
  if (now.memUsedPct >= 95) alerts.push({
    id: "memory-critical", severity: "severe", title: "Memory critically high",
    message: `${now.memUsedPct}% of memory is in use.`,
    help: "Restart the radio backend if memory keeps climbing.",
  });
  else if (now.memUsedPct >= 88) alerts.push({
    id: "memory-high", severity: "attention", title: "Memory usage high",
    message: `${now.memUsedPct}% of memory is in use.`,
    help: "Watch for continued growth; restart the backend if it does not recover.",
  });
  // Whole-machine saturation only. The DSP helper sitting at 250-600% is its
  // expected state (12 lanes across 8 threads, bursts on cold start), so
  // helper% is reported for context but is not itself an alarm.
  if (sustained(recent, (s) => s.cpuPct >= 95)) alerts.push({
    id: "cpu-saturated", severity: "attention", title: "Radio processing saturated",
    message: `CPU ${now.cpuPct}%${now.helperCpuPct === null ? "" : `; DSP helper ${now.helperCpuPct}%`}.`,
    help: "Disable Close Call sweep ranges if scanning becomes unstable.",
  });
  return alerts;
}

export interface SystemStatsOptions {
  /** The DSP helper's pid right now (null when not running). */
  helperPid: () => number | null;
  /** Channels currently open (engine activity, for spike correlation). */
  openCount: () => number;
  dataDir: string;
  intervalMs?: number;
  ringSize?: number;
  /** Injectable for tests. */
  readFile?: (path: string) => string;
  /** Called after each sample; used for temporary machine self-protection. */
  onSample?: (sample: SystemSample) => void;
}

const CLK_TCK = 100; // Linux USER_HZ; constant on every platform we run on

export class SystemStats {
  private readonly opts: Required<SystemStatsOptions>;
  private ring: SystemSample[] = [];
  private timer: NodeJS.Timeout | null = null;
  private lastCpu: { idle: number; total: number } | null = null;
  private lastHelper: { ticks: number; at: number; pid: number } | null = null;
  private lastThrottleCount: number | null = null;

  constructor(opts: SystemStatsOptions) {
    this.opts = {
      intervalMs: 2_500,
      ringSize: 120,           // ~5 minutes
      readFile: (p) => readFileSync(p, "utf8"),
      onSample: () => {},
      ...opts,
    };
  }

  start(): void {
    this.sample();
    this.timer = setInterval(() => this.sample(), this.opts.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  snapshot(): { now: SystemSample | null; ring: SystemSample[]; alerts: SystemAlert[] } {
    const now = this.ring[this.ring.length - 1] ?? null;
    return { now, ring: this.ring, alerts: classifySystemAlerts(now, this.ring) };
  }

  private sample(): void {
    const ts = Date.now();
    const sample: SystemSample = {
      ts,
      cpuPct: this.cpuPct(),
      ...this.helper(ts),
      load1: os.loadavg()[0] ?? 0,
      memUsedPct: Math.round(100 * (1 - os.freemem() / os.totalmem())),
      backendRssMb: Math.round(process.memoryUsage().rss / 1048576),
      tempC: this.tempC(),
      throttled: this.throttled(),
      diskFreeMb: this.diskFreeMb(),
      openCount: this.opts.openCount(),
    };
    this.ring.push(sample);
    if (this.ring.length > this.opts.ringSize) this.ring.shift();
    this.opts.onSample(sample);
  }

  private cpuPct(): number {
    const cpus = os.cpus();
    let idle = 0; let total = 0;
    for (const c of cpus) {
      idle += c.times.idle;
      total += c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq;
    }
    const prev = this.lastCpu;
    this.lastCpu = { idle, total };
    if (!prev || total === prev.total) return 0;
    return Math.round(100 * (1 - (idle - prev.idle) / (total - prev.total)));
  }

  private helper(ts: number): { helperCpuPct: number | null; helperRssMb: number | null } {
    const pid = this.opts.helperPid();
    if (!pid) { this.lastHelper = null; return { helperCpuPct: null, helperRssMb: null }; }
    try {
      // /proc/<pid>/stat fields 14+15 (utime+stime) — but the comm field
      // can contain spaces, so parse from after the closing paren.
      const stat = this.opts.readFile(`/proc/${pid}/stat`);
      const after = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const ticks = Number(after[11]) + Number(after[12]);
      const prev = this.lastHelper;
      this.lastHelper = { ticks, at: ts, pid };
      let pct: number | null = null;
      if (prev && prev.pid === pid && ts > prev.at) {
        pct = Math.round(100 * ((ticks - prev.ticks) / CLK_TCK) / ((ts - prev.at) / 1000));
      }
      const rssKb = /VmRSS:\s+(\d+)/.exec(this.opts.readFile(`/proc/${pid}/status`))?.[1];
      return { helperCpuPct: pct, helperRssMb: rssKb ? Math.round(Number(rssKb) / 1024) : null };
    } catch {
      this.lastHelper = null;
      return { helperCpuPct: null, helperRssMb: null };
    }
  }

  private tempC(): number | null {
    try {
      let max: number | null = null;
      for (const z of readdirSync("/sys/class/thermal")) {
        if (!z.startsWith("thermal_zone")) continue;
        const v = Number(this.opts.readFile(`/sys/class/thermal/${z}/temp`).trim());
        if (Number.isFinite(v) && v > 1000) max = Math.max(max ?? 0, v / 1000);
      }
      return max === null ? null : Math.round(max * 10) / 10;
    } catch { return null; }
  }

  private throttled(): boolean | null {
    // Real thermal-throttle EVENTS, not idle clock-scaling. The kernel bumps
    // core_throttle_count only when a core is actually held back by heat; we
    // report true when it ticked up since the last sample. The previous
    // heuristic (current clock < 70% of max) flagged normal Intel SpeedStep
    // idling as throttling and flapped every sample. Absent on hardware
    // without the counter (degrades to null).
    try {
      const count = Number(this.opts.readFile(
        "/sys/devices/system/cpu/cpu0/thermal_throttle/core_throttle_count").trim());
      if (!Number.isFinite(count)) return null;
      const prev = this.lastThrottleCount;
      this.lastThrottleCount = count;
      return prev === null ? false : count > prev;
    } catch { return null; }
  }

  private diskFreeMb(): number | null {
    try {
      const fs = statfsSync(this.opts.dataDir);
      return Math.round((fs.bavail * fs.bsize) / 1048576);
    } catch { return null; }
  }
}

/** Parse helper for tests: utime+stime ticks from a /proc stat line. */
export function procStatTicks(stat: string): number {
  const after = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  return Number(after[11]) + Number(after[12]);
}
