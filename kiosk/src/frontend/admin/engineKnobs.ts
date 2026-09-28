// Engine knobs in the admin (spec docs/superpowers/specs/2026-09-27-engine-knobs-admin-design.md).
// Pure (no DOM): ONE field table drives markup, load, save, validation and dirty
// tracking, so ~24 knobs aren't 24 hand-written blocks. Values in the table's
// min/max/step/def are UI units; config value = UI value x scale.
import type { Bank, Channel, Config } from "../../backend/config/schema.js";
import {
  AUTO_DWELL_DEFAULTS, PRIORITY_REVISIT_DEFAULTS, HELPER_DEFAULTS,
  DEFAULT_LANES_PER_GROUP, DEFAULT_SAMPLE_RATE_HZ, DEFAULT_WINDOW_BANDWIDTH_HZ, DEFAULT_FLAT_BANDWIDTH_HZ,
  DEFAULT_READY_TIMEOUT_MS, DEFAULT_SILENCE_TIMEOUT_MS,
  LANE_HZ, MAX_LANES_PER_GROUP, MIN_SAMPLE_RATE_HZ, MAX_SAMPLE_RATE_HZ,
} from "../../backend/config/engineDefaults.js";
import { groupChannels } from "../../backend/engine/grouping.js";
import { isScannable, profileFor } from "../../backend/config/banks.js";

export type Band = "sound" | "loudness" | "shape" | "schedule" | "watchdog";
export type Cost = "scan" | "live" | "backend";

// What a save of each band costs — mirrors the server's PUT /api/config diff:
// autoDwell/priorityRevisit are stripped and applied live; the watchdogs are
// read at engine construction; everything else restarts the engine.
export const BAND_COST: Record<Band, Cost> = {
  sound: "scan", loudness: "scan", shape: "scan", schedule: "live", watchdog: "backend",
};
export const COST_LABEL: Record<Cost, string> = {
  scan: "Restarts scanning", live: "Applies live", backend: "Needs a backend restart",
};

export interface KnobField {
  id: string;
  path: readonly string[];
  band: Band;
  label: string;
  hint: string;
  unit: string;
  kind: "number" | "switch";
  /** config value = UI value x scale */
  scale: number;
  /** config value is an integer (rounded after scaling) */
  int?: boolean;
  min: number;
  max: number;
  step: number;
  def: number | boolean;
  /** 0 is valid below min (hum filter: 0 = off) */
  allowZero?: boolean;
  /** sub-heading rendered above this row */
  sub?: string;
}

const H = HELPER_DEFAULTS;
const num = (f: Omit<KnobField, "kind" | "scale"> & { scale?: number }): KnobField =>
  ({ kind: "number", scale: 1, ...f });
const sw = (f: Pick<KnobField, "id" | "path" | "band" | "label" | "hint" | "def" | "sub">): KnobField =>
  ({ kind: "switch", unit: "", scale: 1, min: 0, max: 1, step: 1, ...f });

