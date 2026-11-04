// The Atlas's space weather line and its light (#342). Pure, like hfView. The light says how good a
// global index expects the bands to be. It's a forecast of sorts: the wall's dots show what's actually arriving.
import type { SpaceWeatherNow } from "../lib/api.js";

export type BandCondition = "good" | "fair" | "poor";

export interface SpaceWeatherOpts {
  spaceWeatherShow: boolean;
  spaceWeatherFairKp: number;     // Kp from here is yellow...
  spaceWeatherPoorKp: number;     // ...and from here red (NOAA G3)
  spaceWeatherFairFlux: number;   // solar flux below this is yellow: too little ionisation for the high bands
}

/** R is NOAA's radio blackout scale, HF's own: R1 and R2 are yellow, R3 and up are red. Null with nothing to go on. */
export function bandCondition(sw: SpaceWeatherNow, o: SpaceWeatherOpts): BandCondition | null {
  if (sw.solarFlux === null && sw.kp === null && sw.r === null) return null;
  if ((sw.r ?? 0) >= 3 || (sw.kp ?? 0) >= o.spaceWeatherPoorKp) return "poor";
  if ((sw.r ?? 0) >= 1 || (sw.kp ?? 0) >= o.spaceWeatherFairKp) return "fair";
  if (sw.solarFlux !== null && sw.solarFlux < o.spaceWeatherFairFlux) return "fair";
  return "good";
}

/** Empty hides the line: switched off, or NOAA has given us nothing. */
export function spaceWeatherHtml(sw: SpaceWeatherNow | null, o: SpaceWeatherOpts): string {
  if (!sw || !o.spaceWeatherShow) return "";
  const cond = bandCondition(sw, o);
  if (!cond) return "";
  const numbers = [
    sw.solarFlux !== null ? `Flux ${Math.round(sw.solarFlux)}` : "",
    sw.kp !== null ? `Kp ${Math.round(sw.kp)}` : "",
  ].filter(Boolean).join(" · ");
  const storms = [
    (sw.r ?? 0) >= 1 ? `R${sw.r} radio blackout` : "",
    (sw.g ?? 0) >= 1 ? `G${sw.g} storm` : "",
  ].filter(Boolean).join(" · ");
  return `<div class="kc-space__line"><i class="kc-space__light" data-cond="${cond}"></i>${numbers}</div>`
    + (storms ? `<div class="kc-space__storms">${storms}</div>` : "");
}
