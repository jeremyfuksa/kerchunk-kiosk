import { describe, it, expect } from "vitest";
import { removedHexes, planeIconRotation, kindScale, segmentOpacity } from "../src/frontend/map/aircraft.js";

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

describe("segmentOpacity", () => {
  it("fades from brightest at the head to faintest at the tail", () => {
    const segCount = 6;
    const head = segmentOpacity(segCount - 1, segCount);
    const tail = segmentOpacity(0, segCount);
    expect(head).toBeGreaterThan(tail);
    expect(tail).toBeGreaterThan(0);
  });
  it("never exceeds the head opacity", () => {
    expect(segmentOpacity(9, 10, 0.5)).toBeCloseTo(0.5, 5);
    for (let i = 0; i < 10; i++) expect(segmentOpacity(i, 10, 0.5)).toBeLessThanOrEqual(0.5);
  });
  it("returns 0 for an empty trail", () => {
    expect(segmentOpacity(0, 0)).toBe(0);
  });
});
