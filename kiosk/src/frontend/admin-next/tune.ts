// Tune — every setting, saved as you go (spec §4). One field table
// (tuneFields.ts) drives markup, load, save and dependents; what a save costs
// decides how it goes out:
//   live / backend → saved on change;
//   scan           → batched per group behind a countdown with Undo (one
//                    scanner restart per batch, not per nudge);
//   heavy          → explicit Apply / Cancel.
//
// House rules (same as radio.ts): the page is built once on the first load
// and patched in place afterwards — no group's markup is ever rebuilt, so
// focus and half-typed input survive every refresh. Every read rides the
// "tune" poll and every write rides ctx.poller.run (this box deadlocks on
// concurrent requests). A refresh never overwrites a field that is focused,
// has an unsaved or in-flight change, or differs from what was last loaded.
import type { Channel, Config } from "../../backend/config/schema.js";
import { NOAA_CHANNELS } from "../../backend/config/noaa.js";
import { DEFAULT_GROUP_DWELL_MS } from "../../backend/config/engineDefaults.js";
import {
  ADVANCED_BANDS, BAND_COST, COST_LABEL, KNOB_BY_ID, curveSvg, knobUi, loudnessCurve,
  previewGroups, previewText, revisitHint, type Band, type KnobValues,
} from "../admin/engineKnobs.js";
import { api } from "../lib/api.js";
import { esc } from "../lib/format.js";
import { group, key, slider, switchRow } from "./ui/kit.js";
import { POLL_MS } from "./poller.js";
import { hrefFor } from "./route.js";
import { ico } from "./ui/icons.js";
import { ApplyBatcher, type BatchState } from "./batcher.js";
import {
  FIELD_BY_ID, GROUP_TITLES, TUNE_FIELDS, applyTune, disabledIds, isDefault, readTune, snapValue,
  type TuneField, type TuneGroup, type TuneValue, type TuneValues,
} from "./tuneFields.js";
import type { Ctx } from "./ctx.js";

/** How long an inline "Saved" stays before it clears. */
export const SAVED_SHOW_MS = 3000;
/** How often a pending batch's countdown text is refreshed. */
const COUNTDOWN_TICK_MS = 250;

/** The main groups, in display order (Advanced bands follow in a disclosure). */
const MAIN_GROUPS: readonly TuneGroup[] = ["sound", "scanning", "discovery", "alerts"];
const WX_MODES: ReadonlyArray<[Channel["mode"], string]> = [["nfm", "NFM"], ["fm", "FM"], ["am", "AM"]];
/** What the Apply bar says for a group whose change restarts the scanner. */
const HEAVY_TEXT: Partial<Record<TuneGroup, string>> = {
  discovery: "Recording samples restarts the scanner.",
  shape: "Changing the group shape restarts the scanner.",
};

// ---- Markup (pure) -----------------------------------------------------------

/** A field's control, by kind. `v` is the UI value ("" = default). */
export function controlHtml(f: TuneField, v: TuneValue): string {
  const c = f.control;
  if (c.kind === "slider") {
    const n = v === "" || typeof v !== "string" ? Number(f.def) : Number(v);
    return slider({ id: f.id, label: f.label, hint: f.hint, min: c.min, max: c.max, step: c.step, unit: c.unit, ends: c.ends, value: n });
  }
  if (c.kind === "switch") {
    // An always-present hint slot, so a field whose hint is computed later
    // (Peek at priority channels) has somewhere to write it.
    return switchRow({ id: f.id, label: f.label, hint: f.hint || " ", checked: v === true });
  }
  const val = typeof v === "string" ? v : "";
  const attrs = c.kind === "number"
    ? `type="number" inputmode="decimal" step="${c.step}"${c.min != null ? ` min="${c.min}"` : ""}${c.max != null ? ` max="${c.max}"` : ""} placeholder="${esc(String(f.def))}"`
    : `type="text" spellcheck="false" autocomplete="off" placeholder="${esc(c.placeholder)}"`;
  const unit = c.kind === "number" && c.unit ? `<b>${esc(c.unit)}</b>` : "";
  return `<label class="kc-field" for="${f.id}"><span class="kc-field__label">${esc(f.label)}${f.hint ? `<small>${esc(f.hint)}</small>` : ""}</span>`
    + `<span class="kc-field__input${c.kind === "text" ? " kc-field__input--text" : ""}"><input id="${f.id}" ${attrs} value="${esc(val)}" />${unit}</span></label>`;
}

