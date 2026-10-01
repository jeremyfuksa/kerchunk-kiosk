// The corner's markup and its repaint decisions (spec 2026-10-01). The pill
// and the glass both stay mounted; CSS transitions on the corner's .is-glass
// class do the grow/release. A release must not rebuild the glass — it is
// still visible while it shrinks — and a re-hit on the same channel then
// simply reverses the transition.
import icoVolumeX from "lucide-static/icons/volume-x.svg?raw";
import { esc } from "../lib/format.js";
import { lcd, segmentsHtml } from "../faceplate/lcd.js";
import { METER_SEGMENTS, meterFill, type CornerView, type GlassView, type PillView } from "./cornerView.js";

export function pillHtml(p: PillView): string {
  const cls = p.tone === "hay" ? "kc-pill kc-pill--hay" : "kc-pill";
  const muted = p.muted ? `<span class="kc-pill__muted"> · ${icoVolumeX}Muted</span>` : "";
  const detail = p.detail ? `<span class="kc-pill__detail"> · ${esc(p.detail)}</span>` : "";
  const warm = p.warmLit !== null ? segmentsHtml({ count: METER_SEGMENTS, fill: p.warmLit / METER_SEGMENTS }) : "";
  return `<div class="${cls}" data-sweep="${p.sweep ? "on" : "off"}">`
    + `<div class="kc-pill__line"><span class="kc-pill__word">${esc(p.word)}</span>${muted}${detail}</div>`
    + `${warm}<span class="kc-pill__tick" aria-hidden="true"></span></div>`;
}

export function glassHtml(g: GlassView, db: number | null): string {
  return lcd(g.lcd, {
    dbfs: db,
    size: "wall",
    ...(g.head ? { head: g.head } : {}),
    ...(g.meter ? { segments: { count: METER_SEGMENTS, fill: meterFill(db) } } : {}),
    ...(g.hint ? { hint: g.hint } : {}),
  });
}

export interface CornerMemo { show: "pill" | "glass"; pillKey: string; glassKey: string }
export interface CornerPaint { show: "pill" | "glass"; rebuildPill: boolean; rebuildGlass: boolean; memo: CornerMemo }

export function cornerPaint(prev: CornerMemo | null, v: CornerView): CornerPaint {
  const pillKey = prev?.pillKey ?? "";
  const glassKey = prev?.glassKey ?? "";
  if (v.show === "pill") {
    return { show: "pill", rebuildPill: v.key !== pillKey, rebuildGlass: false, memo: { show: "pill", pillKey: v.key, glassKey } };
  }
  return { show: "glass", rebuildPill: false, rebuildGlass: v.key !== glassKey, memo: { show: "glass", pillKey, glassKey: v.key } };
}
