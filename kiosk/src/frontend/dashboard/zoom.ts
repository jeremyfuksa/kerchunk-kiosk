// The zoom between map mode and HF (spec 2026-11-03-hf-atlas): a staged illusion, because the two pictures are
// far apart in scale. Only transforms, opacity and filter, for under two seconds, and the Google map's camera never moves.
export type ZoomDirection = "out" | "in";
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
