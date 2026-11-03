import { describe, it, expect } from "vitest";
import { zoomFor, zoomFrames } from "../src/frontend/dashboard/zoom.js";

describe("zoomFor", () => {
  it("zoom_out_only_from_scan_to_hf", () => {
    expect(zoomFor("scan", "hf", false, true)).toBe("out");
  });
  it("zoom_in_only_from_hf_to_scan", () => {
    expect(zoomFor("hf", "scan", false, true)).toBe("in");
  });
  it("no_zoom_on_first_load", () => {
    expect(zoomFor(null, "hf", false, true)).toBeNull();
    expect(zoomFor(null, "scan", false, true)).toBeNull();
  });
  it("no_zoom_for_other_modes_or_break_ins", () => {
    for (const [a, b] of [["scan", "weather"], ["weather", "hf"], ["hf", "weather"], ["hf", "cb"], ["cb", "hf"], ["monitor", "hf"], ["scan", "cb"]] as const) {
      expect(zoomFor(a, b, false, true)).toBeNull();
    }
    expect(zoomFor("hf", "scan", true, true)).toBeNull();
    expect(zoomFor("scan", "hf", true, true)).toBeNull();
  });
  it("no_zoom_without_a_map", () => {
    expect(zoomFor("scan", "hf", false, false)).toBeNull();
    expect(zoomFor("hf", "scan", false, false)).toBeNull();
  });
});

describe("zoomFrames", () => {
  it("out: the Atlas settles from 8× and the local map shrinks away", () => {
    const f = zoomFrames("out");
    expect(f.stage[0]).toMatchObject({ transform: "scale(8)", opacity: 0 });
    expect(f.stage.at(-1)).toMatchObject({ transform: "scale(1)", opacity: 1 });
    expect(f.map[0]).toMatchObject({ transform: "scale(1)", opacity: 1 });
    expect(f.map.at(-1)).toMatchObject({ transform: "scale(0.55)", opacity: 0 });
  });
  it("the Atlas covers the map before the map's edges show", () => {
    const f = zoomFrames("out");
    const atEdge = f.stage.find((k) => k.offset === 0.5)!;
    expect(atEdge.opacity).toBe(1);
    const m = f.map.find((k) => k.offset === 0.5)!;
    expect(m.opacity).toBe(1);
    expect(Number(/scale\((.*)\)/.exec(m.transform)![1])).toBeGreaterThanOrEqual(0.7);
  });
  it("in: exactly the reverse", () => {
    const o = zoomFrames("out");
    const i = zoomFrames("in");
    expect(i.stage[0]).toMatchObject({ transform: "scale(1)", opacity: 1 });
    expect(i.stage.at(-1)).toMatchObject({ transform: "scale(8)", opacity: 0 });
    expect(i.map[0]).toMatchObject({ transform: "scale(0.55)", opacity: 0 });
    expect(i.map.at(-1)).toMatchObject({ transform: "scale(1)", opacity: 1 });
    expect(o.stage).toHaveLength(i.stage.length);
  });
  it("only animates what the compositor can do on its own", () => {
    const f = zoomFrames("out");
    for (const k of [...f.stage, ...f.map, ...f.haze]) {
      for (const key of Object.keys(k)) expect(["transform", "opacity", "offset", "filter"]).toContain(key);
    }
  });
  it("feels like motion: both pictures are blurred mid-move and sharp at rest", () => {
    const blur = (k: { filter?: string }) => Number(/blur\((.*)px\)/.exec(k.filter ?? "")?.[1] ?? 0);
    const f = zoomFrames("out");
    expect(blur(f.stage.at(-1)!)).toBe(0);
    expect(blur(f.map[0]!)).toBe(0);
    expect(blur(f.stage.find((k) => k.offset === 0.5)!)).toBeGreaterThan(0);
    expect(blur(f.map.find((k) => k.offset === 0.5)!)).toBeGreaterThan(0);
  });
  it("haze hides the swap: gone at both ends, thick at the crossover", () => {
    for (const d of ["out", "in"] as const) {
      const h = zoomFrames(d).haze;
      expect(h[0]!.opacity).toBe(0);
      expect(h.at(-1)!.opacity).toBe(0);
      expect(Math.max(...h.map((k) => k.opacity))).toBeGreaterThanOrEqual(0.8);
    }
  });
});