export const KNOB_FIELDS: readonly KnobField[] = [
  // ---- Sound card (everyday)
  num({ id: "kAgcTarget", path: ["audio", "agcTargetDb"], band: "sound", label: "Target loudness", hint: "Where every transmission is steered", unit: "dBFS", min: -40, max: -3, step: 1, def: H.agcTargetDb }),
  num({ id: "kAgcMax", path: ["audio", "agcMaxGainDb"], band: "sound", label: "Max boost", hint: "Most a quiet talker is lifted", unit: "dB", min: 0, max: 30, step: 1, def: H.agcMaxGainDb }),
  num({ id: "kLpf", path: ["scan", "fmAudioLpfHz"], band: "sound", label: "Hiss cut (FM)", hint: "Lower = less weak-signal hiss, duller voice", unit: "Hz", min: 1000, max: 24000, step: 100, def: H.fmAudioLpfHz }),
  num({ id: "kHpf", path: ["scan", "fmAudioHpfHz"], band: "sound", label: "Hum filter (FM)", hint: "Strips the sub-audible tone; 0 = off", unit: "Hz", min: 50, max: 1000, step: 10, def: H.fmAudioHpfHz, allowZero: true }),
  num({ id: "kAmGain", path: ["scan", "nativeAmGainDb"], band: "sound", label: "Airband balance", hint: "AM loudness against FM", unit: "dB", min: -30, max: 20, step: 1, def: H.nativeAmGainDb }),
  // ---- Loudness detail
  num({ id: "kAgcAttack", path: ["audio", "agcAttackMs"], band: "loudness", label: "Attack", hint: "How fast a loud burst is pulled down", unit: "ms", min: 1, max: 200, step: 1, def: H.agcAttackMs }),
  num({ id: "kAgcRelease", path: ["audio", "agcReleaseMs"], band: "loudness", label: "Release", hint: "How fast a quiet talker is lifted", unit: "ms", min: 20, max: 5000, step: 10, def: H.agcReleaseMs }),
  num({ id: "kAgcHold", path: ["audio", "agcHoldBelowDb"], band: "loudness", label: "Hold below", hint: "Pauses quieter than this freeze the gain", unit: "dBFS", min: -90, max: -20, step: 1, def: H.agcHoldBelowDb }),
  num({ id: "kAgcMin", path: ["audio", "agcMinGainDb"], band: "loudness", label: "Min gain", hint: "Most a loud talker is cut", unit: "dB", min: -40, max: 0, step: 1, def: H.agcMinGainDb }),
  num({ id: "kLimCeil", path: ["audio", "limiterCeiling"], band: "loudness", label: "Limiter ceiling", hint: "Peak level, linear (at most 0.8)", unit: "FS", min: 0.05, max: 0.8, step: 0.05, def: H.limiterCeiling }),
  num({ id: "kLimRel", path: ["audio", "limiterReleaseMs"], band: "loudness", label: "Limiter release", hint: "Recovery after a clipped peak", unit: "ms", min: 5, max: 1000, step: 5, def: H.limiterReleaseMs }),
  // ---- Group shape
  num({ id: "kLanes", path: ["scan", "lanesPerGroup"], band: "shape", label: "Lanes per group", hint: "Channels one tune can hold", unit: "", min: 1, max: MAX_LANES_PER_GROUP, step: 1, def: DEFAULT_LANES_PER_GROUP, int: true }),
  num({ id: "kRate", path: ["scan", "sampleRateHz"], band: "shape", label: "Sample rate", hint: "Above ~2.56 Msps dongles tend to drop samples", unit: "Msps", scale: 1e6, int: true, min: MIN_SAMPLE_RATE_HZ / 1e6, max: MAX_SAMPLE_RATE_HZ / 1e6, step: 0.05, def: DEFAULT_SAMPLE_RATE_HZ / 1e6 }),
  num({ id: "kWindow", path: ["scan", "windowBandwidthHz"], band: "shape", label: "Window", hint: "Widest group span, at most rate − 0.05", unit: "MHz", scale: 1e6, int: true, min: 0.1, max: (MAX_SAMPLE_RATE_HZ - LANE_HZ) / 1e6, step: 0.05, def: DEFAULT_WINDOW_BANDWIDTH_HZ / 1e6 }),
  num({ id: "kFlat", path: ["scan", "flatBandwidthHz"], band: "shape", label: "Flat passband", hint: "Grouping keeps channels inside this where it's free", unit: "MHz", scale: 1e6, int: true, min: 0.1, max: (MAX_SAMPLE_RATE_HZ - LANE_HZ) / 1e6, step: 0.05, def: DEFAULT_FLAT_BANDWIDTH_HZ / 1e6 }),
  // ---- Scheduling
  sw({ id: "kAutoDwell", path: ["scan", "autoDwell", "enabled"], band: "schedule", label: "Smart dwell", hint: "Busy groups get longer, idle ones shorter", def: AUTO_DWELL_DEFAULTS.enabled }),
  num({ id: "kHalfLife", path: ["scan", "autoDwell", "halfLifeMin"], band: "schedule", label: "Memory", hint: "Half-life of the activity count", unit: "min", min: 1, max: 1440, step: 1, def: AUTO_DWELL_DEFAULTS.halfLifeMin }),
  num({ id: "kMinFactor", path: ["scan", "autoDwell", "minFactor"], band: "schedule", label: "Idle group floor", hint: "Shortest dwell, as a multiple of group dwell", unit: "×", min: 0.2, max: 1, step: 0.1, def: AUTO_DWELL_DEFAULTS.minFactor }),
  num({ id: "kMaxFactor", path: ["scan", "autoDwell", "maxFactor"], band: "schedule", label: "Busy group ceiling", hint: "Longest dwell, as a multiple of group dwell", unit: "×", min: 1, max: 5, step: 0.1, def: AUTO_DWELL_DEFAULTS.maxFactor }),
  sw({ id: "kRevisit", path: ["scan", "priorityRevisit", "enabled"], band: "schedule", label: "Peek at priority channels", hint: "", def: PRIORITY_REVISIT_DEFAULTS.enabled, sub: "Priority revisit" }),
  num({ id: "kRevisitEvery", path: ["scan", "priorityRevisit", "everyMs"], band: "schedule", label: "Every", hint: "Quiet scanning between peeks", unit: "s", scale: 1000, int: true, min: 1, max: 60, step: 0.5, def: PRIORITY_REVISIT_DEFAULTS.everyMs / 1000 }),
  num({ id: "kRevisitLook", path: ["scan", "priorityRevisit", "lookMs"], band: "schedule", label: "Look", hint: "Length of one peek (0.7 s or more to open)", unit: "s", scale: 1000, int: true, min: 0.3, max: 5, step: 0.1, def: PRIORITY_REVISIT_DEFAULTS.lookMs / 1000 }),
  // ---- Helper watchdogs
  num({ id: "kReadyTo", path: ["scan", "helperReadyTimeoutMs"], band: "watchdog", label: "Ready timeout", hint: "Startup grace before a respawn", unit: "s", scale: 1000, int: true, min: 1, max: 120, step: 1, def: DEFAULT_READY_TIMEOUT_MS / 1000 }),
  num({ id: "kSilenceTo", path: ["scan", "helperSilenceTimeoutMs"], band: "watchdog", label: "Silence timeout", hint: "No events for this long counts as stalled", unit: "s", scale: 1000, int: true, min: 1, max: 120, step: 1, def: DEFAULT_SILENCE_TIMEOUT_MS / 1000 }),
];

