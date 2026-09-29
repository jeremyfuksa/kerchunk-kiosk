// HTML-string builders for admin-next. Strings, not nodes: callers render with
// innerHTML and wire events by id/data-attributes, like the rest of the app.
import { esc } from "../../lib/format.js";
import { ico, type IconName } from "./icons.js";
import type { LcdView } from "../live.js";

export function key(o: {
  id?: string; label: string; icon?: IconName;
  variant?: "primary" | "danger" | "plain"; wide?: boolean; disabled?: boolean; title?: string;
}): string {
  const cls = ["kc-key", o.variant && o.variant !== "plain" ? `kc-key--${o.variant}` : "", o.wide ? "kc-key--wide" : ""]
    .filter(Boolean).join(" ");
  return `<button type="button" class="${cls}"${o.id ? ` id="${o.id}"` : ""}${o.title ? ` title="${esc(o.title)}"` : ""}${o.disabled ? " disabled" : ""}>`
    + `${o.icon ? ico(o.icon) : ""}<span>${esc(o.label)}</span></button>`;
}

/** Level meter bars from dBFS (−60 → 0 dB mapped over 4 bars). */
function meter(dbfs: number | null | undefined): string {
  const lit = dbfs == null ? 0 : Math.max(0, Math.min(4, Math.round(((dbfs + 60) / 60) * 4)));
  return `<span class="kc-meter" aria-hidden="true">${[1, 2, 3, 4].map((i) => `<i${i <= lit ? ' class="on"' : ""}></i>`).join("")}</span>`;
}

export function lcd(v: LcdView, o: { dbfs?: number | null } = {}): string {
  const db = v.state === "live" && o.dbfs != null ? `<span class="kc-lcd__db">${String(Math.round(o.dbfs)).replace("-", "−")} dB</span>` : "";
  const silent = v.silent ? ` <span class="kc-lcd__silent">${v.silent}</span>` : "";
  return `<div class="kc-lcd" data-state="${v.state}" role="status" aria-live="polite">
    <div class="kc-lcd__meta"><span>${meter(v.state === "live" ? o.dbfs : null)}${esc(v.meta)}${silent}</span>${db}</div>
    <div class="kc-lcd__name">${esc(v.name)}</div>
    ${v.freq ? `<div class="kc-lcd__freq">${esc(v.freq)}<small>MHz</small></div>` : ""}
  </div>`;
}

export function group(title: string, bodyHtml: string, o: { id?: string } = {}): string {
  return `<section class="kc-group"${o.id ? ` id="${o.id}"` : ""} aria-label="${esc(title)}">
    <h2 class="kc-group__title">${esc(title)}</h2>
    ${bodyHtml}
  </section>`;
}

export function emptyState(text: string): string {
  return `<p class="kc-empty">${esc(text)}</p>`;
}
