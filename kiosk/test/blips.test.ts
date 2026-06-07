import { describe, it, expect } from "vitest";
import { BlipField, syntheticPoint, coverageRadiusM } from "../src/frontend/map/blips.js";

describe("BlipField", () => {
  it("adds blips and computes decaying opacity over the lifetime", () => {
    const f = new BlipField(60_000);
    f.add({ lat: 39, lon: -94.5, alphaTag: "WoF", kind: "active", ts: 0 });
    expect(f.alive(0)).toHaveLength(1);
    expect(f.alive(0)[0]!.opacity).toBeCloseTo(1, 5);
    expect(f.alive(30_000)[0]!.opacity).toBeCloseTo(0.5, 1);
    expect(f.alive(60_001)).toHaveLength(0); // expired AND pruned
  });

  it("repeat hits at the same site refresh the blip instead of stacking", () => {
    const f = new BlipField(60_000);
    f.add({ lat: 39, lon: -94.5, alphaTag: "WoF", kind: "active", ts: 0 });
    f.add({ lat: 39, lon: -94.5, alphaTag: "WoF", kind: "active", ts: 30_000 });
    const alive = f.alive(30_000);
    expect(alive).toHaveLength(1);
    expect(alive[0]!.opacity).toBeCloseTo(1, 5);
    expect(alive[0]!.hits).toBe(2);
  });

  it("distinct sites coexist; backfilled blips start partially decayed", () => {
    const f = new BlipField(60_000);
    f.add({ lat: 39, lon: -94.5, alphaTag: "A", kind: "active", ts: 0 });
    f.add({ lat: 38.9, lon: -94.7, alphaTag: "B", kind: "closecall", ts: 45_000 });
    const alive = f.alive(45_000);
    expect(alive).toHaveLength(2);
    const a = alive.find((b) => b.alphaTag === "A")!;
    expect(a.opacity).toBeLessThan(0.3);
  });
});

describe("syntheticPoint — deterministic unknown placement", () => {
  const HOME = { lat: 39.2915, lng: -94.4953 };

  it("same frequency and known sites always produce the same spot", () => {
    const occupied = [{ lat: 39.31, lng: -94.48 }];
    const a = syntheticPoint(HOME, 18_000, 462_587_500, occupied);
    const b = syntheticPoint(HOME, 18_000, 462_587_500, occupied);
    expect(a).toEqual(b);
  });

  it("adjacent channels receive distinct synthetic identities", () => {
    const a = syntheticPoint(HOME, 18_000, 462_550_000);
    const b = syntheticPoint(HOME, 18_000, 462_575_000);
    const dist = Math.hypot(a.lat - b.lat, a.lng - b.lng);
    expect(dist).toBeGreaterThan(0.01);
  });

  it("keeps synthetic points inside the local field and away from home", () => {
    const p = syntheticPoint(HOME, 18_000, 146_790_000);
    const dLat = (p.lat - HOME.lat) * 111_320;
    const dLon = (p.lng - HOME.lng) * 111_320 * Math.cos(HOME.lat * Math.PI / 180);
    expect(Math.hypot(dLat, dLon)).toBeGreaterThan(4_000);
    expect(Math.hypot(dLat, dLon)).toBeLessThanOrEqual(18_000);
  });

  it("selects an empty area away from a cluster of known sites", () => {
    const occupied = [
      { lat: HOME.lat + 0.07, lng: HOME.lng },
      { lat: HOME.lat + 0.06, lng: HOME.lng + 0.03 },
      { lat: HOME.lat + 0.06, lng: HOME.lng - 0.03 },
    ];
    const p = syntheticPoint(HOME, 18_000, 146_790_000, occupied);
    expect(p.lat).toBeLessThan(HOME.lat + 0.04);
  });
});

describe("coverageRadiusM — power-rated blips", () => {
  it("scales with power and antenna height, clamped to sane bounds", () => {
    const wof = coverageRadiusM(110, 15);          // KUT966: 110 W at 15 m
    expect(wof).toBeGreaterThan(10_000);
    expect(wof).toBeLessThan(25_000);
    expect(coverageRadiusM(5, 3)).toBeGreaterThanOrEqual(2_000);     // handheld floor
    expect(coverageRadiusM(5000, 300)).toBeLessThanOrEqual(30_000);  // broadcast cap
    expect(coverageRadiusM(110, 30)).toBeGreaterThan(coverageRadiusM(110, 10));
    expect(coverageRadiusM(100, 15)).toBeGreaterThan(coverageRadiusM(10, 15));
  });
  it("assumes a typical mast when FCC omitted the height", () => {
    expect(coverageRadiusM(50)).toBe(coverageRadiusM(50, 15));
  });
});
