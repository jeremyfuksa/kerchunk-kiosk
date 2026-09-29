// System tab logic, pure (no DOM, no fetch): vitals and their warn lines,
// sparklines, uptime, the verdict card, power-action copy, the Maps and
// lockout helpers. system.ts / systemConnections.ts only render these.
import type { Config } from "../../backend/config/schema.js";
import { worseVerdict, UNREACHABLE_TEXT, type SystemAlert, type Verdict } from "./verdict.js";

/** One /api/system reading (SystemSample in backend/systemStats.ts). */
export interface SystemNow {
  ts: number; cpuPct: number; helperCpuPct: number | null; helperRssMb: number | null; load1: number;
  memUsedPct: number; backendRssMb: number; tempC: number | null; throttled: boolean | null;
  diskFreeMb: number | null; openCount: number;
}
export interface SystemSnapshot {
  now: SystemNow | null;
  ring: SystemNow[];
  alerts: SystemAlert[];
  safetyMode: boolean;
  health: { verdict: Verdict; reason: string };
  coreCount: number;
}

// Warn lines — calibrated to this appliance (classic renderSystem): the
// 87 °C line matches the backend's own "running hot" alert threshold.
export const CPU_WARN_PCT = 85;
export const HELPER_WARN_PCT_PER_CORE = 80;
export const TEMP_WARN_C = 87;
export const RAM_WARN_PCT = 90;
export const DISK_LOW_MB = 2048;

export interface Vital { id: "temp" | "cpu" | "helper" | "disk"; label: string; value: string; hot: boolean; spark: string | null }

/** Polyline points for a sparkline: values scaled 0..max into W×H (y down),
 *  nulls on the floor, clamped. */
