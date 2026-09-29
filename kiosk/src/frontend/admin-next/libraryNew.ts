// Library · New: Close Call discoveries to triage, as cards — frequency, hits,
// the best guess at what it is, the recorded sample inline, and Add / Dismiss
// / Lock out. Select mode swaps the per-card keys for checkboxes and a sticky
// bulk bar. Suppressed-as-noise discoveries sit behind a footer link, in a
// sheet, each with Restore.
//
// Paint discipline (polls every 15 s, the player notifies ~4 Hz):
//   - the cards are rebuilt only when their markup string changes, and that
//     string leaves out play state and checkbox state — both are patched in
//     place (paintPlay / paintChecks) after a rebuild and on every change;
//   - focus goes back to the same card's same control after a rebuild (or the
//     card now at that position, when the focused one was removed);
//   - a player notify never rebuilds anything: paintPlay only.
// Every write is inside lib.run (removeDiscoveries, Restore).
import { api } from "../lib/api.js";
import { esc, fmtFreq } from "../lib/format.js";
import { hrefFor, type Route } from "./route.js";
import { emptyState, key } from "./ui/kit.js";
import { ico } from "./ui/icons.js";
import { mountSheet } from "./ui/sheet.js";
import {
  discoveryNote, guessLine, hitsText, pendingDiscoveries, restoreDiscovery, suppressedDiscoveries,
  type Discovery,
} from "./libraryModel.js";
import { removeDiscoveries } from "./libraryActions.js";
import type { LibCtx, SampleMeta } from "./libraryStore.js";
import { SamplePlayer } from "./samples.js";

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const mhz = (hz: number): string => `${fmtFreq(hz)} MHz`;
const idleLabel = (s: SampleMeta): string => `Play the recorded sample, ${s.seconds.toFixed(1)} seconds`;

/** Which control inside a card had focus, as a selector that finds the same
 *  control in the rebuilt card. */
function controlSel(el: HTMLElement): string | null {
  const act = el.dataset.act;
  if (act) return `[data-act="${act}"]`;
  if (el.matches(".kc-play")) return ".kc-play";
  if (el.matches(".kc-card__sel input")) return ".kc-card__sel input";
  if (el.matches("a.kc-key")) return "a.kc-key";
  return null;
}

