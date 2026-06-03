import { describe, it, expect } from "vitest";
import { formToChannel, mhzToHz, weatherFormToChannel } from "../src/frontend/admin/admin.js";

describe("admin form helpers", () => {
  it("mhzToHz converts MHz string to integer Hz", () => {
    expect(mhzToHz("145.130")).toBe(145130000);
    expect(mhzToHz("146.94")).toBe(146940000);
  });

  it("formToChannel builds a valid payload", () => {
    const payload = formToChannel({ mhz: "145.130", alphaTag: "KC0KW", mode: "nfm" });
    expect(payload).toEqual({ freq: 145130000, alphaTag: "KC0KW", mode: "nfm", enabled: true });
  });

  it("formToChannel throws on a non-numeric frequency", () => {
    expect(() => formToChannel({ mhz: "abc", alphaTag: "x", mode: "fm" })).toThrow();
  });
});

describe("weather form helper", () => {
  it("weatherFormToChannel builds a valid weather-channel payload", () => {
    const payload = weatherFormToChannel({ mhz: "162.550", alphaTag: "NOAA WX", mode: "nfm" });
    expect(payload).toEqual({ freq: 162550000, alphaTag: "NOAA WX", mode: "nfm", enabled: true });
  });

  it("weatherFormToChannel throws on a non-numeric frequency", () => {
    expect(() => weatherFormToChannel({ mhz: "x", alphaTag: "y", mode: "fm" })).toThrow();
  });
});
