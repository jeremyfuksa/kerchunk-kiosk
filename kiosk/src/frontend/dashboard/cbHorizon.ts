// The CB wall's picture (spec 2026-11-03-cb-horizon): the sky and the masts. Pure strings in wall pixels.
import { starsSvg } from "./greyline.js";
import type { CbTick } from "./cbView.js";

export type CbMast = CbTick;
export type CbSkyState = "day" | "low" | "twilight" | "night";

export const CB_VIEWBOX = "0 0 1366 768";
const GROUND_Y = 628;
const MAST_LEFT = 50;
const MAST_RIGHT = 1316;
const STAR_SCALE = 0.683;   // the stars are laid out for the Atlas's 2000-wide map

/** Top to horizon. The Atlas's day teal and twilight bands, plus how much of the stars show. */
const SKIES: Record<CbSkyState, { stops: readonly string[]; stars: number }> = {
  day: { stops: ["#0f3a4c", "#14505c", "#175a66", "#1f6f76"], stars: 0 },
  low: { stops: ["#14505c", "#3a2c78", "#5b3f7f", "#c9785a"], stars: 0 },
  twilight: { stops: ["#14163c", "#2a2466", "#4c3580", "#8a4f86"], stars: 0.6 },
  night: { stops: ["#0a0b20", "#14163c", "#1c1c50", "#2a2466"], stars: 1 },
};

export function cbSkyState(sunAltDeg: number): CbSkyState {
  if (sunAltDeg > 6) return "day";
  if (sunAltDeg >= -0.8) return "low";
  if (sunAltDeg >= -12) return "twilight";
  return "night";
}

export function cbSkySvg(state: CbSkyState): string {
  const { stops, stars } = SKIES[state];
  const grad = stops.map((c, i) => `<stop offset="${(i / (stops.length - 1)).toFixed(2)}" stop-color="${c}"/>`).join("");
  return `<defs><linearGradient id="cbSkyGrad" x1="0" y1="0" x2="0" y2="1">${grad}</linearGradient></defs>`
    + `<rect width="1366" height="${GROUND_Y + 2}" fill="url(#cbSkyGrad)"/>`
    + (stars > 0 ? `<g opacity="${stars}" transform="scale(${STAR_SCALE})">${starsSvg()}</g>` : "")
    + `<rect class="kc-cb__ground" y="${GROUND_Y}" width="1366" height="${768 - GROUND_Y}"/>`;
}

export function mastTop(m: CbMast): { x: number; y: number } {
  return { x: MAST_LEFT + m.x * (MAST_RIGHT - MAST_LEFT), y: GROUND_Y - (m.core ? 78 : 58) - m.step * 12 };
}

export function mastsSvg(masts: readonly CbMast[], live: number | null): string {
  return masts.map((m) => {
    const { x, y } = mastTop(m);
    const cls = `kc-cb__mast${m.core ? " is-core" : ""}${m.monitored ? "" : " is-off"}${m.n === live ? " is-live" : ""}`;
    const label = m.label
      ? `<text class="kc-cb__lab${m.core ? " is-core" : ""}" x="${x.toFixed(1)}" y="${GROUND_Y + 24}" text-anchor="middle">${m.n}</text>`
      : "";
    return `<g class="${cls}" data-step="${m.step}"><path d="M${(x - 7).toFixed(1)} ${GROUND_Y}L${x.toFixed(1)} ${y}L${(x + 7).toFixed(1)} ${GROUND_Y}"/>`
      + `<circle cx="${x.toFixed(1)}" cy="${y}" r="${(1.6 + m.step * 0.7).toFixed(1)}"/></g>${label}`;
  }).join("");
}
