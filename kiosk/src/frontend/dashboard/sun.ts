// Where the sun is, from the clock (the standard low-precision solar formula, good to about 0.1°).
export interface SubPoint { lat: number; lon: number }

const R = Math.PI / 180;
const J2000_MS = Date.UTC(2000, 0, 1, 12);

export function subsolar(ts: number): SubPoint {
  const d = (ts - J2000_MS) / 86_400_000;
  const g = (357.529 + 0.98560028 * d) * R;
  const q = 280.459 + 0.98564736 * d;
  const ecl = (q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * R;
  const obliquity = (23.439 - 0.00000036 * d) * R;
  const lat = Math.asin(Math.sin(obliquity) * Math.sin(ecl)) / R;
  const ra = Math.atan2(Math.cos(obliquity) * Math.sin(ecl), Math.cos(ecl)) / R;
  const gmstDeg = 280.46061837 + 360.98564736629 * d;
  const lon = ((((ra - gmstDeg) % 360) + 540) % 360) - 180;
  return { lat, lon };
}

/** The sun's height above the horizon at a point, in degrees. */
export function sunAltitude(lat: number, lon: number, sub: SubPoint): number {
  const s = Math.sin(lat * R) * Math.sin(sub.lat * R) + Math.cos(lat * R) * Math.cos(sub.lat * R) * Math.cos((lon - sub.lon) * R);
  return Math.asin(Math.min(1, Math.max(-1, s))) / R;
}
