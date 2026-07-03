import { describe, it, expect } from "vitest";
import { startOfLocalDay, startOfNextLocalDay } from "../src/frontend/lib/localDay.js";

describe("localDay", () => {
  it("startOfNextLocalDay lands on the next local midnight, always in the future", () => {
    // Sample every hour across a year; the next-midnight target must always be
    // strictly after `ts` and be an exact local midnight, no matter the time of
    // day or a DST transition (a naive +24h lands early on the fall-back day).
    const start = new Date(2026, 0, 1).getTime();
    for (let h = 0; h < 24 * 366; h++) {
      const ts = start + h * 3_600_000;
      const next = startOfNextLocalDay(ts);
      expect(next).toBeGreaterThan(ts);          // never in the past → no every-second re-arm
      expect(startOfLocalDay(next)).toBe(next);  // is itself a local midnight
      expect(next - ts).toBeLessThanOrEqual(25 * 3_600_000); // within one (≤25h DST) day
    }
  });

  it("advances exactly one calendar day from a midnight", () => {
    const midnight = new Date(2026, 2, 8, 0, 0, 0, 0).getTime(); // US spring-forward day
    const next = startOfNextLocalDay(midnight);
    expect(new Date(next).getDate()).toBe(9);
    expect(new Date(next).getHours()).toBe(0);
  });
});
