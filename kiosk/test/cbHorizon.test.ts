import { describe, it, expect } from "vitest";
import { cbSkyState, cbSkySvg, mastTop, mastsSvg, type CbMast } from "../src/frontend/dashboard/cbHorizon.js";

const mast = (o: Partial<CbMast>): CbMast => ({ n: 7, x: 0.5, core: false, monitored: true, step: 0, label: false, ...o });

describe("cbSkyState", () => {
  it("follows the sun's real height", () => {
    expect(cbSkyState(40)).toBe("day");
    expect(cbSkyState(6.1)).toBe("day");
    expect(cbSkyState(3)).toBe("low");
    expect(cbSkyState(-0.8)).toBe("low");
    expect(cbSkyState(-5)).toBe("twilight");
    expect(cbSkyState(-12)).toBe("twilight");
    expect(cbSkyState(-30)).toBe("night");
  });
});

describe("cbSkySvg", () => {
  it("is the same string every call, so it can't repaint for nothing", () => {
    expect(cbSkySvg("night")).toBe(cbSkySvg("night"));
  });
  it("shows stars at night and none by day", () => {
    expect(cbSkySvg("night")).toMatch(/<g opacity="1"[^>]*><circle/);
    expect(cbSkySvg("day")).not.toContain("<circle");
  });
  it("each state has its own colours", () => {
    const states = ["day", "low", "twilight", "night"] as const;
    expect(new Set(states.map(cbSkySvg)).size).toBe(4);
  });
});

describe("mastsSvg", () => {
  it("a mast is at its true spacing across the wall", () => {
    const a = mastTop(mast({ x: 0 }));
    const b = mastTop(mast({ x: 1 }));
    expect(a.x).toBe(50);
    expect(b.x).toBe(1316);
  });
  it("recent channels stand taller than plain ones, and the core channels taller still at rest", () => {
    const plain = mastTop(mast({})).y;
    const core = mastTop(mast({ core: true })).y;
    const hot = mastTop(mast({ step: 4 })).y;
    expect(core).toBeLessThan(plain);
    expect(hot).toBeLessThan(plain);
  });
  it("carries the fade step for the stylesheet", () => {
    expect(mastsSvg([mast({ step: 3 })], null)).toContain('data-step="3"');
  });
  it("marks the live mast", () => {
    expect(mastsSvg([mast({ n: 19 }), mast({ n: 20 })], 19).match(/is-live/g)).toHaveLength(1);
    expect(mastsSvg([mast({ n: 19 })], null)).not.toContain("is-live");
  });
  it("labels only what asks for it", () => {
    const svg = mastsSvg([mast({ n: 19, label: true, core: true }), mast({ n: 18 })], null);
    expect(svg.match(/<text/g)).toHaveLength(1);
    expect(svg).toContain(">19</text>");
  });
  it("a channel off the list stays visibly off", () => {
    expect(mastsSvg([mast({ monitored: false })], null)).toContain("is-off");
  });
});
