// ── US service allocations (operator: label what KIND of hit a Close Call
// is from frequency alone — and expose when one is a true OUTBAND oddity).
// Coarse on purpose: a triage label, not a band plan.
export const ALLOCATIONS: Array<{ lo: number; hi: number; svc: string }> = [
  { lo: 118_000_000, hi: 137_000_000, svc: "air" },
  { lo: 144_000_000, hi: 148_000_000, svc: "ham 2m" },
  { lo: 156_000_000, hi: 157_450_000, svc: "marine" },
  { lo: 159_810_000, hi: 161_565_000, svc: "rail" },
  { lo: 161_600_000, hi: 162_025_000, svc: "marine" },
  { lo: 162_400_000, hi: 162_550_000, svc: "NOAA wx" },
  { lo: 148_000_000, hi: 174_000_000, svc: "VHF biz/PS" },   // after the carve-outs above
  { lo: 222_000_000, hi: 225_000_000, svc: "ham 1.25m" },
  { lo: 420_000_000, hi: 450_000_000, svc: "ham 70cm" },
  { lo: 462_537_500, hi: 462_737_500, svc: "GMRS/FRS" },
  { lo: 467_537_500, hi: 467_737_500, svc: "GMRS/FRS" },
  { lo: 450_000_000, hi: 470_000_000, svc: "UHF biz/PS" },   // after GMRS carve-outs
  { lo: 470_000_000, hi: 512_000_000, svc: "T-band" },
  { lo: 764_000_000, hi: 776_000_000, svc: "700 PS" },
  { lo: 794_000_000, hi: 806_000_000, svc: "700 PS" },
  { lo: 806_000_000, hi: 824_000_000, svc: "800 trunked" },
  { lo: 851_000_000, hi: 869_000_000, svc: "800 trunked" },
  { lo: 929_000_000, hi: 932_000_000, svc: "paging" },
  { lo: 896_000_000, hi: 940_000_000, svc: "900 biz" },
];

/** Rough service for a frequency; undefined = a true outband hit. */
export function serviceFor(freqHz: number): string | undefined {
  // First match wins — specific carve-outs precede their parent ranges.
  return ALLOCATIONS.find((a) => freqHz >= a.lo && freqHz <= a.hi)?.svc;
}

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
