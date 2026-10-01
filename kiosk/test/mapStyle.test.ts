// The map's cartography can't read CSS: the console style (map-style.json) and
// the raster fallback (DARK_STYLE) carry hex. Pin both to the --kc-map-* tokens
// so the three can never drift apart silently.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { readProps, resolve, contrast } from "./cssTokens.js";
import { DARK_STYLE, MAP_GROUND } from "../src/frontend/map/map.js";

const props = readProps("src/frontend/tokens.css");
const v = (n: string): string => resolve(props, props[n] ?? "").toLowerCase();
const MAP_TOKENS = ["--kc-map-land", "--kc-map-water", "--kc-map-road", "--kc-map-road-edge", "--kc-map-label", "--kc-map-poi"];
const allowed = new Set(MAP_TOKENS.map(v));
const hexes = (s: string): string[] => (s.match(/#[0-9a-f]{3,8}\b/gi) ?? []).map((h) => h.toLowerCase());

describe("map cartography is the --kc-map-* tokens", () => {
  it("every token resolves to a hex", () => {
    for (const n of MAP_TOKENS) expect(v(n), n).toMatch(/^#[0-9a-f]{6}$/);
  });
  it("map-style.json (the console master) uses only map tokens", () => {
    const used = hexes(readFileSync("kiosk-assets/map-style.json", "utf8"));
    expect(used.length).toBeGreaterThan(5);
    expect(used.filter((h) => !allowed.has(h))).toEqual([]);
  });
  it("DARK_STYLE (the no-Map-ID fallback) uses only map tokens", () => {
    const used = hexes(JSON.stringify(DARK_STYLE));
    expect(used.filter((h) => !allowed.has(h))).toEqual([]);
  });
  it("the colour Google paints under the tiles is the map land", () => {
    expect(MAP_GROUND.toLowerCase()).toBe(v("--kc-map-land"));
  });
  it("land is the Night desk ground and water the LCD well", () => {
    expect(v("--kc-map-land")).toBe(v("--kc-ground"));
    expect(v("--kc-map-water")).toBe(v("--kc-well"));
  });
  it("labels stay deliberately quiet but findable (≥ 2.5:1 on land)", () => {
    expect(contrast(v("--kc-map-label"), v("--kc-map-land"))).toBeGreaterThanOrEqual(2.5);
    expect(contrast(v("--kc-map-poi"), v("--kc-map-land"))).toBeGreaterThan(contrast(v("--kc-map-label"), v("--kc-map-land")));
  });
});

describe("home pin on Night desk", () => {
  const svg = readFileSync("src/frontend/map/pins/pin-home.svg", "utf8").toLowerCase();
  it("body is sea-glass, glyph is glass-ink (visible on the cream head)", () => {
    expect(svg).toContain(`fill="${v("--kc-glass")}"`);
    expect(svg).toContain(`stroke="${v("--kc-glass-ink")}"`);
    expect(svg).not.toContain("#ff5a1f");
  });
  it("the glyph clears 3:1 on the cream head", () => {
    expect(contrast(v("--kc-glass-ink"), v("--kc-pin-cream"))).toBeGreaterThanOrEqual(3);
  });
});
