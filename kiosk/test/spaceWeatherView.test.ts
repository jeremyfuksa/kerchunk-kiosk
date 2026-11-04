import { describe, it, expect } from "vitest";
import { bandCondition, spaceWeatherHtml } from "../src/frontend/dashboard/spaceWeatherView.js";

const O = { spaceWeatherShow: true, spaceWeatherFairKp: 4, spaceWeatherPoorKp: 7, spaceWeatherFairFlux: 80 };
const TODAY = { solarFlux: 100, kp: 3, r: 0, s: 0, g: 0 };   // NOAA, 2026-11-04
const NONE = { solarFlux: null, kp: null, r: null, s: null, g: null };

describe("bandCondition", () => {
  it("green on a quiet day", () => { expect(bandCondition(TODAY, O)).toBe("good"); });
  it("yellow from Kp 4, red from Kp 7", () => {
    expect(bandCondition({ ...TODAY, kp: 3.99 }, O)).toBe("good");
    expect(bandCondition({ ...TODAY, kp: 4 }, O)).toBe("fair");
    expect(bandCondition({ ...TODAY, kp: 6.99 }, O)).toBe("fair");
    expect(bandCondition({ ...TODAY, kp: 7 }, O)).toBe("poor");
  });
  it("yellow for an R1 or R2 blackout, red from R3", () => {
    expect(bandCondition({ ...TODAY, r: 1 }, O)).toBe("fair");
    expect(bandCondition({ ...TODAY, r: 2 }, O)).toBe("fair");
    expect(bandCondition({ ...TODAY, r: 3 }, O)).toBe("poor");
  });
  it("yellow when the sun is too quiet to hold up the high bands", () => {
    expect(bandCondition({ ...TODAY, solarFlux: 79 }, O)).toBe("fair");
    expect(bandCondition({ ...TODAY, solarFlux: 80 }, O)).toBe("good");
  });
  it("the worst sign wins", () => { expect(bandCondition({ ...TODAY, solarFlux: 70, r: 3 }, O)).toBe("poor"); });
  it("judges from what's there when part of the feed is out", () => {
    expect(bandCondition({ ...NONE, kp: 5 }, O)).toBe("fair");
    expect(bandCondition({ ...NONE, solarFlux: 100 }, O)).toBe("good");
  });
  it("has no opinion with nothing to go on", () => { expect(bandCondition(NONE, O)).toBeNull(); });
  it("follows the configured thresholds", () => {
    expect(bandCondition(TODAY, { ...O, spaceWeatherFairKp: 2 })).toBe("fair");
    expect(bandCondition(TODAY, { ...O, spaceWeatherPoorKp: 3 })).toBe("poor");
  });
});

describe("spaceWeatherHtml", () => {
  it("shows the light and numbers, and no storm line on a quiet day", () => {
    const h = spaceWeatherHtml(TODAY, O);
    expect(h).toContain('data-cond="good"');
    expect(h).toContain("Flux 100 · Kp 3");
    expect(h).not.toContain("kc-space__storms");
  });
  it("names what's wrong in a storm", () => {
    const h = spaceWeatherHtml({ ...TODAY, kp: 6.33, r: 3, g: 2 }, O);
    expect(h).toContain('data-cond="poor"');
    expect(h).toContain("R3 radio blackout · G2 storm");
    expect(h).toContain("Kp 6");
  });
  it("leaves out a number NOAA hasn't given", () => {
    expect(spaceWeatherHtml({ ...NONE, kp: 3 }, O)).toContain(">Kp 3<");
  });
  it("is empty when a feed outage leaves nothing, or it's switched off", () => {
    expect(spaceWeatherHtml(null, O)).toBe("");
    expect(spaceWeatherHtml(NONE, O)).toBe("");
    expect(spaceWeatherHtml(TODAY, { ...O, spaceWeatherShow: false })).toBe("");
  });
});
