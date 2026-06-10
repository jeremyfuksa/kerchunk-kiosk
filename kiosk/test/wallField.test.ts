import { describe, it, expect } from "vitest";
import { WallField } from "../src/frontend/wall/wallField.js";

describe("WallField", () => {
  it("counts deposits per frequency", () => {
    const f = new WallField({ breathMs: 6000 });
    f.deposit({ freq: 154_000_000, ts: 0 });
    f.deposit({ freq: 154_000_000, ts: 10 });
    f.deposit({ freq: 460_000_000, ts: 20 });
    expect(f.countFor(154_000_000)).toBe(2);
    expect(f.countFor(460_000_000)).toBe(1);
    expect(f.countFor(999)).toBe(0);
  });

  it("maxCount is the busiest column (>=1 floor for empty)", () => {
    const f = new WallField({ breathMs: 6000 });
    expect(f.maxCount()).toBe(1); // never 0 — keeps the renderer's divide safe
    f.deposit({ freq: 154_000_000, ts: 0 });
    f.deposit({ freq: 154_000_000, ts: 0 });
    f.deposit({ freq: 460_000_000, ts: 0 });
    expect(f.maxCount()).toBe(2);
  });

  it("bloomFor is 1 at the latest hit, linear to 0 at breathMs, never negative", () => {
    const f = new WallField({ breathMs: 4000 });
    f.deposit({ freq: 154_000_000, ts: 0 });
    expect(f.bloomFor(154_000_000, 0)).toBeCloseTo(1, 5);
    expect(f.bloomFor(154_000_000, 2000)).toBeCloseTo(0.5, 5);
    expect(f.bloomFor(154_000_000, 4000)).toBeCloseTo(0, 5);
    expect(f.bloomFor(154_000_000, 9999)).toBe(0);
    expect(f.bloomFor(999, 0)).toBe(0); // unknown freq
  });

  it("anyBloom is true while a column is within breathMs, false after", () => {
    const f = new WallField({ breathMs: 4000 });
    expect(f.anyBloom(0)).toBe(false);
    f.deposit({ freq: 154_000_000, ts: 0 });
    expect(f.anyBloom(1000)).toBe(true);
    expect(f.anyBloom(5000)).toBe(false);
  });

  it("clear() empties the field for the daily reset", () => {
    const f = new WallField({ breathMs: 4000 });
    f.deposit({ freq: 154_000_000, ts: 0 });
    f.clear();
    expect(f.countFor(154_000_000)).toBe(0);
    expect(f.maxCount()).toBe(1);
    expect(f.anyBloom(0)).toBe(false);
  });
});
