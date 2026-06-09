import { describe, it, expect } from "vitest";
import { PIN_COLORS, colorFor } from "../src/frontend/lib/serviceColor.js";

describe("colorFor", () => {
  it("maps a ham frequency to the ham pin color", () => {
    expect(colorFor(146_520_000, "active")).toBe(PIN_COLORS.ham);
  });
  it("maps a NOAA weather frequency to the weather color", () => {
    expect(colorFor(162_550_000, "active")).toBe(PIN_COLORS.weather);
  });
  it("returns the unknown color for an unclassified frequency", () => {
    expect(colorFor(300_000_000, "active")).toBe(PIN_COLORS.unknown);
  });
  it("uses the nofix color when geography is synthetic", () => {
    expect(colorFor(146_520_000, "nofix")).toBe("#4a7c7e");
  });
  it("falls back to a warm orange when frequency is unknown", () => {
    expect(colorFor(undefined, "active")).toBe("#ff6b35");
    expect(colorFor(undefined, "closecall")).toBe("#dc3a38");
  });
});