export function rowHtml(f: TuneField, v: TuneValue): string {
  return `<div class="kc-tuneRow" data-row="${f.id}">${controlHtml(f, v)}`
    + `<button type="button" class="kc-link kc-reset" data-reset="${f.id}" hidden>Use default</button></div>`;
}

/** The Apply / Cancel bar for a group with heavy fields (hidden until used). */
export function heavyHtml(g: TuneGroup): string {
  return `<div class="kc-heavy" data-heavy="${g}" hidden><p class="kc-heavy__text">${esc(HEAVY_TEXT[g] ?? "This change restarts the scanner.")}</p>`
    + `<div class="kc-heavy__keys">${key({ id: `kcApply-${g}`, label: "Apply", variant: "primary" })}${key({ id: `kcCancel-${g}`, label: "Cancel" })}</div></div>`;
}

/** A group's status line. Built once with every slot it can need; painting
 *  only sets text and toggles `hidden`. */
export function statusHtml(g: TuneGroup | "weather", o: { restartLink?: string } = {}): string {
  return `<p class="kc-status" data-status="${g}" role="status" aria-live="polite">`
    + `<span class="kc-status__batch"></span>`
    + (g === "weather" ? "" : `<button type="button" class="kc-link" data-undo="${g}" hidden>Undo</button>`)
    + `<span class="kc-status__direct"></span>`
    + (o.restartLink ? `<a class="kc-link" data-restart href="${esc(o.restartLink)}" hidden>Restart radio</a>` : "")
    + `</p>`;
}

function fieldsOf(g: TuneGroup): TuneField[] {
  return TUNE_FIELDS.filter((f) => f.group === g);
}

export function groupHtml(g: TuneGroup, values: TuneValues, extra = ""): string {
  const fields = fieldsOf(g);
  const heavy = fields.some((f) => f.cost === "heavy") ? heavyHtml(g) : "";
  const rows = fields.map((f) => rowHtml(f, values[f.id] ?? f.def)).join("");
  return group(GROUP_TITLES[g], `${extra}${rows}${heavy}${statusHtml(g)}`, { id: `kcTune-${g}` });
}

const CURVE_HTML = `<figure class="kc-curve"><svg id="kcCurve" viewBox="0 0 300 150" role="img" aria-label="Speaker level: input against output, steady state"></svg><figcaption id="kcCurveSay"></figcaption></figure>`;

function weatherHtml(): string {
  const opts = [`<option value="">Not set</option>`]
    .concat(NOAA_CHANNELS.map((c) => `<option value="${c.mhz}">${esc(`${c.label} — ${c.mhz} MHz`)}</option>`)).join("");
  const modes = WX_MODES.map(([v, l]) => `<option value="${v}">${l}</option>`).join("");
  const field = (id: string, label: string, hint: string, input: string): string =>
    `<label class="kc-field" for="${id}"><span class="kc-field__label">${esc(label)}<small>${esc(hint)}</small></span><span class="kc-field__input${id === "kcWxTag" ? " kc-field__input--text" : ""}">${input}</span></label>`;
  return group("Weather channel",
    field("kcWxFreq", "NOAA channel", "Your local weather radio station", `<select id="kcWxFreq">${opts}</select>`)
    + field("kcWxTag", "Name", "Shown when the radio parks on weather", `<input id="kcWxTag" type="text" autocomplete="off" placeholder="NOAA WX" />`)
    + field("kcWxMode", "Mode", "Weather radio is narrowband FM", `<select id="kcWxMode">${modes}</select>`)
    + statusHtml("weather"),
    { id: "kcTune-weather" });
}

/** One Advanced band: heading with its cost, purpose, rows, Apply bar and
 *  status line. Pure, so its markup is unit-tested. */
