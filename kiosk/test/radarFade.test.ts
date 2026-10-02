import { describe, it, expect } from "vitest";
import { RadarFade } from "../src/frontend/map/radarFade.js";

const FADE = 20_000;

describe("RadarFade", () => {
  it("first scan replaces and fades in from empty", () => {
    const f = new RadarFade(FADE);
    expect(f.alpha(0)).toBe(0);
    expect(f.frame(false, 0)).toBe("replace");
    expect(f.mix(0)).toBe(1);
    expect(f.alpha(FADE / 2)).toBeCloseTo(0.5, 6);
    expect(f.alpha(FADE)).toBe(1);
  });

  it("a later scan on the same grid crossfades", () => {
    const f = new RadarFade(FADE);
    f.frame(false, 0);
    expect(f.frame(true, 30_000)).toBe("crossfade");
    expect(f.mix(30_000 + FADE / 4)).toBeCloseTo(0.25, 6);
    expect(f.alpha(30_000)).toBe(1);
  });

  it("stale fades out; a context loss while stale must NOT bring the old scan back", () => {
    const f = new RadarFade(FADE);
    f.frame(false, 0);
    f.setStale(true, 30_000);
    expect(f.alpha(30_000 + FADE)).toBe(0);
    f.contextLost();
    // Context restored: the last frame is re-uploaded as a first scan.
    expect(f.frame(false, 60_000)).toBe("replace");
    expect(f.alpha(60_000 + FADE)).toBe(0);
  });

  it("returning from stale replaces (no crossfade from hours-old echoes), then fades in", () => {
    const f = new RadarFade(FADE);
    f.frame(false, 0);
    f.setStale(true, 30_000);
    // RadarSync delivers the fresh frame first, then onStale(false).
    expect(f.frame(true, 30_000 + FADE + 1)).toBe("replace");
    f.setStale(false, 30_000 + FADE + 1);
    expect(f.mix(30_000 + FADE + 1)).toBe(1);
    expect(f.alpha(30_000 + 2 * FADE + 1)).toBe(1);
  });

  it("stale before any scan: the first scan stays invisible", () => {
    const f = new RadarFade(FADE);
    f.setStale(true, 0);
    f.frame(false, 10);
    expect(f.alpha(10 + FADE)).toBe(0);
  });

  it("fading() reports any running fade (drives the redraw pacing)", () => {
    const f = new RadarFade(FADE);
    expect(f.fading(0)).toBe(false);
    f.frame(false, 0);
    expect(f.fading(FADE / 2)).toBe(true);
    expect(f.fading(FADE)).toBe(false);
  });
});
