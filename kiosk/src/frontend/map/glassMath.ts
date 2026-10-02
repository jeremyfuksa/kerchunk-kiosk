// Pure helpers + shared types for the Weather Glass layer (spec 2026-10-01).
// No DOM, no GL — everything here is unit-tested headless.

export type Rgb = readonly [number, number, number];

/** One live transmission as the shader sees it. */
export interface Front {
  id: string; key: string; lat: number; lng: number; radiusM: number; color: Rgb;
  /** ms since key-up (drives the 300 ms core flash). */
  ageMs: number;
  /** Eased 0..1 expand progress. */
  grow: number;
  /** 0..1 rim brightness (audible channel: live signal dBFS). */
  bright: number;
  /** 0 = live, 1 = fully dissolved into its afterglow. */
  releasing: number;
}

/** A released site's fading footprint. */
export interface Glow { key: string; lat: number; lng: number; radiusM: number; color: Rgb; strength: number }

export interface GlassFrame { fronts: Front[]; glows: Glow[]; growing: boolean }

export const EMPTY_FRAME: GlassFrame = Object.freeze({ fronts: [], glows: [], growing: false }) as GlassFrame;

// Uniform-array sizes compiled into glassShaders.ts — keep in sync.
export const MAX_FRONTS = 8;
export const MAX_GLOWS = 32;

export function fadeProgress(startMs: number, now: number, durMs: number): number {
  if (durMs <= 0) return 1;
  return Math.min(1, Math.max(0, (now - startMs) / durMs));
}

export function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

const EARTH_CIRCUMFERENCE_M = 40_075_016.686;
const mercX = (lng: number): number => (lng + 180) / 360;
const mercY = (lat: number): number => {
  const r = (lat * Math.PI) / 180;
  return (1 - Math.log(Math.tan(Math.PI / 4 + r / 2)) / Math.PI) / 2;
};

/** [east, north] metres of (lat,lng) from `anchor` in WebGLOverlayView's
 *  local frame: Web Mercator distance scaled to metres at the anchor latitude,
 *  so geometry stays registered with the Mercator base map. */
export function mercatorOffsetM(lat: number, lng: number, anchor: { lat: number; lng: number }): [number, number] {
  const scale = EARTH_CIRCUMFERENCE_M * Math.cos((anchor.lat * Math.PI) / 180);
  return [(mercX(lng) - mercX(anchor.lng)) * scale, -(mercY(lat) - mercY(anchor.lat)) * scale];
}

/** Project a local-frame point through a column-major MVP to drawing-buffer
 *  pixels (origin bottom-left, like gl_FragCoord). null = behind the camera. */
export function clipToPx(m: ArrayLike<number>, x: number, y: number, z: number, w: number, h: number): [number, number] | null {
  const at = (i: number): number => m[i] ?? 0;
  const cx = at(0) * x + at(4) * y + at(8) * z + at(12);
  const cy = at(1) * x + at(5) * y + at(9) * z + at(13);
  const cw = at(3) * x + at(7) * y + at(11) * z + at(15);
  if (cw <= 0) return null;
  return [((cx / cw + 1) / 2) * w, ((cy / cw + 1) / 2) * h];
}

/** Service colour (#rrggbb) → shader RGB, lifted slightly for glow on the dark map. */
export function hexToGlowRgb(hex: string): Rgb {
  const n = parseInt(hex.slice(1), 16);
  const lift = (v: number): number => Math.min(1, (v / 255) * 1.15);
  return [lift((n >> 16) & 255), lift((n >> 8) & 255), lift(n & 255)];
}
