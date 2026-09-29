// System — the verdict, four vitals, kiosk screen actions, connections and
// power (spec §6). /api/system is one poll (System tab only); uptime and the
// break-in flag come from the live store's status poll, so no extra request.
//
// Power actions take the backend away. The routes answer 202 and then exit,
// so SystemActionWatcher probes /api/status until a different process
// answers (or clearly nothing happened). While it watches, the Poller is
// PAUSED: the watcher's probes are then the only requests on the wire (this
// box deadlocks on concurrent requests). Those probes are the one sanctioned
// read outside the lane — they call api.getStatus on the watcher's own
// timers. Every other write rides poller.run (test/adminNext.lane.test.ts
// enforces it), and poller.run refuses while paused, so no tab can write
// alongside the probes. The power send itself goes through run() BEFORE
// the pause.
import "./system.css";
import { api } from "../lib/api.js";
import { esc } from "../lib/format.js";
import { SystemActionWatcher } from "../lib/systemActionWatcher.js";
import { emptyState, group } from "./ui/kit.js";
import { ico } from "./ui/icons.js";
import { POLL_MS } from "./poller.js";
import { glance } from "./verdict.js";
import { hrefFor } from "./route.js";
import {
  alertsView, SYSTEM_ACTION_COPY, TEST_ALERTS, uptimeText, verdictView, vitals,
  type SystemAction, type SystemSnapshot,
} from "./systemModel.js";
import { mountConnections } from "./systemConnections.js";
import type { Ctx } from "./ctx.js";

// Knobs: how patiently the page waits out a power action.
export const WATCH_POLL_MS = 2000;          // while the backend still answers
export const WATCH_DOWN_POLL_MS = 5000;     // once it's gone (a reboot ≈ a minute)
export const WATCH_TIMEOUT_MS = 20_000;     // same process still up ⇒ the action never took
export const WATCH_PROBE_TIMEOUT_MS = 4000; // a rebooting host swallows connections
export const BACK_MESSAGE_MS = 8000;        // how long "…is back" stays
export const KIOSK_STATUS_MS = 6000;        // how long a kiosk-action result stays

/** A status line's text; errors are wrapped so `.kc-status [data-kind="error"]`
 *  paints them coral. Always textContent — server error text is untrusted. */
function setStatus(node: HTMLElement, text: string, error: boolean): void {
  if (!error) { node.textContent = text; return; }
  const span = document.createElement("span");
  span.dataset.kind = "error";
  span.textContent = text;
  node.replaceChildren(span);
}

const STALE_TEXT = "Readings are out of date.";
const PROTECTION_NOTE = "Protection is on: the box is above its thermal limit. Close Call and sweep ranges stay off until it cools.";

