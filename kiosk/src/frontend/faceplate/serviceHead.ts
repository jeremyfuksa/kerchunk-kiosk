// The service head: the round, service-coloured disc with its icon that sits
// on the kiosk's glass beside a live channel (spec 2026-10-01). Built from the
// map's own pin SVGs, so the pin stays the one source of each service's icon —
// the head is the pin's head, without the teardrop.
import { PIN_COLORS, type PinCategory } from "../lib/serviceColor.js";
import pinAir from "../map/pins/pin-air.svg?raw";
import pinRail from "../map/pins/pin-rail.svg?raw";
import pinHam from "../map/pins/pin-ham.svg?raw";
import pinGmrs from "../map/pins/pin-gmrs.svg?raw";
import pinBiz from "../map/pins/pin-biz.svg?raw";
import pinPublicSafety from "../map/pins/pin-publicsafety.svg?raw";
import pinMarine from "../map/pins/pin-marine.svg?raw";
import pinWeather from "../map/pins/pin-weather.svg?raw";
import pinUnknown from "../map/pins/pin-unknown.svg?raw";

export interface ServiceHead {
  /** The disc fill — PIN_COLORS for the category. */
  color: string;
  /** The lucide glyph's inner SVG elements (paths etc.), no wrapper. */
  glyph: string;
  /** True when the disc is under HEAD_MIN_CONTRAST on the glass; the LCD then
   *  draws a --kc-pin-cream ring so the head stays findable. */
  ringed: boolean;
}

/** Non-text contrast floor (WCAG 1.4.11) for the disc against the glass. */
export const HEAD_MIN_CONTRAST = 3;
/** --kc-well, the LCD glass the head sits on (pinned to tokens.css by a test). */
export const WELL_HEX = "#0c1113";

const PIN_SVG: Record<PinCategory, string> = {
  air: pinAir, rail: pinRail, ham: pinHam, gmrs: pinGmrs, biz: pinBiz,
  publicsafety: pinPublicSafety, marine: pinMarine, weather: pinWeather, unknown: pinUnknown,
};

// Every pin draws its glyph in one group scaled into the head:
// <g transform="translate(10.5 10.5) scale(0.875)" …>…</g></g>
const GLYPH_GROUP = /<g transform="translate\(10\.5 10\.5\) scale\(0\.875\)"[^>]*>([\s\S]*?)<\/g>\s*<\/g>/;

export function glyphOf(pinSvg: string): string {
  const inner = GLYPH_GROUP.exec(pinSvg)?.[1]?.trim();
  if (!inner) throw new Error("serviceHead: pin SVG has no glyph group");
  return inner;
}

function luminance(hex: string): number {
  const h = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
    .map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4)) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastOnWell(hex: string): number {
  const [hi, lo] = [luminance(hex), luminance(WELL_HEX)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const HEADS = new Map<PinCategory, ServiceHead>();

export function serviceHead(cat: PinCategory): ServiceHead {
  let h = HEADS.get(cat);
  if (!h) {
    const color = PIN_COLORS[cat] ?? PIN_COLORS.unknown!;
    h = { color, glyph: glyphOf(PIN_SVG[cat]), ringed: contrastOnWell(color) < HEAD_MIN_CONTRAST };
    HEADS.set(cat, h);
  }
  return h;
}
