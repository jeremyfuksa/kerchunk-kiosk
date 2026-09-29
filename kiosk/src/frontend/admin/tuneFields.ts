// Tune's field table: every setting on the Tune tab, in display order, with
// how it reads from / writes to config and what saving it costs (spec §4).
// Pure — no DOM. Engine knobs come from engineKnobs.ts (the one source of
// truth for their ranges and defaults); the rest use the ranges the classic
// Settings page used. Values are UI strings ("" = unset → engine default) or
// booleans for switches — the same shape as engineKnobs' KnobValues.
import type { Config } from "../../backend/config/schema.js";
import { DEFAULT_GROUP_DWELL_MS } from "../../backend/config/engineDefaults.js";
import { BAND_COST, KNOB_BY_ID, KNOB_FIELDS, applyKnobs, readKnob, type Band, type KnobField } from "./engineKnobs.js";

export type TuneGroup = "sound" | "scanning" | "discovery" | "alerts" | Exclude<Band, "sound">;
/** live = saved on change; scan = batched countdown (engine restart);
 *  heavy = explicit Apply (engine restart, rarely wanted by accident);
 *  backend = saved now, used after the next radio restart. */
export type TuneCost = "live" | "scan" | "heavy" | "backend";
export type TuneValue = string | boolean;
export type TuneValues = Record<string, TuneValue>;
export type TuneControl =
  | { kind: "slider"; min: number; max: number; step: number; unit: string; ends: [string, string] }
  | { kind: "number"; min?: number; max?: number; step: number; unit: string }
  | { kind: "switch" }
  | { kind: "text"; placeholder: string };

export interface TuneField {
  id: string;
  group: TuneGroup;
  label: string;
  hint: string;
  cost: TuneCost;
  control: TuneControl;
  /** Default in UI units — shown when the value is blank. */
  def: TuneValue;
  /** "" = unset for numbers/text; a boolean for switches. */
  read(cfg: Config): TuneValue;
  /** Write a UI value into cfg ("" resets to default). Throws a readable Error. */
  write(cfg: Config, v: TuneValue): void;
}

export const GROUP_TITLES: Record<TuneGroup, string> = {
  sound: "Sound", scanning: "Scanning", discovery: "Discovery", alerts: "Alerts",
  loudness: "Loudness detail", shape: "Group shape", schedule: "Scheduling", watchdog: "Helper watchdogs",
};

// ---- helpers ---------------------------------------------------------------
const blank = (n: number | undefined | null): string => (n == null ? "" : String(n));
const str = (v: TuneValue): string => (typeof v === "string" ? v.trim() : "");

function num(label: string, v: TuneValue, o: { min?: number; max?: number; int?: boolean }): number | undefined {
  const t = str(v);
  if (t === "") return undefined;
  const n = Number(t);
  const range = o.max != null ? `${o.min ?? "any"}–${o.max}` : `${o.min} or more`;
  if (!Number.isFinite(n) || (o.min != null && n < o.min) || (o.max != null && n > o.max) || (o.int && !Number.isInteger(n))) {
    throw new Error(`${label}: enter ${range}`);
  }
  return n;
}

type Scan = Config["scan"];
function setScan<K extends keyof Scan>(cfg: Config, k: K, v: Scan[K] | undefined): void {
  if (v === undefined) delete cfg.scan[k]; else cfg.scan[k] = v;
}
type Alerts = NonNullable<Config["alerts"]>;
function setAlert<K extends keyof Alerts>(cfg: Config, k: K, v: Alerts[K] | undefined): void {
  const a: Alerts = { ...(cfg.alerts ?? {}) };
  if (v === undefined) delete a[k]; else a[k] = v;
  if (Object.keys(a).length) cfg.alerts = a; else delete cfg.alerts;
}

export function parseSweep(raw: string): Array<{ loHz: number; hiHz: number }> {
  return raw.split(",").map((x) => x.trim()).filter(Boolean).map((x) => {
    const m = /^([\d.]+)\s*-\s*([\d.]+)$/.exec(x);
    if (!m) throw new Error(`Sweep ranges: "${x}" must be low-high in MHz, e.g. 450-470`);
    const loHz = Math.round(Number(m[1]) * 1e6);
    const hiHz = Math.round(Number(m[2]) * 1e6);
    if (!(loHz > 0 && hiHz > loHz)) throw new Error(`Sweep ranges: in "${x}" the second number must be higher`);
    return { loHz, hiHz };
  });
}
export const sweepText = (r: ReadonlyArray<{ loHz: number; hiHz: number }>): string =>
  r.map((x) => `${x.loHz / 1e6}-${x.hiHz / 1e6}`).join(", ");

