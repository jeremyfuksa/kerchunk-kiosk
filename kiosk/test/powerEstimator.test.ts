import { describe, it, expect } from "vitest";
import { solveK, estimateWatts, pathLossDb, distKm } from "../src/backend/powerEstimator.js";

// Synthesize a world with a known receiver constant, then recover it.
const K = 132.5;
const rf = (watts: number, km: number, mhz: number) =>
  10 * Math.log10(watts) - pathLossDb(km, mhz) + K;

describe("ERP estimator", () => {
  const anchors = [
    { powerWatts: 110, distKm: 13.2, freqMhz: 463.425, rfDb: rf(110, 13.2, 463.425) },
    { powerWatts: 45, distKm: 9.1, freqMhz: 160.5, rfDb: rf(45, 9.1, 160.5) },
    { powerWatts: 5, distKm: 19.4, freqMhz: 160.32, rfDb: rf(5, 19.4, 160.32) },
  ];
  it("recovers the receiver constant from licensed anchors", () => {
    expect(solveK(anchors)).toBeCloseTo(K, 5);
  });
  it("round-trips a known transmitter through the model", () => {
    const k = solveK(anchors)!;
    expect(estimateWatts(rf(50, 10, 146.79), 10, 146.79, k)).toBe(50);
    expect(estimateWatts(rf(100, 25, 462.675), 25, 462.675, k)).toBe(100);
  });
  it("clamps to sane wattage and rounds to 2 significant figures", () => {
    const k = solveK(anchors)!;
    expect(estimateWatts(rf(99999, 5, 460), 5, 460, k)).toBe(500);
    expect(estimateWatts(rf(0.001, 5, 460), 5, 460, k)).toBe(1);
  });
  it("refuses to calibrate from too few anchors", () => {
    expect(solveK(anchors.slice(0, 2))).toBeNull();
  });
  it("haversine sanity", () => {
    expect(distKm({ lat: 39.2915, lon: -94.4953 }, { lat: 39.1764, lon: -94.4911 })).toBeCloseTo(12.8, 0);
  });
});
