import { describe, it, expect } from "vitest";
import { scatterSpot, isSilentHit, type ScatterStage } from "../src/frontend/map/scatter.js";
import { lngLatToViewPx } from "../src/frontend/map/stage.js";

const STAGE: ScatterStage = {
  box: { n: 39.35, s: 38.85, e: -94.2, w: -94.95 }, width: 1920, height: 1080,
  inner: { left: 80, top: 250, right: 1840, bottom: 960 },
};

describe("scatterSpot", () => {
  it("is deterministic per frequency", () => {
    expect(scatterSpot(463_562_500, STAGE, 80)).toEqual(scatterSpot(463_562_500, STAGE, 80));
    expect(scatterSpot(463_562_500, STAGE, 80)).not.toEqual(scatterSpot(463_587_500, STAGE, 80));
  });
  it("lands inside the padded stage less the margin", () => {
    for (let f = 450_000_000; f < 470_000_000; f += 12_500) {
      const s = scatterSpot(f, STAGE, 80);
      const p = lngLatToViewPx(s.lat, s.lng, STAGE.box, STAGE.width, STAGE.height);
      expect(p.x).toBeGreaterThanOrEqual(160 - 0.5);
      expect(p.x).toBeLessThanOrEqual(1760 + 0.5);
      expect(p.y).toBeGreaterThanOrEqual(330 - 0.5);
      expect(p.y).toBeLessThanOrEqual(880 + 0.5);
    }
  });
  it("spreads by area (no centre clumping): each quadrant gets 15–35%", () => {
    const q = [0, 0, 0, 0];
    let n = 0;
    for (let f = 450_000_000; f < 470_000_000; f += 12_500) {
      const s = scatterSpot(f, STAGE, 80);
      const p = lngLatToViewPx(s.lat, s.lng, STAGE.box, STAGE.width, STAGE.height);
      q[(p.x < 960 ? 0 : 1) + (p.y < 605 ? 0 : 2)]!++; n++;
    }
    for (const c of q) { expect(c / n).toBeGreaterThan(0.15); expect(c / n).toBeLessThan(0.35); }
  });
  it("colour is a stable hex, varying across frequencies", () => {
    const hexes = new Set<string>();
    for (let f = 460_000_000; f < 460_250_000; f += 12_500) hexes.add(scatterSpot(f, STAGE, 80).hex);
    expect([...hexes].every((h) => /^#[0-9a-f]{6}$/i.test(h))).toBe(true);
    expect(hexes.size).toBeGreaterThan(12);
  });
  it("a margin larger than the stage collapses to the centre, never outside", () => {
    const s = scatterSpot(463_562_500, STAGE, 5000);
    const p = lngLatToViewPx(s.lat, s.lng, STAGE.box, STAGE.width, STAGE.height);
    expect(Math.abs(p.x - 960)).toBeLessThan(1);
    expect(Math.abs(p.y - 605)).toBeLessThan(1);
  });
});

describe("isSilentHit", () => {
  const FAM = ["air", "rail", "marine", "ham", "gmrs"];
  it("live channel flag wins when present", () => {
    expect(isSilentHit(146_790_000, undefined, false, FAM)).toBe(true);
    expect(isSilentHit(463_562_500, undefined, true, FAM)).toBe(false);
  });
  it("history rows (no flag) fall back to family", () => {
    expect(isSilentHit(463_562_500, undefined, undefined, FAM)).toBe(true);
    expect(isSilentHit(463_562_500, ["ham"], undefined, FAM)).toBe(false);
    expect(isSilentHit(162_550_000, undefined, undefined, [])).toBe(false);   // weather
    expect(isSilentHit(300_000_000, undefined, undefined, FAM)).toBe(true);   // unknown
  });
  it("CB-mode hits are never scattered (they stay off the map)", () => {
    expect(isSilentHit(27_185_000, ["cb"], undefined, FAM)).toBe(false);
    expect(isSilentHit(27_185_000, ["cb"], false, FAM)).toBe(false);
  });
});
