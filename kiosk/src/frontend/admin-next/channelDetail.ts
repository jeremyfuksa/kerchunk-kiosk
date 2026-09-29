// Library · channel detail: a bottom sheet below 900px, a right-side pane
// above it (the list beside it stays usable). Route-driven — library.ts calls
// show() for #/next/library/{ch,hz,add}/… and hide() when the route leaves.
//
// Edit mode saves as you go: every commit is one channel PUT through lib.run
// (re-tunes in place — no restart). The markup is built once per shown
// channel and patched in place on each poll; a field the operator is focused
// on, has edited unsaved, or is saving is never overwritten
// (detailFieldsToPatch). Add mode is a form with one Add key.
import type { Bank, Channel } from "../../backend/config/schema.js";
import { bandFor } from "../../backend/config/banks.js";
import { CTCSS_TONES } from "../../backend/config/ctcss.js";
import { DCS_CODES, dcsAlias } from "../../backend/config/dcs.js";
import { api } from "../lib/api.js";
import { esc, fmtFreq } from "../lib/format.js";
import {
  DETAIL_FIELDS, MODES, bankToggles, channelName, defaultMode, detailFieldsToPatch, discoveryNote, lcdMeta,
  newChannelBody, parseMhz, parseSite, parseTags, resolveDetail, signalSeries, siteLocation, toneFromValue, toneValue,
  type ChannelDraft, type Discovery, type HistRow, type Resolved,
} from "./libraryModel.js";
import { lockout } from "./libraryActions.js";
import type { LibCtx } from "./libraryStore.js";
import { chip, emptyState, field, key, lcd, switchRow } from "./ui/kit.js";
import { ico } from "./ui/icons.js";
import { mountSheet } from "./ui/sheet.js";
import { hrefFor, type Detail } from "./route.js";
import { POLL_MS } from "./poller.js";
import { SAVED_SHOW_MS } from "./tune.js";
import { airtime } from "./radio.js";

/** How many recent transmissions the "Last 24 hours" list shows. */
export const DETAIL_TX_COUNT = 10;
const DAY_MS = 86_400_000;
const SPARK_W = 420;
const SPARK_H = 90;

// ── Pure markup builders ─────────────────────────────────────────────────────

const lcdHtml = (c: { freq: number | null; alphaTag: string; mode: Channel["mode"]; location?: Channel["location"] }, name: string): string =>
  lcd({ state: "detail", meta: c.freq ? lcdMeta({ ...c, freq: c.freq }) : "", name, freq: c.freq ? fmtFreq(c.freq) : "", silent: null, canLock: false });

const input = (id: string, f: string, value: string, extra = ""): string =>
  `<input id="${id}" data-field="${f}" type="text" value="${esc(value)}" aria-describedby="${id}-err"${extra} />`;

function modeSelect(mode: Channel["mode"]): string {
  return `<select id="kcDtMode" data-field="mode" aria-describedby="kcDtMode-err">${MODES.map(([v, l]) =>
    `<option value="${v}"${v === mode ? " selected" : ""}>${l}</option>`).join("")}</select>`;
}

/** None, the CTCSS tones ("100.0"), then every DCS code in both polarities
 *  ("dcs:023N") — classic toneOptions. A channel holds at most one. */
export function toneSelect(c: Pick<Channel, "ctcssHz" | "dcsCode">): string {
  const v = toneValue(c);
  const opt = (value: string, label: string): string => `<option value="${value}"${value === v ? " selected" : ""}>${label}</option>`;
  return `<select id="kcDtTone" data-field="tone" aria-describedby="kcDtTone-err">${opt("", "None")}`
    + `<optgroup label="CTCSS">${CTCSS_TONES.map((t) => opt(t.toFixed(1), `${t.toFixed(1)} Hz`)).join("")}</optgroup>`
    + `<optgroup label="DCS">${DCS_CODES.flatMap((d) => (["N", "I"] as const).map((p) => opt(`dcs:${d}${p}`, `DCS ${d} ${p}`))).join("")}</optgroup></select>`;
}

