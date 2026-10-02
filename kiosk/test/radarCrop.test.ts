import { describe, it, expect } from "vitest";
import { cropWindow, IEM_USCOMP } from "../src/backend/radar/crop.js";

describe("cropWindow (IEM USCOMP grid)", () => {
  it("crops a 4x3 degree box around Kansas City", () => {
    const c = cropWindow(IEM_USCOMP, { lat: 39.1, lon: -94.58 }, { w: 4, h: 3 })!;
    expect(c).toMatchObject({ x0: 5884, y0: 1880, width: 801, height: 601 });
    expect(c.bounds.w).toBeCloseTo(-96.5825, 6);
    expect(c.bounds.e).toBeCloseTo(-92.5775, 6);
    expect(c.bounds.n).toBeCloseTo(40.6025, 6);
    expect(c.bounds.s).toBeCloseTo(37.5975, 6);
  });
  it("bounds are pixel EDGES (world file gives the upper-left pixel centre)", () => {
    const c = cropWindow(IEM_USCOMP, { lat: 39, lon: -94 }, { w: 0.01, h: 0.01 })!;
    expect(c).toMatchObject({ x0: 6399, y0: 2199, width: 3, height: 3 });
    expect(c.bounds.e - c.bounds.w).toBeCloseTo(3 * 0.005, 9);
  });
  it("clamps to the image at the grid corner", () => {
    const c = cropWindow(IEM_USCOMP, { lat: 49.5, lon: -125.5 }, { w: 4, h: 3 })!;
    expect(c).toMatchObject({ x0: 0, y0: 0, width: 501, height: 401 });
    expect(c.bounds.w).toBeCloseTo(-126.0025, 6);
    expect(c.bounds.n).toBeCloseTo(50.0025, 6);
  });
  it("returns null when the box misses the grid entirely", () => {
    expect(cropWindow(IEM_USCOMP, { lat: 0, lon: 0 }, { w: 4, h: 3 })).toBeNull();
  });
});
