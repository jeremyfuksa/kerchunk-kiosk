import { describe, it, expect } from "vitest";
import { subsolar, sunAltitude } from "../src/frontend/dashboard/sun.js";
import { robinson } from "../src/frontend/dashboard/robinson.js";
import { greylineDue, STAGE_VIEWBOX, GREYLINE_BANDS, nightEdges, nightBandPath, nightInterval, skySvg, greylineSvg, globeOutline } from "../src/frontend/dashboard/greyline.js";

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
  it("bands_bleed_past_the_stage_in_november", () => {
    for (const b of GREYLINE_BANDS) {
      const e = nightEdges(b.alt, sub.lon - 180, sub)!;
      expect(e.lower).toBeGreaterThanOrEqual(1069);
    }
  });
  it("bands_bleed_past_the_globe_in_june", () => {
    const s = subsolar(JUNE);
    for (const b of GREYLINE_BANDS) {
      const e = nightEdges(b.alt, s.lon - 180, s)!;
      expect(e.upper).toBeLessThanOrEqual(-17);
    }
  });
  it("sky_is_stable_between_calls", () => {
    expect(skySvg(NOV)).toBe(skySvg(NOV));
    const stars = (s: string) => s.slice(0, s.indexOf('id="hfGreyline"'));
    expect(stars(skySvg(NOV))).toBe(stars(skySvg(JUNE)));
  });
  it("the sky holds the redrawable greyline, inside the globe", () => {
    expect(skySvg(NOV)).toContain(greylineSvg(NOV));
    expect(globeOutline()).toMatch(/^M.*Z$/);
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
  const pxPerUnit = 1366 / w;
  it("the pole's flat line and the high Arctic are off the top, so traces leave rather than flatten", () => {
    expect(y0).toBeGreaterThan(robinson(82, 0).y);
  });
  it("the flat south edge is hidden behind the reception band", () => {
    const southPx = (robinson(-90, 0).y - y0) * pxPerUnit;
    expect(southPx).toBeGreaterThanOrEqual(708);
  });
  it("most of the empty southern sea sits behind the reception band", () => {
    expect((robinson(-75, 0).y - y0) * pxPerUnit).toBeLessThanOrEqual(715);
  });
  it("every landmass stays on screen, New Zealand and Hawaii included", () => {
    expect(robinson(-47, 178).x).toBeLessThan(x0 + w);
    expect(robinson(21, -160).x).toBeGreaterThan(x0);
  });
  it("keeps the wall's shape and centres the globe", () => {
    expect(h / w).toBeCloseTo(768 / 1366, 2);
    expect(x0 + w / 2).toBeCloseTo(robinson(0, 0).x, 0);
  });
});

describe("band shape", () => {
  it("a band at the map's edge doesn't cover daylight inside the rim", () => {
    const s = subsolar(Date.UTC(2026, 2, 20, 18));   // terminator on the antimeridian
    const d = nightBandPath(-0.8, s);
    expect(inPath(d, 150, 500)).toBe(false);          // the equator near 147 W, afternoon there
    expect(inPath(d, 1500, 500)).toBe(true);          // the equator near 91 E, night there
  });
});

describe("greylineDue", () => {
  it("greyline_redraws_only_when_the_step_passes", () => {
    expect(greylineDue(1_000, 1_000 + 299_999, 300_000)).toBe(false);
    expect(greylineDue(1_000, 1_000 + 300_000, 300_000)).toBe(true);
  });
});
