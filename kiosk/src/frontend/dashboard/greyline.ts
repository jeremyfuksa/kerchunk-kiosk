// The Atlas's sky: space, the halo behind the globe, and the real day and night (spec
// 2026-11-03-hf-atlas). Pure strings in world.svg's map units.
import { robinson } from "./robinson.js";
import { subsolar, sunAltitude, type SubPoint } from "./sun.js";

/** The 1366×768 stage in map units. The top is about 81°N, so paths over the Arctic run off the screen instead
 *  of squashing along Robinson's flat pole line. The band hides everything south of about 75°S, and New Zealand
 *  sets how large this can go. */
const STAGE = { x: 70.7, y: 10, w: 1830, h: 1029 };
export const STAGE_VIEWBOX = `${STAGE.x} ${STAGE.y} ${STAGE.w} ${STAGE.h}`;

/** Map units to pixels on a stage this wide. */
export function stagePx(p: { x: number; y: number }, stageWidth: number): { x: number; y: number } {
  const k = stageWidth / STAGE.w;
  return { x: (p.x - STAGE.x) * k, y: (p.y - STAGE.y) * k };
}

export const GREYLINE_BANDS: ReadonlyArray<{ alt: number; color: string }> = [
  { alt: -0.8, color: "#5b3f7f" }, { alt: -3, color: "#4c3580" }, { alt: -6, color: "#3a2c78" },
  { alt: -9, color: "#2a2466" }, { alt: -12, color: "#1c1c50" }, { alt: -14, color: "#14163c" },
];

const LON_STEP = 1;
const LAT_STEP = 0.25;
// The operator rejected the true shape, where night ends in a flat line above a sunlit polar cap, so
// band edges past these latitudes are steepened until they run off the globe. Not true out there.
const STEEPEN_SOUTH = -35;
const STEEPEN_NORTH = 45;
const STEEPEN_BY = 6;
const OFF_BOTTOM = 1120;
const OFF_TOP = -80;
const OFF_LEFT = -60;
const OFF_RIGHT = 2060;

/** Where this longitude is darker than alt. With alt below 0 that's only ever one stretch. */
export function nightInterval(alt: number, lon: number, sub: SubPoint): { lo: number; hi: number } | null {
  let lo: number | null = null;
  let hi: number | null = null;
  for (let lat = -90; lat <= 90; lat += LAT_STEP) {
    if (sunAltitude(lat, lon, sub) < alt) {
      lo ??= lat;
      hi = lat;
    }
  }
  return lo === null || hi === null ? null : { lo, hi };
}

function edgeY(lat: number, lon: number): number {
  const y = robinson(lat, lon).y;
  if (lat < STEEPEN_SOUTH) {
    const y0 = robinson(STEEPEN_SOUTH, lon).y;
    return Math.min(OFF_BOTTOM, y0 + (y - y0) * STEEPEN_BY);
  }
  if (lat > STEEPEN_NORTH) {
    const y0 = robinson(STEEPEN_NORTH, lon).y;
    return Math.max(OFF_TOP, y0 - (y0 - y) * STEEPEN_BY);
  }
  return y;
}

/** The band's upper and lower edges at one longitude, as drawn. */
export function nightEdges(alt: number, lon: number, sub: SubPoint): { upper: number; lower: number; xUpper: number; xLower: number } | null {
  const i = nightInterval(alt, lon, sub);
  if (!i) return null;
  return {
    upper: i.hi >= 90 ? OFF_TOP : edgeY(i.hi, lon),
    lower: i.lo <= -90 ? OFF_BOTTOM : edgeY(i.lo, lon),
    xUpper: robinson(i.hi, lon).x,
    xLower: robinson(i.lo, lon).x,
  };
}

/** One meridian between two latitudes. Robinson's meridians curve, so a straight line would cut across daylight. */
function meridian(lon: number, fromLat: number, toLat: number): string[] {
  const n = Math.max(1, Math.ceil(Math.abs(toLat - fromLat) / 5));
  return Array.from({ length: n + 1 }, (_, i) => {
    const p = robinson(fromLat + ((toLat - fromLat) * i) / n, lon);
    return `${p.x.toFixed(1)} ${p.y.toFixed(1)}`;
  });
}

/** Night as polygons over each run of longitudes that has any. Runs past the rim; the globe clips it. */
export function nightBandPath(alt: number, sub: SubPoint): string {
  let d = "";
  let run: Array<{ lon: number; e: NonNullable<ReturnType<typeof nightEdges>>; i: { lo: number; hi: number } }> = [];
  const flush = (): void => {
    const first = run[0];
    const last = run.at(-1);
    if (!first || !last) return;
    const top = run.map((c) => `${c.e.xUpper.toFixed(1)} ${c.e.upper.toFixed(1)}`);
    const bottom = run.map((c) => `${c.e.xLower.toFixed(1)} ${c.e.lower.toFixed(1)}`).reverse();
    const left = first.lon === -180
      ? [`${OFF_LEFT} ${first.e.lower.toFixed(1)}`, `${OFF_LEFT} ${first.e.upper.toFixed(1)}`]
      : meridian(first.lon, first.i.lo, first.i.hi);
    const right = last.lon === 180
      ? [`${OFF_RIGHT} ${last.e.upper.toFixed(1)}`, `${OFF_RIGHT} ${last.e.lower.toFixed(1)}`]
      : meridian(last.lon, last.i.hi, last.i.lo);
    d += `M${[...top, ...right, ...bottom, ...left].join("L")}Z`;
    run = [];
  };
  for (let lon = -180; lon <= 180; lon += LON_STEP) {
    const e = nightEdges(alt, lon, sub);
    const i = nightInterval(alt, lon, sub);
    if (e && i) run.push({ lon, e, i });
    else flush();
  }
  flush();
  return d;
}

