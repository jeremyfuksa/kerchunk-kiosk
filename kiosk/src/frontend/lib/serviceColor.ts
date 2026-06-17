import { serviceFor } from "../../backend/config/banks.js";

// The pin heads' palette, applied to the TRANSIENT layer too (operator:
// "match the blip colors to the pins") — a rail hit pulses rust, a ham hit
// pink. Frequencies outside the family pulse the unknown gray.
export const PIN_COLORS: Record<string, string> = {
  air: "#3478F5", rail: "#8B5034", ham: "#EC4E89", gmrs: "#1FA84C",
  biz: "#6D28D9", marine: "#0FAEC0", weather: "#F4B315", unknown: "#747B8A",
  publicsafety: "#E5383B",
};
const UNKNOWN_POSITION_COLOR = "#4a7c7e";

export function colorFor(freqHz: number | undefined, kind: "active" | "closecall" | "nofix"): string {
  // Synthetic unknown positions must read as uncertain geography, even when
  // the frequency falls inside a recognizable service allocation.
  if (kind === "nofix") return UNKNOWN_POSITION_COLOR;
  if (freqHz === undefined) return kind === "closecall" ? "#dc3a38" : "#ff6b35";
  const svc = serviceFor(freqHz);
  if (svc === "air") return PIN_COLORS.air!;
  if (svc === "rail") return PIN_COLORS.rail!;
  if (svc?.startsWith("ham")) return PIN_COLORS.ham!;
  if (svc === "GMRS/FRS") return PIN_COLORS.gmrs!;
  if (svc === "marine") return PIN_COLORS.marine!;
  if (svc === "NOAA wx") return PIN_COLORS.weather!;
  // Public safety gets its own red: the dedicated 700 MHz PS band and 800 MHz
  // trunked systems (the metro's primary PS presence). The mixed conventional
  // "biz/PS" bands and T-band stay biz — not separable from business by freq.
  if (svc === "700 PS" || svc?.includes("trunked")) return PIN_COLORS.publicsafety!;
  if (svc && (svc.includes("biz") || svc === "T-band")) return PIN_COLORS.biz!;
  return PIN_COLORS.unknown!;
}
