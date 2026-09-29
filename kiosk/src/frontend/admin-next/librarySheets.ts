// Library · Manage banks and Suggestions sheets. One sheet element serves
// both (mountSheet is called once); openBanks()/openSuggestions() retitle it
// and swap the body. Every write is inside lib.run (test/adminNext.lane.test.ts
// enforces it) — read-modify-write through getConfig/putConfig for bank
// edits, a single call for duplicate/discovery actions.
//
// The bank list re-renders on every store update while the sheet is open, but
// a profile form (or the create-a-bank form) that the operator is mid-typing
// in is left alone: the whole body is skipped while any field is dirty or
// focused, so a poll landing mid-edit can't overwrite what they typed. On a
// render that does happen, `<details>` open/closed state and DOM focus (by
// element id — every id here is a stable bank id, not a rebuilt list index)
// are restored.
import type { Bank, Channel } from "../../backend/config/schema.js";
import { matchesBank } from "../../backend/config/banks.js";
import { api, type ArchiveRec, type DuplicateSet } from "../lib/api.js";
import { esc, fmtFreq } from "../lib/format.js";
import {
  bankFromForm, bankRule, bulkPatch, channelName, profileFromForm, profileText, withProfile,
  type BankForm, type Profile, type ProfileForm,
} from "./libraryModel.js";
import type { LibCtx } from "./libraryStore.js";
import { emptyState, field, group, key } from "./ui/kit.js";
import { ico } from "./ui/icons.js";
import { mountSheet } from "./ui/sheet.js";
import { hrefFor } from "./route.js";

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const BAND_OPTS: ReadonlyArray<[string, string]> = [["", "Any"], ["hf", "HF"], ["vhf", "VHF"], ["uhf", "UHF"], ["shf", "SHF"]];

// ── Manage banks — pure markup ──────────────────────────────────────────────

function summaryLine(b: Bank, n: number): string {
  const bits = [bankRule(b), `${n} channel${n === 1 ? "" : "s"}`];
  const p = profileText(b);
  if (p) bits.push(p);
  return bits.join(" · ");
}

const numInput = (id: string, value: number | undefined, attrs: string): string =>
  `<input id="${id}" type="number" placeholder="global" value="${value !== undefined ? String(value) : ""}" ${attrs} />`;

function bankGroupHtml(b: Bank, channels: Channel[], expanded: ReadonlySet<string>): string {
  const n = channels.filter((c) => c.enabled && matchesBank(c, b)).length;
  const id = esc(b.id);
  const addHref = hrefFor({ tab: "library", detail: { kind: "add", ...(b.tags?.[0] ? { tag: b.tags[0] } : {}) } });
  return `<details class="kc-bank kc-disclosure" data-bank="${id}"${expanded.has(b.id) ? " open" : ""}>
    <summary>
      <span class="kc-bank__info"><b>${esc(b.name)}</b><span class="kc-bank__rule">${esc(summaryLine(b, n))}</span></span>
      ${ico("chevron", "kc-ico kc-disclosure__chev")}
    </summary>
    <div class="kc-formRow" data-bank-form="${id}">
      ${field({ id: `kcBank-${id}-open`, label: "Squelch open", hint: "dB over the noise floor", control: numInput(`kcBank-${id}-open`, b.openAboveFloorDb, 'min="1" step="0.5"') })}
      ${field({ id: `kcBank-${id}-hang`, label: "Hang time", hint: "ms", control: numInput(`kcBank-${id}-hang`, b.hangMs, 'min="100" step="100"') })}
      ${field({ id: `kcBank-${id}-dwell`, label: "Dwell weight", hint: "×, 2 = twice as long", control: numInput(`kcBank-${id}-dwell`, b.dwellWeight, 'min="0.1" step="0.1"') })}
      <div class="kc-keys">${key({ id: `kcBankSave-${id}`, label: "Save profile", wide: true })}</div>
      <p class="kc-detail__status" id="kcBank-${id}-status" role="status" aria-live="polite"></p>
    </div>
    <div class="kc-bank__acts">
      ${key({ id: `kcBankAudible-${id}`, label: "Make audible" })}
      ${key({ id: `kcBankSilent-${id}`, label: "Make silent" })}
      ${key({ id: `kcBankArchive-${id}`, label: "Archive all", variant: "danger" })}
      <a class="kc-key" id="kcBankAdd-${id}" href="${addHref}">${ico("plus")}<span>Add channel here</span></a>
      ${key({ id: `kcBankDelete-${id}`, label: "Delete bank", variant: "danger" })}
    </div>
  </details>`;
}

