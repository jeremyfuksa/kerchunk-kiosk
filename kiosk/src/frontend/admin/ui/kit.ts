// HTML-string builders for the admin. Strings, not nodes: callers render with
// innerHTML and wire events by id/data-attributes, like the rest of the app.
import { esc } from "../../lib/format.js";
import { ico, type IconName } from "./icons.js";

export function key(o: {
  id?: string; label: string; icon?: IconName;
  variant?: "primary" | "danger" | "plain"; wide?: boolean; disabled?: boolean; title?: string;
}): string {
  const cls = ["kc-key", o.variant && o.variant !== "plain" ? `kc-key--${o.variant}` : "", o.wide ? "kc-key--wide" : ""]
    .filter(Boolean).join(" ");
  return `<button type="button" class="${cls}"${o.id ? ` id="${o.id}"` : ""}${o.title ? ` title="${esc(o.title)}"` : ""}${o.disabled ? " disabled" : ""}>`
    + `${o.icon ? ico(o.icon) : ""}<span>${esc(o.label)}</span></button>`;
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

export interface SliderOpts {
  id: string; label: string; hint?: string;
  min: number; max: number; step: number; value: number; unit: string;
  /** What the low and high ends mean, in plain words ("Quieter", "Louder"). */
  ends: [string, string];
  disabled?: boolean;
  /** Trusted HTML placed on the label's line (e.g. a "Use default" link). */
  aside?: string;
}

/** A setting slider, compact: label (+ aside) with the hint directly under
 *  it, the typed-entry box on the right; then the range and the named ends.
 *  The range carries o.id; the box `${o.id}-num`. */
export function slider(o: SliderOpts): string {
  const dis = o.disabled ? " disabled" : "";
  const bounds = `min="${o.min}" max="${o.max}" step="${o.step}" value="${o.value}"`;
  return `<div class="kc-slider" data-slider="${o.id}">
    <div class="kc-slider__head">
      <div class="kc-slider__text">
        <div class="kc-slider__line"><label for="${o.id}">${esc(o.label)}</label>${o.aside ?? ""}</div>
        ${o.hint ? `<small class="kc-slider__hint">${esc(o.hint)}</small>` : ""}
      </div>
      <span class="kc-slider__val"><input id="${o.id}-num" type="number" inputmode="decimal" ${bounds} aria-label="${esc(o.label)}, exact value"${dis} />${o.unit ? `<b>${esc(o.unit)}</b>` : ""}</span>
    </div>
    <input id="${o.id}" type="range" ${bounds}${dis} />
    <div class="kc-slider__ends" aria-hidden="true"><span>${esc(o.ends[0])}</span><span>${esc(o.ends[1])}</span></div>
  </div>`;
}

/** A labelled on/off switch row (checkbox with role="switch"). */
export function switchRow(o: { id: string; label: string; hint?: string; checked: boolean; disabled?: boolean }): string {
  return `<label class="kc-switchRow"><span>${esc(o.label)}${o.hint ? ` <small>${esc(o.hint)}</small>` : ""}</span>`
    + `<input id="${o.id}" type="checkbox" role="switch"${o.checked ? " checked" : ""}${o.disabled ? " disabled" : ""} /></label>`;
}

/** A two-or-more-way view switch made of links (each view is a route). */
export function segmented(o: {
  label: string; current: string;
  items: Array<{ id: string; label: string; href: string; count?: number; attention?: boolean }>;
}): string {
  return `<nav class="kc-seg" aria-label="${esc(o.label)}">${o.items.map((it) =>
    `<a class="kc-seg__item" data-seg="${esc(it.id)}" href="${esc(it.href)}"${it.id === o.current ? ' aria-current="page"' : ""}>`
    + `${esc(it.label)}${it.count !== undefined ? ` <b class="kc-seg__count${it.attention ? " kc-badge" : ""}">${it.count}</b>` : ""}</a>`,
  ).join("")}</nav>`;
}

/** A filter chip: a toggle button (aria-pressed), optional count. */
export function chip(o: { id: string; label: string; count?: number; pressed?: boolean; attrs?: string; dashed?: boolean }): string {
  return `<button type="button" class="kc-chip${o.dashed ? " kc-chip--dashed" : ""}" data-chip="${esc(o.id)}"`
    + `${o.pressed === undefined ? "" : ` aria-pressed="${o.pressed}"`}${o.attrs ? ` ${o.attrs}` : ""}>`
    + `${esc(o.label)}${o.count !== undefined ? ` <b>${o.count}</b>` : ""}</button>`;
}

/** A labelled settings field around a trusted control, with the error line
 *  the caller fills (and un-hides) on a refused value. */
export function field(o: { id: string; label: string; control: string; hint?: string }): string {
  return `<div class="kc-field"><label for="${o.id}">${esc(o.label)}</label>${o.control}`
    + `${o.hint ? `<small class="kc-field__hint">${esc(o.hint)}</small>` : ""}`
    + `<small class="kc-fieldErr" id="${o.id}-err" role="alert" hidden></small></div>`;
}