export function bandHtml(band: Exclude<Band, "sound">, values: TuneValues): string {
  const meta = ADVANCED_BANDS.find((b) => b.band === band);
  if (!meta) return "";
  const cost = band === "shape" ? "Restarts scanning · Apply to confirm" : COST_LABEL[BAND_COST[band]];
  const fields = fieldsOf(band);
  const rows = fields.map((f) => {
    const sub = KNOB_BY_ID[f.id]?.sub;
    return `${sub ? `<h4 class="kc-band__sub">${esc(sub)}</h4>` : ""}${rowHtml(f, values[f.id] ?? f.def)}`;
  }).join("");
  const heavy = fields.some((f) => f.cost === "heavy") ? heavyHtml(band) : "";
  const status = statusHtml(band, band === "watchdog" ? { restartLink: hrefFor({ tab: "system" }) } : {});
  return `<section class="kc-band" aria-labelledby="kcBand-${band}">`
    + `<h3 id="kcBand-${band}">${esc(meta.title)} <small class="kc-cost">${esc(cost)}</small></h3>`
    + `<p class="kc-band__purpose">${esc(meta.purpose)}</p>`
    + (band === "shape" ? `<p class="kc-preview" id="kcPreview" role="status" aria-live="polite"></p>` : "")
    + `${rows}${heavy}${status}</section>`;
}

/** The Advanced disclosure (closed by default), below the main grid. */
export function advancedHtml(values: TuneValues): string {
  return `<details class="kc-group kc-disclosure" id="kcAdvanced">`
    + `<summary class="kc-group__title"><span>Advanced engine settings</span>${ico("chevron", "kc-ico kc-disclosure__chev")}</summary>`
    + `<p class="kc-empty">Tuned for this appliance. Leave a field blank for its default.</p>`
    + ADVANCED_BANDS.map((b) => bandHtml(b.band, values)).join("")
    + `</details>`;
}

/** The whole Tune page for a loaded set of values. */
export function pageHtml(values: TuneValues, advancedHtml = ""): string {
  const groups = MAIN_GROUPS.map((g) => groupHtml(g, values, g === "sound" ? CURVE_HTML : "")).join("");
  return `<div class="kc-tune"><header class="kc-tune__head"><h1>Tune</h1><p>Changes apply as you go.</p></header>`
    + `<div class="kc-tune__grid">${groups}${weatherHtml()}</div>${advancedHtml}</div>`;
}

// ---- Engine --------------------------------------------------------------------

