// Crop math for an equirectangular world-file grid. A world file gives the
// CENTRE of the upper-left pixel, so pixel edges sit half a pixel outward;
// the returned bounds are edges, which is what the frontend mesh needs.

export interface WorldGrid { ulLon: number; ulLat: number; deg: number; width: number; height: number }
export interface Bounds { n: number; s: number; e: number; w: number }
export interface CropWindow { x0: number; y0: number; width: number; height: number; bounds: Bounds }

/** IEM USCOMP n0q composite: n0q_0.wld = 0.005, 0, 0, -0.005, -126.0, 50.0. */
export const IEM_USCOMP: WorldGrid = { ulLon: -126, ulLat: 50, deg: 0.005, width: 12200, height: 5400 };
/** IEM's MRMS lcref composite: lcref.wld = 0.01, 0, 0, -0.01, -129.995, 54.995. */
export const IEM_MRMS: WorldGrid = { ulLon: -129.995, ulLat: 54.995, deg: 0.01, width: 7000, height: 3500 };

export function cropWindow(
  grid: WorldGrid,
  center: { lat: number; lon: number },
  span: { w: number; h: number },
): CropWindow | null {
  const westEdge = grid.ulLon - grid.deg / 2;
  const northEdge = grid.ulLat + grid.deg / 2;
  const x0 = Math.max(0, Math.floor((center.lon - span.w / 2 - westEdge) / grid.deg));
  const x1 = Math.min(grid.width, Math.ceil((center.lon + span.w / 2 - westEdge) / grid.deg));
  const y0 = Math.max(0, Math.floor((northEdge - (center.lat + span.h / 2)) / grid.deg));
  const y1 = Math.min(grid.height, Math.ceil((northEdge - (center.lat - span.h / 2)) / grid.deg));
  if (x1 <= x0 || y1 <= y0) return null;
  return {
    x0, y0, width: x1 - x0, height: y1 - y0,
    bounds: {
      w: westEdge + x0 * grid.deg,
      e: westEdge + x1 * grid.deg,
      n: northEdge - y0 * grid.deg,
      s: northEdge - y1 * grid.deg,
    },
  };
}
