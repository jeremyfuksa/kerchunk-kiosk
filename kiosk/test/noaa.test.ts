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
});
