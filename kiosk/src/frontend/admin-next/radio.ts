// Radio — admin-next home: the faceplate. LCD for what's live, keys for what
// you can do about it, then volume, recently heard, activity and alerts.
// Handlers are the classic Now panel's, ported (same API calls, same guards).
//
// Painting is in place: WS `signal` events move `dbfs` ~4×/s during a
// transmission, so paint() rebuilds the LCD only when what it shows changes
// (lcdKey), patches the meter + dB readout otherwise, and touches a key's
// markup only when its face changes (same model as the shell's mini-player).
//
// Every fetch here rides the sequential Poller (this box deadlocks on
// concurrent requests): reads are polls — user-initiated refreshes raise a
// flag that a `when`-gated poll picks up on the next tick — and every write
// goes through poller.run (test/adminNext.lane.test.ts enforces it).
import type { Config } from "../../backend/config/schema.js";
import { api } from "../lib/api.js";
import { esc, fmtFreq } from "../lib/format.js";
import { lockoutFreqIn } from "../lib/lockout.js";
import { ico, type IconName } from "./ui/icons.js";
import { dbText, emptyState, group, key, lcd, meterLit, switchRow } from "./ui/kit.js";
import { lcdKey, lcdView, type LiveState } from "./live.js";
import { POLL_MS } from "./poller.js";
import { hrefFor } from "./route.js";
import type { Ctx } from "./ctx.js";
import { ago } from "./time.js";

/** How many "recently heard" rows to show. */
export const RECENT_COUNT = 8;
/** How many channels the "Channel activity" disclosure ranks. */
export const INSIGHT_COUNT = 8;
/** How many alerts the Alerts group lists. */
export const ALERT_COUNT = 25;
/** How long the Pause key suppresses the current channel, in seconds (drives
 *  both the API call and the key's label). */
export const PAUSE_S = 1800;

/** "30 min", "1 h", "1 h 30 min" for a whole-minute duration. */
export function durationLabel(s: number): string {
  const m = Math.round(s / 60);
  const h = Math.floor(m / 60);
  const r = m % 60;
  return h === 0 ? `${r} min` : r === 0 ? `${h} h` : `${h} h ${r} min`;
}

type Stats = {
  totalHits: number; totalAirtimeMs: number; discoveries: number;
  topChannels: Array<{ alphaTag: string; freq: number; hits: number; airtimeMs: number }>;
  byHour: number[];
};

/** "42m", "1h 5m" for an airtime total (also the Library detail's 24 h summary). */
export function airtime(ms: number): string {
  const m = Math.round(ms / 60000);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
}

function getStats(sinceMs: number): Promise<Stats> {
  return api.getStats<Stats>(Date.now() - sinceMs);
}