export const KNOB_BY_ID: Record<string, KnobField> = Object.fromEntries(KNOB_FIELDS.map((f) => [f.id, f]));

export const ADVANCED_BANDS: ReadonlyArray<{ band: Exclude<Band, "sound">; title: string; purpose: string }> = [
  { band: "loudness", title: "Loudness detail", purpose: "How fast the leveller reacts, and the peak limiter behind it." },
  { band: "shape", title: "Group shape", purpose: "How many channels one SDR tune covers. Fewer groups make a shorter cycle." },
  { band: "schedule", title: "Scheduling", purpose: "How long each group gets, and peeks at priority channels." },
  { band: "watchdog", title: "Helper watchdogs", purpose: "When a stalled DSP helper is killed and respawned. Saved now, used after the next backend restart (System → Restart radio backend)." },
];

export type KnobValues = Record<string, string | boolean>;

// Trim float noise (2.5000000001 -> "2.5") for display.
const fmt = (n: number): string => String(Number(n.toFixed(4)));
const minus = (s: string): string => s.replace(/-/g, "−");

function getAt(obj: unknown, path: readonly string[]): unknown {
  let cur: unknown = obj;
  for (const k of path) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

// Set (or, for undefined, delete) a nested key, creating intermediate objects
// and removing any intermediate object the delete leaves empty.
function setAt(obj: Record<string, unknown>, path: readonly string[], value: unknown): void {
  const [head, ...rest] = path;
  if (head === undefined) return;
  if (rest.length === 0) {
    if (value === undefined) delete obj[head];
    else obj[head] = value;
    return;
  }
  const child = obj[head];
  const next: Record<string, unknown> = child !== null && typeof child === "object" ? child as Record<string, unknown> : {};
  setAt(next, rest, value);
  if (Object.keys(next).length === 0) delete obj[head];
  else obj[head] = next;
}

export function readKnob(cfg: Config, f: KnobField): string | boolean {
  const v = getAt(cfg, f.path);
  if (f.kind === "switch") return typeof v === "boolean" ? v : f.def as boolean;
  return typeof v === "number" ? fmt(v / f.scale) : "";
}

function rangeText(f: KnobField): string {
  const u = f.unit ? ` ${f.unit}` : "";
  const r = `${minus(fmt(f.min))}…${minus(fmt(f.max))}${u}`;
  return f.allowZero ? `0 (off) or ${r}` : r;
}

export function parseKnob(f: KnobField, raw: string): number | undefined {
  const s = raw.trim();
  if (s === "") return undefined;
  const n = Number(s);
  const inRange = Number.isFinite(n) && ((n >= f.min && n <= f.max) || (f.allowZero === true && n === 0));
  if (!inRange) throw new Error(`${f.label}: ${rangeText(f)}`);
  const v = f.scale === 1 && !f.int ? n : Math.round(n * f.scale);
  if (f.path.join(".") === "scan.sampleRateHz" && v % LANE_HZ !== 0) {
    throw new Error(`${f.label}: a multiple of ${fmt(LANE_HZ / 1e6)} Msps`);
  }
  return v;
}

export function knobUi(values: KnobValues, id: string): number {
  const f = KNOB_BY_ID[id];
  if (!f) throw new Error(`unknown knob ${id}`);
  const raw = values[id];
  if (typeof raw === "string" && raw.trim() !== "") {
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
  }
  return f.def as number;
}

export function windowError(windowHz: number, rateHz: number): string | null {
  if (windowHz <= rateHz - LANE_HZ) return null;
  return `Window ${fmt(windowHz / 1e6)} MHz is wider than rate − ${fmt(LANE_HZ / 1e6)} (${fmt((rateHz - LANE_HZ) / 1e6)}). Raise the rate or narrow the window.`;
}

export function applyKnobs(cfg: Config, fields: readonly KnobField[], values: KnobValues): Config {
  const root = cfg as unknown as Record<string, unknown>;
  for (const f of fields) {
    if (!(f.id in values)) continue;
    const raw = values[f.id];
    const v = f.kind === "switch" ? raw === true : parseKnob(f, typeof raw === "string" ? raw : "");
    setAt(root, f.path, v);
  }
  const rate = cfg.scan.sampleRateHz ?? DEFAULT_SAMPLE_RATE_HZ;
  const win = cfg.scan.windowBandwidthHz ?? DEFAULT_WINDOW_BANDWIDTH_HZ;
  const err = windowError(win, rate);
  if (err) throw new Error(err);
  return cfg;
}

export function dirtyBands(fields: readonly KnobField[], loaded: KnobValues, current: KnobValues): Set<Band> {
  const out = new Set<Band>();
  for (const f of fields) {
    if (f.id in current && current[f.id] !== loaded[f.id]) out.add(f.band);
  }
  return out;
}

export function saveCost(card: "sound" | "advanced", bands: ReadonlySet<Band>): { label: string; note: string; warn: boolean } {
  if (card === "sound") {
    return bands.size > 0
      ? { label: "Save and restart scanning", note: "Audio cuts for a moment and the wall replays its warm-up.", warn: true }
      : { label: "Save sound", note: "Volume and mute stay on the Now panel and apply instantly.", warn: false };
  }
  const costs = new Set([...bands].map((b) => BAND_COST[b]));
  const bits: string[] = [];
  if (costs.has("scan")) bits.push("audio cuts for a moment");
  if (costs.has("live")) bits.push("scheduling applies at once");
  if (costs.has("backend")) bits.push("watchdogs apply after a backend restart (System → Restart radio backend)");
  const note = bits.length ? bits.join("; ").replace(/^./, (c) => c.toUpperCase()) + "." : "Nothing changed.";
  return { label: costs.has("scan") ? "Save and restart scanning" : "Save engine settings", note, warn: costs.has("scan") };
}

// ---- Loudness curve: first-order steady-state picture of the speaker AGC +
// limiter (attack/release not modelled): out = min(ceil, x + clamp(target - x,
// minGain, maxGain)), levels in dBFS, ceiling = 20 log10(limiterCeiling).
export interface CurveParams { targetDb: number; maxGainDb: number; minGainDb: number; holdBelowDb: number; limiterCeiling: number }

const CURVE_LO = -70;
const CURVE_HI = 0;

export function loudnessOut(xDb: number, p: CurveParams): number {
  const ceil = 20 * Math.log10(p.limiterCeiling);
  const gain = Math.max(p.minGainDb, Math.min(p.maxGainDb, p.targetDb - xDb));
  return Math.min(ceil, xDb + gain);
}

export function loudnessCurve(p: CurveParams): { points: Array<[number, number]>; ceilDb: number; caption: string } {
  const points: Array<[number, number]> = [];
  for (let x = CURVE_LO; x <= CURVE_HI; x++) points.push([x, loudnessOut(x, p)]);
  const caption = `Talkers from ${minus(fmt(p.targetDb - p.maxGainDb))} to ${minus(fmt(p.targetDb - p.minGainDb))} dBFS come out at ${minus(fmt(p.targetDb))}`;
  return { points, ceilDb: 20 * Math.log10(p.limiterCeiling), caption };
}

export function curveSvg(p: CurveParams): string {
  const L = 30, R = 292, T = 8, B = 128;
  const sx = (x: number): number => L + (x - CURVE_LO) / (CURVE_HI - CURVE_LO) * (R - L);
  const sy = (y: number): number => B - (Math.max(CURVE_LO, y) - CURVE_LO) / (CURVE_HI - CURVE_LO) * (B - T);
  const { points, ceilDb } = loudnessCurve(p);
  const d = points.map(([x, y], i) => `${i ? "L" : "M"}${sx(x).toFixed(1)} ${sy(y).toFixed(1)}`).join("");
  const holdX = sx(Math.max(CURVE_LO, Math.min(CURVE_HI, p.holdBelowDb)));
  const ticks = [-60, -40, -20, 0].map((v) => `<text x="${sx(v)}" y="${B + 12}" text-anchor="middle">${minus(String(v))}</text>`).join("");
  return (
    `<rect class="lc-hold" x="${L}" y="${T}" width="${(holdX - L).toFixed(1)}" height="${B - T}"/>` +
    `<text x="${L + 4}" y="${T + 12}">gain held</text>` +
    `<line class="lc-unity" x1="${sx(CURVE_LO)}" y1="${sy(CURVE_LO)}" x2="${sx(CURVE_HI)}" y2="${sy(CURVE_HI)}"/>` +
    `<line class="lc-target" x1="${L}" y1="${sy(p.targetDb).toFixed(1)}" x2="${R}" y2="${sy(p.targetDb).toFixed(1)}"/>` +
    `<text x="${R - 2}" y="${(sy(p.targetDb) - 4).toFixed(1)}" text-anchor="end">target ${minus(fmt(p.targetDb))}</text>` +
    `<line class="lc-ceil" x1="${L}" y1="${sy(ceilDb).toFixed(1)}" x2="${R}" y2="${sy(ceilDb).toFixed(1)}"/>` +
    `<text x="${L + 4}" y="${(sy(ceilDb) - 3).toFixed(1)}">limiter</text>` +
    `<path class="lc-curve" d="${d}"/>` +
    `<line class="lc-axis" x1="${L}" y1="${B}" x2="${R}" y2="${B}"/>` +
    ticks
  );
}

// ---- Group-shape preview: the same pure grouping the engine runs, over the
// channels the server would scan (isScannable, as toScanConfig filters). No
// NWR background channel: the appliance has a dedicated weather radio.
// Cycle = sum of each group's dwell (groupDwellMs x its max bank dwellWeight) at
// autoDwell factor 1. The dwell timer runs from the tune, so the ~0.64 s post-
// hop warm-up is inside it (measured 2026-09-27: 10 groups at 1500 ms ~ 15.5 s).
// "Quiet" because holds lengthen it.
export interface PreviewInput { channels: Channel[]; banks: Bank[]; lanes: number; windowHz: number; flatHz: number; rateHz: number; groupDwellMs: number }
export type Preview =
  | { ok: true; groups: number; channels: number; edge: number; cycleS: number; priorityGroups: number }
  | { ok: false; error: string };

export function previewGroups(i: PreviewInput): Preview {
  const err = windowError(i.windowHz, i.rateHz);
  if (err) return { ok: false, error: err };
  const scannable = i.channels.filter((c) => isScannable(c, i.banks));
  const groups = groupChannels(scannable, i.windowHz, Math.max(1, Math.round(i.lanes)), { flatHz: i.flatHz });
  let channels = 0, edge = 0, dwellMs = 0, priorityGroups = 0;
  for (const g of groups) {
    channels += g.channels.length;
    edge += g.channels.filter((c) => Math.abs(c.freq - g.centerHz) > i.flatHz / 2).length;
    dwellMs += i.groupDwellMs * Math.max(1, ...g.channels.map((c) => profileFor(c, i.banks).dwellWeight ?? 1));
    if (g.channels.some((c) => c.priority === true)) priorityGroups++;
  }
  return { ok: true, groups: groups.length, channels, edge, cycleS: Math.round(dwellMs / 100) / 10, priorityGroups };
}

export function previewText(p: Preview): string {
  if (!p.ok) return p.error;
  return `${p.groups} group${p.groups === 1 ? "" : "s"} from ${p.channels} channels, ${p.edge} outside the flat passband. Quiet cycle ≈ ${fmt(p.cycleS)} s.`;
}

export function revisitHint(p: Preview): string {
  if (!p.ok || p.priorityGroups === 0) return "No channel is marked priority yet, so this is idle";
  return `Peeks at ${p.priorityGroups} priority group${p.priorityGroups === 1 ? "" : "s"}`;
}
