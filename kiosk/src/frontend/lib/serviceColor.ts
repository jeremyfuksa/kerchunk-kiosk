import { serviceFor } from "../../backend/config/banks.js";

// The pin heads' palette, applied to the TRANSIENT layer too (operator:
// "match the blip colors to the pins") — a rail hit pulses train-orange,
// a ham hit pink. Frequencies outside the family pulse the unknown gray.
export const PIN_COLORS: Record<string, string> = {
  air: "#3478F5", rail: "#F5821F", ham: "#EC4E89", gmrs: "#1FA84C",
  biz: "#7C4FE0", marine: "#0FAEC0", weather: "#F4B315", unknown: "#747B8A",
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
  if (svc && (svc.includes("biz") || svc.includes("PS") || svc.includes("trunked") || svc === "T-band")) return PIN_COLORS.biz!;
  return PIN_COLORS.unknown!;
}
