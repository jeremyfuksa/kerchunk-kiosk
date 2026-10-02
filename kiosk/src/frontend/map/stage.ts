// Fixed-stage geometry (spec 2026-10-02): the kiosk camera never moves, so an
// audible site outside the padded frame is shown by a soft bloom on the screen
// edge where the line toward it leaves the screen. Pure: no DOM, no Google.

export interface Pt { x: number; y: number }
export interface Rect { left: number; top: number; right: number; bottom: number }
export interface LatLngBox { n: number; s: number; e: number; w: number }

/** Bloom diameter in px (map.css .edgeBloom uses the same size). */
export const BLOOM_PX = 480;

export function padRect(width: number, height: number, pad: { top: number; right: number; bottom: number; left: number }): Rect {
  return { left: pad.left, top: pad.top, right: width - pad.right, bottom: height - pad.bottom };
}

export function outside(p: Pt, r: Rect): boolean {
  return p.x < r.left || p.x > r.right || p.y < r.top || p.y > r.bottom;
}

/** Where the ray from `center` (inside `r`) through `target` crosses `r`'s
 *  border. The target may be inside or outside `r`; only its direction counts. */
export function edgeExit(center: Pt, target: Pt, r: Rect): Pt {
  const dx = target.x - center.x, dy = target.y - center.y;
  if (dx === 0 && dy === 0) return { x: center.x, y: center.y };
  let t = Infinity;
  if (dx > 0) t = Math.min(t, (r.right - center.x) / dx);
  if (dx < 0) t = Math.min(t, (r.left - center.x) / dx);
  if (dy > 0) t = Math.min(t, (r.bottom - center.y) / dy);
  if (dy < 0) t = Math.min(t, (r.top - center.y) / dy);
  return { x: center.x + dx * t, y: center.y + dy * t };
}

const mercY = (lat: number): number => {
  const r = (lat * Math.PI) / 180;
  return Math.log(Math.tan(Math.PI / 4 + r / 2));
};

/** Project a site into viewport pixels from the map's visible bounds. Valid
 *  for the kiosk's north-up, untilted camera; works off-screen too. */
export function lngLatToViewPx(lat: number, lng: number, box: LatLngBox, width: number, height: number): Pt {
  const x = ((lng - box.w) / (box.e - box.w)) * width;
  const y = ((mercY(box.n) - mercY(lat)) / (mercY(box.n) - mercY(box.s))) * height;
  return { x, y };
}
