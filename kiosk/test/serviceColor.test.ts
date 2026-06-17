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

  it("gives dedicated 700 MHz PS and 800 MHz trunked the public-safety color", () => {
    expect(colorFor(770_000_000, "active")).toBe(PIN_COLORS.publicsafety); // 700 PS
    expect(colorFor(815_000_000, "active")).toBe(PIN_COLORS.publicsafety); // 800 trunked
  });
  it("keeps the mixed biz/PS conventional bands and T-band on the biz color", () => {
    expect(colorFor(152_000_000, "active")).toBe(PIN_COLORS.biz); // VHF biz/PS
    expect(colorFor(452_000_000, "active")).toBe(PIN_COLORS.biz); // UHF biz/PS
    expect(colorFor(480_000_000, "active")).toBe(PIN_COLORS.biz); // T-band
    expect(colorFor(900_000_000, "active")).toBe(PIN_COLORS.biz); // 900 biz
  });
  it("maps a rail frequency to the rail color", () => {
    expect(colorFor(160_000_000, "active")).toBe(PIN_COLORS.rail);
  });

  it("pins the recolored/added head hexes (blip + pin palette)", () => {
    expect(PIN_COLORS.rail).toBe("#8B5034"); // subdued rust, was #F5821F
    expect(PIN_COLORS.biz).toBe("#6D28D9"); // deeper violet, was #7C4FE0
    expect(PIN_COLORS.publicsafety).toBe("#E5383B"); // new public-safety red
  });
});