/** What the helper last heard (classic toneHint): each is a button that picks
 *  it; a heard DCS code is its on-air normal form, so name the inverted twin. */
export function toneHeard(c: Pick<Channel, "heardCtcssHz" | "heardDcs">): string {
  const use = (value: string, label: string): string =>
    `<button type="button" class="kc-chip" data-tone="${esc(value)}" title="Use this tone">${esc(label)}</button>`;
  const heard: string[] = [];
  if (c.heardCtcssHz != null) heard.push(use(c.heardCtcssHz.toFixed(1), `${c.heardCtcssHz.toFixed(1)} Hz`));
  if (c.heardDcs != null) {
    const twin = dcsAlias(c.heardDcs);
    heard.push(use(`dcs:${c.heardDcs}`, `DCS ${c.heardDcs}`) + (twin ? ` <span>(= ${esc(twin)})</span>` : ""));
  }
  return heard.length ? `<span>Heard:</span> ${heard.join(" ")}` : "<span>Sub-audible CTCSS or DCS — opens only on this tone or code</span>";
}

/** Bank membership chips; a chip a tag change can't flip is aria-disabled. */
export function banksHtml(c: Channel, banks: Bank[]): string {
  return bankToggles(c, banks).map((t) => chip({
    id: t.id, label: t.name, pressed: t.member, attrs: t.next === null ? 'aria-disabled="true"' : "",
  })).join("");
}

/** The classic drawer's info list (dwInfo). */
export function factsHtml(c: Channel): string {
  const loc = c.location;
  const via = (s: string): string => ` <span class="kc-field__hint">${esc(s)}</span>`;
  const place = loc
    ? `${esc([loc.city, loc.state].filter(Boolean).join(", ") || "—")}${loc.lat != null ? ` · ${loc.lat}, ${loc.lon}` : ""}${via(`via ${loc.source}`)}`
    : "Not identified";
  const power = loc?.powerWatts
    ? `${loc.powerWatts} W${loc.antennaHaatM ? ` at ${loc.antennaHaatM} m` : ""}${via(loc.powerEstimated ? "RF estimate" : "FCC license")}`
    : c.rfDb != null ? `Measured ${c.rfDb} dB — awaiting an estimate` : "—";
  const row = (k: string, v: string): string => `<dt>${k}</dt><dd>${v}</dd>`;
  return `<dl class="kc-facts">${row("Band", bandFor(c.freq).toUpperCase())}${row("Exact", `${c.freq.toLocaleString()} Hz`)}`
    + `${row("Location", place)}${row("Power", power)}`
    + `${row("Looked up", c.lookedUpAt ? esc(new Date(c.lookedUpAt).toLocaleString()) : "Never")}${row("Id", esc(c.id))}</dl>`;
}

