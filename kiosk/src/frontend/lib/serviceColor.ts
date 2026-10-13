import { familyFor, type Family } from "../../backend/config/family.js";
import { oklchHex, type Lch } from "./oklch.js";

export type PinCategory = Family;

// Service family palette (spec 2026-10-04 site palette): OKLCH bases searched
// for the best worst-case separation under normal / deuteranopic / protanopic
// vision inside a glow-friendly band (L 0.62–0.84). One source: PIN_COLORS,
// the pin SVGs (drift-tested), the live-card head and the glass all follow it,
// and the transient layer matches the pins (operator: "match the blip colors
// to the pins"). Frequencies outside every family pulse the unknown gray.
export const FAMILY_OKLCH: Record<Exclude<PinCategory, "unknown">, Lch> = {
  publicsafety: { L: 0.62, C: 0.20, h: 17 },
  rail: { L: 0.70, C: 0.20, h: 60 },
  weather: { L: 0.81, C: 0.18, h: 82 },
  gmrs: { L: 0.80, C: 0.16, h: 155 },
  marine: { L: 0.71, C: 0.14, h: 184 },
  biz: { L: 0.80, C: 0.23, h: 212 },
  air: { L: 0.65, C: 0.20, h: 252 },
  ham: { L: 0.64, C: 0.19, h: 327 },
};

export const PIN_COLORS: Record<string, string> = {
  ...Object.fromEntries(Object.entries(FAMILY_OKLCH).map(([k, c]) => [k, oklchHex(c)])),
  unknown: "#747B8A",
};

/** The pin/head glyph colour: whichever of white / dark ink reads better on
 *  the head (all >= 4.03:1). */
export const GLYPH_INK_DARK = "#1f2530";
export const PIN_GLYPH_INK: Record<PinCategory, string> = {
  publicsafety: "#ffffff", unknown: "#ffffff",
  rail: GLYPH_INK_DARK, weather: GLYPH_INK_DARK, gmrs: GLYPH_INK_DARK, marine: GLYPH_INK_DARK,
  biz: GLYPH_INK_DARK, air: GLYPH_INK_DARK, ham: GLYPH_INK_DARK,
};
const UNKNOWN_POSITION_COLOR = "#4a7c7e";

/** Pin/colour category — the shared family classifier (config/family.ts). */
export const categoryFor = familyFor;

export function colorFor(
  freqHz: number | undefined,
  kind: "active" | "closecall" | "nofix",
  tags?: readonly string[],
): string {
  // Synthetic unknown positions must read as uncertain geography, even when
  // the frequency falls inside a recognizable service allocation.
  if (kind === "nofix") return UNKNOWN_POSITION_COLOR;
  const cat = categoryFor(freqHz, tags);
  // No frequency AND no classifying tag → close calls stay flamingo; a live hit
  // glows sea-glass, the Faceplate's live colour (spec 2026-10-01).
  if (freqHz === undefined && cat === "unknown") return kind === "closecall" ? "#dc3a38" : "#5fd4c3";
  return PIN_COLORS[cat] ?? PIN_COLORS.unknown!;
}
