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
  it("only animates what the compositor can move on its own", () => {
    for (const k of [...zoomFrames("out").stage, ...zoomFrames("out").map]) {
      for (const key of Object.keys(k)) expect(["transform", "opacity", "offset"]).toContain(key);
    }
  });
});
