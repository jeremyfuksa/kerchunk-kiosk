// The LCD — the Faceplate's signature glass, shared by the admin (panel size)
// and the kiosk (wall size, spec 2026-10-01). An HTML-string builder like the
// rest of the app: callers render with innerHTML.
import { esc } from "../lib/format.js";
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

export interface LcdOpts { dbfs?: number | null }

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
  const silent = v.silent ? ` <span class="kc-lcd__silent">${v.silent}</span>` : "";
  return `<div class="kc-lcd" data-state="${v.state}">
    <div class="kc-lcd__meta"><span>${v.state === "detail" ? "" : meter(v.state === "live" ? o.dbfs : null)}${esc(v.meta)}${silent}</span>${db}</div>
    <div class="kc-lcd__name">${esc(v.name)}</div>
    ${v.freq ? `<div class="kc-lcd__freq">${esc(v.freq)}<small>MHz</small></div>` : ""}
  </div>`;
}
