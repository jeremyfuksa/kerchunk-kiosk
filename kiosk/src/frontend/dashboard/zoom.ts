// The zoom between map mode and HF (spec 2026-11-03-hf-atlas): a staged illusion, because the two pictures are
// far apart in scale. Only transforms, opacity and filter, for under two seconds, and the Google map's camera never moves.
import { tracesSvg, type AtlasDot, type AtlasTrace } from "./atlas.js";
import { LIMB_MASK, limbMaskSvg } from "./greyline.js";

export type ZoomDirection = "out" | "in";

/** The log only grows in HF, so one fetch at page load keeps it right for every zoom out of map mode. */
export function hfLogWanted(hfOn: boolean, loaded: boolean): boolean {
  return hfOn || !loaded;
}
type Mode = "scan" | "weather" | "monitor" | "cb" | "hf";

const STAGE_FROM = 8;
const MAP_TO = 0.55;

export function zoomFor(prev: Mode | null, next: Mode, breakIn: boolean, hasMap: boolean): ZoomDirection | null {
  if (!hasMap || breakIn || prev === null) return null;
  if (prev === "scan" && next === "hf") return "out";
  if (prev === "hf" && next === "scan") return "in";
  return null;
}

type ZoomFrame = { offset: number; transform: string; opacity: number; filter?: string };

export function zoomFrames(direction: ZoomDirection): { stage: ZoomFrame[]; map: ZoomFrame[]; haze: ZoomFrame[] } {
  // Passing through the atmosphere. The Atlas is on top and fades in over a still-large map, both are blurred
  // mid-move, and the haze peaks over the swap, so the map's edges never show.
  const stage: ZoomFrame[] = [
    { offset: 0, transform: `scale(${STAGE_FROM})`, opacity: 0, filter: "blur(14px)" },
    { offset: 0.1, transform: `scale(${1 + (STAGE_FROM - 1) * 0.8})`, opacity: 0, filter: "blur(14px)" },
    { offset: 0.5, transform: `scale(${1 + (STAGE_FROM - 1) * 0.25})`, opacity: 1, filter: "blur(10px)" },
    { offset: 0.8, transform: `scale(${1 + (STAGE_FROM - 1) * 0.05})`, opacity: 1, filter: "blur(2px)" },
    { offset: 1, transform: "scale(1)", opacity: 1, filter: "blur(0px)" },
  ];
  const map: ZoomFrame[] = [
    { offset: 0, transform: "scale(1)", opacity: 1, filter: "blur(0px)" },
    { offset: 0.25, transform: "scale(0.88)", opacity: 1, filter: "blur(6px)" },
    { offset: 0.5, transform: "scale(0.7)", opacity: 1, filter: "blur(14px)" },
    { offset: 0.6, transform: "scale(0.65)", opacity: 0, filter: "blur(14px)" },
    { offset: 1, transform: `scale(${MAP_TO})`, opacity: 0, filter: "blur(14px)" },
  ];
  const haze: ZoomFrame[] = [
    { offset: 0, transform: "scale(1.5)", opacity: 0 },
    { offset: 0.2, transform: "scale(1.35)", opacity: 0.45 },
    { offset: 0.42, transform: "scale(1.15)", opacity: 0.9 },
    { offset: 0.6, transform: "scale(1.05)", opacity: 0.7 },
    { offset: 1, transform: "scale(1)", opacity: 0 },
  ];
  const reverse = (f: ZoomFrame[]): ZoomFrame[] => [...f].reverse().map((k) => ({ ...k, offset: 1 - k.offset }));
  return direction === "out" ? { stage, map, haze } : { stage: reverse(stage), map: reverse(map), haze: reverse(haze) };
}

export interface ZoomRun { finished: Promise<void>; stop(): void }

/** Runs it. Animations hold their last frame until stop(), so the caller can swap the stage first. */
export function runZoom(direction: ZoomDirection, stageEl: HTMLElement, mapEl: HTMLElement, hazeEl: HTMLElement, originPx: { x: number; y: number }, ms: number): ZoomRun {
  const f = zoomFrames(direction);
  stageEl.style.transformOrigin = `${originPx.x}px ${originPx.y}px`;
  hazeEl.style.transformOrigin = `${originPx.x}px ${originPx.y}px`;
  hazeEl.style.setProperty("--kc-hf-zoom-at", `${originPx.x}px ${originPx.y}px`);
  const timing = { duration: ms, easing: "ease-in-out", fill: "both" as const };
  const anims = [stageEl.animate(f.stage, timing), mapEl.animate(f.map, timing), hazeEl.animate(f.haze, timing)];
  return {
    finished: Promise.allSettled(anims.map((a) => a.finished)).then(() => undefined),
    stop: () => { for (const a of anims) a.cancel(); },
  };
}

export interface SnapshotInput {
  sky: string;
  world: string;
  dots: readonly AtlasDot[];
  traces: readonly AtlasTrace[];
  traceOpacity: number;
  home: { x: number; y: number };
  width: number;
  height: number;
  viewBox: string;
  colors: { land: string; border: string; dot: string; glass: string };
}

/** The Atlas as one self-contained image. An image can't see the page's CSS, so everything is spelled out. */
export function atlasSnapshotSvg(i: SnapshotInput): string {
  const land = [...i.world.matchAll(/<path\b[^>]*?\bd="([^"]+)"/g)].map((m) => m[1]).join(" ");
  const dots = i.dots.map((d) => `<circle cx="${d.x.toFixed(1)}" cy="${d.y.toFixed(1)}" r="${d.r.toFixed(1)}" opacity="${d.opacity.toFixed(2)}"/>`).join("");
  const traces = tracesSvg(i.traces, i.traceOpacity).replaceAll("var(--kc-glass)", i.colors.glass);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${i.width}" height="${i.height}" viewBox="${i.viewBox}">${i.sky}`
    + `<path d="${land}" fill="${i.colors.land}" fill-opacity="0.72" stroke="${i.colors.border}" stroke-opacity="0.2" stroke-width="0.7"/>`
    + `<g fill="${i.colors.dot}">${dots}</g>${limbMaskSvg()}<g ${LIMB_MASK}>${traces}</g>`
    + `<circle cx="${i.home.x.toFixed(1)}" cy="${i.home.y.toFixed(1)}" r="6" fill="${i.colors.dot}"/></svg>`;
}

/** Paints that image into a canvas. Scaling a canvas moves one finished texture, so nothing re-rasters mid-zoom. */
export async function paintSnapshot(canvas: HTMLCanvasElement, svg: string, width: number, height: number): Promise<void> {
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    canvas.width = width;
    canvas.height = height;
    canvas.getContext("2d")!.drawImage(img, 0, 0, width, height);
  } finally {
    URL.revokeObjectURL(url);
  }
}
