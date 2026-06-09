import { describe, it, expect } from "vitest";
import { makeProjection } from "../src/frontend/art/project.js";

const HOME = { lat: 39.2915, lon: -94.4953 };

describe("makeProjection", () => {
  it("places home at the canvas center", () => {
    const p = makeProjection(HOME, 18_000, 1000, 800);
    const c = p(HOME.lat, HOME.lon);
    expect(c.x).toBeCloseTo(500, 0);
    expect(c.y).toBeCloseTo(400, 0);
  });
  it("maps a point due north to a smaller y (up on screen)", () => {
    const p = makeProjection(HOME, 18_000, 1000, 800);
    const north = p(HOME.lat + 0.05, HOME.lon);
    expect(north.y).toBeLessThan(400);
    expect(north.x).toBeCloseTo(500, 0);
  });
  it("maps a point due east to a larger x", () => {
    const p = makeProjection(HOME, 18_000, 1000, 800);
    const east = p(HOME.lat, HOME.lon + 0.05);
    expect(east.x).toBeGreaterThan(500);
  });
  it("scales so spanM maps to the smaller canvas half-dimension", () => {
    const p = makeProjection(HOME, 18_000, 1000, 800);
    const dLat = 18_000 / 111_320;
    const edge = p(HOME.lat + dLat, HOME.lon);
    expect(edge.y).toBeCloseTo(0, 0);
  });
});
