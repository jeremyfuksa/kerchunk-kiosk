// The zoom between map mode and HF (spec 2026-11-03-hf-atlas): a staged illusion, because the two pictures are
// far apart in scale. Only transforms and opacity, and the Google map's camera never moves.
export type ZoomDirection = "out" | "in";
type Mode = "scan" | "weather" | "monitor" | "cb" | "hf";

const STAGE_FROM = 8;
const MAP_TO = 0.3;

export function zoomFor(prev: Mode | null, next: Mode, breakIn: boolean, hasMap: boolean): ZoomDirection | null {
  if (!hasMap || breakIn || prev === null) return null;
  if (prev === "scan" && next === "hf") return "out";
  if (prev === "hf" && next === "scan") return "in";
  return null;
}

type ZoomFrame = { offset: number; transform: string; opacity: number };

export function zoomFrames(direction: ZoomDirection): { stage: ZoomFrame[]; map: ZoomFrame[] } {
  // The crossfade sits mid-move, where it hides the jump in scale.
  const stage: ZoomFrame[] = [
    { offset: 0, transform: `scale(${STAGE_FROM})`, opacity: 0 },
    { offset: 0.35, transform: `scale(${1 + (STAGE_FROM - 1) * 0.45})`, opacity: 0 },
    { offset: 0.65, transform: `scale(${1 + (STAGE_FROM - 1) * 0.15})`, opacity: 1 },
    { offset: 1, transform: "scale(1)", opacity: 1 },
  ];
  const map: ZoomFrame[] = [
    { offset: 0, transform: "scale(1)", opacity: 1 },
    { offset: 0.35, transform: `scale(${1 - (1 - MAP_TO) * 0.55})`, opacity: 1 },
    { offset: 0.65, transform: `scale(${1 - (1 - MAP_TO) * 0.85})`, opacity: 0 },
    { offset: 1, transform: `scale(${MAP_TO})`, opacity: 0 },
  ];
  const reverse = (f: ZoomFrame[]): ZoomFrame[] => [...f].reverse().map((k) => ({ ...k, offset: 1 - k.offset }));
  return direction === "out" ? { stage, map } : { stage: reverse(stage), map: reverse(map) };
}

export interface ZoomRun { finished: Promise<void>; stop(): void }

/** Runs it. Animations hold their last frame until stop(), so the caller can swap the stage first. */
export function runZoom(direction: ZoomDirection, stageEl: HTMLElement, mapEl: HTMLElement, originPx: { x: number; y: number }, ms: number): ZoomRun {
  const f = zoomFrames(direction);
  stageEl.style.transformOrigin = `${originPx.x}px ${originPx.y}px`;
  const timing = { duration: ms, easing: "ease-in-out", fill: "both" as const };
  const anims = [stageEl.animate(f.stage, timing), mapEl.animate(f.map, timing)];
  return {
    finished: Promise.allSettled(anims.map((a) => a.finished)).then(() => undefined),
    stop: () => { for (const a of anims) a.cancel(); },
  };
}
