import { describe, it, expect } from "vitest";
import { CoverageMeter } from "../src/backend/engine/coverage.js";

describe("CoverageMeter", () => {
  it("reports fractions of recorded time per kind", () => {
    const m = new CoverageMeter(600_000, 60_000);
    m.record("audible", 3000, 1000);
    m.record("quiet", 1000, 2000);
    const f = m.fractions(2000);
    expect(f.audible).toBeCloseTo(0.75);
    expect(f.quiet).toBeCloseTo(0.25);
    expect(f.silent).toBe(0);
    expect(f.sweep).toBe(0);
    expect(f.windowMs).toBe(600_000);
  });
  it("forgets buckets older than the window", () => {
    const m = new CoverageMeter(600_000, 60_000);
    m.record("silent", 5000, 0);
    m.record("quiet", 1000, 700_000);
    const f = m.fractions(700_000);
    expect(f.silent).toBe(0);
    expect(f.quiet).toBe(1);
  });
  it("all zeros with nothing recorded", () => {
    const f = new CoverageMeter().fractions(0);
    expect([f.audible, f.silent, f.quiet, f.sweep]).toEqual([0, 0, 0, 0]);
  });
});