export function mountTune(ctx: Ctx): void {
  const { poller } = ctx;
  const el = ctx.shell.panel("tune");
  el.innerHTML = `<p class="kc-empty">Loading…</p>`;

  let values: TuneValues = {};
  let loaded: TuneValues = {};
  let cfgCache: Config | null = null;
  let ready = false;
  /** Set when opening Advanced asks for a fresh load ahead of the schedule. */
  let refreshNow = false;
  const heavy = new Map<TuneGroup, Set<string>>();
  const batchers = new Map<TuneGroup, ApplyBatcher>();
  /** Ids in a direct (live/backend/heavy) save that hasn't resolved yet. */
  const inflight = new Set<string>();

  // ── small DOM helpers (patch only on change)
  const $ = <T extends HTMLElement>(sel: string): T | null => el.querySelector<T>(sel);
  const byId = <T extends HTMLElement>(id: string): T | null => el.querySelector<T>(`#${CSS.escape(id)}`);
  function setText(e: Element, t: string): void { if (e.textContent !== t) e.textContent = t; }
  function setHidden(e: HTMLElement, h: boolean): void { if (e.hidden !== h) e.hidden = h; }
  function setDisabled(e: HTMLInputElement | HTMLButtonElement | HTMLSelectElement, d: boolean): void { if (e.disabled !== d) e.disabled = d; }
  function setKind(e: HTMLElement, error: boolean): void {
    if (error) { if (e.dataset.kind !== "error") e.dataset.kind = "error"; } else if (e.dataset.kind) delete e.dataset.kind;
  }
  const focused = (id: string): boolean => {
    const a = document.activeElement;
    return !!a && (a.id === id || a.id === `${id}-num`);
  };
  const same = (a: TuneValue | undefined, b: TuneValue | undefined): boolean => a === b;
  function batchIds(g: TuneGroup): string[] {
    const s: BatchState | undefined = batchers.get(g)?.state;
    return s && (s.kind === "pending" || s.kind === "saving" || s.kind === "error") ? s.ids : [];
  }
  const busy = (f: TuneField): boolean =>
    inflight.has(f.id) || batchIds(f.group).includes(f.id) || (heavy.get(f.group)?.has(f.id) ?? false);

  // ── painting
  function shownValue(f: TuneField, v: TuneValue | undefined): string {
    return typeof v === "string" && v.trim() !== "" ? v : String(f.def);
  }
  /** The unit next to a slider's box; a 0-means-off field says so. */
  function paintUnit(f: TuneField, v: string): void {
    if (f.control.kind !== "slider") return;
    const b = $(`[data-slider="${f.id}"] .kc-slider__val b`);
    if (b) setText(b, KNOB_BY_ID[f.id]?.allowZero && Number(v) === 0 ? "Off" : f.control.unit);
  }
  function paintControl(id: string): void {
    const f = FIELD_BY_ID[id];
    if (!f) return;
    const v = values[id];
    if (f.control.kind === "slider") {
      const s = shownValue(f, v);
      const range = byId<HTMLInputElement>(id);
      const box = byId<HTMLInputElement>(`${id}-num`);
      if (range && document.activeElement !== range && range.value !== s) range.value = s;
      if (box && document.activeElement !== box && box.value !== s) box.value = s;
      paintUnit(f, s);
      return;
    }
    const input = byId<HTMLInputElement>(id);
    if (!input || document.activeElement === input) return;
    if (f.control.kind === "switch") { if (input.checked !== (v === true)) input.checked = v === true; }
    else { const s = typeof v === "string" ? v : ""; if (input.value !== s) input.value = s; }
  }
  function paintRow(id: string): void {
    const f = FIELD_BY_ID[id];
    const b = $<HTMLButtonElement>(`[data-reset="${id}"]`);
    if (f && b) setHidden(b, isDefault(f, values[id] ?? f.def));
  }
  function paintDependents(): void {
    const off = disabledIds(values);
    for (const f of TUNE_FIELDS) {
      const row = $(`[data-row="${f.id}"]`);
      if (!row) continue;
      const d = off.has(f.id);
      row.classList.toggle("is-off", d);
      row.querySelectorAll<HTMLInputElement>("input").forEach((i) => setDisabled(i, d));
    }
  }
  let curveShown = "";
  function paintCurve(): void {
    const svg = $("#kcCurve");
    const say = $("#kcCurveSay");
    if (!svg || !say) return;
    const v = values as KnobValues;
    const p = {
      targetDb: knobUi(v, "kAgcTarget"), maxGainDb: knobUi(v, "kAgcMax"), minGainDb: knobUi(v, "kAgcMin"),
      holdBelowDb: knobUi(v, "kAgcHold"), limiterCeiling: knobUi(v, "kLimCeil"),
    };
    const s = curveSvg(p);
    if (s !== curveShown) { curveShown = s; svg.innerHTML = s; }
    setText(say, loudnessCurve(p).caption);
  }
  /** Group-shape preview (Advanced): the engine's own grouping over the
   *  loaded channel list, with the shape fields as currently entered. */
  function paintPreview(): void {
    const out = $("#kcPreview");
    if (!cfgCache || !out) return;
    const v = values as KnobValues;
    const pv = previewGroups({
      channels: cfgCache.channels, banks: cfgCache.banks ?? [],
      lanes: knobUi(v, "kLanes"), rateHz: knobUi(v, "kRate") * 1e6,
      windowHz: knobUi(v, "kWindow") * 1e6, flatHz: knobUi(v, "kFlat") * 1e6,
      groupDwellMs: Number(values.tGroupDwell || DEFAULT_GROUP_DWELL_MS),
      sweeping: (cfgCache.scan.sweepRanges?.length ?? 0) > 0,
    });
    setText(out, previewText(pv));
    setKind(out, !pv.ok);
    const apply = byId<HTMLButtonElement>("kcApply-shape");
    if (apply) setDisabled(apply, !pv.ok);
    const hint = $('[data-row="kRevisit"] small');
    if (hint) setText(hint, revisitHint(pv));
  }

  // ── status lines: a batch part (countdown / Undo) and a direct part
  //    (live saves), painted independently so neither hides the other.
  const directTimers = new Map<string, ReturnType<typeof setTimeout>>();
  function statusEl(g: TuneGroup | "weather"): HTMLElement | null { return $(`[data-status="${g}"]`); }
  function paintDirect(g: TuneGroup | "weather", text: string, o: { error?: boolean; fade?: boolean; restart?: boolean } = {}): void {
    const st = statusEl(g);
    if (!st) return;
    const span = st.querySelector<HTMLElement>(".kc-status__direct")!;
    setText(span, text);
    setKind(span, !!o.error);
    const link = st.querySelector<HTMLElement>("[data-restart]");
    if (link) setHidden(link, !o.restart);
    const t = directTimers.get(g);
    if (t) { clearTimeout(t); directTimers.delete(g); }
    if (o.fade) directTimers.set(g, setTimeout(() => { directTimers.delete(g); paintDirect(g, ""); }, SAVED_SHOW_MS));
  }
  const batchTimers = new Map<TuneGroup, ReturnType<typeof setTimeout>>();
  function paintStatus(g: TuneGroup, s: BatchState): void {
    const st = statusEl(g);
    if (!st) return;
    const span = st.querySelector<HTMLElement>(".kc-status__batch")!;
    const undo = st.querySelector<HTMLButtonElement>("[data-undo]")!;
    const t = batchTimers.get(g);
    if (t) { clearTimeout(t); batchTimers.delete(g); }
    let text = "";
    if (s.kind === "pending") text = `Applying in ${Math.max(0, Math.ceil((s.dueAt - Date.now()) / 1000))} s — restarts scanning briefly`;
    else if (s.kind === "saving") text = "Saving…";
    else if (s.kind === "saved") {
      text = "Saved";
      batchTimers.set(g, setTimeout(() => { batchTimers.delete(g); paintStatus(g, { kind: "idle" }); }, SAVED_SHOW_MS));
    } else if (s.kind === "error") text = s.message;
    setText(span, text);
    setKind(span, s.kind === "error");
    setHidden(undo, s.kind !== "pending" && s.kind !== "error");
    syncCountdown();
  }
  let countdown: ReturnType<typeof setInterval> | null = null;
  /** Run the countdown refresh only while some batch is pending. */
  function syncCountdown(): void {
    const pending = [...batchers.values()].some((b) => b.state.kind === "pending");
    if (pending && countdown === null) {
      countdown = setInterval(() => {
        for (const [g, b] of batchers) if (b.state.kind === "pending") paintStatus(g, b.state);
      }, COUNTDOWN_TICK_MS);
    } else if (!pending && countdown !== null) { clearInterval(countdown); countdown = null; }
  }

  // ── saving
  async function saveIds(ids: string[]): Promise<void> {
    const sent: TuneValues = Object.fromEntries(ids.map((id) => [id, values[id]!]));
    const saved = await poller.run(async () => {
      const cfg = await api.getConfig();
      applyTune(cfg, ids, values);
      return api.putConfig(cfg);
    });
    cfgCache = saved;
    const fresh = readTune(saved);
    for (const id of ids) {
      loaded[id] = fresh[id]!;
      // A newer edit made while this save was in flight stays the operator's.
      if (same(values[id], sent[id])) { values[id] = fresh[id]!; paintControl(id); paintRow(id); }
    }
    paintDependents();
    paintPreview();
  }
  /** Save ids now; resolves true when saved (the status line says either way). */
  async function saveNow(g: TuneGroup, ids: string[]): Promise<boolean> {
    const backend = ids.some((id) => FIELD_BY_ID[id]?.cost === "backend");
    for (const id of ids) inflight.add(id);
    paintDirect(g, "Saving…");
    try {
      await saveIds(ids);
      paintDirect(g, backend ? "Saved — used after the next radio restart" : "Saved", { fade: !backend, restart: backend });
      return true;
    } catch (e) {
      paintDirect(g, e instanceof Error ? e.message : String(e), { error: true });
      return false;
    } finally {
      for (const id of ids) inflight.delete(id);
    }
  }
  function batcher(g: TuneGroup): ApplyBatcher {
    let b = batchers.get(g);
    if (!b) { b = new ApplyBatcher((ids) => saveIds(ids), (s) => paintStatus(g, s)); batchers.set(g, b); }
    return b;
  }
  function heavySet(g: TuneGroup): Set<string> {
    let s = heavy.get(g);
    if (!s) { s = new Set(); heavy.set(g, s); }
    return s;
  }
  function paintHeavy(g: TuneGroup): void {
    const bar = $(`[data-heavy="${g}"]`);
    if (bar) setHidden(bar, (heavy.get(g)?.size ?? 0) === 0);
  }
  const isSound = (f: TuneField): boolean => f.group === "sound" || f.group === "loudness";

  /** After every operator change: repaint what depends on it, then route by cost. */
  function commit(id: string): void {
    const f = FIELD_BY_ID[id];
    if (!f) return;
    paintRow(id);
    paintDependents();
    if (isSound(f)) paintCurve();
    if (f.group === "shape" || id === "tGroupDwell") paintPreview();
    if (f.cost === "live" || f.cost === "backend") void saveNow(f.group, [id]);
    else if (f.cost === "scan") batcher(f.group).change(id);
    else {
      // Changing it back to what's saved needs no Apply.
      const set = heavySet(f.group);
      if (same(values[id], loaded[id])) set.delete(id); else set.add(id);
      paintHeavy(f.group);
    }
  }
  function revert(ids: readonly string[]): void {
    for (const id of ids) { values[id] = loaded[id]!; paintControl(id); paintRow(id); }
    paintDependents();
    paintCurve();
    paintPreview();
  }

  // ── input wiring (delegated: the page is built later, the listeners now)
  function fieldOf(t: EventTarget | null): { f: TuneField; input: HTMLInputElement; box: boolean } | null {
    if (!(t instanceof HTMLInputElement)) return null;
    const box = t.id.endsWith("-num");
    const f = FIELD_BY_ID[box ? t.id.slice(0, -4) : t.id];
    return f ? { f, input: t, box } : null;
  }
  el.addEventListener("input", (e) => {
    const hit = fieldOf(e.target);
    if (!hit || hit.box || hit.input.type !== "range") return;
    const { f, input } = hit;
    const n = snapValue(f, Number(input.value));
    if (String(n) !== input.value) input.value = String(n);
    values[f.id] = String(n);
    const box = byId<HTMLInputElement>(`${f.id}-num`);
    if (box) box.value = String(n);
    paintUnit(f, String(n));
    if (isSound(f)) paintCurve();
  });
  el.addEventListener("change", (e) => {
    if (e.target instanceof Element && e.target.closest("#kcTune-weather")) { void saveWeather(); return; }
    const hit = fieldOf(e.target);
    if (!hit) return;
    const { f, input, box } = hit;
    if (input.type === "range") { commit(f.id); return; }
    if (box && f.control.kind === "slider") {
      const c = f.control;
      const raw = input.value.trim();
      if (raw === "") values[f.id] = "";
      else {
        const n = snapValue(f, Math.min(c.max, Math.max(c.min, Number(raw))));
        values[f.id] = String(n);
        input.value = String(n);
      }
      const range = byId<HTMLInputElement>(f.id);
      if (range) range.value = shownValue(f, values[f.id]);
      paintUnit(f, shownValue(f, values[f.id]));
      commit(f.id);
      return;
    }
    if (input.type === "checkbox") values[f.id] = input.checked;
    else values[f.id] = input.value.trim();
    commit(f.id);
  });
  el.addEventListener("keydown", (e) => {
    const t = e.target;
    if (e.key === "Enter" && t instanceof HTMLInputElement && t.type === "text") { e.preventDefault(); t.blur(); }
  });
  el.addEventListener("click", (e) => {
    const t = (e.target as HTMLElement).closest<HTMLElement>("[data-reset], [data-undo], [id^='kcApply-'], [id^='kcCancel-']");
    if (!t) return;
    if (t.dataset.reset) {
      const f = FIELD_BY_ID[t.dataset.reset];
      if (!f) return;
      values[f.id] = f.control.kind === "switch" ? f.def : "";
      paintControl(f.id);
      commit(f.id);
      return;
    }
    if (t.dataset.undo) {
      const g = t.dataset.undo as TuneGroup;
      revert(batcher(g).undo());
      return;
    }
    const m = /^kc(Apply|Cancel)-(.+)$/.exec(t.id);
    if (!m) return;
    const g = m[2] as TuneGroup;
    const ids = [...(heavy.get(g) ?? [])];
    heavy.get(g)?.clear();
    paintHeavy(g);
    if (!ids.length) return;
    if (m[1] === "Cancel") { revert(ids); return; }
    void saveNow(g, ids).then((ok) => {
      // Refused (e.g. a window wider than the rate): keep the change and its
      // Apply bar so the operator can fix it or cancel.
      if (ok) return;
      const set = heavySet(g);
      for (const id of ids) if (!same(values[id], loaded[id])) set.add(id);
      paintHeavy(g);
    });
  });

  // ── weather channel (its own route; the radio re-tunes on save)
  let wxLoaded: { freq: string; tag: string; mode: string } | null = null;
  let wxSaving = false;
  const mhzOf = (hz: number): string => (hz / 1e6).toFixed(3);
  function paintWeather(w: Channel | null): void {
    const freq = byId<HTMLSelectElement>("kcWxFreq");
    const tag = byId<HTMLInputElement>("kcWxTag");
    const mode = byId<HTMLSelectElement>("kcWxMode");
    if (!freq || !tag || !mode || wxSaving) return;
    const next = { freq: w ? mhzOf(w.freq) : "", tag: w?.alphaTag ?? "", mode: w?.mode ?? "nfm" };
    // A station outside the NOAA list (hand-edited config) still shows.
    if (next.freq && !Array.from(freq.options).some((o) => o.value === next.freq)) {
      freq.add(new Option(`${next.freq} MHz`, next.freq));
    }
    const follow = (c: HTMLInputElement | HTMLSelectElement, was: string | undefined, v: string): void => {
      if (document.activeElement === c) return;
      if (was !== undefined && c.value !== was) return; // operator's unsaved edit
      if (c.value !== v) c.value = v;
    };
    follow(freq, wxLoaded?.freq, next.freq);
    follow(tag, wxLoaded?.tag, next.tag);
    follow(mode, wxLoaded?.mode, next.mode);
    wxLoaded = next;
  }
  async function saveWeather(): Promise<void> {
    const freqSel = byId<HTMLSelectElement>("kcWxFreq");
    const tag = byId<HTMLInputElement>("kcWxTag");
    const modeSel = byId<HTMLSelectElement>("kcWxMode");
    if (!freqSel || !tag || !modeSel) return;
    if (!freqSel.value) { paintDirect("weather", "Pick a NOAA channel first", { error: true }); return; }
    const freq = Math.round(Number(freqSel.value) * 1e6);
    const alphaTag = tag.value.trim() || "NOAA WX";
    const mode = modeSel.value as Channel["mode"];
    wxSaving = true;
    paintDirect("weather", "Saving…");
    try {
      await poller.run(() => api.setWeatherChannel({ freq, alphaTag, mode, enabled: true }));
      wxLoaded = { freq: freqSel.value, tag: tag.value, mode };
      ctx.live.set({ weatherChannel: { freq, alphaTag, mode } });
      paintDirect("weather", "Saved — the radio re-tunes briefly", { fade: true });
    } catch (e) {
      paintDirect("weather", e instanceof Error ? e.message : String(e), { error: true });
    } finally { wxSaving = false; }
  }

  // ── load + refresh
  function render(): void {
    el.innerHTML = pageHtml(values, advancedHtml(values));
    // Opening Advanced refreshes the channel list behind the shape preview —
    // through the poller, via a flag (makeDue("tune") would also refire every
    // tab-less poll: verdict, status, audio).
    const adv = byId<HTMLDetailsElement>("kcAdvanced");
    adv?.addEventListener("toggle", () => { if (adv.open) { refreshNow = true; void poller.tick("tune"); } });
    for (const f of TUNE_FIELDS) { paintControl(f.id); paintRow(f.id); }
    paintDependents();
    paintCurve();
    paintPreview();
  }
  async function load(): Promise<void> {
    let cfg: Config;
    try { cfg = await api.getConfig(); }
    catch (e) {
      if (!ready) el.innerHTML = `<p class="kc-empty">Couldn't load settings — retrying</p>`;
      throw e;
    }
    cfgCache = cfg;
    const fresh = readTune(cfg);
    if (!ready) {
      values = { ...fresh }; loaded = { ...fresh };
      render();
      ready = true;
    } else {
      for (const f of TUNE_FIELDS) {
        // Only untouched fields follow the server: never clobber an edit in progress.
        if (same(values[f.id], loaded[f.id]) && !busy(f) && !focused(f.id)) {
          values[f.id] = loaded[f.id] = fresh[f.id]!;
          paintControl(f.id); paintRow(f.id);
        }
      }
      paintCurve();
    }
    paintDependents();
    paintPreview();
    const { weatherChannel } = await api.getWeatherChannel(); // sequential, same poll
    paintWeather(weatherChannel);
  }
  poller.add({ name: "tune", tabs: ["tune"], everyMs: POLL_MS.tune, run: () => { refreshNow = false; return load(); } });
  poller.add({ name: "tune-now", tabs: ["tune"], everyMs: 0, when: () => refreshNow, run: () => { refreshNow = false; return load(); } });
}