function createBankHtml(open: boolean): string {
  return `<details class="kc-group kc-disclosure" id="kcLibBankCreate"${open ? " open" : ""}>
    <summary class="kc-group__title"><span>Create a bank</span>${ico("chevron", "kc-ico kc-disclosure__chev")}</summary>
    ${field({ id: "kcBankNewName", label: "Name", control: `<input id="kcBankNewName" type="text" />` })}
    ${field({ id: "kcBankNewBand", label: "Band", control: `<select id="kcBankNewBand">${BAND_OPTS.map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}</select>` })}
    ${field({ id: "kcBankNewLo", label: "From MHz", control: `<input id="kcBankNewLo" type="number" min="0" step="0.001" />` })}
    ${field({ id: "kcBankNewHi", label: "To MHz", control: `<input id="kcBankNewHi" type="number" min="0" step="0.001" />` })}
    ${field({ id: "kcBankNewTags", label: "Tags", hint: "Comma-separated", control: `<input id="kcBankNewTags" type="text" placeholder="air, rail, ham" />` })}
    <div class="kc-keys">${key({ id: "kcBankNewSave", label: "Create bank", icon: "plus", variant: "primary", wide: true })}</div>
    <p class="kc-detail__status" id="kcBankNewStatus" role="status" aria-live="polite"></p>
  </details>`;
}

// ── Suggestions — pure markup ────────────────────────────────────────────────

function dupSetHtml(s: DuplicateSet): string {
  const rows = s.channels.map((c, i) =>
    `<div class="kc-row"><span>${esc(c.channel.alphaTag || "(unnamed)")}</span><span class="${i === 0 ? "kc-dupSet__tag--keep" : "kc-dupSet__tag--drop"}">${i === 0 ? "keeps" : "removed"}</span></div>`,
  ).join("");
  return `<div class="kc-dupSet"><div class="kc-dupSet__freq">${esc(fmtFreq(s.freq))}</div>${rows}</div>`;
}

function suggestionsHtml(dups: DuplicateSet[], recs: ArchiveRec[]): string {
  const groups: string[] = [];
  if (dups.length) {
    const total = dups.reduce((n, s) => n + Math.max(0, s.channels.length - 1), 0);
    groups.push(group("Duplicates", `${dups.map(dupSetHtml).join("")}<div class="kc-keys">`
      + `${key({ id: "kcLibDupResolve", label: `Delete ${total} duplicate row${total === 1 ? "" : "s"}`, variant: "danger", wide: true })}</div>`));
  }
  if (recs.length) {
    const rows = recs.slice(0, 12).map((c) =>
      `<div class="kc-row"><span>${esc(channelName(c))} · ${esc(fmtFreq(c.freq))}</span>${key({ id: `kcLibArchiveRec-${esc(c.id)}`, label: "Archive" })}</div>`,
    ).join("");
    groups.push(group("Not heard in 30 days", `<p class="kc-field__hint">Priority and hand-located channels are never suggested.</p>${rows}`));
  }
  return groups.length ? groups.join("") : emptyState("Nothing to review.");
}

// ── Wiring ───────────────────────────────────────────────────────────────────

