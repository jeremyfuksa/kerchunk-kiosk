import { serviceFor } from "./banks.js";

// Service FAMILY of a frequency (spec 2026-10-13 silent chatter): one
// classifier for the map's colours AND the speaker gate. Operator SERVICE
// tags (bank labels) win over the frequency guess. Some services aren't
// separable from business by frequency alone — public safety on conventional
// UHF (462–470) reads as "biz/PS" by allocation — so the operator's tag
// decides. Tags this module doesn't recognize are ignored.
export type Family =
  "air" | "rail" | "ham" | "gmrs" | "biz" | "marine" | "weather" | "publicsafety" | "unknown";

const TAG_FAMILY: Record<string, Family> = {
  "public-safety": "publicsafety",
  air: "air", rail: "rail", ham: "ham", gmrs: "gmrs",
  business: "biz", marine: "marine",
};

export function familyForService(svc: string | undefined): Family {
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

/** Family for a site: an operator service tag wins, else the frequency's
 *  service allocation. A heard-only site or transient hit with no channel
 *  has no tags and falls back to frequency. */
export function familyFor(freqHz: number | undefined, tags?: readonly string[]): Family {
  if (tags) {
    for (const t of tags) {
      const f = TAG_FAMILY[t];
      if (f) return f;
    }
  }
  return freqHz === undefined ? "unknown" : familyForService(serviceFor(freqHz));
}
