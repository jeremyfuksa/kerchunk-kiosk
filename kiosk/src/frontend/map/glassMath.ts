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

/** A released transmission's smoke (spec 2026-10-02 glass smoke), sampled at
 *  the shared smoke tick. Screen terms: dir is [east, north]. */
export interface Puff {
  key: string; lat: number; lng: number; radiusM: number; color: Rgb;
  /** Hit-ramp strength × the life dim. */
  strength: number;
  /** Downwind unit vector [east, north]; [0, 0] = calm (no drift). */
  dir: readonly [number, number];
  /** Drift so far along `dir`, px at a 1080-px-tall viewport. */
  driftPx: number;
  /** Radius multipliers along / across the wind. */
  along: number; cross: number;
  /** Stable 0..1 per puff: outline noise + spark hash. */
  seed: number;
}

export interface GlassFrame {
  fronts: Front[]; puffs: Puff[];
  /** The shared smoke tick index (gridTick / smokeStepMs). Wrap with
   *  STEP_WRAP before it becomes a shader uniform. */
  step: number;
  /** A front is in its grow phase: pace at txFps. */
  growing: boolean;
  /** Something moves every frame (a grow or a release dissolve). */
  continuous: boolean;
  /** Date.now() ms of the next VISIBLE change if no event arrives (a smoke
   *  tick, a rate-limited signal step, a ttl expiry); null = never. */
  nextChangeAt: number | null;
}

export const EMPTY_FRAME: GlassFrame = Object.freeze({ fronts: [], puffs: [], step: 0, growing: false, continuous: false, nextChangeAt: null }) as GlassFrame;

// Uniform-array sizes compiled into glassShaders.ts — keep in sync.
export const MAX_FRONTS = 8;
export const MAX_PUFFS = 48;
/** The step index wraps here before the shader sees it: Date.now()/step is
 *  ~3e8, far past float32 precision. A multiple of 7 keeps the 7-tick spark
 *  reshuffle continuous across the wrap. */
export const STEP_WRAP = 7000;

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

/** Floor for any scheduled redraw delay: a boundary at/before now (float
 *  rounding) must never spin zero-delay timers. */
export const MIN_STEP_MS = 16;

/** How long until the glass layer must redraw, from the frame it just drew.
 *  null = nothing will change on its own (no timer; events poke the layer). */
export function paceDelay(
  f: GlassFrame, now: number,
  o: { haze: boolean; radarFading: boolean; maxFps: number; txFps: number },
): number | null {
  if (o.haze || o.radarFading || f.continuous) {
    return 1000 / Math.max(1, f.growing ? o.txFps : o.maxFps);
  }
  if (f.nextChangeAt === null) return null;
  return Math.max(MIN_STEP_MS, f.nextChangeAt - now);
}

/** The smoke pass is the costly part of a glass frame, and it only changes on
 *  a smoke tick or a new puff — but the layer redraws for fronts, radar fades
 *  and Google's own repaints far more often (~1000/min on a busy band; the
 *  first deploy hit 95 °C). So smoke renders into a texture, and only when
 *  its packed inputs change. stale() compares against a private copy. */
export class SmokeCache {
  private last: Float32Array | null = null;
  stale(sig: Float32Array): boolean {
    const l = this.last;
    if (l && l.length === sig.length) {
      let same = true;
      for (let i = 0; i < sig.length; i++) if (l[i] !== sig[i]) { same = false; break; }
      if (same) return false;
    }
    this.last = sig.slice();
    return true;
  }
  invalidate(): void { this.last = null; }
}
