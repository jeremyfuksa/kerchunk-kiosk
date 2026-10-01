import { describe, it, expect } from "vitest";
import { glyphOf, serviceHead, WELL_HEX, HEAD_MIN_CONTRAST } from "../src/frontend/faceplate/serviceHead.js";
import { PIN_COLORS, type PinCategory } from "../src/frontend/lib/serviceColor.js";
import { readProps, resolve, contrast } from "./cssTokens.js";

const CATS = Object.keys(PIN_COLORS) as PinCategory[];

describe("serviceHead", () => {
  it("every category has its PIN_COLORS colour and a non-empty lucide glyph", () => {
    for (const cat of CATS) {
      const h = serviceHead(cat);
      expect(h.color, cat).toBe(PIN_COLORS[cat]);
      expect(h.glyph, cat).toMatch(/<(path|circle|rect|line|polyline)\b/);
      expect(h.glyph, cat).not.toContain("<g");
    }
  });
  it("rings exactly the heads under 3:1 on the well (today: business, rail)", () => {
    const ringed = CATS.filter((c) => serviceHead(c).ringed).sort();
    expect(ringed).toEqual(["biz", "rail"]);
    for (const c of CATS) {
      const h = serviceHead(c);
      expect(h.ringed, c).toBe(contrast(h.color, WELL_HEX) < HEAD_MIN_CONTRAST);
    }
  });
  it("WELL_HEX is --kc-well", () => {
    const p = readProps("src/frontend/tokens.css");
    expect(resolve(p, p["--kc-well"]!).toLowerCase()).toBe(WELL_HEX);
  });
  it("glyphOf fails loudly when a pin's glyph group is missing", () => {
    expect(() => glyphOf("<svg><circle r='1'/></svg>")).toThrow(/glyph group/);
  });
});

describe("serviceHead fallback", () => {
  it("a category outside the map falls back to the unknown head, colour AND glyph — never throws", () => {
    const h = serviceHead("not-a-service" as never);
    expect(h.color).toBe(serviceHead("unknown").color);
    expect(h.glyph).toBe(serviceHead("unknown").glyph);
  });
});
