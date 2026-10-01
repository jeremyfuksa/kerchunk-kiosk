// The LCD — the Faceplate's signature glass, shared by the admin (panel size)
// and the kiosk (wall size, spec 2026-10-01). An HTML-string builder like the
// rest of the app: callers render with innerHTML.
import { esc } from "../lib/format.js";
import type { ServiceHead } from "./serviceHead.js";
import "./lcd.css";

/** What the glass shows. The admin's LcdView (admin/live.ts) satisfies this. */
export interface LcdInput {
  /** "live" carries the dB slot; "detail" (a Library channel) has no meter. */
  state: string;
  meta: string;
  name: string;
  freq: string;
  silent: string | null;
}

export interface LcdOpts {
  dbfs?: number | null;
  /** The kiosk's service disc, left of the name and frequency. */
  head?: ServiceHead;
  /** The kiosk's segmented meter under the frequency; fill is 0..1 (clamped).
   *  When present it replaces the four-bar meter on the meta line. Each caller
   *  owns its dB→fill mapping (the admin and kiosk scales differ). */
  segments?: { count: number; fill: number };
  /** "wall" is the kiosk's room-distance glass. */
  size?: "panel" | "wall";
  /** A muted line under the name — the kiosk's error glass says how it recovers. */
  hint?: string;
}

/** Lit segments for a 0..1 fill; NaN and out-of-range clamp. */
export function segmentsLit(fill: number, count: number): number {
  if (!Number.isFinite(fill)) return 0;
  return Math.round(Math.max(0, Math.min(1, fill)) * count);
}

function headSvg(h: ServiceHead): string {
  return `<svg class="kc-lcd__head${h.ringed ? " kc-lcd__head--ringed" : ""}" viewBox="0 0 42 42" aria-hidden="true">`
    + `<circle cx="21" cy="21" r="21" fill="${h.color}"/>`
    + `<g transform="translate(9 9)" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${h.glyph}</g></svg>`;
}

/** The segmented meter row (also the kiosk's warm-up pill). */
export function segmentsHtml(s: { count: number; fill: number }): string {
  const lit = segmentsLit(s.fill, s.count);
  return `<div class="kc-lcd__seg" aria-hidden="true">${Array.from({ length: s.count }, (_, i) => (i < lit ? '<i class="on"></i>' : "<i></i>")).join("")}</div>`;
}

/** The level meter's floor: dBFS at or below this lights no bars; 0 dBFS
 *  lights all four. */
export const METER_FLOOR_DB = -60;

/** How many of the 4 level-meter bars are lit for a dBFS (METER_FLOOR_DB → 0 dB). */
export function meterLit(dbfs: number | null | undefined): number {
  return dbfs == null ? 0 : Math.max(0, Math.min(4, Math.round(((dbfs - METER_FLOOR_DB) / -METER_FLOOR_DB) * 4)));
}

/** The LCD's dB readout text ("−41 dB"), or "" with no reading. */
export function dbText(dbfs: number | null | undefined): string {
  return dbfs == null ? "" : `${String(Math.round(dbfs)).replace("-", "−")} dB`;
}

/** Level meter bars from dBFS (METER_FLOOR_DB → 0 dB mapped over 4 bars). */
function meter(dbfs: number | null | undefined): string {
  const lit = meterLit(dbfs);
  return `<span class="kc-meter" aria-hidden="true">${[1, 2, 3, 4].map((i) => `<i${i <= lit ? ' class="on"' : ""}></i>`).join("")}</span>`;
}

/** The LCD's markup. Not itself a live region: the caller's persistent host
 *  element carries role="status" (a region recreated on every rebuild isn't
 *  reliably announced). */
export function lcd(v: LcdInput, o: LcdOpts = {}): string {
  // Live state always carries the dB slot (empty until the first reading) so a
  // caller can update it in place at signal rate; aria-hidden because it
  // changes ~4×/s inside the host's polite live region.
  const db = v.state === "live" ? `<span class="kc-lcd__db" aria-hidden="true">${dbText(o.dbfs)}</span>` : "";
  const silent = v.silent ? ` <span class="kc-lcd__silent">${esc(v.silent)}</span>` : "";
  const bars = v.state === "detail" || o.segments || o.size === "wall" ? "" : meter(v.state === "live" ? o.dbfs : null);
  const cls = o.size === "wall" ? "kc-lcd kc-lcd--wall" : "kc-lcd";
  const text = `<div class="kc-lcd__name">${esc(v.name)}</div>
    ${v.freq ? `<div class="kc-lcd__freq">${esc(v.freq)}<small>MHz</small></div>` : ""}`;
  const body = o.head
    ? `<div class="kc-lcd__row">${headSvg(o.head)}<div class="kc-lcd__text">${text}</div></div>`
    : text;
  return `<div class="${cls}" data-state="${esc(v.state)}">
    <div class="kc-lcd__meta"><span>${bars}${esc(v.meta)}${silent}</span>${db}</div>
    ${body}
    ${o.hint ? `<div class="kc-lcd__hint">${esc(o.hint)}</div>` : ""}
  ${o.segments ? segmentsHtml(o.segments) : ""}</div>`;
}
