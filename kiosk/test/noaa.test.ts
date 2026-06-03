import { describe, it, expect } from "vitest";
import { NOAA_CHANNELS, NOAA_MODE } from "../src/backend/config/noaa.js";

describe("NOAA channels", () => {
  it("has the 7 NWR frequencies in the 162.4-162.55 MHz band", () => {
    expect(NOAA_CHANNELS).toHaveLength(7);
    const freqs = NOAA_CHANNELS.map((c) => c.freq).sort((a, b) => a - b);
    expect(freqs).toEqual([162400000, 162425000, 162450000, 162475000, 162500000, 162525000, 162550000]);
  });
  it("uses nfm mode", () => {
    expect(NOAA_MODE).toBe("nfm");
  });

  it("maps each WX label to its canonical NWS frequency", () => {
    const byLabel = Object.fromEntries(NOAA_CHANNELS.map((c) => [c.label, c.freq]));
    expect(byLabel["WX1"]).toBe(162550000);
    expect(byLabel["WX2"]).toBe(162400000);
    expect(byLabel["WX3"]).toBe(162475000);
    expect(byLabel["WX4"]).toBe(162425000);
    expect(byLabel["WX5"]).toBe(162450000);
    expect(byLabel["WX6"]).toBe(162500000);
    expect(byLabel["WX7"]).toBe(162525000);
  });

  it("each mhz string matches its freq (freq/1e6 to 3 decimals)", () => {
    for (const c of NOAA_CHANNELS) {
      expect((c.freq / 1e6).toFixed(3)).toBe(c.mhz);
    }
  });
});
