// The live layer of the Atlas: the station's ring, its line home and its country (spec
// 2026-11-03-hf-atlas). Only this layer moves, so a hit never repaints the map under it.
import { bandColor, lineKeyframes, pulseFrames, tracePath, tracePoints, type HitKey } from "./atlas.js";
import { stagePx } from "./greyline.js";
import { robinson, type LatLon } from "./robinson.js";

const NS = "http://www.w3.org/2000/svg";
const RING_R = 52;
const TRAIL_GAP = 9;
const FLASH_MS = 300;
const LINE_STEPS = 40;
const EASE_OUT = "cubic-bezier(.33,1,.68,1)";

export const HF_WALL_DEFAULTS = {
  greylineStepMs: 300_000, traceOpacity: 0.34, hitGrowMs: 900, hitLineDelayMs: 550, hitLineMs: 2_000, hitPingMs: 800, hitFadeMs: 700, zoomMs: 1_500, pulseEveryMs: 4_500, pulseMs: 2_000,
};
export type HfWallOpts = typeof HF_WALL_DEFAULTS;

export class HitAnimator {
  private readonly tintGroup: SVGGElement;
  private readonly hitGroup: SVGGElement;
  private anims: Animation[] = [];
  private fading: (() => void) | null = null;
  private lines: SVGElement[] = [];
  private glows: SVGElement[] = [];
  private rings: { rim: SVGElement; halo: SVGElement; core: SVGElement } | null = null;
  private pulseTimer: ReturnType<typeof setInterval> | null = null;
  private pulseAnim: Animation | null = null;

  constructor(svg: SVGSVGElement, private readonly pulse: HTMLElement, private readonly opts: () => HfWallOpts) {
    this.tintGroup = document.createElementNS(NS, "g");
    this.hitGroup = document.createElementNS(NS, "g");
    svg.append(this.tintGroup, this.hitGroup);
  }

  private add(parent: SVGElement, name: string, attrs: Record<string, string | number>): SVGElement {
    const el = document.createElementNS(NS, name);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
    parent.appendChild(el);
    return el;
  }

  /** The transmitting country, which a station can have without coordinates. */
  tint(paths: readonly string[], color: string): void {
    this.tintGroup.replaceChildren();
    for (const d of paths) this.add(this.tintGroup, "path", { d, fill: color, "fill-opacity": 0.6 });
  }

  private stopAnims(): void {
    for (const a of this.anims) a.cancel();
    this.anims = [];
    this.stopPulses();
  }

  private stopPulses(): void {
    if (this.pulseTimer) clearInterval(this.pulseTimer);
    this.pulseTimer = null;
    this.pulseAnim?.cancel();
    this.pulseAnim = null;
  }