export function editHtml(c: Channel, banks: Bank[]): string {
  const archived = !c.enabled;
  return `<div class="kc-detail">
    <div id="kcDtLcd">${lcdHtml(c, channelName(c))}</div>
    <div class="kc-keys kc-keys--two">
      ${key({ id: "kcDtListen", label: "Listen now", icon: "play", variant: "primary" })}
      ${key({ id: "kcDtLock", label: "Lock out", icon: "lockout", variant: "danger" })}
    </div>
    <div class="kc-group">
      ${switchRow({ id: "kcDtAudible", label: "Play through speaker", checked: c.audible !== false })}
      ${switchRow({ id: "kcDtPriority", label: "Priority", hint: "Takes the speaker from other channels in its group", checked: !!c.priority, disabled: archived })}
      ${switchRow({ id: "kcDtAlert", label: "Alert when heard", hint: "Flashes the kiosk and lands in Alerts", checked: !!c.alert, disabled: archived })}
      ${switchRow({ id: "kcDtArchive", label: "Archive", hint: "Keep it, stop scanning it", checked: archived })}
    </div>
    <div class="kc-group">
      ${field({ id: "kcDtName", label: "Name", control: input("kcDtName", "name", c.alphaTag, ' placeholder="KC0KW — Gibbs Rd"') })}
      ${field({ id: "kcDtMode", label: "Mode", control: modeSelect(c.mode) })}
      ${banks.length ? field({ id: "kcDtBanks", label: "Banks", control: `<div class="kc-banks" id="kcDtBanks">${banksHtml(c, banks)}</div>`, hint: "Tap to add or remove. Range-only banks follow the frequency." }) : ""}
    </div>
    <details class="kc-group kc-disclosure" id="kcDtMore">
      <summary class="kc-group__title"><span>More details</span>${ico("chevron", "kc-ico kc-disclosure__chev")}</summary>
      ${field({ id: "kcDtFreq", label: "Frequency (MHz)", control: input("kcDtFreq", "freq", fmtFreq(c.freq), ' inputmode="decimal"') })}
      ${field({ id: "kcDtTone", label: "Tone", control: `${toneSelect(c)}<div class="kc-toneHeard" id="kcDtHeard">${toneHeard(c)}</div>` })}
      ${field({ id: "kcDtTags", label: "Tags", control: input("kcDtTags", "tags", DETAIL_FIELDS.tags!(c), ' placeholder="air, rail, ham"'), hint: "Comma-separated — banks match on these" })}
      ${field({ id: "kcDtSite", label: "Site", control: input("kcDtSite", "site", DETAIL_FIELDS.site!(c), ' placeholder="39.1755, -94.4861"'), hint: "Transmitter lat, lon — places it on the map" })}
      <div id="kcDtFacts">${factsHtml(c)}</div>
      <h3 class="kc-group__title">Last 24 hours</h3>
      <div id="kcDtStats">${emptyState("Loading activity…")}</div>
    </details>
    <p class="kc-detail__status" id="kcDtStatus" role="status" aria-live="polite"></p>
  </div>`;
}

export function addHtml(draft: ChannelDraft, from?: Discovery): string {
  const note = from ? discoveryNote(from) : "";
  return `<div class="kc-detail">
    <div id="kcDtLcd">${lcdHtml(draft, "New channel")}</div>
    <div class="kc-group">
      ${field({ id: "kcDtFreq", label: "Frequency (MHz)", control: input("kcDtFreq", "freq", draft.freq ? fmtFreq(draft.freq) : "", ' inputmode="decimal" placeholder="146.5200"') })}
      ${field({ id: "kcDtName", label: "Name", control: input("kcDtName", "name", draft.alphaTag, ' placeholder="KC0KW — Gibbs Rd"') })}
      ${field({ id: "kcDtMode", label: "Mode", control: modeSelect(draft.mode) })}
      ${switchRow({ id: "kcDtAudible", label: "Play through speaker", checked: draft.audible })}
      ${field({ id: "kcDtTags", label: "Tags", control: input("kcDtTags", "tags", draft.tags.join(", "), ' placeholder="air, rail, ham"'), hint: "Comma-separated — banks match on these" })}
    </div>
    ${note ? `<p class="kc-field__hint">${esc(note)}</p>` : ""}
    <div class="kc-keys kc-detail__add">${key({ id: "kcDtAdd", label: "Add channel", icon: "plus", variant: "primary", wide: true })}</div>
    <p class="kc-detail__status" id="kcDtStatus" role="status" aria-live="polite"></p>
  </div>`;
}

export function analyticsHtml(rows: HistRow[] | null): string {
  if (!rows) return emptyState("Activity is unavailable right now.");
  const s = signalSeries(rows, SPARK_W, SPARK_H);
  const dB = (n: number): string => `${Math.round(n)}`.replace("-", "−");
  const spark = s.samples
    ? `<svg class="kc-spark" viewBox="0 0 ${SPARK_W} ${SPARK_H}" preserveAspectRatio="none" role="img" aria-label="Signal strength per transmission, ${dB(s.min)} to ${dB(s.max)} dB"><polyline points="${s.points}"/></svg>`
    : emptyState("Signal strength appears after new transmissions close.");
  const list = s.active.slice(0, DETAIL_TX_COUNT).map((r) => `<div class="kc-row">`
    + `<span>${esc(new Date(r.ts).toLocaleTimeString())}</span>`
    + `<span>${r.durationMs === null ? "Open" : `${(r.durationMs / 1000).toFixed(1)} s`}</span>`
    + `<span>${r.rfDb === null ? "—" : `${r.rfDb.toFixed(1)} dB`}</span></div>`).join("");
  return `<p class="kc-empty">${s.active.length} transmission${s.active.length === 1 ? "" : "s"} · ${airtime(s.airtimeMs)} airtime</p>${spark}${list}`;
}