export function mountSheets(lib: LibCtx, host: HTMLElement): { openBanks(): void; openSuggestions(): void } {
  const sheet = mountSheet(host, { id: "kcLibSheet", label: "Banks" });
  const body = sheet.body;
  const byId = <T extends HTMLElement>(id: string): T | null => document.getElementById(id) as T | null;

  let mode: "banks" | "suggestions" | null = null;
  let renderedKind: "banks" | "suggestions" | null = null;
  let lastBanksHtml = "";
  let lastSuggestionsHtml = "";
  /** Bank ids (or "create") with an unsaved edit — that form is left alone
   *  across a re-render until the edit is saved or the sheet closes. */
  const dirty = new Set<string>();
  const expanded = new Set<string>();
  let createOpen = false;

  function isDirtyOrFocused(): boolean {
    if (dirty.size > 0) return true;
    const a = document.activeElement;
    return a instanceof HTMLElement && body.contains(a) && !!a.closest("[data-bank-form], #kcLibBankCreate");
  }
  function focusKey(): string | null {
    const a = document.activeElement;
    return a instanceof HTMLElement && body.contains(a) && a.id ? a.id : null;
  }
  function restoreFocus(id: string | null): void {
    if (id) byId(id)?.focus();
  }

  function setStatus(id: string, text: string): void {
    const el = byId(id);
    if (el) el.textContent = text;
  }

  // ── Manage banks ───────────────────────────────────────────────────────────
  function banksHtml(): string {
    const banks = lib.store.data?.cfg.banks ?? [];
    const channels = lib.store.data?.channels ?? [];
    const list = banks.length
      ? `<div class="kc-group">${banks.map((b) => bankGroupHtml(b, channels, expanded)).join("")}</div>`
      : emptyState("No banks yet.");
    return `${list}${createBankHtml(createOpen)}`;
  }

  function renderBanks(force = false): void {
    if (mode !== "banks" || !sheet.isOpen()) return;
    if (!force && isDirtyOrFocused()) return;
    const html = banksHtml();
    if (!force && renderedKind === "banks" && html === lastBanksHtml) return;
    lastBanksHtml = html;
    renderedKind = "banks";
    const fk = focusKey();
    body.innerHTML = html;
    restoreFocus(fk);
  }

  async function saveProfile(id: string): Promise<void> {
    const bank = lib.store.data?.cfg.banks?.find((b) => b.id === id);
    if (!bank) return;
    const open = byId<HTMLInputElement>(`kcBank-${id}-open`)?.value ?? "";
    const hang = byId<HTMLInputElement>(`kcBank-${id}-hang`)?.value ?? "";
    const dwell = byId<HTMLInputElement>(`kcBank-${id}-dwell`)?.value ?? "";
    const f: ProfileForm = { open, hang, dwell };
    let p: Profile;
    try { p = profileFromForm(f); } catch (e) { setStatus(`kcBank-${id}-status`, msg(e)); return; }
    if (profileText(withProfile(bank, p)) === profileText(bank)) { setStatus(`kcBank-${id}-status`, "No change."); return; }
    setStatus(`kcBank-${id}-status`, "Saving…");
    try {
      await lib.run(async () => {
        const cfg = await api.getConfig();
        cfg.banks = (cfg.banks ?? []).map((x) => (x.id === id ? withProfile(x, p) : x));
        await api.putConfig(cfg);
      });
    } catch (e) { setStatus(`kcBank-${id}-status`, msg(e)); return; }
    dirty.delete(`bank:${id}`);
    setStatus(`kcBank-${id}-status`, "Saved — scanning restarted briefly.");
  }

  async function bulk(id: string, kind: "audible" | "silent" | "archive"): Promise<void> {
    const bank = lib.store.data?.cfg.banks?.find((b) => b.id === id);
    if (!bank) return;
    if (kind === "archive") {
      const ok = await lib.dialogs.confirm({
        title: `Archive every channel in ${bank.name}?`,
        message: "Archived channels stop being scanned but keep their name and location. Scanning restarts briefly.",
        confirmLabel: "Archive channels", danger: true,
      });
      if (!ok) return;
    }
    const patch = kind === "audible" ? { enabled: true, audible: true } : kind === "silent" ? { enabled: true, audible: false } : { enabled: false };
    const label = kind === "audible" ? "Made audible" : kind === "silent" ? "Made silent" : "Archived";
    let before = new Map<string, Pick<Channel, "enabled" | "audible">>();
    try {
      await lib.run(async () => {
        const cfg = await api.getConfig();
        const b = (cfg.banks ?? []).find((x) => x.id === id);
        if (!b) return;
        const r = bulkPatch(cfg.channels, b, patch);
        cfg.channels = r.channels;
        before = r.before;
        await api.putConfig(cfg);
      });
    } catch (e) { lib.dialogs.toast(`Couldn't update ${bank.name}: ${msg(e)}`); return; }
    if (!before.size) return;
    lib.dialogs.toast(`${label} — ${before.size} channel${before.size === 1 ? "" : "s"}.`, {
      undo: () => lib.run(async () => {
        const cfg = await api.getConfig();
        cfg.channels = cfg.channels.map((c) => (before.has(c.id) ? { ...c, ...before.get(c.id)! } : c));
        await api.putConfig(cfg);
      }),
    });
  }

  async function deleteBank(id: string): Promise<void> {
    const bank = lib.store.data?.cfg.banks?.find((b) => b.id === id);
    if (!bank) return;
    const ok = await lib.dialogs.confirm({
      title: `Delete bank ${bank.name}?`, message: "Its channels stay in the library and keep scanning.",
      confirmLabel: "Delete bank", danger: true,
    });
    if (!ok) return;
    try {
      await lib.run(async () => {
        const cfg = await api.getConfig();
        cfg.banks = (cfg.banks ?? []).filter((x) => x.id !== id);
        await api.putConfig(cfg);
      });
    } catch (e) { lib.dialogs.toast(`Couldn't delete ${bank.name}: ${msg(e)}`); }
  }

  async function createBank(): Promise<void> {
    const f: BankForm = {
      name: byId<HTMLInputElement>("kcBankNewName")?.value ?? "",
      band: byId<HTMLSelectElement>("kcBankNewBand")?.value ?? "",
      lo: byId<HTMLInputElement>("kcBankNewLo")?.value ?? "",
      hi: byId<HTMLInputElement>("kcBankNewHi")?.value ?? "",
      tags: byId<HTMLInputElement>("kcBankNewTags")?.value ?? "",
    };
    let bank: Bank;
    try { bank = bankFromForm(f, `bk_${crypto.randomUUID().slice(0, 8)}`); }
    catch (e) { setStatus("kcBankNewStatus", msg(e)); return; }
    setStatus("kcBankNewStatus", "Creating…");
    try {
      await lib.run(async () => {
        const cfg = await api.getConfig();
        cfg.banks = [...(cfg.banks ?? []), bank];
        await api.putConfig(cfg);
      });
    } catch (e) { setStatus("kcBankNewStatus", msg(e)); return; }
    dirty.delete("create");
    for (const id of ["kcBankNewName", "kcBankNewLo", "kcBankNewHi", "kcBankNewTags"]) { const el = byId<HTMLInputElement>(id); if (el) el.value = ""; }
    const band = byId<HTMLSelectElement>("kcBankNewBand"); if (band) band.value = "";
    setStatus("kcBankNewStatus", "");
    lib.dialogs.toast(`Created ${bank.name}.`);
  }

  // ── Suggestions ──────────────────────────────────────────────────────────
  function renderSuggestions(force = false): void {
    if (mode !== "suggestions" || !sheet.isOpen()) return;
    const html = suggestionsHtml(lib.store.dups, lib.store.recs);
    if (!force && renderedKind === "suggestions" && html === lastSuggestionsHtml) return;
    lastSuggestionsHtml = html;
    renderedKind = "suggestions";
    body.innerHTML = html;
  }

  async function resolveDuplicatesAction(): Promise<void> {
    const total = lib.store.dups.reduce((n, s) => n + Math.max(0, s.channels.length - 1), 0);
    const ok = await lib.dialogs.confirm({
      title: `Delete ${total} duplicate row${total === 1 ? "" : "s"}?`,
      message: "The most complete row for each frequency is kept. GMRS frequencies are never affected. This can't be undone. Scanning restarts briefly.",
      confirmLabel: total === 1 ? "Delete row" : "Delete rows", danger: true,
    });
    if (!ok) return;
    let removed = 0;
    try { ({ removed } = await lib.run(() => api.resolveDuplicates())); }
    catch (e) { lib.dialogs.toast(`Couldn't delete duplicates: ${msg(e)}`); return; }
    lib.refresh("suggestions");
    lib.dialogs.toast(`Removed ${removed} duplicate row${removed === 1 ? "" : "s"}.`);
  }

  async function archiveRec(id: string): Promise<void> {
    const rec = lib.store.recs.find((r) => r.id === id);
    const name = rec ? channelName(rec) : "channel";
    try { await lib.run(() => api.updateChannel(id, { enabled: false })); }
    catch (e) { lib.dialogs.toast(`Couldn't archive ${name}: ${msg(e)}`); return; }
    lib.dialogs.toast(`Archived ${name}.`, { undo: async () => { await lib.run(() => api.updateChannel(id, { enabled: true })); } });
    lib.refresh("suggestions");
  }

  // ── Delegated events (registered once; the body's innerHTML is replaced
  // freely, delegation keeps working without re-attaching listeners) ────────
  const idAfter = (elId: string, prefix: string): string | null => (elId.startsWith(prefix) ? elId.slice(prefix.length) : null);

  body.addEventListener("click", (ev) => {
    const t = ev.target instanceof Element ? ev.target : null;
    const el = t?.closest<HTMLElement>("button, a");
    if (!el?.id) return;
    let id: string | null;
    if ((id = idAfter(el.id, "kcBankSave-"))) { void saveProfile(id); return; }
    if ((id = idAfter(el.id, "kcBankAudible-"))) { void bulk(id, "audible"); return; }
    if ((id = idAfter(el.id, "kcBankSilent-"))) { void bulk(id, "silent"); return; }
    if ((id = idAfter(el.id, "kcBankArchive-"))) { void bulk(id, "archive"); return; }
    if ((id = idAfter(el.id, "kcBankAdd-"))) { sheet.close(); return; } // let the <a>'s navigation continue
    if ((id = idAfter(el.id, "kcBankDelete-"))) { void deleteBank(id); return; }
    if (el.id === "kcBankNewSave") { void createBank(); return; }
    if (el.id === "kcLibDupResolve") { void resolveDuplicatesAction(); return; }
    if ((id = idAfter(el.id, "kcLibArchiveRec-"))) { void archiveRec(id); return; }
  });

  body.addEventListener("input", (ev) => {
    const t = ev.target instanceof HTMLElement ? ev.target : null;
    const form = t?.closest<HTMLElement>("[data-bank-form]");
    if (form?.dataset.bankForm) { dirty.add(`bank:${form.dataset.bankForm}`); return; }
    if (t?.closest("#kcLibBankCreate")) dirty.add("create");
  });

  // "toggle" doesn't bubble — capture it instead.
  body.addEventListener("toggle", (ev) => {
    const d = ev.target as HTMLDetailsElement;
    const bankId = d.dataset.bank;
    if (bankId) { if (d.open) expanded.add(bankId); else expanded.delete(bankId); }
    else if (d.id === "kcLibBankCreate") createOpen = d.open;
  }, true);

  lib.store.subscribe(() => {
    if (mode === "banks") renderBanks();
    else if (mode === "suggestions") renderSuggestions();
  });

  sheet.onClose(() => { mode = null; renderedKind = null; dirty.clear(); });

  return {
    openBanks() { mode = "banks"; sheet.open({ title: "Manage banks" }); renderBanks(true); },
    openSuggestions() { mode = "suggestions"; sheet.open({ title: "Suggestions" }); renderSuggestions(true); },
  };
}
