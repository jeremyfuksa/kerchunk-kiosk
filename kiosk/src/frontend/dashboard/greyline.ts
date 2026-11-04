// The Atlas's sky: the real day and night (spec 2026-11-03-hf-atlas). Pure strings in the map's units.
import { CENTER_LON, MAP_H, MAP_W, miller } from "./miller.js";
import { subsolar, sunAltitude, type SubPoint } from "./sun.js";

export const STAGE_VIEWBOX = `0 0 ${MAP_W} ${MAP_H}`;

/** Map units to pixels on a stage this wide. */
export function stagePx(p: { x: number; y: number }, stageWidth: number): { x: number; y: number } {
  const k = stageWidth / MAP_W;
  return { x: p.x * k, y: p.y * k };
}

export const GREYLINE_BANDS: ReadonlyArray<{ alt: number; color: string }> = [
  { alt: -0.8, color: "#5b3f7f" }, { alt: -3, color: "#4c3580" }, { alt: -6, color: "#3a2c78" },
  { alt: -9, color: "#2a2466" }, { alt: -12, color: "#1c1c50" }, { alt: -14, color: "#14163c" },
];

const LON_STEP = 1;
const LAT_STEP = 0.25;
const OFF_BOTTOM = MAP_H + 80;
const OFF_TOP = -80;

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

/** The band's upper and lower edges at one longitude. Night reaching a pole runs off the stage. */
export function nightEdges(alt: number, lon: number, sub: SubPoint): { upper: number; lower: number } | null {
  const i = nightInterval(alt, lon, sub);
  if (!i) return null;
  return {
    upper: i.hi >= 90 ? OFF_TOP : miller(i.hi, lon).y,
    lower: i.lo <= -90 ? OFF_BOTTOM : miller(i.lo, lon).y,
  };
}

/** Night as polygons over each run of longitudes that has any, left edge of the map to right. */
export function nightBandPath(alt: number, sub: SubPoint): string {
  let d = "";
  let top: string[] = [];
  let bottom: string[] = [];
  const flush = (): void => {
    if (top.length) d += `M${[...top, ...bottom.reverse()].join("L")}Z`;
    top = [];
    bottom = [];
  };
  for (let t = -180; t <= 180; t += LON_STEP) {
    const e = nightEdges(alt, CENTER_LON + t, sub);
    if (!e) { flush(); continue; }
    const x = ((t + 180) * (MAP_W / 360)).toFixed(1);
    top.push(`${x} ${e.upper.toFixed(1)}`);
    bottom.push(`${x} ${e.lower.toFixed(1)}`);
  }
  flush();
  return d;
}

export function greylineDue(lastTs: number, now: number, stepMs: number): boolean {
  return now - lastTs >= stepMs;
}

/** The part of the sky that changes: the sun's glow and the bands. */
export function greylineSvg(ts: number): string {
  const sub = subsolar(ts);
  const sun = miller(sub.lat, sub.lon);
  return `<ellipse cx="${sun.x.toFixed(0)}" cy="${sun.y.toFixed(0)}" rx="620" ry="430" fill="url(#hfSun)"/>`
    + GREYLINE_BANDS.map((b) => `<path d="${nightBandPath(b.alt, sub)}" fill="${b.color}"/>`).join("");
}

export function starsSvg(): string {
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
  return `<defs><linearGradient id="hfDay" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#14505c"/><stop offset="1" stop-color="#0f3a4c"/></linearGradient>`
    + `<radialGradient id="hfSun"><stop offset="0" stop-color="#2fb7a6" stop-opacity=".45"/><stop offset="1" stop-color="#2fb7a6" stop-opacity="0"/></radialGradient></defs>`
    + `<rect width="${MAP_W}" height="${MAP_H}" fill="url(#hfDay)"/><g id="hfGreyline">${greylineSvg(ts)}</g>`;
}
