import { describe, it, expect } from "vitest";
import { fadeProgress, easeOutCubic, mercatorOffsetM, clipToPx, hexToGlowRgb, EMPTY_FRAME, MAX_FRONTS, MAX_PUFFS, STEP_WRAP } from "../src/frontend/map/glassMath.js";

describe("glassMath", () => {
  it("fadeProgress clamps and treats a zero duration as done", () => {
    expect(fadeProgress(1000, 500, 100)).toBe(0);
    expect(fadeProgress(1000, 1050, 100)).toBe(0.5);
    expect(fadeProgress(1000, 9999, 100)).toBe(1);
    expect(fadeProgress(1000, 1000, 0)).toBe(1);
  });
  it("easeOutCubic is 0 at 0, 1 at 1, fast early", () => {
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(1)).toBe(1);
    expect(easeOutCubic(0.5)).toBeCloseTo(0.875, 9);
  });
  it("mercatorOffsetM: metres east/north of the anchor in Google's local frame", () => {
    const a = { lat: 39, lng: -94 };
    const [e0, n0] = mercatorOffsetM(39, -94, a);
    expect(e0).toBeCloseTo(0, 6); expect(n0).toBeCloseTo(0, 6);
    const [e1, n1] = mercatorOffsetM(39, -93.99, a);
    expect(e1).toBeCloseTo(865.11, 1); expect(n1).toBeCloseTo(0, 6);
    const [, n2] = mercatorOffsetM(39.01, -94, a);
    expect(n2).toBeCloseTo(1113.27, 1);
    const [, n3] = mercatorOffsetM(41, -94, a);   // Mercator stretch, not a flat 222 km
    expect(n3).toBeCloseTo(225893.09, 0);
  });
  it("clipToPx projects through a column-major matrix and drops points behind the camera", () => {
    const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    expect(clipToPx(identity, 0, 0, 0, 200, 100)).toEqual([100, 50]);
    expect(clipToPx(identity, 1, 1, 0, 200, 100)).toEqual([200, 100]);
    const scaleX2 = [2, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    expect(clipToPx(scaleX2, 0.25, 0, 0, 200, 100)).toEqual([150, 50]);
    const behind = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1];
    expect(clipToPx(behind, 0, 0, 0, 200, 100)).toBeNull();
  });
  it("hexToGlowRgb lifts by 15% and clamps", () => {
    const [r, g, b] = hexToGlowRgb("#6D28D9");
    expect(r).toBeCloseTo((0x6d / 255) * 1.15, 6);
    expect(g).toBeCloseTo((0x28 / 255) * 1.15, 6);
    expect(b).toBeCloseTo((0xd9 / 255) * 1.15, 6);
    expect(hexToGlowRgb("#E5383B")[0]).toBe(1); // 0xE5 * 1.15 > 255: clamped
  });
  it("exports the empty frame and the shader caps", () => {
    expect(EMPTY_FRAME).toEqual({ fronts: [], puffs: [], step: 0, growing: false, continuous: false, nextChangeAt: null });
    expect([MAX_FRONTS, MAX_PUFFS]).toEqual([8, 48]);
    expect(STEP_WRAP % 7).toBe(0);
    expect(Math.fround(STEP_WRAP - 1)).toBe(STEP_WRAP - 1);   // exact in float32
  });
});
