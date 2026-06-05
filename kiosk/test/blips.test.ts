import { describe, it, expect } from "vitest";
import { BlipField } from "../src/frontend/map/blips.js";

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
