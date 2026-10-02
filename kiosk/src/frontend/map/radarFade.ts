// Radar visibility + crossfade state for the Weather Glass layer, kept pure
// so the "never fake it, never freeze it" rules are unit-tested (glassLayer.ts
// only uploads textures and reads alpha()/mix()). The layer owns `wanted`:
// staleness is what RadarSync last said, NOT a flag frozen into an old frame,
// so a GL context loss can't resurrect a stale scan.
import { fadeProgress } from "./glassMath.js";

export class RadarFade {
  private wanted = true;
  private hasRadar = false;
  private alphaFrom = 0;
  private alphaTo = 0;
  private alphaStart = -Infinity;
  private mixStart = -Infinity;

  constructor(private readonly fadeMs: number) {}

  alpha(now: number): number {
    const k = fadeProgress(this.alphaStart, now, this.fadeMs);
    return this.alphaFrom + (this.alphaTo - this.alphaFrom) * k;
  }

  mix(now: number): number {
    return fadeProgress(this.mixStart, now, this.fadeMs);
  }

  fading(now: number): boolean {
    return (this.hasRadar && this.mix(now) < 1) || fadeProgress(this.alphaStart, now, this.fadeMs) < 1;
  }

  setStale(stale: boolean, now: number): void {
    this.wanted = !stale;
    if (this.hasRadar) this.retarget(this.wanted ? 1 : 0, now);
  }

  /** A new frame is about to be uploaded. "crossfade" = the old scan becomes
   *  prev; "replace" = fill both slots (first scan, new grid, or radar not on
   *  screen — e.g. returning from stale, where crossfading from hours-old
   *  echoes would show old weather as current). */
  frame(sameGrid: boolean, now: number): "crossfade" | "replace" {
    const visible = this.alpha(now) > 0.001;
    if (this.hasRadar && sameGrid && visible) {
      this.mixStart = now;
      return "crossfade";
    }
    this.mixStart = now - this.fadeMs; // mix complete: both slots hold this scan
    if (!this.hasRadar || !visible) this.retarget(this.wanted ? 1 : 0, now);
    this.hasRadar = true;
    return "replace";
  }

  contextLost(): void {
    this.hasRadar = false;
  }

  private retarget(to: number, now: number): void {
    this.alphaFrom = this.alpha(now);
    this.alphaTo = to;
    this.alphaStart = now;
  }
}