// ---- engine knobs → fields --------------------------------------------------
const SOUND_ENDS: Record<string, [string, string]> = {
  kAgcTarget: ["Quieter", "Louder"],
  kAgcMax: ["Less lift", "More lift"],
  kLpf: ["Less hiss", "Brighter"],
  kHpf: ["Off", "Stronger"],
  kAmGain: ["Quieter AM", "Louder AM"],
};

function fromKnob(k: KnobField): TuneField {
  const ends = SOUND_ENDS[k.id];
  const lo = k.allowZero ? 0 : k.min;
  const control: TuneControl = k.kind === "switch" ? { kind: "switch" }
    : ends ? { kind: "slider", min: lo, max: k.max, step: k.step, unit: k.unit, ends }
    : { kind: "number", min: lo, max: k.max, step: k.step, unit: k.unit };
  return {
    id: k.id, group: k.band, label: k.label, hint: k.hint, control,
    def: typeof k.def === "number" ? String(k.def) : k.def,
    cost: k.band === "shape" ? "heavy" : BAND_COST[k.band],
    read: (cfg) => readKnob(cfg, k),
    write: (cfg, v) => { applyKnobs(cfg, [k], { [k.id]: v }, {}); },
  };
}
const knob = (id: string): TuneField => fromKnob(KNOB_BY_ID[id]!);

// ---- the table ---------------------------------------------------------------
const HANG_DEFAULT_MS = 2000;

const SCANNING: TuneField[] = [
  {
    id: "tOpenDb", group: "scanning", label: "Squelch open", hint: "How strong a signal must be to open", cost: "scan",
    control: { kind: "slider", min: 1, max: 30, step: 0.5, unit: "dB", ends: ["Hear more", "Hear less"] }, def: "9",
    read: (c) => blank(c.scan.openAboveFloorDb),
    write: (c, v) => setScan(c, "openAboveFloorDb", num("Squelch open", v, { min: 1, max: 30 })),
  },
  {
    id: "tQuietDb", group: "scanning", label: "Quieting", hint: "How clean a signal must sound to stay open", cost: "scan",
    control: { kind: "slider", min: -30, max: 0, step: 0.5, unit: "dB", ends: ["Hear less", "Hear more"] }, def: "-7",
    read: (c) => blank(c.scan.nativeQuietDb),
    write: (c, v) => setScan(c, "nativeQuietDb", num("Quieting", v, { min: -30, max: 0 })),
  },
  {
    id: "tGroupDwell", group: "scanning", label: "Group dwell", hint: "Time spent on each frequency group", cost: "scan",
    control: { kind: "slider", min: 500, max: 10_000, step: 100, unit: "ms", ends: ["Faster cycle", "Longer listen"] },
    def: String(DEFAULT_GROUP_DWELL_MS),
    read: (c) => blank(c.scan.groupDwellMs),
    write: (c, v) => setScan(c, "groupDwellMs", num("Group dwell", v, { min: 500, max: 10_000, int: true })),
  },
  {
    id: "tHang", group: "scanning", label: "Hang time", hint: "Wait after a transmission ends", cost: "scan",
    control: { kind: "slider", min: 100, max: 10_000, step: 100, unit: "ms", ends: ["Shorter", "Longer"] },
    def: String(HANG_DEFAULT_MS),
    read: (c) => String(c.scan.dwellMs),
    // dwellMs is required in the schema: blank means the default, not "unset".
    write: (c, v) => { c.scan.dwellMs = num("Hang time", v, { min: 100, max: 10_000, int: true }) ?? HANG_DEFAULT_MS; },
  },
  {
    id: "tSweep", group: "scanning", label: "Sweep ranges", hint: "MHz ranges to hunt for activity; empty turns sweeping off", cost: "scan",
    control: { kind: "text", placeholder: "450-470, 150-162" }, def: "",
    read: (c) => sweepText(c.scan.sweepRanges ?? []),
    write: (c, v) => { const r = parseSweep(str(v)); setScan(c, "sweepRanges", r.length ? r : undefined); },
  },
];

