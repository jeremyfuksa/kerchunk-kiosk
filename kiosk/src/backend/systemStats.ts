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

/** Turn raw host telemetry into operator-facing, self-clearing alerts. */
export function classifySystemAlerts(sample: SystemSample | null): SystemAlert[] {
  if (!sample) return [];
  const alerts: SystemAlert[] = [];
  if (sample.tempC !== null && sample.tempC >= 90) alerts.push({
    id: "temperature-critical", severity: "severe", title: "Machine temperature critical",
    message: `${sample.tempC.toFixed(1)}°C; hardware is at risk.`,
    help: "Check airflow immediately. Stop Close Call or shut down the machine if temperature keeps rising.",
  });
  else if ((sample.tempC !== null && sample.tempC >= 82) || sample.throttled) alerts.push({
    id: "temperature-high", severity: "attention", title: "Machine is running hot",
    message: `${sample.tempC?.toFixed(1) ?? "Unknown"}°C${sample.throttled ? " and CPU throttling detected" : ""}.`,
    help: "Check vents and fans. Consider disabling transcription and Close Call sweeps until it cools.",
  });
  if (sample.diskFreeMb !== null && sample.diskFreeMb < 512) alerts.push({
    id: "disk-critical", severity: "severe", title: "Storage almost full",
    message: `${sample.diskFreeMb} MB remains; history writes may fail.`,
    help: "Remove old files or expand storage immediately.",
  });
  else if (sample.diskFreeMb !== null && sample.diskFreeMb < 2048) alerts.push({
    id: "disk-low", severity: "attention", title: "Storage running low",
    message: `${(sample.diskFreeMb / 1024).toFixed(1)} GB remains.`,
    help: "Review retained history and free space before recording stops.",
  });
  if (sample.memUsedPct >= 95) alerts.push({
    id: "memory-critical", severity: "severe", title: "Memory critically high",
    message: `${sample.memUsedPct}% of memory is in use.`,
    help: "Restart the radio backend. Disable transcription if memory climbs again.",
  });
  else if (sample.memUsedPct >= 88) alerts.push({
    id: "memory-high", severity: "attention", title: "Memory usage high",
    message: `${sample.memUsedPct}% of memory is in use.`,
    help: "Watch for continued growth; restart the backend if it does not recover.",
  });
  if (sample.cpuPct >= 95 || (sample.helperCpuPct ?? 0) >= 380) alerts.push({
    id: "cpu-saturated", severity: "attention", title: "Radio processing saturated",
    message: `CPU ${sample.cpuPct}%${sample.helperCpuPct === null ? "" : `; DSP helper ${sample.helperCpuPct}%`}.`,
    help: "Disable transcription first, then Close Call sweep ranges if scanning becomes unstable.",
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
  private maxFreqKhz: number | null = null;

  constructor(opts: SystemStatsOptions) {
    this.opts = {
      intervalMs: 2_500,
      ringSize: 120,           // ~5 minutes
      readFile: (p) => readFileSync(p, "utf8"),
      onSample: () => {},
      ...opts,
    };
    try {
      this.maxFreqKhz = Number(this.opts.readFile(
        "/sys/devices/system/cpu/cpu0/cpufreq/cpuinfo_max_freq").trim()) || null;
    } catch { this.maxFreqKhz = null; }
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
    return { now, ring: this.ring, alerts: classifySystemAlerts(now) };
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
    if (!this.maxFreqKhz) return null;
    try {
      const cur = Number(this.opts.readFile(
        "/sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq").trim());
      // Well under max clock while we're sampling = the SoC is pulling back.
      return cur > 0 ? cur < this.maxFreqKhz * 0.7 : null;
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
