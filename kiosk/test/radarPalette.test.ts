import { describe, it, expect } from "vitest";
import { RADAR_STOPS, radarPaletteGlsl } from "../src/frontend/map/radarPalette.js";

// Operator mandate (2026-10-01): radar colours may be tuned to the theme but
// must keep the conventional reflectivity meaning — light blue → green →
// yellow → orange → red → magenta → violet/white, at the NWS breakpoints.
function hue([r, g, b]: readonly [number, number, number]): number {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (d === 0) return 0;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}

describe("radar palette", () => {
  it("follows the conventional order of meaning", () => {
    expect(RADAR_STOPS.map((s) => s.name)).toEqual(["blue", "green", "deep-green", "yellow", "orange", "red", "magenta", "violet"]);
  });

  it("sits on the NWS reflectivity breakpoints, ascending", () => {
    expect(RADAR_STOPS.map((s) => s.dbz)).toEqual([15, 22, 32, 38, 45, 52, 60, 68]);
  });

  it("each stop's hue is in its conventional family", () => {
    const fam: Record<string, [number, number]> = {
      blue: [190, 230], green: [120, 165], "deep-green": [120, 165], yellow: [40, 60],
      orange: [20, 40], red: [345, 375], magenta: [290, 330], violet: [240, 290],
    };
    for (const s of RADAR_STOPS) {
      const [lo, hi] = fam[s.name]!;
      let h = hue(s.rgb);
      if (hi > 360 && h < lo) h += 360;
      expect([s.name, h >= lo && h <= hi]).toEqual([s.name, true]);
    }
  });

  it("generates a GLSL function over exactly these stops", () => {
    const src = radarPaletteGlsl();
    expect(src).toContain("vec3 radarColor(float d)");
    for (const s of RADAR_STOPS) expect(src).toContain(`${s.dbz.toFixed(1)}`);
  });
});
