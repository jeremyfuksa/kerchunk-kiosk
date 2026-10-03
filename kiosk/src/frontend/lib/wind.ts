// Surface wind for the glass smoke (spec 2026-10-02 glass smoke). The
// dashboard's existing /api/weather poll feeds setWind(); the map subscribes
// with onWind(). No second poll: the appliance deadlocks on concurrent requests.

/** Where the wind blows TOWARD (compass degrees, 0 = N, 90 = E) and its speed. */
export interface Wind { towardDeg: number; mph: number }

// NWS gives the direction the wind comes FROM ("SW 3 mph").
const COMPASS: Record<string, number> = {
  N: 0, NNE: 22, NE: 45, ENE: 67, E: 90, ESE: 112, SE: 135, SSE: 157,
  S: 180, SSW: 202, SW: 225, WSW: 247, W: 270, WNW: 292, NW: 315, NNW: 337,
};

/** The from-bearing of an NWS wind string, or undefined. */
export function fromDeg(raw: string): number | undefined {
  return COMPASS[(/\b([NSEW]{1,3})\b/.exec(raw) ?? [])[1] ?? ""];
}

/** "NE 7 mph" → { towardDeg: 225, mph: 7 }. Ranges use the upper bound.
 *  Calm, variable, zero or unparseable → null (smoke pools, no drift). */
export function parseWind(raw: string): Wind | null {
  const from = fromDeg(raw);
  const nums = [...raw.matchAll(/\d+/g)].map((m) => Number(m[0]));
  const mph = nums.length ? Math.max(...nums) : 0;
  if (from === undefined || !(mph > 0)) return null;
  return { towardDeg: (from + 180) % 360, mph };
}

let current: Wind | null = null;
const subs = new Set<(w: Wind | null) => void>();

export function setWind(raw: string | null | undefined): void {
  current = raw ? parseWind(raw) : null;
  for (const cb of subs) cb(current);
}

/** Subscribe; the callback gets the current wind at once. Returns unsubscribe. */
export function onWind(cb: (w: Wind | null) => void): () => void {
  subs.add(cb);
  cb(current);
  return () => { subs.delete(cb); };
}