  /** A dot on its own small layer, so a pulse moves on the compositor and repaints nothing. */
  private startPulses(s: HitKey, home: LatLon): void {
    this.stopPulses();
    const o = this.opts();
    if (o.pulseEveryMs <= 0 || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    this.pulse.style.color = bandColor(s.band);
    const frames = pulseFrames(tracePoints({ lat: s.lat, lon: s.lon }, home), (p) => stagePx(p, this.pulse.parentElement!.clientWidth));
    const send = (): void => {
      this.pulseAnim?.cancel();
      this.pulseAnim = this.pulse.animate(frames, { duration: o.pulseMs, easing: "linear" });
    };
    send();
    this.pulseTimer = setInterval(send, Math.max(o.pulseEveryMs, o.pulseMs));
  }

  /** Ends a fade right now, handing its line to the traces. */
  private finishFade(): void {
    const done = this.fading;
    this.fading = null;
    if (done) { this.stopAnims(); this.hitGroup.replaceChildren(); done(); }
  }

  /** Everything off: for leaving the stage. */
  clear(): void {
    this.fading = null;
    this.stopAnims();
    this.tintGroup.replaceChildren();
    this.hitGroup.replaceChildren();
    this.rings = null;
  }

  /** Draws the held state. Animations run on top of it, and cancelling them leaves exactly this. */
  private build(s: HitKey, home: LatLon): void {
    this.stopAnims();
    this.hitGroup.replaceChildren();
    const color = bandColor(s.band);
    this.lines = [];
    this.glows = [];
    for (const d of tracePath({ lat: s.lat, lon: s.lon }, home)) {
      this.glows.push(this.add(this.hitGroup, "path", { d, fill: "none", stroke: color, "stroke-opacity": 0.2, "stroke-width": 8, "stroke-linecap": "round", pathLength: 1 }));
      this.lines.push(this.add(this.hitGroup, "path", { d, fill: "none", stroke: color, "stroke-width": 2.6, "stroke-linecap": "round", pathLength: 1 }));
    }
    const { x, y } = robinson(s.lat, s.lon);
    const ring = (o: Record<string, string | number>) => this.add(this.hitGroup, "circle", { cx: x, cy: y, r: RING_R, fill: "none", stroke: color, ...o });
    this.rings = {
      halo: ring({ "stroke-opacity": 0.22, "stroke-width": 12 }),
      rim: ring({ "stroke-width": 3 }),
      core: this.add(this.hitGroup, "circle", { cx: x, cy: y, r: 8, fill: color }),
    };
  }

  /** The station as it sits while playing, with no motion. */
  hold(s: HitKey, home: LatLon): void {
    this.fading = null;
    this.build(s, home);
    this.startPulses(s, home);
  }

  start(s: HitKey, home: LatLon): void {
    this.finishFade();
    this.build(s, home);
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const o = this.opts();
    const color = bandColor(s.band);
    const { x, y } = robinson(s.lat, s.lon);
    const grow = { duration: o.hitGrowMs, easing: EASE_OUT, fill: "both" as const };
    const from = RING_R * 0.08;
    const run = (el: Element, frames: Keyframe[], timing: KeyframeAnimationOptions): void => { this.anims.push(el.animate(frames, timing)); };
    const extras: SVGElement[] = [];   // only exist during the hit

    run(this.rings!.rim, [{ r: `${from}px` }, { r: `${RING_R}px` }], grow);
    run(this.rings!.halo, [{ r: `${from}px` }, { r: `${RING_R}px` }], grow);
    for (const [gap, opacity] of [[TRAIL_GAP, 0.45], [TRAIL_GAP * 2, 0.25]] as const) {
      const trail = this.add(this.hitGroup, "circle", { cx: x, cy: y, r: 0, fill: "none", stroke: color, "stroke-width": 2, "stroke-opacity": 0 });
      extras.push(trail);
      run(trail, [
        { r: "0px", strokeOpacity: opacity },
        { r: `${RING_R - gap}px`, strokeOpacity: 0 },
      ], grow);
    }
    const flash = this.add(this.hitGroup, "circle", { cx: x, cy: y, r: 8, fill: "#eafff9", opacity: 0 });
    extras.push(flash);
    run(flash, [{ r: "8px", opacity: 1 }, { r: "32px", opacity: 0 }], { duration: FLASH_MS, easing: "ease-out", fill: "both" });

    // Sampled keyframes, because one eased line can cross the antimeridian and be two paths.
    const lengths = this.lines.map((l) => (l as SVGGeometryElement).getTotalLength());
    const steps = lineKeyframes(lengths, LINE_STEPS);
    this.lines.forEach((line, i) => {
      const frames = steps[i]!.map((v) => ({ strokeDasharray: "1 1", strokeDashoffset: v }));
      const timing = { duration: o.hitLineMs, delay: o.hitLineDelayMs, fill: "both" as const };
      run(line, frames, timing);
      run(this.glows[i]!, frames, timing);
    });

    const homeXy = robinson(home.lat, home.lon);
    const ping = this.add(this.hitGroup, "circle", { cx: homeXy.x, cy: homeXy.y, r: 6, fill: "none", stroke: color, "stroke-width": 2.4, "stroke-opacity": 0 });
    extras.push(ping);
    run(ping, [{ r: "6px", strokeOpacity: 1 }, { r: "32px", strokeOpacity: 0 }], {
      duration: o.hitPingMs, delay: o.hitLineDelayMs + o.hitLineMs - 80, easing: EASE_OUT, fill: "both",
    });

    // Once it has landed, nothing here should still be running. Cancelling leaves the held state.
    const running = this.anims;
    void Promise.allSettled(running.map((a) => a.finished)).then(() => {
      if (this.anims !== running) return;
      this.stopAnims();
      for (const e of extras) e.remove();
      this.startPulses(s, home);
    });
  }

  /** The scan moved on: the ring fades out and the line settles to a trace. Calls onDone when it's a trace. */
  end(onDone: () => void): void {
    this.finishFade();
    if (!this.rings) { onDone(); return; }
    this.stopAnims();
    const o = this.opts();
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) { this.hitGroup.replaceChildren(); onDone(); return; }
    const timing = { duration: o.hitFadeMs, easing: "ease-out", fill: "both" as const };
    const anims: Animation[] = [];
    for (const el of [this.rings.rim, this.rings.halo, this.rings.core, ...this.glows]) anims.push(el.animate([{ opacity: 1 }, { opacity: 0 }], timing));
    for (const el of this.lines) anims.push(el.animate([{ opacity: 1 }, { opacity: o.traceOpacity }], timing));
    this.anims = anims;
    this.fading = onDone;
    void Promise.allSettled(anims.map((a) => a.finished)).then(() => { if (this.anims === anims) this.finishFade(); });
  }
}