const DISCOVERY: TuneField[] = [
  {
    id: "tCloseCall", group: "discovery", label: "Close Call", hint: "Find strong nearby signals outside your channel list", cost: "scan",
    control: { kind: "switch" }, def: true,
    read: (c) => c.scan.closeCall ?? true,
    write: (c, v) => setScan(c, "closeCall", v === true),
  },
  {
    id: "tCloseCallDb", group: "discovery", label: "Close Call threshold", hint: "Higher finds fewer false signals", cost: "scan",
    control: { kind: "slider", min: 5, max: 40, step: 1, unit: "dB", ends: ["Find more", "Fewer false finds"] }, def: "15",
    read: (c) => blank(c.scan.closeCallDb),
    write: (c, v) => setScan(c, "closeCallDb", num("Close Call threshold", v, { min: 5, max: 40 })),
  },
  {
    id: "tCcRecord", group: "discovery", label: "Record samples", hint: "Keep a clip of each discovery so you can judge it by ear", cost: "heavy",
    control: { kind: "switch" }, def: false,
    read: (c) => c.scan.recordCloseCalls === true,
    write: (c, v) => setScan(c, "recordCloseCalls", v === true ? true : undefined),
  },
  {
    id: "tCcSampleSec", group: "discovery", label: "Sample length", hint: "Longest clip kept, including 2 s before the hit", cost: "live",
    control: { kind: "slider", min: 3, max: 120, step: 1, unit: "s", ends: ["Shorter clips", "Longer clips"] }, def: "20",
    read: (c) => blank(c.scan.closeCallSampleSeconds),
    write: (c, v) => setScan(c, "closeCallSampleSeconds", num("Sample length", v, { min: 3, max: 120 })),
  },
  {
    id: "tCcSampleMb", group: "discovery", label: "Sample storage", hint: "Space for clips; the oldest go first", cost: "live",
    control: { kind: "number", min: 1, max: 2000, step: 1, unit: "MB" }, def: "50",
    read: (c) => blank(c.scan.closeCallSampleMaxMb),
    write: (c, v) => setScan(c, "closeCallSampleMaxMb", num("Sample storage", v, { min: 1, max: 2000 })),
  },
];

const ALERTS: TuneField[] = [
  {
    id: "tAlertCool", group: "alerts", label: "Alert cooldown", hint: "Minimum time before repeating an alert", cost: "live",
    control: { kind: "number", min: 1, step: 1, unit: "min" }, def: "15",
    read: (c) => blank(c.alerts?.cooldownMinutes),
    write: (c, v) => setAlert(c, "cooldownMinutes", num("Alert cooldown", v, { min: 1 })),
  },
  {
    id: "tAlertHold", group: "alerts", label: "Alert hold", hint: "How long an alert stays on screen", cost: "live",
    control: { kind: "number", min: 5, step: 5, unit: "s" }, def: "30",
    read: (c) => blank(c.alerts?.holdSeconds),
    write: (c, v) => setAlert(c, "holdSeconds", num("Alert hold", v, { min: 5 })),
  },
  {
    id: "tAlertNtfy", group: "alerts", label: "Push notification URL", hint: "Optional ntfy topic", cost: "live",
    control: { kind: "text", placeholder: "https://ntfy.sh/your-topic" }, def: "",
    read: (c) => c.alerts?.ntfyUrl ?? "",
    write: (c, v) => {
      const t = str(v);
      if (t) {
        let ok = false;
        try { ok = /^https?:$/.test(new URL(t).protocol); } catch { ok = false; }
        if (!ok) throw new Error("Push notification URL: enter a full http(s) address");
      }
      setAlert(c, "ntfyUrl", t || undefined);
    },
  },
  {
    id: "tSameFips", group: "alerts", label: "SAME county codes", hint: "Comma-separated FIPS codes; empty allows all", cost: "live",
    control: { kind: "text", placeholder: "029047, 029095" }, def: "",
    read: (c) => (c.alerts?.sameFips ?? []).join(", "),
    write: (c, v) => {
      const codes = str(v).split(",").map((x) => x.trim()).filter(Boolean);
      const bad = codes.find((x) => !/^\d{5,6}$/.test(x));
      if (bad) throw new Error(`SAME county codes: "${bad}" must be 5 or 6 digits`);
      setAlert(c, "sameFips", codes.length ? codes : undefined);
    },
  },
  {
    id: "tSameTests", group: "alerts", label: "Show SAME tests", hint: "Include weekly and monthly test banners", cost: "live",
    control: { kind: "switch" }, def: false,
    read: (c) => c.alerts?.sameTests === true,
    write: (c, v) => setAlert(c, "sameTests", v === true ? true : undefined),
  },
];