export function sparkPoints(values: Array<number | null>, max: number, W = 120, H = 28): string {
  if (!values.length) return "";
  return values.map((v, i) => {
    const x = values.length === 1 ? W / 2 : (i / (values.length - 1)) * W;
    const y = H - Math.min(1, Math.max(0, (v ?? 0) / max)) * H;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
}

export function vitals(sys: SystemSnapshot): { main: Vital[]; secondary: string[] } | null {
  const n = sys.now;
  if (!n) return null;
  const series = (k: keyof SystemNow): Array<number | null> =>
    (sys.ring ?? []).map((r) => (typeof r[k] === "number" ? (r[k] as number) : null));
  const cores = Math.max(1, sys.coreCount || 1);
  const t = n.tempC;
  const main: Vital[] = [
    {
      id: "temp", label: "Temperature",
      value: t === null ? "—" : `${t}°C${n.throttled ? " · throttled" : ""}`,
      hot: t !== null && t >= TEMP_WARN_C, spark: sparkPoints(series("tempC"), 100),
    },
    { id: "cpu", label: "CPU", value: `${n.cpuPct}%`, hot: n.cpuPct >= CPU_WARN_PCT, spark: sparkPoints(series("cpuPct"), 100) },
    {
      id: "helper", label: "DSP helper",
      value: n.helperCpuPct === null ? "Not running" : `${(n.helperCpuPct / 100).toFixed(1)} of ${cores} cores`,
      hot: n.helperCpuPct !== null && n.helperCpuPct >= HELPER_WARN_PCT_PER_CORE * cores,
      spark: sparkPoints(series("helperCpuPct"), 100 * cores),
    },
    {
      id: "disk", label: "Disk free",
      value: n.diskFreeMb === null ? "—" : n.diskFreeMb >= 10 * 1024 ? `${Math.round(n.diskFreeMb / 1024)} GB` : `${(n.diskFreeMb / 1024).toFixed(1)} GB`,
      hot: n.diskFreeMb !== null && n.diskFreeMb < DISK_LOW_MB, spark: null,
    },
  ];
  const secondary = [
    `RAM ${n.memUsedPct}% · backend ${n.backendRssMb} MB${n.memUsedPct >= RAM_WARN_PCT ? " — high" : ""}`,
    `${n.openCount} channel${n.openCount === 1 ? "" : "s"} open`,
  ];
  return { main, secondary };
}

/** "up 3 d 4 h" from the backend's start time, or "" when unknown. */
export function uptimeText(startedAt: number | null, now: number = Date.now()): string {
  if (startedAt === null) return "";
  const m = Math.floor(Math.max(0, now - startedAt) / 60_000);
  if (m < 1) return "up less than a minute";
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  const min = m % 60;
  if (d > 0) return `up ${d} d${h ? ` ${h} h` : ""}`;
  if (h > 0) return `up ${h} h${min ? ` ${min} min` : ""}`;
  return `up ${min} min`;
}

const LABEL: Record<Verdict | "unknown", string> = { healthy: "Healthy", stressed: "Degraded", trouble: "Trouble", unknown: "Unknown" };
const VALID_VERDICTS: readonly Verdict[] = ["healthy", "stressed", "trouble"];

export function verdictView(sys: SystemSnapshot | null): { verdict: Verdict | "unknown"; label: string; reason: string } {
  if (!sys || !VALID_VERDICTS.includes(sys.health?.verdict as Verdict)) {
    return { verdict: "unknown", label: LABEL.unknown, reason: sys?.health?.reason || UNREACHABLE_TEXT };
  }
  const v = worseVerdict(sys.health, sys.alerts ?? []);
  return { verdict: v.verdict, label: LABEL[v.verdict], reason: v.text };
}

/** Alerts to list under the verdict (severe first) and whether the thermal
 *  protection note shows. */
export function alertsView(sys: SystemSnapshot): { protection: boolean; alerts: SystemAlert[] } {
  const rank = (a: SystemAlert): number => (a.severity === "severe" ? 0 : 1);
  return { protection: sys.safetyMode === true, alerts: [...(sys.alerts ?? [])].sort((a, b) => rank(a) - rank(b)) };
}

/** The config with the Maps key / Map ID set (trimmed) or cleared (empty).
 *  No display block = no coordinates = no map: refuse a non-empty value. */
export function withMaps(cfg: Config, key: string, mapId: string): Config {
  const k = key.trim();
  const id = mapId.trim();
  if (!cfg.display) {
    if (k || id) throw new Error("Set a weather location first — the map needs coordinates.");
    return cfg;
  }
  const { googleMapsApiKey: _k, googleMapsMapId: _m, ...rest } = cfg.display;
  return {
    ...cfg,
    display: { ...rest, ...(k ? { googleMapsApiKey: k } : {}), ...(id ? { googleMapsMapId: id } : {}) },
  };
}

export function mapsState(cfg: Config): "connected" | "not set" {
  return cfg.display?.googleMapsApiKey ? "connected" : "not set";
}

/** What removing a lockout will change, so Undo restores exactly that: each
 *  channel's enabled flag at the frequency (unlockFreqIn re-enables them). */
export function unlockSnapshot(cfg: Config, freq: number): { enabled: Map<string, boolean> } {
  const enabled = new Map<string, boolean>();
  for (const c of cfg.channels ?? []) if (c.freq === freq) enabled.set(c.id, c.enabled);
  return { enabled };
}

export type SystemAction = "restart" | "reboot" | "poweroff";
export interface ActionCopy {
  title: string; message: string; confirmLabel: string;
  pending: string; down: string; back: string; unchanged: string;
}

/** Power-action copy (classic SYSTEM_ACTION_COPY; "backend" is "radio" here). */
export const SYSTEM_ACTION_COPY: Record<SystemAction, ActionCopy> = {
  restart: {
    title: "Restart the radio?",
    message: "Audio and scanning stop briefly while the radio and its helpers restart.",
    confirmLabel: "Restart radio",
    pending: "Restarting the radio…",
    down: "The radio is down — waiting for it to come back…",
    back: "The radio is back.",
    unchanged: "The radio didn't restart. Try again.",
  },
  reboot: {
    title: "Reboot the appliance?",
    message: "The whole machine restarts. Radio, audio and the kiosk screen go down for about a minute.",
    confirmLabel: "Reboot",
    pending: "Rebooting the appliance…",
    down: "The appliance is rebooting — waiting for it to come back…",
    back: "The appliance is back online.",
    unchanged: "The reboot didn't start. Try again.",
  },
  poweroff: {
    title: "Shut down the appliance?",
    message: "The machine powers off. It won't come back until someone presses the power button on the laptop.",
    confirmLabel: "Shut down",
    pending: "Shutting down…",
    down: "The appliance is off — press its power button to start it again.",
    back: "The appliance is back online.",
    unchanged: "The shut down didn't start. Try again.",
  },
};

/** Test weather alerts, cycled one per press (each themed banner in turn). */
export const TEST_ALERTS: readonly string[] = [
  "TORNADO WARNING", "SEVERE THUNDERSTORM WARNING", "FLASH FLOOD WARNING", "TORNADO WATCH", "WINTER STORM WARNING",
];
