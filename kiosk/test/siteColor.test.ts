import { describe, it, expect } from "vitest";
import { siteColor, SITE_ARC } from "../src/frontend/lib/siteColor.js";
import { PIN_COLORS, FAMILY_OKLCH, type PinCategory } from "../src/frontend/lib/serviceColor.js";
import { hexToOklab } from "../src/frontend/lib/oklch.js";

const keys = Array.from({ length: 1500 }, (_, i) => `${(39 + i * 1e-4).toFixed(5)},${(-94.5 - i * 3e-4).toFixed(5)}`);

describe("siteColor", () => {
  it("same key, same colour; different keys usually differ", () => {
    expect(siteColor("39.16139,-94.46806", "biz", "site")).toBe(siteColor("39.16139,-94.46806", "biz", "site"));
    const distinct = new Set(keys.slice(0, 50).map((k) => siteColor(k, "biz", "site")));
    expect(distinct.size).toBeGreaterThan(30);
  });
  it("service mode returns the family base", () => {
    for (const cat of Object.keys(PIN_COLORS) as PinCategory[]) {
      expect(siteColor(keys[0]!, cat, "service"), cat).toBe(PIN_COLORS[cat]);
    }
  });
  it("families with no arc (weather, unknown) never vary", () => {
    expect(SITE_ARC.weather).toEqual({ hue: 0, light: 0 });
    expect(siteColor(keys[7]!, "weather", "site")).toBe(PIN_COLORS.weather);
    expect(siteColor(keys[7]!, "unknown", "site")).toBe(PIN_COLORS.unknown);
  });
  it("every variant is a valid hex", () => {
    for (const k of keys.slice(0, 200)) expect(siteColor(k, "ham", "site")).toMatch(/^#[0-9a-f]{6}$/);
  });
  it("containment: each variant's nearest family base is its own (business may sit nearer marine)", () => {
    const fams = Object.keys(FAMILY_OKLCH) as Array<keyof typeof FAMILY_OKLCH>;
    const base = Object.fromEntries(fams.map((f) => [f, hexToOklab(PIN_COLORS[f]!)]));
    for (const f of fams) {
      for (const k of keys) {
        const p = hexToOklab(siteColor(k, f, "site"));
        let best = "", bd = Infinity;
        for (const g of fams) {
          const q = base[g]!;
          const d = Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
          if (d < bd) { bd = d; best = g; }
        }
        const ok = best === f || (f === "biz" && best === "marine");
        expect(ok, `${f} key ${k} nearer ${best}`).toBe(true);
      }
    }
  });
});
