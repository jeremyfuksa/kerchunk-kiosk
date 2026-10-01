// What the kiosk's bottom-left corner shows (spec 2026-10-01): the small idle
// pill or the wall-size glass. Pure — dashboard.ts feeds it state and paints
// the result; tests pin every one of the twelve approved states.
import { categoryFor, type PinCategory } from "../lib/serviceColor.js";
import { spectrumLabelFor } from "../../backend/config/banks.js";
import { fmtFreq } from "../lib/format.js";
import { segmentsLit, type LcdInput } from "../faceplate/lcd.js";
import { serviceHead, type ServiceHead } from "../faceplate/serviceHead.js";

/** Segments in the glass meter and the warm-up pill — one instrument. */
export const METER_SEGMENTS = 12;
/** The kiosk meter's dB range: the floor lights nothing, the ceiling all. */
export const METER_RANGE_DB = { floor: -35, ceil: 5 } as const;

export const WARM_LABELS: Record<string, string> = {
  booting: "starting the radio",
  spawning: "building signal processing",
  tuned: "acquiring channels",
  ready: "ready",
};

export const ERROR_HINT = "Scanning resumes on its own. If this stays up, restart the radio from System in the admin.";

/** dB → 0..1 across METER_RANGE_DB (unclamped; the LCD clamps). */
export function meterFill(db: number | null): number {
  return db === null ? 0 : (db - METER_RANGE_DB.floor) / (METER_RANGE_DB.ceil - METER_RANGE_DB.floor);
}

const WINDOW_NAMES: Record<string, string> = {
  AIRBAND: "Airband", "2M": "2 m", "VHF-HI": "VHF high", "1.25M": "1.25 m", "70CM": "70 cm",
  "UHF-T": "UHF-T", "T-BAND": "T-band", "700": "700 MHz", "800": "800 MHz", "900": "900 MHz",
};

/** The tuned window, e.g. "VHF high 160.9" — the old bank rail's spectrum chip, in words. */
export function windowLabel(hz: number): string {
  const raw = spectrumLabelFor(hz);
  return `${WINDOW_NAMES[raw] ?? raw} ${(hz / 1e6).toFixed(1)}`;
}

const SERVICE_LABEL: Record<PinCategory, string> = {
  air: "Air", rail: "Rail", ham: "Ham", gmrs: "GMRS", biz: "Business", marine: "Marine",
  weather: "Weather", publicsafety: "Public safety", unknown: "",
};
export function serviceLabel(cat: PinCategory): string { return SERVICE_LABEL[cat]; }

/** "TORNADO WARNING" → "Tornado warning". Mixed case (an operator's channel name) is left alone. */
export function sentenceCase(s: string): string {
  return /[a-z]/.test(s) ? s : s.charAt(0) + s.slice(1).toLowerCase();
}

export interface CornerInput {
  warmed: boolean; warmupPhase: string | null; warmupStep: number; warmupOf: number;
  error: string | null; engineState: string;
  nowPlaying: { freq: number; alphaTag: string; tags?: readonly string[] } | null;
  tunedHz: number | null; scanCount: number; muted: boolean;
  mode: "scan" | "weather" | "monitor"; breakIn: boolean;
}
export interface PillView { show: "pill"; key: string; word: string; detail: string; tone: "plain" | "hay"; muted: boolean; sweep: boolean; warmLit: number | null }
export interface GlassView { show: "glass"; key: string; lcd: LcdInput; head: ServiceHead | null; hint: string | null; meter: boolean }
export type CornerView = PillView | GlassView;

// A head that can't be built (a pin SVG that lost its glyph group) must not
// take the wall down: the glass renders without it.
function safeHead(cat: PinCategory): ServiceHead | null {
  try { return serviceHead(cat); } catch { return null; }
}

function pill(p: Omit<PillView, "show" | "key">): PillView {
  return { show: "pill", key: `pill|${p.word}|${p.detail}|${p.tone}|${p.muted}|${p.sweep}|${p.warmLit}`, ...p };
}

function glass(g: Omit<GlassView, "show" | "key">): GlassView {
  const l = g.lcd;
  return { show: "glass", key: `glass|${l.state}|${l.meta}|${l.name}|${l.freq}|${l.silent}|${g.head?.color ?? ""}|${g.hint ?? ""}`, ...g };
}

function modeWord(mode: CornerInput["mode"]): string {
  return mode === "weather" ? "Weather only" : mode === "monitor" ? "Listening to one channel" : "Scanning";
}

export function cornerView(i: CornerInput): CornerView {
  if (!i.warmed) {
    const label = i.warmupPhase ? (WARM_LABELS[i.warmupPhase] ?? i.warmupPhase) : WARM_LABELS.booting!;
    return pill({
      word: "Warming up", detail: `step ${i.warmupStep} of ${i.warmupOf} · ${label}`, tone: "plain",
      muted: i.muted, sweep: false, warmLit: segmentsLit(i.warmupStep / i.warmupOf, METER_SEGMENTS),
    });
  }
  if (i.error) {
    return glass({ lcd: { state: "error", meta: "Radio error", name: i.error, freq: "", silent: null }, head: null, hint: ERROR_HINT, meter: false });
  }
  if (i.nowPlaying) {
    const { freq, alphaTag, tags } = i.nowPlaying;
    const cat = categoryFor(freq, tags);
    const prefix = i.breakIn ? "Weather break-in"
      : i.mode === "weather" ? "Weather only"
      : i.mode === "monitor" ? "Listening to one channel" : "Live";
    // A break-in is always NOAA weather radio — say so, not "· Weather".
    const svc = i.breakIn ? "NOAA" : serviceLabel(cat);
    return glass({
      lcd: {
        state: i.breakIn ? "breakin" : "live",
        meta: svc ? `${prefix} · ${svc}` : prefix,
        name: alphaTag || fmtFreq(freq),
        freq: alphaTag ? fmtFreq(freq) : "",
        silent: i.muted ? "Muted" : null,
      },
      head: safeHead(cat), hint: null, meter: true,
    });
  }
  if (i.engineState === "starting") {
    return pill({ word: "Retuning", detail: "changing windows", tone: "plain", muted: i.muted, sweep: true, warmLit: null });
  }
  if (i.scanCount === 0) {
    return pill({ word: "Standby", detail: "no channels are on — turn a bank on in the admin", tone: "hay", muted: i.muted, sweep: false, warmLit: null });
  }
  return pill({
    word: modeWord(i.mode), detail: i.tunedHz !== null ? windowLabel(i.tunedHz) : "",
    tone: "plain", muted: i.muted, sweep: true, warmLit: null,
  });
}