// ── Wiring ───────────────────────────────────────────────────────────────────

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
/** Text fields that commit on `change` — flushed if the sheet closes first. */
const FLUSH_FIELDS = ["name", "freq", "tags", "site"] as const;
const SWITCHES: Record<string, string> = { kcDtAudible: "audible", kcDtPriority: "priority", kcDtAlert: "alert", kcDtArchive: "archive" };

export function mountDetail(lib: LibCtx, host: HTMLElement): {
  show(d: Detail, o: { fromList: boolean }): void; hide(): void; paint(): void; isOpen(): boolean;
} {
  // The LCD already names the channel: the heading stays for assistive tech
  // only, and the header keeps just the close button.
  const sheet = mountSheet(host, { id: "kcDetail", label: "Channel", titleHidden: true });
  const body = sheet.body;
  const q = <T extends HTMLElement>(sel: string): T | null => body.querySelector<T>(sel);

  let detail: Detail | null = null;
  /** What's rendered: "loading", "gone", "add", or "edit:<channel id>". Only
   *  a change of this rebuilds the body; otherwise paint() patches in place. */
  let shownKey = "";
  let shown: Channel | null = null;
  let adding: { draft: ChannelDraft; from?: Discovery } | null = null;
  const dirty = new Set<string>();
  /** The raw text each field last sent (commit), so a close-time flush never
   *  re-sends what `change` already committed. */
  const lastSent = new Map<string, string>();
  /** Saves in flight per field (a field can have a second save queued). */
  const inflight = new Map<string, number>();
  const busy = (f: string): boolean => (inflight.get(f) ?? 0) > 0;
  const bump = (f: string, by: 1 | -1): void => {
    const n = (inflight.get(f) ?? 0) + by;
    if (n > 0) inflight.set(f, n); else inflight.delete(f);
  };
  let analyticsFreq: number | null = null;
  let statusTimer: ReturnType<typeof setTimeout> | undefined;
  let modeTouched = false;
  /** A channel we just added: not in the data until the next poll lands. */
  let justAdded: string | null = null;

  // Close navigation. The rule: `openedFromList` is taken from the FIRST
  // show() of an open session; later show()s (tapping another row while the
  // desktop pane is open) swap the content but keep it. On close, history.back()
  // only when the session came from the list AND showed exactly one detail —
  // then the entry below is the list. With more than one detail pushed, back()
  // would land on the previous detail, so replace the entry with the list
  // instead (as for a detail reached from outside the Library: a deep link or
  // Radio's "Recently heard"). Our own location.replace() (after Add) doesn't
  // push an entry, so it doesn't count as another detail.
  let openedFromList = false;
  let detailsShown = 0;
  let selfReplace = false;
  let routeClosing = false;

  function closeNav(): void {
    if (openedFromList && detailsShown === 1) history.back();
    else location.replace(lib.listHref());
  }
  sheet.onClose(() => {
    // Re-shown before this (async) close event landed: nothing to close.
    if (sheet.isOpen()) { routeClosing = false; return; }
    const byRoute = routeClosing;
    routeClosing = false;
    const wasOpen = detail !== null;
    flushTyped();
    detail = null; shownKey = ""; shown = null; adding = null; analyticsFreq = null;
    dirty.clear(); inflight.clear(); lastSent.clear();
    if (!byRoute && wasOpen) closeNav();
    openedFromList = false; detailsShown = 0; selfReplace = false;
  });

  /** Edit mode only: text typed into a field but never committed (the sheet
   *  closed by Back or Esc before `change` fired) still saves, through the
   *  same path as `change`. commit() captures `shown` before its first await,
   *  so clearing it right after is safe. An invalid value is skipped (nothing
   *  sent); a value `change` already sent is not sent twice. */
  function flushTyped(): void {
    const c = shown;
    if (!c) return;
    for (const f of FLUSH_FIELDS) {
      if (!dirty.has(f)) continue;
      const el = q<HTMLInputElement>(`#${idFor(f)}`);
      if (!el) continue;
      const v = el.value;
      const was = f === "freq" ? fmtFreq(c.freq) : DETAIL_FIELDS[f]!(c);
      if (v === was || lastSent.get(f) === v) continue;
      void commit(f, v);
    }
  }

  // ── status + field errors
  function status(text: string, o: { fade?: boolean } = {}): void {
    const st = q("#kcDtStatus");
    if (!st) return;
    if (statusTimer !== undefined) { clearTimeout(statusTimer); statusTimer = undefined; }
    st.textContent = text;
    if (o.fade) statusTimer = setTimeout(() => { statusTimer = undefined; st.textContent = ""; }, SAVED_SHOW_MS);
  }
  function fieldErr(id: string, text: string | null): void {
    const inp = q(`#${id}`);
    const slot = q(`#${id}-err`);
    if (text === null) { inp?.removeAttribute("aria-invalid"); if (slot) { slot.hidden = true; slot.textContent = ""; } return; }
    inp?.setAttribute("aria-invalid", "true");
    if (slot) { slot.textContent = text; slot.hidden = false; }
  }
  const idFor = (f: string): string => `kcDt${f[0]!.toUpperCase()}${f.slice(1)}`;

  // ── render / patch
  function render(r: Resolved | null): void {
    clearTimeout(statusTimer);
    dirty.clear(); inflight.clear(); lastSent.clear(); modeTouched = false;
    shown = null; adding = null; analyticsFreq = null;
    if (!r) {
      shownKey = "loading"; sheet.setTitle("Channel");
      body.innerHTML = `<div class="kc-detail"><p class="kc-empty" id="kcDtLoad"></p></div>`;
      paintLoading();
      return;
    }
    if (r.kind === "gone") {
      shownKey = "gone"; sheet.setTitle("Channel");
      body.innerHTML = `<div class="kc-detail">${emptyState(r.message)}<div class="kc-keys">${key({ id: "kcDtClose", label: "Close", wide: true })}</div></div>`;
      q("#kcDtClose")!.addEventListener("click", () => sheet.close());
      return;
    }
    if (r.kind === "add") {
      shownKey = "add"; adding = { draft: r.draft, ...(r.from ? { from: r.from } : {}) };
      sheet.setTitle("New channel");
      body.innerHTML = addHtml(r.draft, r.from);
      wireAdd();
      return;
    }
    const c = r.channel;
    shownKey = `edit:${c.id}`; shown = c; analyticsFreq = c.freq;
    if (c.id === justAdded) justAdded = null;
    sheet.setTitle(channelName(c));
    body.innerHTML = editHtml(c, lib.store.data?.cfg.banks ?? []);
    wireEdit();
    // Pin a frequency route to the channel it found, so editing the frequency
    // (or another client moving it) can't re-resolve the pane to another row.
    // A self-replace: it swaps the history entry, so it isn't another detail.
    if (detail?.kind === "hz") {
      detail = { kind: "ch", id: c.id };
      selfReplace = true;
      location.replace(hrefFor({ tab: "library", detail }));
    }
  }

  function paintLoading(): void {
    const p = q("#kcDtLoad");
    const err = lib.store.loadError;
    if (p) p.textContent = err ? `The library couldn't load: ${err}` : "Loading…";
  }

  /** Rewrite a read-only block only when its markup changes (keeps focus on
   *  a chip or tone button across polls). */
  const painted = new WeakMap<Element, string>();
  function setHtml(el: HTMLElement | null, html: string): void {
    if (!el || painted.get(el) === html) return;
    painted.set(el, html);
    el.innerHTML = html;
  }

  /** Repaint what the operator can't edit, and the untouched fields that changed. */
  function patchEdit(fresh: Channel): void {
    const prev = shown!;
    const active = document.activeElement;
    const focused = active instanceof HTMLElement && body.contains(active) ? active.closest<HTMLElement>("[data-field]")?.dataset.field ?? null : null;
    for (const f of detailFieldsToPatch(prev, fresh, { focused, dirty, inflight: new Set(inflight.keys()) })) {
      const el = q<HTMLInputElement | HTMLSelectElement>(`#${idFor(f)}`);
      if (!el) continue;
      if (el instanceof HTMLInputElement && el.type === "checkbox") el.checked = DETAIL_FIELDS[f]!(fresh) === "true";
      else el.value = f === "freq" ? fmtFreq(fresh.freq) : DETAIL_FIELDS[f]!(fresh);
    }
    shown = fresh;
    const archived = !fresh.enabled;
    for (const id of ["kcDtPriority", "kcDtAlert"]) { const s = q<HTMLInputElement>(`#${id}`); if (s) s.disabled = archived; }
    sheet.setTitle(channelName(fresh));
    setHtml(q("#kcDtLcd"), lcdHtml(fresh, channelName(fresh)));
    if (!busy("banks")) {
      // Re-rendered chips drop focus: put it back on the same bank's chip.
      const chipId = active instanceof HTMLElement && active.closest("#kcDtBanks") ? active.dataset.chip ?? null : null;
      setHtml(q("#kcDtBanks"), banksHtml(fresh, lib.store.data?.cfg.banks ?? []));
      if (chipId !== null && document.activeElement !== active) q(`#kcDtBanks [data-chip="${CSS.escape(chipId)}"]`)?.focus();
    }
    setHtml(q("#kcDtFacts"), factsHtml(fresh));
    setHtml(q("#kcDtHeard"), toneHeard(fresh));
    if (analyticsFreq !== fresh.freq) { analyticsFreq = fresh.freq; q("#kcDtStats")!.innerHTML = emptyState("Loading activity…"); lib.refresh("analytics"); }
  }

  function paint(): void {
    const data = lib.store.data;
    if (!data) { if (shownKey === "loading") paintLoading(); return; }
    // Add mode keeps its half-typed form until the route changes.
    if (!detail || shownKey === "add") return;
    const r = resolveDetail(detail, data);
    if (r.kind === "gone" && detail.kind === "ch" && detail.id === justAdded) { if (shownKey !== "loading") render(null); return; }
    const k = r.kind === "edit" ? `edit:${r.channel.id}` : r.kind;
    if (k !== shownKey) { render(r); return; }
    if (r.kind === "edit") patchEdit(r.channel);
  }

  // ── edit-mode saving
  /** One channel PUT. `sent` is the raw text a text/select field committed:
   *  the field stops being dirty only if it still holds that text (the
   *  operator may have typed on while this saved). A failure keeps a typed
   *  value (and its dirty flag) with the error; a switch reverts. */
  async function save(f: string, patch: Parameters<typeof api.updateChannel>[1], o: { revert?: () => void; sent?: string } = {}): Promise<boolean> {
    const c = shown;
    if (!c) return false;
    bump(f, 1);
    status("Saving…");
    let updated: Channel;
    try {
      updated = await lib.run(() => api.updateChannel(c.id, patch));
    } catch (e) {
      bump(f, -1);
      // Closed (or moved on) meanwhile — e.g. a close-time flush: say so.
      if (shown?.id !== c.id) { lib.dialogs.toast(`Couldn't save ${channelName(c)}: ${msg(e)}`); return false; }
      o.revert?.();
      if (q(`#${idFor(f)}-err`)) { fieldErr(idFor(f), msg(e)); status(""); } else status(`Couldn't save: ${msg(e)}`);
      return false;
    }
    bump(f, -1);
    // Our copy of the list, too: a paint() before the next good poll (say
    // the refresh fails) must not repaint the pre-save value.
    const d = lib.store.data;
    if (d) d.channels = d.channels.map((x) => (x.id === updated.id ? updated : x));
    if (shown?.id === c.id) {
      const el = q<HTMLInputElement | HTMLSelectElement>(`#${idFor(f)}`);
      if (o.sent === undefined || el?.value === o.sent) dirty.delete(f);
      if (!busy(f)) fieldErr(idFor(f), null);
      status("Saved", { fade: true });
      if (updated.id === c.id) patchEdit(updated); // adopt the server's copy
    }
    return true;
  }

  // Delegated once (the sheet body outlives every render): heard-tone picks
  // and bank chips, both edit mode only.
  body.addEventListener("click", (ev) => {
    if (!shown) return;
    const t = ev.target instanceof Element ? ev.target : null;
    const tone = t?.closest<HTMLButtonElement>("[data-tone]");
    if (tone) { const sel = q<HTMLSelectElement>("#kcDtTone")!; sel.value = tone.dataset.tone ?? ""; void commit("tone", sel.value); return; }
    const bank = t?.closest<HTMLButtonElement>("#kcDtBanks [data-chip]");
    if (bank && bank.getAttribute("aria-disabled") !== "true" && !busy("banks")) {
      const tog = bankToggles(shown, lib.store.data?.cfg.banks ?? []).find((b) => b.id === bank.dataset.chip);
      if (tog?.next) void save("banks", { tags: tog.next });
    }
  });

  function wireEdit(): void {
    const c0 = shown!;
    for (const [id, f] of Object.entries(SWITCHES)) {
      const sw = q<HTMLInputElement>(`#${id}`)!;
      sw.addEventListener("change", () => {
        const on = sw.checked;
        const patch = f === "archive" ? { enabled: !on } : f === "audible" ? { audible: on } : f === "priority" ? { priority: on } : { alert: on };
        void save(f, patch, { revert: () => { sw.checked = !on; } });
      });
    }
    // Text + select fields: dirty from the first keystroke; commit on change.
    body.querySelectorAll<HTMLInputElement | HTMLSelectElement>("[data-field]").forEach((el) => {
      const f = el.dataset.field!;
      el.addEventListener("input", () => { dirty.add(f); fieldErr(el.id, null); });
      el.addEventListener("change", () => { void commit(f, el.value); });
    });
    q("#kcDtListen")!.addEventListener("click", async () => {
      const c = shown ?? c0;
      try { await lib.run(() => api.monitor(c.freq, channelName(c))); lib.dialogs.toast(`Listening on ${channelName(c)}`); }
      catch (e) { status(`Couldn't listen: ${msg(e)}`); }
    });
    q("#kcDtLock")!.addEventListener("click", async () => {
      const c = shown ?? c0;
      if (await lockout(lib, c.freq, channelName(c))) sheet.close();
    });
    const more = q<HTMLDetailsElement>("#kcDtMore")!;
    more.addEventListener("toggle", () => { if (more.open) lib.refresh("analytics"); });
  }

  async function commit(f: string, v: string): Promise<void> {
    const c = shown;
    if (!c) return;
    let patch: Parameters<typeof api.updateChannel>[1];
    try {
      switch (f) {
        case "name": patch = { alphaTag: v.trim() }; break;
        case "mode": patch = { mode: v as Channel["mode"] }; break;
        case "freq": patch = { freq: parseMhz(v) }; break;
        case "tone": patch = toneFromValue(v); break;
        case "tags": patch = { tags: parseTags(v) }; break;
        case "site": { const loc = siteLocation(c.location, parseSite(v)); patch = loc ? { location: loc } : {}; break; }
        default: return;
      }
    } catch (e) { fieldErr(idFor(f), msg(e)); return; } // invalid: nothing sent, value (and dirty) kept
    if (!Object.keys(patch).length) { dirty.delete(f); return; }
    lastSent.set(f, v);
    await save(f, patch, { sent: v });
  }

  // ── add mode
  function wireAdd(): void {
    const val = (id: string): string => q<HTMLInputElement | HTMLSelectElement>(`#${id}`)!.value;
    body.querySelectorAll<HTMLInputElement>("input[data-field]").forEach((el) => el.addEventListener("input", () => fieldErr(el.id, null)));
    const mode = q<HTMLSelectElement>("#kcDtMode")!;
    mode.addEventListener("change", () => { modeTouched = true; });
    // Until the operator picks a mode, it follows the band (airband → AM).
    q<HTMLInputElement>("#kcDtFreq")!.addEventListener("change", () => {
      try { if (!modeTouched) mode.value = defaultMode(parseMhz(val("kcDtFreq"))); } catch { /* shown on Add */ }
    });
    const btn = q<HTMLButtonElement>("#kcDtAdd")!;
    btn.addEventListener("click", async () => {
      const a = adding;
      if (!a) return;
      let freq: number;
      try { freq = parseMhz(val("kcDtFreq")); } catch (e) { fieldErr("kcDtFreq", msg(e)); q("#kcDtFreq")!.focus(); return; }
      const alphaTag = val("kcDtName").trim();
      const name = channelName({ alphaTag, freq });
      const payload = newChannelBody({
        ...a.draft, freq, alphaTag, mode: val("kcDtMode") as Channel["mode"],
        audible: q<HTMLInputElement>("#kcDtAudible")!.checked, tags: parseTags(val("kcDtTags")),
      });
      const from = a.from;
      const out: { id?: string } = {};
      btn.disabled = true;
      status("Adding…");
      try {
        await lib.run(async () => {
          const created = await api.addChannel(payload);
          out.id = created.id;
          if (from) {
            const cfg = await api.getConfig();
            cfg.discoveries = (cfg.discoveries ?? []).filter((x) => x.id !== from.id);
            await api.putConfig(cfg);
          }
        });
        lib.dialogs.toast(`Added ${name}.`);
      } catch (e) {
        if (!out.id) {
          btn.disabled = false;
          // A 409 collision ("frequency already used by …") belongs under
          // Frequency; anything else is not the frequency's fault.
          if (/^frequency already used by /.test(msg(e))) { status(""); fieldErr("kcDtFreq", msg(e)); }
          else status(`Couldn't add the channel: ${msg(e)}`);
          return;
        }
        lib.dialogs.toast(`Added ${name}; the discovery is still listed in New.`);
      }
      const id = out.id;
      if (!id) return;
      justAdded = id;
      selfReplace = true;
      location.replace(hrefFor({ tab: "library", detail: { kind: "ch", id } }));
    });
  }

  // ── analytics (registered once; runs only while More details is open)
  lib.poller.add({
    name: "analytics", everyMs: POLL_MS.analytics, tabs: ["library"],
    when: () => analyticsFreq !== null && !!q<HTMLDetailsElement>("#kcDtMore")?.open,
    run: async () => {
      const f = analyticsFreq!;
      const rows = await api.getHistory<HistRow[]>({ freq: f, since: Date.now() - DAY_MS, limit: 1000 }).catch(() => null);
      if (f !== analyticsFreq) return;
      const host = q("#kcDtStats");
      if (host) host.innerHTML = analyticsHtml(rows);
    },
  });

  return {
    show(d, o) {
      // Consumed first: render() below may raise it again (the hz → ch pin).
      const replaced = selfReplace;
      selfReplace = false;
      routeClosing = false;
      const first = detail === null; // session state resets on close
      if (first) { openedFromList = o.fromList; detailsShown = 0; }
      const same = !first && JSON.stringify(detail) === JSON.stringify(d);
      if (!same) {
        if (!replaced) detailsShown++;
        detail = d;
        const data = lib.store.data;
        const r = data ? resolveDetail(d, data) : null;
        render(r?.kind === "gone" && d.kind === "ch" && d.id === justAdded ? null : r);
      }
      sheet.open({ title: shown ? channelName(shown) : adding ? "New channel" : "Channel", pane: true });
    },
    hide() {
      if (!sheet.isOpen()) { detail = null; return; }
      routeClosing = true;
      sheet.close();
    },
    paint,
    isOpen: () => sheet.isOpen(),
  };
}
