import { describe, it, expect } from "vitest";
import { subsolar, sunAltitude } from "../src/frontend/dashboard/sun.js";
import { CENTER_LON, MAP_H, MAP_W, miller } from "../src/frontend/dashboard/miller.js";
import { greylineDue, STAGE_VIEWBOX, GREYLINE_BANDS, nightEdges, nightBandPath, nightInterval, skySvg, greylineSvg } from "../src/frontend/dashboard/greyline.js";

const NOV = Date.UTC(2026, 10, 3, 9, 11);
const JUNE = Date.UTC(2026, 5, 21, 12, 0);
const near = (a: number, b: number, by: number) => expect(Math.abs(a - b)).toBeLessThanOrEqual(by);

describe("subsolar", () => {
  it("subsolar_nov_3_0911_utc", () => {
    const s = subsolar(NOV);
    near(s.lat, -15, 1);
    near(s.lon, 38.2, 1);   // noon there is 16 min before 12:00 UTC at Greenwich this time of year
  });
  it("subsolar_june_solstice_noon_utc", () => {
    const s = subsolar(JUNE);
    near(s.lat, 23.4, 1);
    near(s.lon, 0, 3);
  });
  it("altitude_at_the_sun_is_90_and_opposite_is_minus_90", () => {
    const s = subsolar(NOV);
    near(sunAltitude(s.lat, s.lon, s), 90, 0.01);
    near(sunAltitude(-s.lat, s.lon + 180, s), -90, 0.01);
  });
});

describe("night bands", () => {
  const sub = subsolar(NOV);
  it("night_band_covers_midnight_not_noon", () => {
    const anti = sub.lon - 180;
    const at = nightInterval(-0.8, anti, sub)!;
    expect(at.lo).toBeLessThan(0);
    expect(at.hi).toBeGreaterThan(0);
    const noon = nightInterval(-0.8, sub.lon, sub)!;
    expect(noon.lo).toBeGreaterThan(0);
  });
  it("night_band_exists_at_the_equinox", () => {
    for (const b of GREYLINE_BANDS) expect(nightBandPath(b.alt, { lat: 0, lon: 0 })).toMatch(/^M/);
  });
  it("night reaching a pole runs off the stage, so no band ends in a line at the frame", () => {
    for (const b of GREYLINE_BANDS) expect(nightEdges(b.alt, sub.lon - 180, sub)!.upper).toBeLessThan(0);   // November: the north
    const s = subsolar(JUNE);
    for (const b of GREYLINE_BANDS) expect(nightEdges(b.alt, s.lon - 180, s)!.lower).toBeGreaterThan(MAP_H);
  });
  it("the edge is the true terminator, a real wave at the solstice", () => {
    const ys = Array.from({ length: 180 }, (_, i) => nightEdges(-0.8, i * 2 - 180, subsolar(JUNE)))
      .flatMap((e) => (e ? [e.upper, e.lower] : [])).filter((y) => y > 0 && y < MAP_H);
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(200);
  });
  it("sky_is_stable_between_calls", () => {
    expect(skySvg(NOV)).toBe(skySvg(NOV));
    const still = (s: string) => s.slice(0, s.indexOf('id="hfGreyline"'));
    expect(still(skySvg(NOV))).toBe(still(skySvg(JUNE)));
  });
  it("the sky holds the redrawable greyline", () => {
    expect(skySvg(NOV)).toContain(greylineSvg(NOV));
  });
  it("uses the spec's six bands", () => {
    expect(GREYLINE_BANDS.map((b) => b.alt)).toEqual([-0.8, -3, -6, -9, -12, -14]);
    expect(GREYLINE_BANDS.map((b) => b.color)).toEqual(["#5b3f7f", "#4c3580", "#3a2c78", "#2a2466", "#1c1c50", "#14163c"]);
  });
});

function inPath(d: string, px: number, py: number): boolean {
  let inside = false;
  for (const sub of d.split("M").filter(Boolean)) {
    const pts = sub.replace("Z", "").split("L").map((p) => p.split(" ").map(Number) as [number, number]);
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [xi, yi] = pts[i]!;
      const [xj, yj] = pts[j]!;
      if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

describe("framing", () => {
  const [x0, y0, w, h] = STAGE_VIEWBOX.split(" ").map(Number) as [number, number, number, number];
  it("shows the whole map, in the wall's shape", () => {
    expect([x0, y0, w, h]).toEqual([0, 0, MAP_W, MAP_H]);
    expect(h / w).toBeCloseTo(768 / 1366, 2);
  });
  it("has home in the middle", () => {
    expect(miller(39.29, CENTER_LON).x).toBeCloseTo(w / 2, 6);
  });
});

describe("band shape", () => {
  it("a band at the map's edge doesn't cover daylight inside the rim", () => {
    const s = subsolar(Date.UTC(2026, 2, 20, 18));   // terminator on the antimeridian
    const d = nightBandPath(-0.8, s);
    const at = (lon: number) => { const p = miller(0, lon); return [p.x, p.y] as const; };
    expect(inPath(d, ...at(-147))).toBe(false);       // afternoon there
    expect(inPath(d, ...at(91))).toBe(true);          // night there
  });
});

describe("greylineDue", () => {
  it("greyline_redraws_only_when_the_step_passes", () => {
    expect(greylineDue(1_000, 1_000 + 299_999, 300_000)).toBe(false);
    expect(greylineDue(1_000, 1_000 + 300_000, 300_000)).toBe(true);
  });
});