/** Display order: Sound, Scanning, Discovery, Alerts, then the Advanced bands. */
export const TUNE_FIELDS: readonly TuneField[] = [
  ...KNOB_FIELDS.filter((k) => k.band === "sound").map((k) => knob(k.id)),
  ...SCANNING,
  ...DISCOVERY,
  ...ALERTS,
  ...KNOB_FIELDS.filter((k) => k.band !== "sound").map((k) => knob(k.id)),
];

export const FIELD_BY_ID: Record<string, TuneField> = Object.fromEntries(TUNE_FIELDS.map((f) => [f.id, f]));

export function readTune(cfg: Config): TuneValues {
  return Object.fromEntries(TUNE_FIELDS.map((f) => [f.id, f.read(cfg)]));
}

/** Write the given fields' values into cfg (mutates and returns it). */
export function applyTune(cfg: Config, ids: readonly string[], values: TuneValues): Config {
  for (const id of ids) {
    const f = FIELD_BY_ID[id];
    if (f) f.write(cfg, values[id] ?? f.def);
  }
  return cfg;
}

/** Close Call off greys out its settings; recording off greys out the clip settings. */
export function disabledIds(v: TuneValues): Set<string> {
  const off = new Set<string>();
  if (v.tCloseCall === false) for (const id of ["tCloseCallDb", "tCcRecord", "tCcSampleSec", "tCcSampleMb"]) off.add(id);
  else if (v.tCcRecord !== true) for (const id of ["tCcSampleSec", "tCcSampleMb"]) off.add(id);
  return off;
}

/** Fields whose 0 means "off" (hum filter) have a dead zone below their
 *  minimum: the lower half snaps to off, the upper half to the minimum. */
export function snapValue(f: TuneField, n: number): number {
  const k = KNOB_BY_ID[f.id];
  if (!k?.allowZero || n <= 0 || n >= k.min) return n;
  return n < k.min / 2 ? 0 : k.min;
}

export function isDefault(f: TuneField, v: TuneValue): boolean {
  if (typeof v === "boolean" || typeof f.def === "boolean") return v === f.def;
  // Text fields (URLs, FIPS lists, sweep ranges) aren't numeric: "0" and ""
  // are equal under Number() but not the same value for a free-text field.
  if (f.control.kind === "text") return v.trim() === str(f.def);
  return v.trim() === "" || Number(v) === Number(f.def);
}

/** True when `v` would save nothing new over what the radio has (`loaded`):
 *  the same value (numbers compared numerically, text trimmed), or an unset
 *  field ("" = default) landing on its displayed default. Writing that
 *  default explicitly would read as unset → value on the server and restart
 *  the scanner for nothing. Resetting a set field to "" IS a change. */
export function isNoChange(f: TuneField, v: TuneValue, loaded: TuneValue): boolean {
  if (v === loaded) return true;
  if (typeof v === "boolean" || typeof loaded === "boolean") return false;
  const a = v.trim(), b = loaded.trim();
  if (a === b) return true;
  if (b === "") return isDefault(f, v);
  if (a === "" || f.control.kind === "text") return false;
  return Number.isFinite(Number(a)) && Number(a) === Number(b);
}

/** isNoChange against what the radio WILL have: the value in an unresolved
 *  save when there is one (`inflight`), else what was last loaded. Comparing
 *  against `loaded` while a save is in flight would call "put it back to the
 *  old value" a no-op — and leave the radio on the value in flight. */
export function isNoOp(f: TuneField, v: TuneValue, loaded: TuneValue, inflight?: TuneValue): boolean {
  return isNoChange(f, v, inflight !== undefined ? inflight : loaded);
}
