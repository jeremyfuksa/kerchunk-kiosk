import { describe, it, expect } from "vitest";
import { SedimentField, startOfLocalDay } from "../src/frontend/art/sediment.js";

describe("SedimentField", () => {
  it("accumulates hits at a site and counts them per service color", () => {
    const f = new SedimentField({ breathMs: 4000 });
    f.deposit({ lat: 39.30, lon: -94.50, color: "#EC4E89", ts: 0 });
    f.deposit({ lat: 39.30, lon: -94.50, color: "#EC4E89", ts: 1000 });
    const d = f.deposits(1000);
    expect(d).toHaveLength(1);
    expect(d[0]!.totalHits).toBe(2);
    expect(d[0]!.strata).toEqual([{ color: "#EC4E89", hits: 2 }]);
  });

  it("keeps distinct services at one site as separate strata, busiest first", () => {
    const f = new SedimentField({ breathMs: 4000 });
    f.deposit({ lat: 39.30, lon: -94.50, color: "#EC4E89", ts: 0 }); // ham
    f.deposit({ lat: 39.30, lon: -94.50, color: "#EC4E89", ts: 10 });
    f.deposit({ lat: 39.30, lon: -94.50, color: "#7C4FE0", ts: 20 }); // biz
    const strata = f.deposits(20)[0]!.strata;
    expect(strata).toEqual([
      { color: "#EC4E89", hits: 2 },
      { color: "#7C4FE0", hits: 1 },
    ]);
  });

  it("treats sites >~1m apart as distinct deposits", () => {
    const f = new SedimentField({ breathMs: 4000 });
    f.deposit({ lat: 39.30, lon: -94.50, color: "#F5821F", ts: 0 });
    f.deposit({ lat: 39.31, lon: -94.70, color: "#F4B315", ts: 0 });
    expect(f.deposits(0)).toHaveLength(2);
  });

  it("a fresh deposit sets breath=1, decaying linearly to 0 over breathMs", () => {
    const f = new SedimentField({ breathMs: 4000 });
    f.deposit({ lat: 39.30, lon: -94.50, color: "#EC4E89", ts: 0 });
    expect(f.deposits(0)[0]!.breath).toBeCloseTo(1, 5);
    expect(f.deposits(2000)[0]!.breath).toBeCloseTo(0.5, 5);
    expect(f.deposits(4000)[0]!.breath).toBeCloseTo(0, 5);
    expect(f.deposits(9999)[0]!.breath).toBe(0); // never negative
  });

  it("clear() empties the field for the daily reset", () => {
    const f = new SedimentField({ breathMs: 4000 });
    f.deposit({ lat: 39.30, lon: -94.50, color: "#EC4E89", ts: 0 });
    f.clear();
    expect(f.deposits(0)).toHaveLength(0);
  });
});

describe("startOfLocalDay", () => {
  it("returns local midnight for a timestamp", () => {
    const noon = new Date(2026, 5, 9, 12, 0, 0, 0).getTime();
    const midnight = new Date(2026, 5, 9, 0, 0, 0, 0).getTime();
    expect(startOfLocalDay(noon)).toBe(midnight);
  });
  it("is idempotent on a midnight input", () => {
    const midnight = new Date(2026, 5, 9, 0, 0, 0, 0).getTime();
    expect(startOfLocalDay(midnight)).toBe(midnight);
  });
  it("two timestamps on the same local day share a start", () => {
    const a = new Date(2026, 5, 9, 6, 30).getTime();
    const b = new Date(2026, 5, 9, 23, 59).getTime();
    expect(startOfLocalDay(a)).toBe(startOfLocalDay(b));
  });
});

describe("SedimentField strata tie-ordering", () => {
  it("orders equal-hit services by first-deposited (stable, deterministic)", () => {
    const f = new SedimentField({ breathMs: 4000 });
    // Two services, each one hit, deposited in a known order.
    f.deposit({ lat: 39.30, lon: -94.50, color: "#FIRST0", ts: 0 });
    f.deposit({ lat: 39.30, lon: -94.50, color: "#SECND0", ts: 10 });
    const strata = f.deposits(10)[0]!.strata;
    // Equal hits (1 each) → first-deposited color leads, by stable sort + Map insertion order.
    expect(strata).toEqual([
      { color: "#FIRST0", hits: 1 },
      { color: "#SECND0", hits: 1 },
    ]);
  });
});
