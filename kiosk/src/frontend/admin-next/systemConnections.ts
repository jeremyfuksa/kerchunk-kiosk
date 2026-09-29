// System › Connections (spec §6): the Google Maps key / Map ID sheet (saved
// as you go, live — config.display is never read by toScanConfig) and the
// locked-out frequencies sheet (Remove + Undo; removing one changes the
// channel set, so scanning restarts briefly).
//
// One read, a System-tab poll of /api/config; every write rides
// ctx.poller.run (test/adminNext.lane.test.ts). While a power action is being
// watched the poller is paused and its probes must be alone on the wire, so
// every write here refuses with WAIT_TEXT instead.
//
// The Maps key is secret-ish: it only ever lands in its input's `.value`,
// never in text anywhere else on the page.
import type { Config } from "../../backend/config/schema.js";
import { api } from "../lib/api.js";
import { esc, fmtFreq } from "../lib/format.js";
import { unlockFreqIn } from "../lib/lockout.js";
import { emptyState, field, group } from "./ui/kit.js";
import { ico } from "./ui/icons.js";
import { mountSheet } from "./ui/sheet.js";
import { POLL_MS } from "./poller.js";
import { mapsState, unlockSnapshot, withMaps } from "./systemModel.js";
import type { Ctx } from "./ctx.js";

const WAIT_TEXT = "Wait for the radio to come back.";
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** A status line's text; errors are wrapped so `.kc-status [data-kind="error"]`
 *  paints them coral. Always textContent — server error text is untrusted. */
function setStatus(node: HTMLElement, text: string, error = false): void {
  if (!error) { node.textContent = text; return; }
  const span = document.createElement("span");
  span.dataset.kind = "error";
  span.textContent = text;
  node.replaceChildren(span);
}

function lockoutsHtml(cfg: Config): string {
  const freqs = [...(cfg.scan.lockoutHz ?? [])].sort((a, b) => a - b);
  if (!freqs.length) return emptyState("Nothing is locked out. Lock out a frequency from Radio or the Library.");
  const rows = freqs.map((f) => {
    const name = cfg.channels.find((c) => c.freq === f && c.alphaTag)?.alphaTag;
    return `<div class="kc-row" data-hz="${f}"><span class="kc-row__name">${esc(fmtFreq(f))} MHz${name ? ` · ${esc(name)}` : ""}</span>`
      + `<button type="button" class="kc-key" data-unlock="${f}">Remove</button></div>`;
  }).join("");
  return `<p class="kc-conn__intro">These are never scanned and Close Call never reports them. Removing one scans it again (restarts scanning briefly).</p>${rows}`;
}

