// Robinson projection for Simplemaps' world.svg (viewBox 0 0 2000 857). The constants were measured
// against that file on 2026-11-02 (spec 2026-11-02-hf-mode), with residuals under 1 unit.
const PLEN = [1, 0.9986, 0.9954, 0.99, 0.9822, 0.973, 0.96, 0.9427, 0.9216, 0.8962, 0.8679, 0.835, 0.7986, 0.7597, 0.7186, 0.6732, 0.6213, 0.5722, 0.5322];
const PDFE = [0, 0.062, 0.124, 0.186, 0.248, 0.31, 0.372, 0.434, 0.4958, 0.5571, 0.6176, 0.6769, 0.7346, 0.7903, 0.8435, 0.8936, 0.9394, 0.9761, 1];

function lookup(table: readonly number[], absLat: number): number {
  const i = Math.min(Math.floor(absLat / 5), table.length - 2);
  const f = absLat / 5 - i;
  return table[i]! + (table[i + 1]! - table[i]!) * f;
}

export function robinson(lat: number, lon: number): { x: number; y: number } {
  const a = Math.min(Math.abs(lat), 90);
  return { x: 985.7 + 5.6579 * lookup(PLEN, a) * lon, y: 501.94 - 518.393 * Math.sign(lat) * lookup(PDFE, a) };
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
