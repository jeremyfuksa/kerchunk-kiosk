// Library · Channels: search, bank chips, suggestions strip, the list. The
// list is rebuilt only when what it shows changes (a string compare), and
// focus is put back on the same row control after a rebuild — polls every
// 15 s must not steal focus or swallow a tap.
import type { Channel } from "../../backend/config/schema.js";
import { api } from "../lib/api.js";
import { esc } from "../lib/format.js";
import { colorFor } from "../lib/serviceColor.js";
import { hrefFor } from "./route.js";
import { chip, emptyState } from "./ui/kit.js";
import { ico } from "./ui/icons.js";
import {
  CHIP_ALL, channelName, chipsFor, rowMeta, suggestionSummary, validChip, visibleChannels,
} from "./libraryModel.js";
import type { LibCtx } from "./libraryStore.js";

export function mountChannels(lib: LibCtx, host: HTMLElement, o: { openBanks(): void; openSuggestions(): void }): {
  paint(): void; setSelected(id: string | null): void;
} {
  host.innerHTML = `
    <label class="kc-visuallyHidden" for="kcLibSearch">Search channels</label>
    <input id="kcLibSearch" class="kc-search" type="search" autocomplete="off" placeholder="Search name, frequency or tag  ( / )" />
    <div class="kc-chips" id="kcLibChips" role="group" aria-label="Filter by bank"></div>
    <div id="kcLibSugg"></div>
    <p class="kc-count" id="kcLibCount" aria-live="polite"></p>
    <div class="kc-list--ch" id="kcLibRows"></div>`;
  const $ = <T extends HTMLElement>(s: string): T => host.querySelector<T>(s)!;
  const search = $<HTMLInputElement>("#kcLibSearch");
  const chipsEl = $("#kcLibChips");
  const suggEl = $("#kcLibSugg");
  const countEl = $("#kcLibCount");
  const rows = $("#kcLibRows");

  let chipSel = CHIP_ALL;
  let query = "";
  let selected: string | null = null;
  /** Rows whose speaker save is in flight: never repainted from a poll. */
  const pending = new Map<string, boolean>();
  let chipsShown = "", rowsShown = "", suggShown = "";

  search.addEventListener("input", () => { query = search.value; paint(); });

  chipsEl.addEventListener("click", (ev) => {
    const b = (ev.target as HTMLElement).closest<HTMLButtonElement>(".kc-chip");
    if (!b) return;
    if (b.dataset.chip === "manage") { o.openBanks(); return; }
    chipSel = b.dataset.chip ?? CHIP_ALL;
    paint();
  });

  suggEl.addEventListener("click", (ev) => {
    if ((ev.target as HTMLElement).closest("#kcLibReview")) o.openSuggestions();
  });

  rows.addEventListener("click", (ev) => {
    const b = (ev.target as HTMLElement).closest<HTMLButtonElement>(".kc-spk");
    if (!b || b.disabled) return;
    const id = b.dataset.id!;
    const next = b.getAttribute("aria-pressed") !== "true";
    pending.set(id, next);
    paintSpeaker(b, next, true);
    lib.run(() => api.updateChannel(id, { audible: next }))
      .then(() => { pending.delete(id); })
      .catch((e: unknown) => {
        pending.delete(id);
        paintSpeaker(b, !next, false);
        lib.dialogs.toast(`Couldn't change the speaker: ${e instanceof Error ? e.message : String(e)}`);
      });
  });

  function paintSpeaker(b: HTMLButtonElement, on: boolean, busy: boolean): void {
    b.setAttribute("aria-pressed", String(on));
    b.disabled = busy;
    b.innerHTML = ico(on ? "speaker" : "speakerOff");
  }

  function rowHtml(c: Channel): string {
    const name = channelName(c);
    const audible = pending.get(c.id) ?? c.audible !== false;
    const busy = pending.has(c.id);
    return `<div class="kc-lrow" data-id="${esc(c.id)}"${c.id === selected ? ' aria-current="true"' : ""}>
      <a class="kc-lrow__open" href="${hrefFor({ tab: "library", detail: { kind: "ch", id: c.id } })}">
        <i class="kc-dot" style="background:${colorFor(c.freq, "active", c.tags)}" aria-hidden="true"></i>
        <span class="kc-lrow__text"><span class="kc-lrow__name">${esc(name)}</span><span class="kc-lrow__meta">${esc(rowMeta(c))}</span></span>
      </a>
      ${c.enabled ? `<button type="button" class="kc-spk" data-id="${esc(c.id)}" aria-pressed="${audible}"${busy ? " disabled" : ""}
        aria-label="Play ${esc(name)} through the speaker">${ico(audible ? "speaker" : "speakerOff")}</button>` : ""}
    </div>`;
  }

  function paint(): void {
    const d = lib.store.data;
    if (!d) {
      if (lib.store.loadError && !rows.childElementCount) rows.innerHTML = emptyState(`The library couldn't load: ${lib.store.loadError}`);
      return;
    }
    const banks = d.cfg.banks ?? [];
    const chips = chipsFor(d.channels, banks);
    chipSel = validChip(chipSel, chips);
    const chipsHtml = chips.map((c) => chip({ id: c.id, label: c.label, count: c.count, pressed: c.id === chipSel })).join("")
      + chip({ id: "manage", label: "Manage banks", dashed: true });
    if (chipsHtml !== chipsShown) { chipsShown = chipsHtml; chipsEl.innerHTML = chipsHtml; }

    const summary = suggestionSummary(lib.store.dups, lib.store.recs);
    const suggHtml = summary
      ? `<div class="kc-sugg"><span>${esc(summary)}</span><button type="button" class="kc-link" id="kcLibReview">Review</button></div>` : "";
    if (suggHtml !== suggShown) { suggShown = suggHtml; suggEl.innerHTML = suggHtml; }

    const visible = visibleChannels(d.channels, banks, { chip: chipSel, query });
    const total = chips.find((c) => c.id === chipSel)?.count ?? visible.length;
    const count = query.trim() ? `${visible.length} of ${total}` : "";
    if (countEl.textContent !== count) countEl.textContent = count;

    const html = visible.length
      ? visible.map(rowHtml).join("")
      : emptyState(query.trim() ? `No channel matches “${query.trim()}”.` : d.channels.length ? "Nothing here." : "No channels yet. Use Add channel to create one.");
    if (html === rowsShown) return;
    // Put focus back where it was after the rebuild (same row, same control).
    const active = document.activeElement as HTMLElement | null;
    const focusRow = active && rows.contains(active) ? active.closest<HTMLElement>(".kc-lrow")?.dataset.id : undefined;
    const focusSpk = active?.classList.contains("kc-spk") ?? false;
    rowsShown = html;
    rows.innerHTML = html;
    if (focusRow) {
      const row = rows.querySelector<HTMLElement>(`.kc-lrow[data-id="${CSS.escape(focusRow)}"]`);
      row?.querySelector<HTMLElement>(focusSpk ? ".kc-spk" : ".kc-lrow__open")?.focus();
    }
  }

  return {
    paint,
    setSelected(id) { if (selected !== id) { selected = id; rowsShown = ""; paint(); } },
  };
}
