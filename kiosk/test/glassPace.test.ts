import { describe, it, expect } from "vitest";
import { paceDelay, MIN_STEP_MS, EMPTY_FRAME, type GlassFrame } from "../src/frontend/map/glassMath.js";

const O = { haze: false, radarFading: false, maxFps: 30, txFps: 60 };
const fr = (p: Partial<GlassFrame>): GlassFrame => ({ ...EMPTY_FRAME, ...p });

describe("paceDelay", () => {
  it("idle scene: no timer at all", () => {
    expect(paceDelay(EMPTY_FRAME, 0, O)).toBeNull();
  });
  it("continuous: maxFps; growing: txFps", () => {
    expect(paceDelay(fr({ continuous: true }), 0, O)).toBeCloseTo(1000 / 30, 9);
    expect(paceDelay(fr({ continuous: true, growing: true }), 0, O)).toBeCloseTo(1000 / 60, 9);
  });
  it("haze or a radar fade forces the steady rate", () => {
    expect(paceDelay(EMPTY_FRAME, 0, { ...O, haze: true })).toBeCloseTo(1000 / 30, 9);
    expect(paceDelay(EMPTY_FRAME, 0, { ...O, radarFading: true })).toBeCloseTo(1000 / 30, 9);
  });
  it("a scheduled change: one timer to that moment, floored at MIN_STEP_MS", () => {
    expect(paceDelay(fr({ nextChangeAt: 2500 }), 1000, O)).toBe(1500);
    expect(paceDelay(fr({ nextChangeAt: 1000 }), 1000, O)).toBe(MIN_STEP_MS);
    expect(paceDelay(fr({ nextChangeAt: 900 }), 1000, O)).toBe(MIN_STEP_MS);
  });
});