export function globeOutline(): string {
  const pts: string[] = [];
  for (let lat = 90; lat >= -90; lat -= 2) { const p = robinson(lat, -180); pts.push(`${p.x.toFixed(1)} ${p.y.toFixed(1)}`); }
  for (let lat = -90; lat <= 90; lat += 2) { const p = robinson(lat, 180); pts.push(`${p.x.toFixed(1)} ${p.y.toFixed(1)}`); }
  return `M${pts.join("L")}Z`;
}

const LIMB_REACH = 80;   // how far past the rim a path takes to fade out, in map units
const LIMB_STEPS = 16;
export const LIMB_MASK = 'mask="url(#hfLimb)"';
let limbMask = "";

/** Shows all of the globe and fades what's past the rim, so a path goes over the horizon and then fades. Stacked
 *  strokes, not a blur: a mask gets re-rastered with its layer. */
export function limbMaskSvg(): string {
  if (limbMask) return limbMask;
  const outline = globeOutline();
  let strokes = "";
  for (let i = LIMB_STEPS; i > 0; i--) {
    strokes += `<path d="${outline}" stroke="#fff" stroke-opacity="0.2" stroke-width="${(2 * LIMB_REACH * (i / LIMB_STEPS)).toFixed(1)}"/>`;
  }
  limbMask = `<mask id="hfLimb" maskUnits="userSpaceOnUse" x="-100" y="-100" width="2200" height="1300"><rect x="-100" y="-100" width="2200" height="1300" fill="#000"/><g fill="none">${strokes}</g><path d="${outline}" fill="#fff"/></mask>`;
  return limbMask;
}

export function greylineDue(lastTs: number, now: number, stepMs: number): boolean {
  return now - lastTs >= stepMs;
}

/** The part of the sky that changes: the sun's glow and the bands. */
export function greylineSvg(ts: number): string {
  const sub = subsolar(ts);
  const sun = robinson(sub.lat, sub.lon);
  return `<ellipse cx="${sun.x.toFixed(0)}" cy="${sun.y.toFixed(0)}" rx="620" ry="430" fill="url(#hfSun)"/>`
    + GREYLINE_BANDS.map((b) => `<path d="${nightBandPath(b.alt, sub)}" fill="${b.color}"/>`).join("");
}

function halo(outline: string, color: string, reach: number, steps: number, opacity: number): string {
  let out = "";
  for (let i = steps; i > 0; i--) {
    const width = 2 * reach * (i / steps) ** 1.8;
    out += `<path d="${outline}" stroke="${color}" stroke-opacity="${opacity}" stroke-width="${width.toFixed(1)}"/>`;
  }
  return out;
}

function stars(): string {
  let seed = 7;
  const rnd = (): number => {   // mulberry32: the same sky on every load
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const sizes = [0.7, 0.7, 0.9, 0.9, 1.1, 1.4, 1.9];
  const colors = ["#ffffff", "#ffffff", "#dfe7ff", "#ffe9d6", "#cfd8ff"];
  let out = "";
  for (let i = 0; i < 520; i++) {
    const x = rnd() * 2000;
    const y = rnd() * 1125 - 56;
    const r = sizes[Math.floor(rnd() * sizes.length)]!;
    const c = colors[Math.floor(rnd() * colors.length)]!;
    out += `<circle cx="${x.toFixed(0)}" cy="${y.toFixed(0)}" r="${r}" fill="${c}" opacity="${(0.3 + rnd() * 0.65).toFixed(2)}"/>`;
  }
  return out;
}

/** Everything behind the land, back to front. */
export function skySvg(ts: number): string {
  const outline = globeOutline();
  return `<defs><linearGradient id="hfDay" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#14505c"/><stop offset="1" stop-color="#0f3a4c"/></linearGradient>`
    + `<radialGradient id="hfSun"><stop offset="0" stop-color="#2fb7a6" stop-opacity=".45"/><stop offset="1" stop-color="#2fb7a6" stop-opacity="0"/></radialGradient>`
    + `<clipPath id="hfGlobe"><path d="${outline}"/></clipPath></defs>`
    + `<rect x="-100" y="-100" width="2200" height="1300" fill="#04050d"/>${stars()}`
    + `<g fill="none">${halo(outline, "#5a78e6", 85, 18, 0.02)}${halo(outline, "#7fd0ee", 24, 12, 0.028)}</g>`
    + `<g clip-path="url(#hfGlobe)"><rect x="-100" y="-100" width="2200" height="1300" fill="url(#hfDay)"/>`
    + `<g id="hfGreyline">${greylineSvg(ts)}</g></g>`;
}