export function mountRadio(ctx: Ctx): void {
  const { live, poller, dialogs } = ctx;
  const el = ctx.shell.panel("radio");
  el.innerHTML = `
    <div class="kc-radio">
      <div class="kc-radio__main">
        <div id="kcHealth" class="kc-healthStrip" hidden></div>
        <div id="kcLcd" role="status" aria-live="polite" aria-atomic="true"></div>
        <div class="kc-keys">
          ${key({ id: "kcListen", label: "Listen here", icon: "play", variant: "primary", wide: true })}
          ${key({ id: "kcSkip", label: "Skip", icon: "skip", title: "Force-close the current transmission" })}
          ${key({ id: "kcWeather", label: "Weather", icon: "weather", title: "Park the radio on the NOAA weather channel" })}
          ${key({ id: "kcPause", label: `Pause ${durationLabel(PAUSE_S)}`, icon: "pause", title: `Suppress this channel for ${durationLabel(PAUSE_S)} (clears on restart)` })}
          ${key({ id: "kcLock", label: "Lock out", icon: "lockout", variant: "danger", title: "Stop scanning this frequency and never Close-Call it" })}
        </div>
        <div class="kc-volume">
          <label for="kcVol" id="kcVolLabel">Volume <b id="kcVolPct"></b></label>
          <input id="kcVol" type="range" min="0" max="100" />
          <button type="button" class="kc-key" id="kcMute" aria-pressed="false"></button>
        </div>
        ${switchRow({ id: "kcRemote", label: "Remote listening", hint: "Stream the speaker to this browser — restarts scanning", checked: false })}
        ${group("Recently heard", `<div id="kcRecent">${emptyState("Loading…")}</div>`)}
      </div>
      <div class="kc-radio__side">
        ${group("Today", `<div id="kcToday">${emptyState("Loading…")}</div>`)}
        <details class="kc-group kc-disclosure" id="kcInsights">
          <summary class="kc-group__title"><span>Channel activity</span>${ico("chevron", "kc-ico kc-disclosure__chev")}</summary>
          <div class="kc-periods" role="group" aria-label="Period">
            <button type="button" data-h="24">24 h</button><button type="button" data-h="168">7 d</button><button type="button" data-h="720">30 d</button>
          </div>
          <div id="kcInBody"></div>
        </details>
        ${group("Alerts", `<ul id="kcAlerts" class="kc-list"><li>${emptyState("Loading…")}</li></ul><div class="kc-group__foot"><button type="button" class="kc-link" id="kcClearAlerts" hidden>Clear all</button></div>`)}
      </div>
    </div>`;

  const $ = <T extends HTMLElement>(sel: string): T => el.querySelector<T>(sel)!;
  const lcdHost = $("#kcLcd");
  const listen = $<HTMLButtonElement>("#kcListen");
  const weather = $<HTMLButtonElement>("#kcWeather");
  const pause = $<HTMLButtonElement>("#kcPause");
  const lock = $<HTMLButtonElement>("#kcLock");
  const vol = $<HTMLInputElement>("#kcVol");
  const volPct = $("#kcVolPct");
  const mute = $<HTMLButtonElement>("#kcMute");
  const remote = $<HTMLInputElement>("#kcRemote");

  // ── In-place painting helpers
  const faces = new WeakMap<HTMLElement, string>();
  /** Set a key's icon + label, only when either actually changed. */
  function face(btn: HTMLElement, icon: IconName, label: string): void {
    const k = `${icon}|${label}`;
    if (faces.get(btn) === k) return;
    faces.set(btn, k);
    btn.innerHTML = `${ico(icon)}<span>${esc(label)}</span>`;
  }
  function setDisabled(btn: HTMLButtonElement, d: boolean): void { if (btn.disabled !== d) btn.disabled = d; }
  function setAttr(e: HTMLElement, name: string, value: string): void { if (e.getAttribute(name) !== value) e.setAttribute(name, value); }
  function setText(e: HTMLElement, t: string): void { if (e.textContent !== t) e.textContent = t; }

  let lcdShown: string | null = null;
  let meterBars: HTMLElement[] = [];
  let dbEl: HTMLElement | null = null;
  function paintLcd(s: LiveState): void {
    const v = lcdView(s);
    const k = lcdKey(v);
    if (k !== lcdShown) {
      lcdShown = k;
      lcdHost.innerHTML = lcd(v, { dbfs: s.dbfs });
      meterBars = Array.from(lcdHost.querySelectorAll<HTMLElement>(".kc-meter i"));
      dbEl = lcdHost.querySelector<HTMLElement>(".kc-lcd__db");
      return;
    }
    // Same channel, new level: patch the meter and the readout only (both
    // aria-hidden, so the polite live region doesn't re-announce at 4 Hz).
    if (v.state !== "live") return;
    const lit = meterLit(s.dbfs);
    meterBars.forEach((b, i) => b.classList.toggle("on", i < lit));
    if (dbEl) setText(dbEl, dbText(s.dbfs));
  }

  // ── Stream: owned by LiveStore (shared with the mini-player)
  function paintListen(s: LiveState): void {
    setDisabled(listen, !s.remoteListening && !live.streaming);
    setAttr(listen, "title", s.remoteListening ? "Listen to the live speaker feed in this browser" : "Turn on remote listening to stream the feed");
    if (live.streaming) face(listen, "stop", "Stop listening"); else face(listen, "play", "Listen here");
  }
  listen.addEventListener("click", () => live.toggleStream());

  let remoteBusy = false; // confirm dialog / save in flight for the switch
  function paint(s: LiveState): void {
    const v = lcdView(s);
    paintLcd(s);
    paintListen(s);
    if (s.monitoring) {
      face(weather, "stop", "Resume scan");
      setDisabled(weather, false);
    } else {
      face(weather, "weather", s.mode === "weather" ? "Resume scan" : "Weather");
      setDisabled(weather, s.mode !== "weather" && s.weatherChannel === null);
    }
    setDisabled(pause, !v.canLock);
    setDisabled(lock, !v.canLock);
    // Never fight the operator's thumb: the slider and its readout follow the
    // store only while the slider isn't focused (repainted on blur).
    if (document.activeElement !== vol) {
      const vs = String(s.volume);
      if (vol.value !== vs) vol.value = vs;
      setText(volPct, `${s.volume}%`);
    }
    // A toggle keeps one label; its state is aria-pressed (a label that flips
    // to "Muted" reads as the opposite action to a screen reader).
    setAttr(mute, "aria-pressed", String(s.muted));
    face(mute, s.muted ? "volumeOff" : "volume", "Mute");
    if (!remoteBusy && document.activeElement !== remote && remote.checked !== s.remoteListening) remote.checked = s.remoteListening;
  }
  live.subscribe(paint);
  vol.addEventListener("blur", () => paint(live.state));

  /** A write's failure, said as a toast (a bare `void` would drop it). */
  const say = (e: unknown): void => { dialogs.toast(e instanceof Error ? e.message : String(e)); };
  $<HTMLButtonElement>("#kcSkip").addEventListener("click", () => { poller.run(() => api.skip()).catch(say); });
  weather.addEventListener("click", async () => {
    const s = live.state;
    try {
      if (s.monitoring) await poller.run(() => api.monitorStop());
      else await poller.run(() => api.setMode(s.mode === "weather" ? "scan" : "weather"));
    } catch (e) { say(e); }
    // The resync rides the Poller (never a direct /api/status fetch here).
    // Only the status resync: making every Radio poll due here refired all of
    // them right after an engine-restarting mode change.
    live.requestResync();
    void poller.tick("radio");
  });
  pause.addEventListener("click", async () => {
    try {
      await poller.run(() => api.skip(PAUSE_S));
      dialogs.toast(`Paused this channel for ${durationLabel(PAUSE_S)}.`);
    } catch (e) { say(e); }
  });
  lock.addEventListener("click", async () => {
    const np = live.state.nowPlaying;
    if (!np) return;
    const name = np.alphaTag || fmtFreq(np.freq);
    if (!await dialogs.confirm({
      title: `Lock out ${name}?`,
      message: "This stops the frequency being scanned or Close-Called. The channel is archived, not deleted — unlock restores it.",
      confirmLabel: "Lock out", danger: true,
    })) return;
    try {
      // Snapshot what lockout drops so Undo restores what was actually there
      // (same rule as the classic admin's lockoutFreq). Read and write are one
      // lane slot, so no poll lands between them.
      const { dropped, priorEnabled } = await poller.run(async () => {
        const before = await api.getConfig();
        const out = {
          dropped: (before.discoveries ?? []).filter((d) => d.freq === np.freq),
          priorEnabled: new Map(before.channels.filter((c) => c.freq === np.freq).map((c) => [c.id, c.enabled])),
        };
        await api.putConfig(lockoutFreqIn(before, np.freq));
        return out;
      });
      dialogs.toast(`Locked out ${name}.`, {
        undo: () => poller.run(async () => {
          const cfg: Config = await api.getConfig();
          cfg.scan = { ...cfg.scan, lockoutHz: (cfg.scan.lockoutHz ?? []).filter((f) => f !== np.freq) };
          cfg.channels = cfg.channels.map((c) => (priorEnabled.has(c.id) ? { ...c, enabled: priorEnabled.get(c.id)! } : c));
          if (dropped.length) cfg.discoveries = [...(cfg.discoveries ?? []), ...dropped];
          await api.putConfig(cfg);
        }),
      });
    } catch (e) { say(e); }
  });

  // `input` keeps the readout live while dragging; the write waits for `change`
  // so a drag is one request.
  vol.addEventListener("input", () => { volPct.textContent = `${vol.value}%`; });
  vol.addEventListener("change", () => { const v = Number(vol.value); live.set({ volume: v }); poller.run(() => api.setVolume(v)).catch(say); });
  mute.addEventListener("click", () => { const m = !live.state.muted; live.set({ muted: m }); poller.run(() => api.setMuted(m)).catch(say); });
  remote.addEventListener("change", async () => {
    const on = remote.checked;
    remoteBusy = true;
    try {
      if (!await dialogs.confirm({
        title: on ? "Turn on remote listening?" : "Turn off remote listening?",
        message: "The scanner restarts briefly to rebuild its audio tap.",
        confirmLabel: on ? "Turn on" : "Turn off",
      })) { remote.checked = !on; return; }
      await poller.run(async () => {
        const cfg = await api.getConfig();
        await api.putConfig({ ...cfg, audio: { ...cfg.audio, remoteListening: on } });
      });
      live.set({ remoteListening: on });
    } catch (e) { remote.checked = !on; say(e); }
    finally { remoteBusy = false; paint(live.state); }
  });

  // ── Recently heard
  const recent = $("#kcRecent");
  // Rows are focusable links: rewrite only when the markup changes, so a
  // 10 s poll doesn't drop focus or swallow a tap.
  let recentShown = "";
  poller.add({
    name: "recent", everyMs: POLL_MS.recent, tabs: ["radio"],
    run: async () => {
      let logs: Awaited<ReturnType<typeof api.getLogs>>;
      try { logs = await api.getLogs(); }
      catch {
        if (!recent.querySelector(".kc-row")) { recentShown = ""; recent.innerHTML = emptyState("Recent activity is unavailable right now."); }
        return;
      }
      const rows = logs.slice().sort((a, b) => b.ts - a.ts).slice(0, RECENT_COUNT);
      const html = rows.length
        ? rows.map((r) => `<a class="kc-row kc-row--link" href="${hrefFor({ tab: "library", detail: { kind: "hz", hz: r.freq } })}"><span class="kc-row__name">${esc(r.alphaTag || fmtFreq(r.freq))}</span><span class="kc-row__meta">${ago(r.ts)}</span></a>`).join("")
        : emptyState("Nothing heard yet. Transmissions appear here as they happen.");
      if (html !== recentShown) { recentShown = html; recent.innerHTML = html; }
    },
  });

  // ── Today (one request per poll; the Poller runs them one at a time)
  const today = $("#kcToday");
  poller.add({
    name: "today", everyMs: POLL_MS.activity, tabs: ["radio"],
    run: async () => {
      let st: Stats;
      // Say so rather than keep a blank (or stale) group: the Poller swallows
      // a throw, and nothing else would.
      try { st = await getStats(86_400_000); }
      catch { if (!today.querySelector(".kc-today")) today.innerHTML = emptyState("Today's activity is unavailable right now."); return; }
      const max = Math.max(1, ...st.byHour);
      const nowH = new Date().getHours();
      const total = st.byHour.reduce((a, b) => a + b, 0);
      today.innerHTML = `<div class="kc-today">
          <div><b>${st.totalHits.toLocaleString()}</b><small>transmissions</small></div>
          <div><b>${airtime(st.totalAirtimeMs)}</b><small>airtime</small></div>
          <div><b>${st.discoveries}</b><small>close calls</small></div>
        </div>
        <div class="kc-hours" role="img" aria-label="${total ? `${total} transmissions in the last 24 hours, by hour` : "No traffic in the last 24 hours"}">${
          st.byHour.map((n, h) => `<i${h === nowH ? ' class="now"' : ""} style="height:${Math.max(4, (n / max) * 100)}%"></i>`).join("")}</div>`;
    },
  });

  // ── Channel activity (only fetched while expanded)
  const IN_KEY = "kerchunk.adminNext.insightHours";
  let inHours = 24;
  try { inHours = Number(localStorage.getItem(IN_KEY)) || 24; } catch { /* private mode */ }
  const insights = $<HTMLDetailsElement>("#kcInsights");
  const inBody = $("#kcInBody");
  const periodBtns = Array.from(insights.querySelectorAll<HTMLButtonElement>(".kc-periods button"));
  function paintPeriods(): void {
    periodBtns.forEach((b) => b.setAttribute("aria-pressed", String(Number(b.dataset.h) === inHours)));
  }
  paintPeriods();
  let insightsPending = false;
  async function renderInsights(): Promise<void> {
    insightsPending = false;
    let st: Stats;
    try { st = await getStats(inHours * 3_600_000); }
    catch { inBody.innerHTML = emptyState("History is unavailable. Restart the radio if this persists."); return; }
    const max = Math.max(1, ...st.topChannels.map((c) => c.hits));
    // Plain rows for now; tap-to-open-channel arrives with Library (PR 4).
    inBody.innerHTML = st.topChannels.length
      ? st.topChannels.slice(0, INSIGHT_COUNT).map((c) => `<div class="kc-row kc-bar">
          <span class="kc-bar__name">${esc(c.alphaTag || fmtFreq(c.freq))}</span>
          <span class="kc-bar__track"><i style="width:${Math.round((100 * c.hits) / max)}%"></i></span>
          <span class="kc-row__meta">${c.hits} · ${airtime(c.airtimeMs)}</span></div>`).join("")
      : emptyState("No traffic in this window.");
  }
  /** User asked for fresh insights: queue one sequential fetch. */
  function queueInsights(): void {
    if (!inBody.firstChild) inBody.innerHTML = emptyState("Loading…");
    insightsPending = true;
    void poller.tick("radio");
  }
  insights.addEventListener("toggle", () => { if (insights.open) queueInsights(); });
  periodBtns.forEach((b) => b.addEventListener("click", () => {
    inHours = Number(b.dataset.h);
    try { localStorage.setItem(IN_KEY, String(inHours)); } catch { /* private mode */ }
    paintPeriods();
    queueInsights();
  }));
  poller.add({ name: "insights", everyMs: POLL_MS.insights, tabs: ["radio"], when: () => insights.open, run: renderInsights });
  poller.add({ name: "insights-now", everyMs: 0, tabs: ["radio"], when: () => insightsPending && insights.open, run: renderInsights });

  // ── Alerts
  // A WS `alert` event (or a dismiss / clear) raises `alertsPending`; the
  // "alerts-now" poll picks it up on the next tick — one sequential fetch,
  // without making every other Radio poll due the way makeDue("radio") would.
  const alertList = $("#kcAlerts");
  const clearAll = $<HTMLButtonElement>("#kcClearAlerts");
  let alertsPending = false;
  function queueAlerts(): void { alertsPending = true; void poller.tick("radio"); }
  async function renderAlerts(): Promise<void> {
    alertsPending = false;
    let rows: Array<{ id: number; ts: number; freq: number; alphaTag: string }>;
    try {
      rows = await api.getHistory<typeof rows>({ kind: "alert", limit: ALERT_COUNT });
    } catch {
      // Keep a list we already have; replace only the loading placeholder.
      if (!alertList.querySelector("[data-id]")) alertList.innerHTML = `<li>${emptyState("Alerts are unavailable right now.")}</li>`;
      return;
    }
    clearAll.hidden = rows.length === 0;
    alertList.innerHTML = rows.length
      ? rows.map((a) => `<li class="kc-row"><span>${esc(a.alphaTag || fmtFreq(a.freq))}<small class="kc-row__meta"> ${ago(a.ts)}</small></span>
          <button type="button" class="kc-iconKey" data-id="${a.id}" aria-label="Dismiss alert: ${esc(a.alphaTag || fmtFreq(a.freq))}">${ico("trash")}</button></li>`).join("")
      : `<li>${emptyState("No alerts. Turn on “Alert when heard” for a channel in Library to get one.")}</li>`;
  }
  // Delegated: the list is re-rendered, the listener isn't.
  alertList.addEventListener("click", async (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-id]");
    if (!b) return;
    b.disabled = true;
    try { await poller.run(() => api.dismissAlert(Number(b.dataset.id))); } catch (e) { say(e); }
    queueAlerts();
  });
  clearAll.addEventListener("click", async () => {
    if (!await dialogs.confirm({ title: "Clear all alerts?", message: "Removes every alert from the feed. Activity history is kept.", confirmLabel: "Clear all", danger: true })) return;
    try { await poller.run(() => api.clearAlerts()); } catch (e) { say(e); }
    queueAlerts();
  });
  poller.add({ name: "alerts", everyMs: POLL_MS.alerts, tabs: ["radio"], run: renderAlerts });
  poller.add({ name: "alerts-now", everyMs: 0, tabs: ["radio"], when: () => alertsPending, run: renderAlerts });
  live.onAlert(() => { alertsPending = true; });
}
