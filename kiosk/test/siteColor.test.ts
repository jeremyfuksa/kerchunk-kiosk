import { describe, it, expect } from "vitest";
import { siteColor, SITE_ARC } from "../src/frontend/lib/siteColor.js";
import { PIN_COLORS, FAMILY_OKLCH, type PinCategory } from "../src/frontend/lib/serviceColor.js";
import { hexToOklab, linearRgb, linearToOklab } from "../src/frontend/lib/oklch.js";

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
  it("containment holds for colour-vision-deficient viewers too (deutan, protan)", () => {
    // Final review I1: arcs checked only under normal vision let ham variants
    // read as air under protanopia. Machado 2009 severity-1.0 matrices.
    const M: Record<string, number[][]> = {
      deutan: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.011820, 0.042940, 0.968881]],
      protan: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
    };
    const fams = Object.keys(FAMILY_OKLCH) as Array<keyof typeof FAMILY_OKLCH>;
    for (const [name, m] of Object.entries(M)) {
      const sim = (hex: string): [number, number, number] => {
        const v = linearRgb(hex);
        return linearToOklab(m.map((r) => Math.min(1, Math.max(0, r[0]! * v[0] + r[1]! * v[1] + r[2]! * v[2]))) as [number, number, number]);
      };
      const base = Object.fromEntries(fams.map((f) => [f, sim(PIN_COLORS[f]!)]));
      for (const f of fams) {
        for (const k of keys) {
          const p = sim(siteColor(k, f, "site"));
          let best = "", bd = Infinity;
          for (const g of fams) {
            const q = base[g]!;
            const d = Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
            if (d < bd) { bd = d; best = g; }
          }
          const ok = best === f || (f === "biz" && best === "marine");
          expect(ok, `${name}: ${f} key ${k} nearer ${best}`).toBe(true);
        }
      }
    }
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
