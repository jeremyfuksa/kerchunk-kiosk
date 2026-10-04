import { describe, it, expect } from "vitest";
import { oklchHex, hexToOklab } from "../src/frontend/lib/oklch.js";

describe("oklch", () => {
  it("converts known OKLCH colours to sRGB hex", () => {
    expect(oklchHex({ L: 0.62, C: 0.20, h: 17 })).toBe("#e54059");
    expect(oklchHex({ L: 0.80, C: 0.23, h: 212 })).toBe("#21d4f0");
  });
  it("pulls an out-of-gamut chroma in instead of clipping channels", () => {
    const hex = oklchHex({ L: 0.8, C: 0.5, h: 212 });
    expect(hex).toMatch(/^#[0-9a-f]{6}$/);
  });
  it("hexToOklab round-trips lightness", () => {
    expect(hexToOklab("#ffffff")[0]).toBeCloseTo(1, 3);
    expect(hexToOklab("#000000")[0]).toBeCloseTo(0, 3);
  });
});