export function mountConnections(ctx: Ctx, host: HTMLElement): void {
  host.innerHTML = group("Connections", `
    <button type="button" class="kc-row kc-row--btn" data-conn="maps">${ico("map")}<span>Google Maps</span><span class="kc-row__end"><span id="kcMapsState">…</span>${ico("chevron")}</span></button>
    <button type="button" class="kc-row kc-row--btn" data-conn="lockouts">${ico("lockout")}<span>Locked-out frequencies</span><span class="kc-row__end"><span id="kcLockCount">…</span>${ico("chevron")}</span></button>`,
  { id: "kcSysConn" });
  const mapsStateEl = host.querySelector<HTMLElement>("#kcMapsState")!;
  const lockCountEl = host.querySelector<HTMLElement>("#kcLockCount")!;

  let cfg: Config | null = null;

  // ── Maps sheet ───────────────────────────────────────────────────────────
  const maps = mountSheet(host, { id: "kcMapsSheet", label: "Google Maps" });
  maps.body.innerHTML = `
    <p class="kc-conn__intro">The kiosk map and the admin's location tools use this key. Saved as you go — refresh the kiosk screen afterwards so the map picks it up.</p>
    ${field({ id: "kcMapsKey", label: "API key", control: '<input id="kcMapsKey" type="text" autocomplete="off" spellcheck="false" placeholder="AIza…">' })}
    ${field({ id: "kcMapsId", label: "Map ID", control: '<input id="kcMapsId" type="text" autocomplete="off" spellcheck="false" placeholder="Optional vector map ID">', hint: "Leave empty for the standard map." })}
    <p class="kc-status" id="kcMapsStatus" role="status" aria-live="polite"></p>`;
  const keyEl = maps.body.querySelector<HTMLInputElement>("#kcMapsKey")!;
  const idEl = maps.body.querySelector<HTMLInputElement>("#kcMapsId")!;
  const mapsStatusEl = maps.body.querySelector<HTMLElement>("#kcMapsStatus")!;
  const dirty = new Set<HTMLInputElement>();

  /** Fill the inputs from cfg — except one being typed in or not yet saved. */
  function fillMaps(): void {
    if (!cfg) return;
    const vals: Array<[HTMLInputElement, string]> = [
      [keyEl, cfg.display?.googleMapsApiKey ?? ""],
      [idEl, cfg.display?.googleMapsMapId ?? ""],
    ];
    for (const [el, v] of vals) {
      if (dirty.has(el) || document.activeElement === el) continue;
      if (el.value !== v) el.value = v;
    }
  }

  for (const el of [keyEl, idEl]) {
    el.addEventListener("input", () => dirty.add(el));
    el.addEventListener("change", () => { void saveMaps(el); });
  }

  let saving = false;
  let saveAgain = false;
  async function saveMaps(changed: HTMLInputElement): Promise<void> {
    if (ctx.poller.paused) { setStatus(mapsStatusEl, WAIT_TEXT, true); return; }
    // One save at a time: a second change while one is in flight saves both
    // values again once it settles.
    if (saving) { saveAgain = true; return; }
    saving = true;
    const sent = new Map([[keyEl, keyEl.value], [idEl, idEl.value]]);
    setStatus(mapsStatusEl, "Saving…");
    try {
      await ctx.poller.run(async () => {
        const c = await api.getConfig();
        // withMaps throws (before anything is sent) without a display block.
        await api.putConfig(withMaps(c, sent.get(keyEl)!, sent.get(idEl)!));
      });
      for (const [el, v] of sent) if (el.value === v) dirty.delete(el);
      setStatus(mapsStatusEl, "Saved. Refresh the kiosk screen to use it.");
      ctx.poller.request("connections");
      void ctx.poller.tick("system");
    } catch (e) {
      // Keep the typed value (still dirty) so it can be fixed and re-saved.
      setStatus(mapsStatusEl, msg(e), true);
    } finally {
      saving = false;
      if (saveAgain) { saveAgain = false; void saveMaps(changed); }
    }
  }
  maps.onClose(() => {
    // Nothing unsaved survives a close: the next open shows what's stored.
    dirty.clear();
    mapsStatusEl.textContent = "";
  });

  // ── Lockouts sheet ───────────────────────────────────────────────────────
  const locks = mountSheet(host, { id: "kcLockSheet", label: "Locked-out frequencies" });
  const lockCloseBtn = (): HTMLElement | null => host.querySelector<HTMLElement>("#kcLockSheet .kc-sheet__close");
  let lastLocksHtml = "";

  function renderLocks(force = false): void {
    if (!cfg || !locks.isOpen()) return;
    const html = lockoutsHtml(cfg);
    if (!force && html === lastLocksHtml) return;
    lastLocksHtml = html;
    // Focus restore (librarySheets renderSuggestions): same row's key, else
    // the next row's, else the previous, else the close button.
    const active = document.activeElement;
    const focused = active instanceof HTMLElement && locks.body.contains(active) ? active : null;
    const focusedHz = focused?.dataset.unlock ?? null;
    const oldHz = [...locks.body.querySelectorAll<HTMLElement>("[data-unlock]")].map((b) => b.dataset.unlock!);
    const oldIdx = focusedHz ? oldHz.indexOf(focusedHz) : -1;
    locks.body.innerHTML = html;
    if (!focused) return; // a background poll must not steal focus
    const keyFor = (hz: string | undefined): HTMLElement | null =>
      hz ? locks.body.querySelector<HTMLElement>(`[data-unlock="${CSS.escape(hz)}"]`) : null;
    let target = keyFor(focusedHz ?? undefined);
    if (!target && oldIdx >= 0) target = keyFor(oldHz[oldIdx + 1]) ?? keyFor(oldHz[oldIdx - 1]);
    (target ?? lockCloseBtn())?.focus();
  }
  locks.onClose(() => { lastLocksHtml = ""; });

  async function removeLockout(f: number): Promise<void> {
    if (ctx.poller.paused) { ctx.dialogs.toast(WAIT_TEXT); return; }
    const ok = await ctx.dialogs.confirm({
      title: `Scan ${fmtFreq(f)} MHz again?`,
      message: "It's removed from the lockout list and any archived channel on it is scanned again. Scanning restarts briefly.",
      confirmLabel: "Remove lockout",
    });
    if (!ok) return;
    if (ctx.poller.paused) { ctx.dialogs.toast(WAIT_TEXT); return; }
    let snap: ReturnType<typeof unlockSnapshot> | null = null;
    try {
      await ctx.poller.run(async () => {
        const c = await api.getConfig();
        snap = unlockSnapshot(c, f);
        await api.putConfig(unlockFreqIn(c, f));
      });
    } catch (e) {
      ctx.dialogs.toast(`Couldn't remove the lockout: ${msg(e)}`);
      return;
    }
    const s: ReturnType<typeof unlockSnapshot> = snap!;
    ctx.dialogs.toast(`Removed the lockout on ${fmtFreq(f)} MHz.`, {
      undo: async () => {
        if (ctx.poller.paused) throw new Error(WAIT_TEXT);
        await ctx.poller.run(async () => {
          const c = await api.getConfig();
          c.scan = { ...c.scan, lockoutHz: [...new Set([...(c.scan.lockoutHz ?? []), f])] };
          c.channels = c.channels.map((ch) => (s.enabled.has(ch.id) ? { ...ch, enabled: s.enabled.get(ch.id)! } : ch));
          await api.putConfig(c);
        });
        ctx.poller.request("connections");
        void ctx.poller.tick("system");
      },
    });
    ctx.poller.request("connections");
    void ctx.poller.tick("system");
  }

  locks.body.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-unlock]");
    if (!btn || btn.disabled) return;
    const f = Number(btn.dataset.unlock);
    if (!Number.isFinite(f)) return;
    btn.disabled = true;
    void removeLockout(f).finally(() => { btn.disabled = false; });
  });

  // ── Rows, poll ───────────────────────────────────────────────────────────
  function paint(): void {
    if (!cfg) return;
    const state = mapsState(cfg) === "connected" ? "Connected" : "Not set";
    if (mapsStateEl.textContent !== state) mapsStateEl.textContent = state;
    const n = String(cfg.scan.lockoutHz?.length ?? 0);
    if (lockCountEl.textContent !== n) lockCountEl.textContent = n;
    if (maps.isOpen()) fillMaps();
    renderLocks();
  }

  host.querySelector<HTMLElement>("#kcSysConn")!.addEventListener("click", (e) => {
    const row = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-conn]");
    if (!row) return;
    if (row.dataset.conn === "maps") {
      maps.open({ title: "Google Maps" });
      fillMaps();
    } else if (row.dataset.conn === "lockouts") {
      locks.open({ title: "Locked-out frequencies" });
      if (cfg) renderLocks(true);
      else locks.body.innerHTML = emptyState("Loading…");
    }
    // Catch up at once rather than showing up to a poll interval old.
    ctx.poller.request("connections");
    void ctx.poller.tick("system");
  });

  ctx.poller.add({
    name: "connections", everyMs: POLL_MS.audio, tabs: ["system"],
    run: async () => { try { cfg = await api.getConfig(); paint(); } catch { /* keep last */ } },
  });
}
