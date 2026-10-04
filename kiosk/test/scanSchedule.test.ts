import { describe, it, expect } from "vitest";
import {
  ActivityTracker, dwellFactor, scaledDwellMs, resolveAutoDwell, AUTO_DWELL_DEFAULTS,
  nextRevisitTarget, resolvePriorityRevisit, PRIORITY_REVISIT_DEFAULTS,
  resolveVisualHold, VISUAL_HOLD_DEFAULTS,
} from "../src/backend/engine/scanSchedule.js";

describe("activity-weighted dwell math", () => {
  it("cold start (all zero activity) is exactly 1.0", () => {
    expect(dwellFactor(0, 0, 0.5, 2)).toBe(1);
  });

  it("an average group is 1.0, busier is longer, idle is shorter, clamped", () => {
    expect(dwellFactor(3, 3, 0.5, 2)).toBe(1);
    expect(dwellFactor(3, 1, 0.5, 2)).toBe(2);        // (3+1)/(1+1)
    expect(dwellFactor(0, 1, 0.5, 2)).toBe(0.5);      // (0+1)/(1+1)
    expect(dwellFactor(100, 1, 0.5, 2)).toBe(2);      // clamped to max
    expect(dwellFactor(0, 100, 0.5, 2)).toBe(0.5);    // clamped to min
    expect(dwellFactor(2, 1, 0.5, 1.2)).toBeCloseTo(1.2);
  });

  it("never shrinks a dwell below 1 s, but honors a base already under it", () => {
    expect(scaledDwellMs(3000, 0.5)).toBe(1500);
    expect(scaledDwellMs(1500, 0.5)).toBe(1000);
    expect(scaledDwellMs(3000, 2)).toBe(6000);
    expect(scaledDwellMs(500, 0.5)).toBe(500);
  });

  it("activity decays by half every half-life", () => {
    const t = new ActivityTracker();
    const hl = 60_000;
    t.record("g", 0, hl);
    t.record("g", 0, hl);
    expect(t.value("g", 0, hl)).toBe(2);
    expect(t.value("g", hl, hl)).toBeCloseTo(1);
    expect(t.value("g", 2 * hl, hl)).toBeCloseTo(0.5);
    t.record("g", 2 * hl, hl);
    expect(t.value("g", 2 * hl, hl)).toBeCloseTo(1.5);
    expect(t.value("other", 0, hl)).toBe(0);
  });

  it("resolves defaults for omitted fields", () => {
    expect(resolveAutoDwell(undefined)).toEqual(AUTO_DWELL_DEFAULTS);
    expect(resolveAutoDwell({ maxFactor: 3 })).toEqual({ ...AUTO_DWELL_DEFAULTS, maxFactor: 3 });
  });
});

describe("priority revisit helpers", () => {
  it("round-robins the targets and wraps the cursor", () => {
    expect(nextRevisitTarget([], 0)).toBeNull();
    expect(nextRevisitTarget([2, 5], 0)).toEqual({ index: 2, cursor: 1 });
    expect(nextRevisitTarget([2, 5], 1)).toEqual({ index: 5, cursor: 0 });
    expect(nextRevisitTarget([2, 5], 7)).toEqual({ index: 5, cursor: 0 }); // stale cursor after a regroup
  });

  it("resolves defaults (everyMs 8000, lookMs 700)", () => {
    expect(resolvePriorityRevisit(undefined)).toEqual(PRIORITY_REVISIT_DEFAULTS);
    expect(resolvePriorityRevisit({ lookMs: 900 })).toEqual({ ...PRIORITY_REVISIT_DEFAULTS, lookMs: 900 });
  });
});

describe("visual hold helpers", () => {
  it("defaults: enabled, 15 s cap, credits dwell", () => {
    expect(VISUAL_HOLD_DEFAULTS).toEqual({ enabled: true, maxMs: 15000, creditDwell: true });
    expect(resolveVisualHold(undefined)).toEqual(VISUAL_HOLD_DEFAULTS);
  });

  it("fills only the missing fields", () => {
    expect(resolveVisualHold({ maxMs: 8000 })).toEqual({ ...VISUAL_HOLD_DEFAULTS, maxMs: 8000 });
    expect(resolveVisualHold({ enabled: false, creditDwell: false }))
      .toEqual({ enabled: false, maxMs: 15000, creditDwell: false });
  });
});
