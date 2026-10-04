// Per-site colour (spec 2026-10-04 site palette): each site wears its own
// variation of its family's base — hue within ±arc, lightness within ±spread/2
// — seeded from the site key, so a transmitter keeps its colour across reloads.
// Applies to the glass (rings, smoke, sparks) and the "dot" site markers only.
import { oklchHex } from "./oklch.js";
import { FAMILY_OKLCH, PIN_COLORS, type PinCategory } from "./serviceColor.js";

export type SiteColorMode = "site" | "service";

/** ± hue degrees and total lightness spread per family. Business gets the most
 *  room (it is ~half the smoke); public safety and rail stay tight so a hospital
 *  plume never drifts toward rail orange. Containment-tested. */
export const SITE_ARC: Record<PinCategory, { hue: number; light: number }> = {
  biz: { hue: 28, light: 0.12 }, ham: { hue: 20, light: 0.12 }, gmrs: { hue: 12, light: 0.10 },
  air: { hue: 8, light: 0.10 }, publicsafety: { hue: 6, light: 0.06 }, rail: { hue: 6, light: 0.08 },
  marine: { hue: 4, light: 0.08 }, weather: { hue: 0, light: 0 }, unknown: { hue: 0, light: 0 },
};

/** Stable 0..1 per string (FNV-1a). */
function hash01(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0) / 4294967296;
}

export function siteColor(key: string, cat: PinCategory, mode: SiteColorMode): string {
  const family = PIN_COLORS[cat] ?? PIN_COLORS.unknown!;
  if (mode === "service" || cat === "unknown") return family;
  const arc = SITE_ARC[cat];
  if (arc.hue === 0 && arc.light === 0) return family;
  const base = FAMILY_OKLCH[cat];
  const u = hash01(key), v = hash01(key + "#L");
  return oklchHex({ L: base.L + arc.light * (v - 0.5), C: base.C, h: base.h + arc.hue * (2 * u - 1) });
}
