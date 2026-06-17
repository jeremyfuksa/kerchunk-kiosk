import { describe, it, expect } from "vitest";
import { PIN_COLORS, colorFor, categoryFor } from "../src/frontend/lib/serviceColor.js";

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
  it("falls back to a warm orange when frequency is unknown", () => {
    expect(colorFor(undefined, "active")).toBe("#ff6b35");
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

  it("pins the recolored/added head hexes (blip + pin palette)", () => {
    expect(PIN_COLORS.rail).toBe("#8B5034"); // subdued rust, was #F5821F
    expect(PIN_COLORS.biz).toBe("#6D28D9"); // deeper violet, was #7C4FE0
    expect(PIN_COLORS.publicsafety).toBe("#E5383B"); // new public-safety red
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
    expect(colorFor(undefined, "active")).toBe("#ff6b35"); // still the warm orange with no tag
  });

  it("the nofix gray still wins over any tag (geography is the uncertain bit)", () => {
    expect(colorFor(PS_FREQ, "nofix", ["public-safety"])).toBe("#4a7c7e");
  });
});
