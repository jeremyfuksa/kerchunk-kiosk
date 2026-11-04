// The Atlas's map: Miller, centred on home so that no path from home can reach the seam (#338). Straight
// meridians also make the terminator a true wave, near the solstices. world.svg is drawn to these same numbers
// by scripts/gen-atlas-land.mjs, so changing one means regenerating it. Units keep the sizes the wall was tuned at.
export const CENTER_LON = -94.5;
export const MAP_W = 1800;
export const MAP_H = 1012;
const EQUATOR_Y = 527;   // about 80°N at the top and 76°S at the bottom

const R = Math.PI / 180;
const K = MAP_W / (2 * Math.PI);

/** Longitude as an offset from the map's centre, in [-180, 180). */
export function fromCenter(lon: number): number {
  return ((((lon - CENTER_LON) % 360) + 540) % 360) - 180;
}

export function miller(lat: number, lon: number): { x: number; y: number } {
  return { x: MAP_W / 2 + K * fromCenter(lon) * R, y: EQUATOR_Y - K * 1.25 * Math.log(Math.tan(Math.PI / 4 + 0.4 * lat * R)) };
}

export interface LatLon { lat: number; lon: number }

export function greatCircle(a: LatLon, b: LatLon, segments: number): LatLon[] {
  const r = Math.PI / 180;
  const v = (p: LatLon): [number, number, number] => [Math.cos(p.lat * r) * Math.cos(p.lon * r), Math.cos(p.lat * r) * Math.sin(p.lon * r), Math.sin(p.lat * r)];
  const [ax, ay, az] = v(a);
  const [bx, by, bz] = v(b);
  const d = Math.acos(Math.min(1, Math.max(-1, ax * bx + ay * by + az * bz)));
  const out: LatLon[] = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const [p, q] = d < 1e-9 ? [1 - t, t] : [Math.sin((1 - t) * d) / Math.sin(d), Math.sin(t * d) / Math.sin(d)];
    const x = p * ax + q * bx;
    const y = p * ay + q * by;
    const z = p * az + q * bz;
    out.push({ lat: Math.atan2(z, Math.hypot(x, y)) / r, lon: Math.atan2(y, x) / r });
  }
  return out;
}