export function mountSystem(ctx: Ctx): void {
  const el = ctx.shell.panel("system");
  el.innerHTML = `<div class="kc-sys">
    <header class="kc-sys__head"><h1>System</h1></header>
    <section class="kc-group kc-verdictCard" aria-label="Health">
      <div class="kc-verdictCard__line" role="status" aria-live="polite">
        <i class="kc-verdictCard__dot" aria-hidden="true"></i><b id="kcSysLabel">Checking…</b><span id="kcSysReason"></span>
      </div>
      <p class="kc-verdictCard__up" id="kcSysUp"></p>
      <div id="kcSysAlerts"></div>
    </section>
    <div class="kc-vitals" id="kcSysVitals">${emptyState("Loading readings…")}</div>
    <p class="kc-vitals__more" id="kcSysMore"></p>
    ${group("Kiosk screen", `
      <button type="button" class="kc-row kc-row--btn" data-kiosk="reload">${ico("refresh")}<span>Refresh kiosk screen</span></button>
      <button type="button" class="kc-row kc-row--btn" data-kiosk="alert">${ico("bell")}<span>Show a test weather alert</span></button>
      <button type="button" class="kc-row kc-row--btn" data-kiosk="clear">${ico("close")}<span>Clear the test alert</span></button>
      <p class="kc-status" id="kcKioskStatus" role="status" aria-live="polite"></p>`, { id: "kcSysKiosk" })}
    <div id="kcSysConnections"></div>
    ${group("Power", `
      <button type="button" class="kc-row kc-row--btn kc-row--danger" data-power="restart">${ico("power")}<span>Restart radio</span></button>
      <button type="button" class="kc-row kc-row--btn kc-row--danger" data-power="reboot">${ico("power")}<span>Reboot appliance</span></button>
      <button type="button" class="kc-row kc-row--btn kc-row--danger" data-power="poweroff">${ico("power")}<span>Shut down</span></button>
      <p class="kc-status" id="kcPowerStatus" role="status" aria-live="polite"></p>`, { id: "kcSysPower" })}
  </div>`;
  mountConnections(ctx, el.querySelector<HTMLElement>("#kcSysConnections")!);

  const card = el.querySelector<HTMLElement>(".kc-verdictCard")!;
  const labelEl = el.querySelector<HTMLElement>("#kcSysLabel")!;
  const reasonEl = el.querySelector<HTMLElement>("#kcSysReason")!;
  const upEl = el.querySelector<HTMLElement>("#kcSysUp")!;
  const alertsEl = el.querySelector<HTMLElement>("#kcSysAlerts")!;
  const vitalsEl = el.querySelector<HTMLElement>("#kcSysVitals")!;
  const moreEl = el.querySelector<HTMLElement>("#kcSysMore")!;
  const kioskStatusEl = el.querySelector<HTMLElement>("#kcKioskStatus")!;
  const powerStatusEl = el.querySelector<HTMLElement>("#kcPowerStatus")!;

  // ── Verdict, uptime, alerts ──────────────────────────────────────────────
  // The most recent snapshot's `now.ts` is server time: uptime is measured
  // against it so a phone with a skewed clock still reads right. It's only
  // trusted while fresh (off the System tab the poll stops); a stale one
  // falls back to the local clock.
  let lastServerTs: number | null = null;
  let lastServerAt = 0; // local receipt time of lastServerTs
  let lastAlertSig = "";
  let lastVitals = "";

  function setText(node: HTMLElement, text: string): void {
    if (node.textContent !== text) node.textContent = text;
  }

  function paintUptime(): void {
    // While a power action is watched the process is going away: no uptime.
    if (watching) { setText(upEl, ""); return; }
    const local = Date.now();
    const fresh = lastServerTs !== null && local - lastServerAt <= 2 * POLL_MS.system;
    // Fresh: server time advanced by the local time elapsed since receipt.
    const now = fresh ? lastServerTs! + (local - lastServerAt) : local;
    setText(upEl, uptimeText(ctx.live.state.startedAt, now));
  }

  function paintVerdict(sys: SystemSnapshot | null): void {
    const v = verdictView(sys);
    if (card.dataset.verdict !== v.verdict) card.dataset.verdict = v.verdict;
    setText(labelEl, v.label);
    setText(reasonEl, v.reason);
    if (sys?.now && typeof sys.now.ts === "number") { lastServerTs = sys.now.ts; lastServerAt = Date.now(); }
    paintUptime();
    if (!sys) {
      // No answer: an old alert list would read as current.
      lastAlertSig = "";
      if (alertsEl.innerHTML) alertsEl.innerHTML = "";
      return;
    }
    const { protection, alerts } = alertsView(sys);
    // Title and message too: backend alert messages embed live temperatures.
    const sig = JSON.stringify([protection, alerts.map((a) => [a.id, a.severity, a.title, a.message])]);
    if (sig === lastAlertSig) return;
    lastAlertSig = sig;
    alertsEl.innerHTML = (protection ? `<p class="kc-protect">${PROTECTION_NOTE}</p>` : "")
      + alerts.map((a) => `<div class="kc-alert" data-severity="${esc(a.severity)}">
          <b>${esc(a.title)}</b><span>${esc(a.message)}</span><small>${esc(a.help)}</small>
          ${a.id.startsWith("cpu-") || a.id.startsWith("memory-") ? `<a class="kc-link" href="${hrefFor({ tab: "tune" })}">Open Tune</a>` : ""}
        </div>`).join("");
  }

  function paintVitals(sys: SystemSnapshot | null): void {
    const v = sys ? vitals(sys) : null;
    // A failed read keeps the last readings on screen, dimmed and labelled
    // out of date; the next good read restores them.
    vitalsEl.classList.toggle("kc-vitals--stale", !sys && !!lastVitals);
    if (!v) {
      if (!lastVitals) {
        vitalsEl.innerHTML = emptyState(sys ? "No readings yet — they appear within a minute." : "Readings are unavailable right now.");
      } else if (!sys) {
        setText(moreEl, STALE_TEXT);
      }
      return;
    }
    const html = v.main.map((m) => `<div class="kc-vital${m.hot ? " kc-vital--hot" : ""}" data-vital="${m.id}">
        <span class="kc-vital__label">${m.label}</span>
        <b class="kc-vital__value">${esc(m.value)}</b>
        ${m.spark !== null ? `<svg class="kc-spark2" viewBox="0 0 120 28" preserveAspectRatio="none" aria-hidden="true"><polyline points="${m.spark}"/></svg>` : ""}
      </div>`).join("");
    if (html !== lastVitals) {
      lastVitals = html;
      vitalsEl.innerHTML = html;
    }
    setText(moreEl, v.secondary.join(" · "));
  }

  ctx.poller.add({
    name: "system", everyMs: POLL_MS.system, tabs: ["system"],
    run: async () => {
      let sys: SystemSnapshot | null = null;
      try { sys = await api.getSystem<SystemSnapshot>(); } catch { /* shown as unknown */ }
      paintVerdict(sys);
      paintVitals(sys);
      // Same read, same verdict: keep the top bar in step with the card.
      const g = glance(sys);
      ctx.shell.setVerdict(g.verdict, g.text);
    },
  });

  // ── Kiosk screen ─────────────────────────────────────────────────────────
  let alertIdx = 0;
  let kioskTimer: ReturnType<typeof setTimeout> | undefined;
  function kioskStatus(text: string, clear: boolean, error = false): void {
    if (kioskTimer !== undefined) clearTimeout(kioskTimer);
    kioskTimer = undefined;
    setStatus(kioskStatusEl, text, error);
    if (clear) kioskTimer = setTimeout(() => { kioskStatusEl.textContent = ""; }, KIOSK_STATUS_MS);
  }
  const kioskBtns = [...el.querySelectorAll<HTMLButtonElement>("[data-kiosk]")];
  const kioskSending = new Set<HTMLButtonElement>(); // keys with a send in flight
  el.querySelector<HTMLElement>("#kcSysKiosk")!.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-kiosk]");
    // Paused = a power action is being watched: its probes must stay alone.
    if (!btn || btn.disabled || busy || ctx.poller.paused) return;
    const kind = btn.dataset.kiosk;
    let send: () => Promise<unknown>;
    let done: string;
    if (kind === "reload") {
      kioskStatus("Refreshing the kiosk screen…", false);
      send = () => ctx.poller.run(() => api.reloadKiosk());
      done = "Refresh sent.";
    } else if (kind === "alert") {
      const tag = TEST_ALERTS[alertIdx % TEST_ALERTS.length]!;
      // The cycle advances only once this type actually showed.
      send = () => ctx.poller.run(() => api.testAlert({ alphaTag: tag })).then(() => { alertIdx++; });
      done = `Showing “${tag}” on the kiosk — press again for the next type.`;
    } else if (kind === "clear") {
      send = () => ctx.poller.run(() => api.testAlert({ clear: true }));
      done = "Test alert cleared.";
    } else {
      return;
    }
    kioskSending.add(btn);
    syncKeys();
    void send()
      .then(() => kioskStatus(done, true))
      .catch((err: unknown) => kioskStatus(err instanceof Error ? err.message : String(err), true, true))
      .finally(() => { kioskSending.delete(btn); syncKeys(); });
  });

  // ── Power ────────────────────────────────────────────────────────────────
  const powerBtns = [...el.querySelectorAll<HTMLButtonElement>("[data-power]")];
  let watcher: SystemActionWatcher | undefined;
  let powerTimer: ReturnType<typeof setTimeout> | undefined;
  // True from confirm until the watcher settles (or the send fails): every
  // System key is off, since the watcher's probes must be alone on the wire.
  let busy = false;
  let watching = false;
  function powerStatus(text: string, clearMs?: number, error = false): void {
    if (powerTimer !== undefined) clearTimeout(powerTimer);
    powerTimer = undefined;
    setStatus(powerStatusEl, text, error);
    if (clearMs !== undefined) powerTimer = setTimeout(() => { powerStatusEl.textContent = ""; }, clearMs);
  }
  /** Power keys need the running process's startedAt: without a baseline
   *  the watcher can't tell a restarted process from the one it asked, and
   *  a real restart could read as "didn't restart". */
  function syncKeys(): void {
    const known = ctx.live.state.startedAt !== null;
    for (const b of powerBtns) {
      b.disabled = busy || !known;
      if (known) b.removeAttribute("title");
      else b.title = "Waiting for the radio's status…";
    }
    // Kiosk keys are off from confirm until settle too, and while their own
    // send is in flight.
    for (const b of kioskBtns) b.disabled = busy || kioskSending.has(b);
  }
  function settle(): void {
    busy = false;
    watching = false;
    ctx.poller.setPaused(false); // every poll due: the verdict and System polls repaint
    syncKeys();
  }
  /** While a power action is watched the polls are paused, so nothing else
   *  would repaint the verdict: show it as unknown (card and top bar) rather
   *  than a frozen "Healthy". settle() unpauses and the polls repaint it. */
  function paintWatching(text: string): void {
    if (card.dataset.verdict !== "unknown") card.dataset.verdict = "unknown";
    setText(labelEl, "Unknown");
    setText(reasonEl, text);
    setText(upEl, "");
    ctx.shell.setVerdict("unknown", text);
  }
  async function runAction(action: SystemAction): Promise<void> {
    const copy = SYSTEM_ACTION_COPY[action];
    const ok = await ctx.dialogs.confirm({
      title: copy.title,
      message: ctx.live.state.breakIn ? `A weather alert is on air right now. ${copy.message}` : copy.message,
      confirmLabel: copy.confirmLabel, danger: true,
    });
    if (!ok) return;
    const baseline = ctx.live.state.startedAt;
    if (baseline === null || busy) return; // keys are off without one; belt and braces
    busy = true;
    syncKeys();
    powerStatus(copy.pending);
    try {
      await ctx.poller.run(() => (action === "restart" ? api.restartBackend() : api.powerAction(action)));
    } catch (e) {
      // The send failed, so nothing is going down: recover now.
      powerStatus(e instanceof Error ? e.message : String(e), undefined, true);
      busy = false;
      syncKeys();
      return;
    }
    // From here the watcher's probes are the only requests: pause the polls
    // and take the kiosk keys off with the power keys.
    watching = true;
    syncKeys();
    ctx.poller.setPaused(true);
    watcher?.stop();
    watcher = new SystemActionWatcher({
      probe: (signal) => api.getStatus(signal),
      baselineStartedAt: baseline,
      pollMs: WATCH_POLL_MS, downPollMs: WATCH_DOWN_POLL_MS,
      timeoutMs: WATCH_TIMEOUT_MS, probeTimeoutMs: WATCH_PROBE_TIMEOUT_MS,
      onPhase: (phase) => {
        switch (phase) {
          case "pending": powerStatus(copy.pending); paintWatching(copy.pending); break;
          case "down": powerStatus(copy.down); paintWatching(copy.down); break;
          case "back":
            powerStatus(copy.back, BACK_MESSAGE_MS);
            // The old startedAt belongs to the process that just went away: a
            // quick second action must wait for the new one's (syncKeys holds
            // the power keys off while it's null).
            ctx.live.set({ startedAt: null });
            settle();
            ctx.live.requestResync();
            break;
          case "unchanged": powerStatus(copy.unchanged); settle(); break;
        }
      },
    });
    watcher.start();
  }
  el.querySelector<HTMLElement>("#kcSysPower")!.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-power]");
    if (!btn || btn.disabled || busy) return;
    const action = btn.dataset.power;
    if (action === "restart" || action === "reboot" || action === "poweroff") void runAction(action);
  });

  // Uptime and the power keys' baseline both follow the live store.
  ctx.live.subscribe(() => { paintUptime(); syncKeys(); });
}