export function mountNew(lib: LibCtx, host: HTMLElement): { paint(): void } {
  host.innerHTML = `
    <div class="kc-newHead" id="kcNewHead" hidden>
      <p class="kc-count" id="kcNewCount" aria-live="polite"></p>
      <button type="button" class="kc-link" id="kcNewSelect" aria-pressed="false" hidden>Select</button>
    </div>
    <div id="kcNewCards"></div>
    <div class="kc-bulkBar" id="kcNewBulk" hidden>
      <span id="kcNewBulkCount" aria-live="polite">0 selected</span>
      <span class="kc-bulkBar__keys">
        ${key({ id: "kcNewBulkDismiss", label: "Dismiss", disabled: true })}
        ${key({ id: "kcNewBulkLock", label: "Lock out", variant: "danger", disabled: true })}
      </span>
    </div>
    <div class="kc-lib__foot"><button type="button" class="kc-link" id="kcNewSupp" hidden></button></div>`;
  const $ = <T extends HTMLElement>(s: string): T => host.querySelector<T>(s)!;
  const head = $("#kcNewHead");
  const countEl = $("#kcNewCount");
  const selectBtn = $<HTMLButtonElement>("#kcNewSelect");
  const cards = $("#kcNewCards");
  const bulkBar = $("#kcNewBulk");
  const bulkCount = $("#kcNewBulkCount");
  const bulkDismiss = $<HTMLButtonElement>("#kcNewBulkDismiss");
  const bulkLock = $<HTMLButtonElement>("#kcNewBulkLock");
  const suppBtn = $<HTMLButtonElement>("#kcNewSupp");

  const player = new SamplePlayer();
  const sheet = mountSheet(host, { id: "kcSuppSheet", label: "Suppressed as likely noise" });

  let selecting = false;
  const selected = new Set<string>();
  /** Discoveries with a single-card write in flight: further taps ignored. */
  const busy = new Set<string>();
  let cardsShown = "", suppShown = "";

  // ── Cards ────────────────────────────────────────────────────────────────

  function cardHtml(d: Discovery, s: SampleMeta | undefined, home: { lat: number; lon: number } | undefined): string {
    const id = esc(d.id);
    const f = mhz(d.freq);
    const note = discoveryNote(d);
    const freq = `<span class="kc-card__freq">${f}</span>`;
    const top = selecting
      ? `<label class="kc-card__sel"><input type="checkbox" data-sel="${id}" aria-label="Select ${f}" />${freq}</label>`
      : freq;
    const sample = s
      ? `<div class="kc-card__sample">
          <button type="button" class="kc-play" data-play="${id}" data-idle="${esc(idleLabel(s))}" aria-label="${esc(idleLabel(s))}">${ico("play")}</button>
          <span>Recorded sample</span>
          <span data-left="${id}" data-full="${s.seconds}">${s.seconds.toFixed(1)} s</span>
        </div>` : "";
    const acts = selecting ? "" : `<div class="kc-card__acts">
        <a class="kc-key kc-key--primary" href="${hrefFor({ tab: "library", detail: { kind: "add", from: d.id } })}" aria-label="Add channel: ${f}"><span>Add channel</span></a>
        <button type="button" class="kc-key" data-act="dismiss" aria-label="Dismiss ${f}"><span>Dismiss</span></button>
        <button type="button" class="kc-key kc-key--danger" data-act="lockout" aria-label="Lock out ${f}"><span>Lock out</span></button>
      </div>`;
    return `<article class="kc-card" data-id="${id}" aria-label="${f}">
      <div class="kc-card__top">${top}<span class="kc-card__hits">${esc(hitsText(d))}</span></div>
      <p class="kc-card__guess">${esc(guessLine(d, home))}</p>
      ${note ? `<p class="kc-card__note">${esc(note)}</p>` : ""}
      ${sample}
      ${acts}
    </article>`;
  }

  function paintPlay(): void {
    const playing = player.playingId;
    for (const b of cards.querySelectorAll<HTMLButtonElement>("[data-play]")) {
      const on = b.dataset.play === playing;
      const face = on ? "stop" : "play";
      if (b.dataset.face !== face) { b.dataset.face = face; b.innerHTML = ico(face); }
      b.toggleAttribute("data-playing", on);
      const label = on ? "Stop the recorded sample" : b.dataset.idle ?? "Play the recorded sample";
      if (b.getAttribute("aria-label") !== label) b.setAttribute("aria-label", label);
    }
    for (const el of cards.querySelectorAll<HTMLElement>("[data-left]")) {
      const full = Number(el.dataset.full);
      const left = el.dataset.left === playing ? player.remaining(full) : null;
      const t = `${(left ?? full).toFixed(1)} s`;
      if (el.textContent !== t) el.textContent = t;
    }
  }
  player.subscribe(paintPlay);

  function paintChecks(): void {
    for (const cb of cards.querySelectorAll<HTMLInputElement>("[data-sel]")) cb.checked = selected.has(cb.dataset.sel!);
  }

  function paintBulk(): void {
    bulkBar.hidden = !selecting;
    const n = selected.size;
    const t = `${n} selected`;
    if (bulkCount.textContent !== t) bulkCount.textContent = t;
    bulkDismiss.disabled = n === 0;
    bulkLock.disabled = n === 0;
    selectBtn.textContent = selecting ? "Done" : "Select";
    selectBtn.setAttribute("aria-pressed", String(selecting));
  }

  function paint(): void {
    const d = lib.store.data;
    if (!d) {
      if (lib.store.loadError && !cards.childElementCount) cards.innerHTML = emptyState(`New discoveries couldn't load: ${lib.store.loadError}`);
      return;
    }
    const pending = pendingDiscoveries(d.cfg);
    const ids = new Set(pending.map((x) => x.id));
    for (const id of selected) if (!ids.has(id)) selected.delete(id);
    if (!pending.length && selecting) selecting = false;
    // A clip whose card is gone (dismissed, or its sample dropped) stops.
    if (player.playingId && !(ids.has(player.playingId) && d.samples[player.playingId])) player.stop();

    const count = pending.length ? `${pending.length} to review` : "";
    if (countEl.textContent !== count) countEl.textContent = count;
    selectBtn.hidden = pending.length === 0;
    head.hidden = pending.length === 0;
    paintBulk();

    const disp = d.cfg.display;
    const home = disp && disp.weatherLat != null && disp.weatherLon != null ? { lat: disp.weatherLat, lon: disp.weatherLon } : undefined;
    const html = pending.length
      ? `<div class="kc-cards">${pending.map((x) => cardHtml(x, d.samples[x.id], home)).join("")}</div>`
      : d.cfg.scan.closeCall === false
        ? `<p class="kc-empty">Close Call is off, so nothing new will arrive. <a href="${hrefFor({ tab: "tune" })}">Turn it on in Tune</a></p>`
        : emptyState("Nothing new. Close Call is listening — new frequencies land here.");
    if (html !== cardsShown) {
      const active = document.activeElement as HTMLElement | null;
      const card = active && cards.contains(active) ? active.closest<HTMLElement>(".kc-card") : null;
      const focusId = card?.dataset.id;
      const focusSel = active && card ? controlSel(active) : null;
      const focusIdx = card ? [...cards.querySelectorAll(".kc-card")].indexOf(card) : -1;
      cardsShown = html;
      cards.innerHTML = html;
      if (focusId) {
        const all = [...cards.querySelectorAll<HTMLElement>(".kc-card")];
        const same = all.find((c) => c.dataset.id === focusId) ?? all[Math.min(focusIdx, all.length - 1)];
        const target = (focusSel ? same?.querySelector<HTMLElement>(focusSel) : null)
          ?? same?.querySelector<HTMLElement>("a.kc-key, .kc-card__sel input")
          ?? (selectBtn.hidden ? null : selectBtn)
          ?? cards.querySelector<HTMLElement>(".kc-empty a");
        target?.focus();
      }
    }
    paintChecks();
    paintPlay();

    const nSupp = suppressedDiscoveries(d.cfg).length;
    suppBtn.hidden = nSupp === 0;
    const suppText = `Suppressed as likely noise (${nSupp})`;
    if (suppBtn.textContent !== suppText) suppBtn.textContent = suppText;
    if (sheet.isOpen()) renderSupp();
  }

  async function single(id: string, lockout: boolean): Promise<void> {
    if (busy.has(id)) return;
    busy.add(id);
    try {
      await removeDiscoveries(lib, new Set([id]), { lockout });
    } catch (e) {
      lib.dialogs.toast(`Couldn't ${lockout ? "lock out" : "dismiss"} it: ${msg(e)}`);
    } finally {
      busy.delete(id);
    }
  }

  cards.addEventListener("click", (ev) => {
    const t = ev.target as HTMLElement;
    const play = t.closest<HTMLButtonElement>("[data-play]");
    if (play) {
      const id = play.dataset.play!;
      player.toggle(id, lib.store.data?.samples[id]?.ts ?? 0);
      return;
    }
    const act = t.closest<HTMLButtonElement>("[data-act]");
    const id = act?.closest<HTMLElement>(".kc-card")?.dataset.id;
    if (!act || !id) return;
    void single(id, act.dataset.act === "lockout");
  });

  cards.addEventListener("change", (ev) => {
    const cb = (ev.target as HTMLElement).closest<HTMLInputElement>("[data-sel]");
    if (!cb) return;
    if (cb.checked) selected.add(cb.dataset.sel!); else selected.delete(cb.dataset.sel!);
    paintBulk();
  });

  function setSelecting(on: boolean): void {
    selecting = on;
    selected.clear();
    paint();
  }
  selectBtn.addEventListener("click", () => setSelecting(!selecting));

  let bulkBusy = false;
  async function bulk(lockout: boolean): Promise<void> {
    const n = selected.size;
    if (n === 0 || bulkBusy) return;
    const verb = lockout ? "Lock out" : "Dismiss";
    const ok = await lib.dialogs.confirm({
      title: `${verb} ${n} ${n === 1 ? "discovery" : "discoveries"}?`,
      message: lockout
        ? "These frequencies will be permanently prevented from triggering Close Call."
        : "Dismissed frequencies may be discovered again later.",
      confirmLabel: lockout ? "Lock out permanently" : "Dismiss",
      danger: lockout,
    });
    if (!ok) return;
    bulkBusy = true;
    try {
      await removeDiscoveries(lib, new Set(selected), { lockout });
      setSelecting(false);
      selectBtn.focus();
    } catch (e) {
      lib.dialogs.toast(`Couldn't ${lockout ? "lock them out" : "dismiss them"}: ${msg(e)}`);
    } finally {
      bulkBusy = false;
    }
  }
  bulkDismiss.addEventListener("click", () => void bulk(false));
  bulkLock.addEventListener("click", () => void bulk(true));

  // ── Suppressed sheet ─────────────────────────────────────────────────────

  function suppRowHtml(d: Discovery): string {
    const f = mhz(d.freq);
    const meta = `${d.suppressionReason ?? "Likely repeated noise"} · ${d.hitCount ?? "several"} hits`;
    return `<div class="kc-row kc-supp" data-id="${esc(d.id)}">
      <span class="kc-supp__text"><span><b>${f}</b> ${esc(d.alphaTag)}</span><small>${esc(meta)}</small></span>
      <button type="button" class="kc-key" data-restore="${esc(d.id)}" aria-label="Restore ${f} to New">Restore</button>
    </div>`;
  }

  function renderSupp(force = false): void {
    const d = lib.store.data;
    if (!d || !sheet.isOpen()) return;
    const list = suppressedDiscoveries(d.cfg);
    const html = list.length ? list.map(suppRowHtml).join("") : emptyState("Nothing is suppressed.");
    if (!force && html === suppShown) return;
    const active = document.activeElement as HTMLElement | null;
    const row = active && sheet.body.contains(active) ? active.closest<HTMLElement>(".kc-supp") : null;
    const idx = row ? [...sheet.body.querySelectorAll(".kc-supp")].indexOf(row) : -1;
    const focusId = row?.dataset.id;
    suppShown = html;
    sheet.body.innerHTML = html;
    if (row) {
      const rows = [...sheet.body.querySelectorAll<HTMLElement>(".kc-supp")];
      const same = rows.find((r) => r.dataset.id === focusId) ?? rows[Math.min(idx, rows.length - 1)];
      (same?.querySelector<HTMLElement>("[data-restore]") ?? sheet.body.closest("dialog")?.querySelector<HTMLElement>(".kc-sheet__close"))?.focus();
    }
  }

  const restoring = new Set<string>();
  sheet.body.addEventListener("click", (ev) => {
    const b = (ev.target as HTMLElement).closest<HTMLButtonElement>("[data-restore]");
    const id = b?.dataset.restore;
    if (!b || !id || restoring.has(id)) return;
    restoring.add(id);
    b.setAttribute("aria-disabled", "true");
    lib.run(async () => {
      const cfg = await api.getConfig();
      cfg.discoveries = (cfg.discoveries ?? []).map((d) => (d.id === id ? restoreDiscovery(d) : d));
      await api.putConfig(cfg);
    })
      .then(() => lib.dialogs.toast("Restored to New."))
      .catch((e: unknown) => lib.dialogs.toast(`Couldn't restore it: ${msg(e)}`))
      .finally(() => { restoring.delete(id); b.removeAttribute("aria-disabled"); });
  });

  suppBtn.addEventListener("click", () => {
    sheet.open({ title: "Suppressed as likely noise" });
    renderSupp(true);
  });

  // Leaving the New view (another tab, or Channels) stops the clip and closes
  // the sheet. A detail route over New (Add channel from a card) keeps both.
  lib.shell.onRoute((r: Route) => {
    if (r.tab === "library" && (r.detail || r.sub === "new")) return;
    player.stop();
    sheet.close();
  });

  return { paint };
}
