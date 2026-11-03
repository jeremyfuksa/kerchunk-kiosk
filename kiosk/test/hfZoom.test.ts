import { describe, it, expect } from "vitest";
import { atlasSnapshotSvg, hfLogWanted, zoomFor, zoomFrames } from "../src/frontend/dashboard/zoom.js";

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

describe("hfLogWanted", () => {
  it("fetches once on a page in map mode, so the first zoom's picture has the night's traces", () => {
    expect(hfLogWanted(false, false)).toBe(true);
    expect(hfLogWanted(false, true)).toBe(false);
  });
  it("always fetches on the HF stage", () => {
    expect(hfLogWanted(true, false)).toBe(true);
    expect(hfLogWanted(true, true)).toBe(true);
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

describe("atlasSnapshotSvg", () => {
  const world = '<svg><path class="A" d="M1 1L2 2Z"/>\n<path d="M3 3L4 4Z" id="B"/></svg>';
  const input = {
    sky: '<rect fill="url(#x)"/>', world, dots: [{ x: 5, y: 6, r: 3, opacity: 0.5 }],
    traces: [{ key: "k", color: "var(--kc-glass)", segments: ["M7 7L8 8"] }], traceOpacity: 0.34,
    home: { x: 9, y: 9 }, width: 1366, height: 768, viewBox: "0 0 10 10",
    colors: { land: "#111111", border: "#222222", dot: "#333333", glass: "#5fd4c3" },
  };
  it("is a self-contained image: sized, namespaced, and needing no page CSS", () => {
    const svg = atlasSnapshotSvg(input);
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    expect(svg).toContain('width="1366" height="768" viewBox="0 0 10 10"');
    expect(svg).not.toContain("var(");
    expect(svg).toContain('stroke="#5fd4c3"');
  });
  it("draws sky, then every land path, then dots, then traces, then home", () => {
    const svg = atlasSnapshotSvg(input);
    const order = ['url(#x)', 'M1 1L2 2Z M3 3L4 4Z', 'cx="5.0"', 'M7 7L8 8', 'cx="9.0"'].map((t) => svg.indexOf(t));
    expect(order.every((v) => v >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(svg).toContain('fill="#111111"');
    expect(svg).toContain('stroke="#222222"');
  });
});
