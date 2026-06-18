import { describe, it, expect } from "vitest";
import { removedHexes, planeIconRotation, kindScale } from "../src/frontend/map/aircraft.js";

describe("removedHexes", () => {
  it("returns hexes present before but absent from the new snapshot", () => {
    const prev = ["a", "b", "c"];
    const next = [{ hex: "b" }, { hex: "d" }];
    expect(removedHexes(prev, next).sort()).toEqual(["a", "c"]);
  });

  it("returns nothing when every previous hex is still present", () => {
    expect(removedHexes(["a", "b"], [{ hex: "a" }, { hex: "b" }])).toEqual([]);
  });

  it("returns all previous hexes for an empty snapshot", () => {
    expect(removedHexes(["a", "b"], []).sort()).toEqual(["a", "b"]);
  });
});

describe("planeIconRotation", () => {
  it("passes a known heading through", () => {
    expect(planeIconRotation(155.5)).toBe(155.5);
  });
  it("defaults to 0 when heading is unknown", () => {
    expect(planeIconRotation(null)).toBe(0);
  });
});

describe("kindScale", () => {
  it("sizes airliners largest and unknown smallest", () => {
    expect(kindScale("airliner", "A3")).toBeGreaterThan(kindScale("prop", "A1"));
    expect(kindScale("unknown", null)).toBeLessThan(kindScale("prop", "A1"));
  });
  it("shrinks A2 small/regional jets below heavy airliners", () => {
    expect(kindScale("airliner", "A2")).toBeLessThan(kindScale("airliner", "A3"));
  });
  it("does not shrink a heavy airliner", () => {
    expect(kindScale("airliner", "A5")).toBe(kindScale("airliner", "A3"));
  });
});
