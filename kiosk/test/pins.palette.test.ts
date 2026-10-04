import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PIN_COLORS, PIN_GLYPH_INK, type PinCategory } from "../src/frontend/lib/serviceColor.js";

const DIR = join(__dirname, "..", "src", "frontend", "map", "pins");
const CATS = Object.keys(PIN_COLORS) as PinCategory[];

// Drift guard (spec 2026-10-04 §2): the pin SVGs bake the head colour and the
// glyph stroke in as literals; a palette edit that forgets them must fail.
describe("pin SVGs follow the palette", () => {
  for (const cat of CATS) {
    it(cat, () => {
      const svg = readFileSync(join(DIR, `pin-${cat}.svg`), "utf8");
      const head = /<circle cx="21" cy="21" r="17\.5" fill="(#[0-9A-Fa-f]{6})"/.exec(svg)?.[1];
      const ink = /<g transform="translate\(10\.5 10\.5\) scale\(0\.875\)"[^>]*stroke="(#[0-9A-Fa-f]{6})"/.exec(svg)?.[1];
      expect(head?.toLowerCase(), "head fill").toBe(PIN_COLORS[cat]!.toLowerCase());
      expect(ink?.toLowerCase(), "glyph stroke").toBe(PIN_GLYPH_INK[cat].toLowerCase());
    });
  }
});
