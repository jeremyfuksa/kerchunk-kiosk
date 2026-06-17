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

export type PinCategory =
  "air" | "rail" | "ham" | "gmrs" | "biz" | "marine" | "weather" | "publicsafety" | "unknown";

// Operator SERVICE tags (bank labels) win over the frequency guess. Some
// services aren't separable from business by frequency alone — public safety
// on conventional UHF (462–470) reads as "biz/PS" by allocation — so the
// operator's classification of a site, via its bank tag, decides the pin and
// the matching blip color. Tags the map doesn't recognize are ignored.
const TAG_CATEGORY: Record<string, PinCategory> = {
  "public-safety": "publicsafety",
  air: "air", rail: "rail", ham: "ham", gmrs: "gmrs",
  business: "biz", marine: "marine",
};

function categoryForService(svc: string | undefined): PinCategory {
  if (svc === "air") return "air";
  if (svc === "rail") return "rail";
  if (svc?.startsWith("ham")) return "ham";
  if (svc === "GMRS/FRS") return "gmrs";
  if (svc === "marine") return "marine";
  if (svc === "NOAA wx") return "weather";
  // Public safety gets its own red: the dedicated 700 MHz PS band and 800 MHz
  // trunked systems (the metro's primary PS presence). The mixed conventional
  // "biz/PS" bands and T-band stay biz — not separable from business by freq.
  if (svc === "700 PS" || svc?.includes("trunked")) return "publicsafety";
  if (svc && (svc.includes("biz") || svc === "T-band")) return "biz";
  return "unknown";
}

/** Pin/color category for a site: an operator service tag wins, else the
 *  frequency's service allocation. `tags` come from the site's config channel
 *  (banks); a heard-only site or transient blip with no channel has none and
 *  falls back to frequency. */
export function categoryFor(freqHz: number | undefined, tags?: readonly string[]): PinCategory {
  if (tags) {
    for (const t of tags) {
      const cat = TAG_CATEGORY[t];
      if (cat) return cat;
    }
  }
  return freqHz === undefined ? "unknown" : categoryForService(serviceFor(freqHz));
}

export function colorFor(
  freqHz: number | undefined,
  kind: "active" | "closecall" | "nofix",
  tags?: readonly string[],
): string {
  // Synthetic unknown positions must read as uncertain geography, even when
  // the frequency falls inside a recognizable service allocation.
  if (kind === "nofix") return UNKNOWN_POSITION_COLOR;
  const cat = categoryFor(freqHz, tags);
  // No frequency AND no classifying tag → the generic transient colors.
  if (freqHz === undefined && cat === "unknown") return kind === "closecall" ? "#dc3a38" : "#ff6b35";
  return PIN_COLORS[cat] ?? PIN_COLORS.unknown!;
}
