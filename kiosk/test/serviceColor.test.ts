import { describe, it, expect } from "vitest";
import { PIN_COLORS, PIN_GLYPH_INK, FAMILY_OKLCH, colorFor, categoryFor } from "../src/frontend/lib/serviceColor.js";
import { linearRgb, linearToOklab } from "../src/frontend/lib/oklch.js";

describe("colorFor", () => {
  it("maps a ham frequency to the ham pin color", () => {
    expect(colorFor(146_520_000, "active")).toBe(PIN_COLORS.ham);
  });
  it("maps a NOAA weather frequency to the weather color", () => {
    expect(colorFor(162_550_000, "active")).toBe(PIN_COLORS.weather);
  });
  it("returns the unknown color for an unclassified frequency", () => {
    expect(colorFor(300_000_000, "active")).toBe(PIN_COLORS.unknown);
  });
  it("uses the nofix color when geography is synthetic", () => {
    expect(colorFor(146_520_000, "nofix")).toBe("#4a7c7e");
  });
  it("falls back to sea-glass (live) or flamingo (close call) when frequency is unknown", () => {
    expect(colorFor(undefined, "active")).toBe("#5fd4c3");
    expect(colorFor(undefined, "closecall")).toBe("#dc3a38");
  });

  it("gives dedicated 700 MHz PS and 800 MHz trunked the public-safety color", () => {
    expect(colorFor(770_000_000, "active")).toBe(PIN_COLORS.publicsafety); // 700 PS
    expect(colorFor(815_000_000, "active")).toBe(PIN_COLORS.publicsafety); // 800 trunked
  });
  it("keeps the mixed biz/PS conventional bands and T-band on the biz color", () => {
    expect(colorFor(152_000_000, "active")).toBe(PIN_COLORS.biz); // VHF biz/PS
    expect(colorFor(452_000_000, "active")).toBe(PIN_COLORS.biz); // UHF biz/PS
    expect(colorFor(480_000_000, "active")).toBe(PIN_COLORS.biz); // T-band
    expect(colorFor(900_000_000, "active")).toBe(PIN_COLORS.biz); // 900 biz
  });
  it("maps a rail frequency to the rail color", () => {
    expect(colorFor(160_000_000, "active")).toBe(PIN_COLORS.rail);
  });

  it("pins the glow-tuned family palette (spec 2026-10-04)", () => {
    expect(PIN_COLORS).toEqual({
      publicsafety: "#e54059", rail: "#e58212", weather: "#f5b40e", gmrs: "#56db8f",
      marine: "#07baaa", biz: "#21d4f0", air: "#0f90fe", ham: "#c55ac7", unknown: "#747B8A",
    });
  });
  it("glyph ink: white on public safety and unknown, dark ink elsewhere", () => {
    expect(PIN_GLYPH_INK.publicsafety).toBe("#ffffff");
    expect(PIN_GLYPH_INK.unknown).toBe("#ffffff");
    for (const k of ["rail", "weather", "gmrs", "marine", "biz", "air", "ham"] as const) {
      expect(PIN_GLYPH_INK[k], k).toBe("#1f2530");
    }
  });
  it("families stay apart under colour-vision deficiency (worst ΔE_ok ≥ 0.10)", () => {
    // Machado 2009 severity-1.0 matrices, applied in linear RGB.
    const M: Record<string, number[][]> = {
      normal: [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
      deutan: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.011820, 0.042940, 0.968881]],
      protan: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
    };
    const fams = Object.keys(FAMILY_OKLCH);
    for (const [name, m] of Object.entries(M)) {
      const P = fams.map((f) => {
        const v = linearRgb(PIN_COLORS[f]!);
        const sim = m.map((r) => Math.min(1, Math.max(0, r[0]! * v[0] + r[1]! * v[1] + r[2]! * v[2]))) as [number, number, number];
        return linearToOklab(sim);
      });
      for (let i = 0; i < P.length; i++) {
        for (let j = i + 1; j < P.length; j++) {
          const d = Math.hypot(P[i]![0] - P[j]![0], P[i]![1] - P[j]![1], P[i]![2] - P[j]![2]);
          expect(d, `${name} ${fams[i]}/${fams[j]}`).toBeGreaterThanOrEqual(0.10);
        }
      }
    }
  });
});

describe("operator service tag overrides the frequency guess", () => {
  // A conventional UHF EMS/hospital channel: by FREQUENCY it's biz/PS, but the
  // operator filed it in the Public Safety bank — the tag must win (red).
  const PS_FREQ = 462_975_000; // BuchCo EMS — serviceFor() => "UHF biz/PS"

  it("a public-safety tag turns a biz-by-frequency channel red", () => {
    expect(colorFor(PS_FREQ, "active")).toBe(PIN_COLORS.biz);                 // no tag: freq wins
    expect(colorFor(PS_FREQ, "active", ["public-safety"])).toBe(PIN_COLORS.publicsafety);
    expect(categoryFor(PS_FREQ, ["public-safety"])).toBe("publicsafety");
  });

  it("ignores unrecognized tags and falls back to frequency", () => {
    expect(colorFor(PS_FREQ, "active", ["liberty", "casino"])).toBe(PIN_COLORS.biz);
    expect(categoryFor(PS_FREQ, [])).toBe("biz");
  });

  it("the first RECOGNIZED tag decides (skips bank-irrelevant tags)", () => {
    expect(categoryFor(PS_FREQ, ["liberty", "public-safety"])).toBe("publicsafety");
  });

  it("a tag classifies even a location-only blip with no usable frequency", () => {
    expect(colorFor(undefined, "active", ["public-safety"])).toBe(PIN_COLORS.publicsafety);
    expect(colorFor(undefined, "active")).toBe("#5fd4c3"); // sea-glass: live, no tag
  });

  it("the nofix gray still wins over any tag (geography is the uncertain bit)", () => {
    expect(colorFor(PS_FREQ, "nofix", ["public-safety"])).toBe("#4a7c7e");
  });
});
