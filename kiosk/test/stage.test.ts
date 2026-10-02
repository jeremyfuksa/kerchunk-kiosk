import { describe, it, expect } from "vitest";
import { padRect, outside, edgeExit, lngLatToViewPx } from "../src/frontend/map/stage.js";

const VIEW = { left: 0, top: 0, right: 1920, bottom: 1080 };

describe("stage geometry", () => {
  it("padRect insets the viewport by an asymmetric pad", () => {
    expect(padRect(1920, 1080, { top: 250, right: 80, bottom: 120, left: 80 }))
      .toEqual({ left: 80, top: 250, right: 1840, bottom: 960 });
  });

  it("outside: a point under the padding counts as outside the padded rect", () => {
    const inner = padRect(1920, 1080, { top: 250, right: 80, bottom: 120, left: 80 });
    expect(outside({ x: 960, y: 600 }, inner)).toBe(false);
    expect(outside({ x: 1800, y: 100 }, inner)).toBe(true);   // on screen, under the clock
    expect(outside({ x: 40, y: 1000 }, inner)).toBe(true);    // on screen, under the corner LCD
    expect(outside({ x: -50, y: 500 }, inner)).toBe(true);
  });

  it("edgeExit lands on the edge the ray leaves through", () => {
    const c = { x: 960, y: 540 };
    expect(edgeExit(c, { x: 960, y: -5000 }, VIEW)).toEqual({ x: 960, y: 0 });      // north
    expect(edgeExit(c, { x: 960, y: 9000 }, VIEW)).toEqual({ x: 960, y: 1080 });    // south
    expect(edgeExit(c, { x: -3000, y: 540 }, VIEW)).toEqual({ x: 0, y: 540 });      // west
    expect(edgeExit(c, { x: 5000, y: 540 }, VIEW)).toEqual({ x: 1920, y: 540 });    // east
  });

  it("edgeExit extends a ray through an on-screen target out to the edge", () => {
    // A pin hidden under the clock (on screen) still anchors on the border.
    // dx=840, dy=-505: the right edge (t=960/840) comes before the top (t=605/505).
    const p = edgeExit({ x: 960, y: 605 }, { x: 1800, y: 100 }, VIEW);
    expect(p.x).toBeCloseTo(1920, 6);
    expect(p.y).toBeCloseTo(605 - 505 * (960 / 840), 6);
  });

  it("edgeExit hits a corner exactly on the diagonal", () => {
    const p = edgeExit({ x: 960, y: 540 }, { x: 960 + 1920, y: 540 - 1080 }, VIEW);
    expect(p.x).toBeCloseTo(1920, 6);
    expect(p.y).toBeCloseTo(0, 6);
  });

  it("edgeExit with target == center returns the center (no direction)", () => {
    expect(edgeExit({ x: 10, y: 10 }, { x: 10, y: 10 }, VIEW)).toEqual({ x: 10, y: 10 });
  });

  it("lngLatToViewPx maps the bounds' corners to the viewport corners (Mercator y)", () => {
    const box = { n: 40, s: 38, e: -93, w: -96 };
    expect(lngLatToViewPx(40, -96, box, 1920, 1080)).toEqual({ x: 0, y: 0 });
    const se = lngLatToViewPx(38, -93, box, 1920, 1080);
    expect(se.x).toBeCloseTo(1920, 6);
    expect(se.y).toBeCloseTo(1080, 6);
    // Mercator: the latitude midpoint sits slightly SOUTH of the pixel midpoint
    // (north latitudes are stretched).
    expect(lngLatToViewPx(39, -94.5, box, 1920, 1080).y).toBeGreaterThan(540);
    // A site north of the view projects above the top edge.
    expect(lngLatToViewPx(40.5, -94.5, box, 1920, 1080).y).toBeLessThan(0);
  });
});
