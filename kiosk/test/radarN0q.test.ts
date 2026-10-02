import { describe, it, expect } from "vitest";
import { n0qIndexToDbz, N0Q_NO_ECHO } from "../src/backend/radar/n0q.js";

// Anchors read from the live n0q_0.png PLTE on 2026-10-01: index 0 is black
// (no echo), index 64 is the 0 dBZ grey-blue, and the NWS 20 dBZ green band
// starts exactly at index 104 (75,214,144).
describe("n0qIndexToDbz", () => {
  it("index 0 is no echo", () => {
    expect(N0Q_NO_ECHO).toBe(0);
    expect(n0qIndexToDbz(0)).toBeNull();
  });
  it("matches the palette anchors", () => {
    expect(n0qIndexToDbz(64)).toBe(0);
    expect(n0qIndexToDbz(104)).toBe(20);
  });
  it("spans -31.5 .. 95.5 in 0.5 dBZ steps", () => {
    expect(n0qIndexToDbz(1)).toBe(-31.5);
    expect(n0qIndexToDbz(255)).toBe(95.5);
    expect(n0qIndexToDbz(105)! - n0qIndexToDbz(104)!).toBe(0.5);
  });
});
