// The live layer of the Atlas: the station's ring, its line home and its country (spec
// 2026-11-03-hf-atlas). Only this layer moves, so a hit never repaints the map under it.
import { bandColor, tracePath, type HitKey } from "./atlas.js";
import type { LatLon } from "./robinson.js";
import { robinson } from "./robinson.js";

const NS = "http://www.w3.org/2000/svg";
const RING_R = 52;

export class HitAnimator {
  constructor(private readonly svg: SVGSVGElement) {}

  private add(name: string, attrs: Record<string, string | number>): SVGElement {
    const el = document.createElementNS(NS, name);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
    this.svg.appendChild(el);
    return el;
  }

  clear(): void { this.svg.replaceChildren(); }

  /** The station as it sits while playing, with no motion. */
  hold(s: HitKey, home: LatLon, tint: readonly string[]): void {
    this.clear();
    const color = bandColor(s.band);
    for (const d of tint) this.add("path", { d, fill: color, "fill-opacity": 0.6 });
    for (const d of tracePath({ lat: s.lat, lon: s.lon }, home)) {
      this.add("path", { d, fill: "none", stroke: color, "stroke-opacity": 0.2, "stroke-width": 8, "stroke-linecap": "round" });
      this.add("path", { d, fill: "none", stroke: color, "stroke-width": 2.6, "stroke-linecap": "round" });
    }
    const { x, y } = robinson(s.lat, s.lon);
    this.add("circle", { cx: x, cy: y, r: RING_R, fill: "none", stroke: color, "stroke-opacity": 0.22, "stroke-width": 12 });
    this.add("circle", { cx: x, cy: y, r: RING_R, fill: "none", stroke: color, "stroke-width": 3 });
    this.add("circle", { cx: x, cy: y, r: 8, fill: color });
  }
}
