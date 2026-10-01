import type { EngineEvent } from "../../backend/engine/ScannerEngine.js";
import { ReconnectingWs } from "../lib/wsClient.js";
import { api } from "../lib/api.js";
import { fmtFreq, esc } from "../lib/format.js";
import { alertTheme } from "./alertTheme.js";
import { mountActivityMap } from "../map/map.js";
import { cornerView, sentenceCase, meterFill, METER_SEGMENTS } from "./cornerView.js";
import { pillHtml, glassHtml, cornerPaint, pillDetailText, alertFlip, type CornerMemo } from "./corner.js";
import { createPoller } from "./poller.js";
import { segmentsLit, dbText } from "../faceplate/lcd.js";
import icoSun from "lucide-static/icons/sun.svg?raw";
import icoMoon from "lucide-static/icons/moon.svg?raw";
import icoCloud from "lucide-static/icons/cloud.svg?raw";
import icoCloudSun from "lucide-static/icons/cloud-sun.svg?raw";
import icoRain from "lucide-static/icons/cloud-rain.svg?raw";
import icoStorm from "lucide-static/icons/cloud-lightning.svg?raw";
import icoSnow from "lucide-static/icons/cloud-snow.svg?raw";
import icoFog from "lucide-static/icons/cloud-fog.svg?raw";
import icoWind from "lucide-static/icons/wind.svg?raw";
import icoArrow from "lucide-static/icons/navigation-2.svg?raw";
import "./dashboard.css";

export interface NowPlaying { freq: number; alphaTag: string; tags?: readonly string[]; }
export interface LogRow { freq: number; alphaTag: string; ts: number; }
export interface AlertBanner { freq: number; alphaTag: string; until: number; counties?: string; }
export interface DashState {
  nowPlaying: NowPlaying | null;
  /** Center frequency of the tuned window (names the idle pill: "VHF high 160.9"). */
  tunedHz: number | null;
  /** Active alert banner; cleared by paint once `until` passes. */
  alert: AlertBanner | null;
  log: LogRow[];
  error: string | null;
  /** Latest signal level (dB) of the audible channel; null when silent. */
  signalDb: number | null;
  /** Engine state from status events — "starting" renders as retuning. */
  engineState: string;
  // True once an "audible" event has been seen: the engine reports speaker
  // ownership explicitly (wideband), so "active" stops driving nowPlaying —
  // many channels can be active while exactly one is audible. RtlFm never
  // emits audible, so there active keeps driving (its active IS audible).
  audibleDriven: boolean;
  // Cold-start warm-up: the "WARMING UP" overlay shows while !warmed. Driven by
  // engine "warmup" events (live boot) and corrected by the /api/status `warmed`
  // poll (late-load). Default warmed=true so an already-warm page never flashes
  // the overlay — a fresh boot's "booting" event (or a warmed:false poll) shows it.
  warmed: boolean;
  warmupPhase: string | null;
  warmupStep: number;
  warmupOf: number;
}

export function initialState(): DashState {
  return { nowPlaying: null, tunedHz: null, alert: null, log: [], error: null, signalDb: null, engineState: "running", audibleDriven: false, warmed: true, warmupPhase: null, warmupStep: 0, warmupOf: 4 };
}

/** Merge live WS log rows (already in state) with a historical backfill fetch:
 *  newest-first, deduped by ts+freq, capped at 100. The initial getLogs()
 *  resolves AFTER the WS is live, so wholesale-replacing state.log dropped any
 *  "active" rows that arrived in between; merging keeps them. */
export function mergeLogs(live: LogRow[], fetched: LogRow[]): LogRow[] {
  const seen = new Set(live.map((r) => `${r.ts}:${r.freq}`));
  return [...live, ...fetched.filter((r) => !seen.has(`${r.ts}:${r.freq}`))]
    .sort((a, b) => b.ts - a.ts)
    .slice(0, 100);
}

export function reduce(s: DashState, ev: EngineEvent): DashState {
  switch (ev.type) {
    // active/idle prove the engine is working, so they also clear any stale
    // error: a page whose WS was reconnecting during a backend restart misses
    // the status:running event and would otherwise show the old error forever.
    case "active":
      return {
        ...s,
        error: null,
        // The Recent log records every opening; nowPlaying only follows when
        // the engine doesn't report audibility explicitly.
        nowPlaying: s.audibleDriven ? s.nowPlaying : { freq: ev.freq, alphaTag: ev.channel.alphaTag, ...(ev.channel.tags ? { tags: ev.channel.tags } : {}) },
        log: [{ freq: ev.freq, alphaTag: ev.channel.alphaTag, ts: ev.ts }, ...s.log].slice(0, 100),
      };
    case "audible":
      return {
        ...s,
        error: null,
        audibleDriven: true,
        nowPlaying: ev.channel ? { freq: ev.channel.freq, alphaTag: ev.channel.alphaTag, ...(ev.channel.tags ? { tags: ev.channel.tags } : {}) } : null,
        signalDb: ev.channel ? s.signalDb : null,
      };
    case "signal":
      return { ...s, signalDb: ev.dbfs };
    case "tuned":
      return { ...s, tunedHz: ev.freqHz };
    case "alert":
      // The banner outlives the transmission: holdSeconds is the operator's
      // attention window, not the squelch's.
      return { ...s, alert: {
        freq: ev.freq, alphaTag: ev.channel.alphaTag,
        until: ev.ts + ev.holdSeconds * 1000,
        ...(ev.counties ? { counties: ev.counties } : {}),
      } };
    case "warmup":
      // booting (re)shows the overlay; ready clears it; the middle phases just
      // advance the bar. warmed is left unchanged for spawning/tuned so a late
      // page that already learned warmed=true (status poll) isn't re-hidden.
      return {
        ...s,
        warmupPhase: ev.phase, warmupStep: ev.step, warmupOf: ev.of,
        warmed: ev.phase === "ready" ? true : ev.phase === "booting" ? false : s.warmed,
      };
    case "idle":
      return { ...s, error: null, nowPlaying: s.audibleDriven ? s.nowPlaying : null };
    case "error":
      // A hard engine error (e.g. NO_DEVICE) during warm-up must not stay
      // hidden behind the opaque full-screen overlay — force it cleared so the
      // error shows through. A later booting/ready re-establishes warm-up.
      return { ...s, error: ev.message, warmed: true };
    case "status":
      // Any engine state transition means playback context reset: a restart
      // (e.g. channel edit) kills the helper without squelch-close events, so
      // now-playing must not survive it — a fresh active/audible
      // re-establishes it (audibleDriven resets too: the engine kind may change).
      // The alert banner is NOT playback context: it's an operator-attention
      // window with its own `until` timer (and a weather break-in's retune
      // would otherwise wipe the warning it just raised), so it rides through.
      return ev.state === "running"
        ? { ...s, error: null, nowPlaying: null, signalDb: null, engineState: ev.state, audibleDriven: false }
        : { ...s, nowPlaying: null, signalDb: null, engineState: ev.state, audibleDriven: false };
    default:
      return s;
  }
}

function fmtTime(ts: number): string { return new Date(ts).toLocaleTimeString(); }

// Re-exported for tests (kept stable from the pre-refactor public surface).
export { esc } from "../lib/format.js";

export function renderDashboard(root: HTMLElement): void {
  let state = initialState();

  root.innerHTML = `
    <div class="dash">
      <div id="mapBase" class="mapBase"></div>
      <div id="riskPill" class="kc-risk" role="status" hidden></div>
      <header class="kc-clock">
        <div id="clock" class="kc-clock__time"></div>
        <div id="wx" class="kc-wx"></div>
        <div id="clockDate" class="kc-clock__date"></div>
      </header>
      <div class="kc-stage">
        <div id="corner" class="kc-corner">
          <div id="alertBar" class="alertBar"></div>
          <div class="kc-corner__slot" role="status">
            <div id="pillHost" class="kc-corner__pill"></div>
            <div id="glassHost" class="kc-corner__glass"></div>
          </div>
        </div>
        <aside class="kc-recent"><h2>Recently heard</h2><ul id="logList"></ul></aside>
      </div>
    </div>`;
  // ── Poll budget ─────────────────────────────────────────────────────────
  // Three independent timers (status 5 s, system 10 s, weather 10 min) used to
  // collide every 10 s, and the appliance has been observed to deadlock on 2+
  // concurrent requests (see CLAUDE.md). One ticker now runs them strictly one
  // at a time. Cadences are the knobs.
  const POLL_MS = { status: 5_000, risk: 10_000, weather: 600_000 };
  const POLL_TICK_MS = 1_000;
  const poller = createPoller();

  const dashEl = root.querySelector<HTMLElement>(".dash")!;
  const riskEl = root.querySelector<HTMLElement>("#riskPill")!;
  // True once the WebGL map mounts (the .mapStage layout). Under it, the Recent
  // log is display:none, so paint() skips rebuilding it.
  let mapMounted = false;
  void mountActivityMap(root.querySelector<HTMLElement>("#mapBase")!, { interactive: false })
    .then((mounted) => { if (mounted) { mapMounted = true; dashEl.classList.add("mapStage"); } })
    .catch(() => { /* no map = classic dashboard, nothing lost */ });
  let lastRiskSig = "";
  function paintRisk(): Promise<void> {
    return fetch("/api/system").then((r) => r.ok ? r.json() : null).then((s) => {
      const severe = s?.alerts?.filter((a: { severity: string }) => a.severity === "severe") ?? [];
      const sig = severe.map((a: { title: string }) => a.title).join("|");
      if (sig === lastRiskSig) return; // unchanged — skip the innerHTML write (usually "")
      lastRiskSig = sig;
      riskEl.textContent = severe.length
        ? `Machine warning · ${severe.map((a: { title: string }) => a.title).join(" · ")}`
        : "";
      riskEl.hidden = severe.length === 0;
    }).catch(() => {});
  }
  poller.poll("risk", paintRisk, POLL_MS.risk);

  const logEl = root.querySelector<HTMLElement>("#logList")!;
  // Coalesce repaints to one per animation frame: a burst of WS events in a
  // single frame collapses to ONE paint() instead of N full renders.
  let rafPending = false;
  function schedule(): void {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => { rafPending = false; paint(); });
  }
  // Mode and break-in come from /api/status (mode flips restart the engine, so
  // the status event re-polls); they name the pill and the glass's meta line.
  let mode: "scan" | "weather" | "monitor" = "scan";
  let breakIn = false;
  function paintStatus(): Promise<void> {
    return api.getStatus()
      .then((s) => {
        const sc = s.scanCount ?? -1;
        const mu = s.muted ?? false;
        const bi = s.breakIn ?? false;
        // Late-load correction ONLY: a page that opened after warm-up never sees
        // the WS warmup events, so trust the server flag. But once we've observed
        // the live WS warmup stream, IT is authoritative — otherwise an in-flight
        // poll (snapshotted warmed=true) could land after a fresh "booting" and
        // wrongly end the warm-up pill mid-restart.
        const wm = (!sawWarmupEvent && typeof s.warmed === "boolean") ? s.warmed : state.warmed;
        // The 5s poll usually reads identical values — only repaint on a change.
        const changed = s.mode !== mode || sc !== scanCount || mu !== muted || bi !== breakIn || wm !== state.warmed;
        mode = s.mode; scanCount = sc; muted = mu; breakIn = bi;
        if (wm !== state.warmed) state = { ...state, warmed: wm };
        if (changed) schedule();
      })
      .catch(() => {});
  }
  // Mute flips in the admin without an engine restart — polled so the kiosk
  // tracks it within a few seconds.
  poller.poll("status", paintStatus, POLL_MS.status);

  let scanCount = -1; // unknown until the first status fetch
  // Once the live WS warmup stream is seen, it owns `warmed` (the /api/status
  // poll stops correcting it) — prevents a stale in-flight poll from clobbering
  // a fresh booting/ready during a restart.
  let sawWarmupEvent = false;
  let muted = false;



  const alertEl = root.querySelector<HTMLElement>("#alertBar")!;
  let alertTimer: ReturnType<typeof setTimeout> | null = null;

  function paintAlert(): void {
    if (state.alert && Date.now() >= state.alert.until) {
      state = { ...state, alert: null };
    }
    if (state.alert) {
      // Stacked above the corner: a header strip, then the alert TYPE big, then
      // the affected counties as a prominent second line (no frequency — the
      // NWR channel number means nothing to someone glancing across the room).
      // The theme (severity tier + storm kind) sets size, color, and icon; CSS
      // keys the palette off the `tier` class + `data-kind` attribute.
      const theme = alertTheme(state.alert.alphaTag);
      const tierLabel = theme.tier === "watch" ? "Watch"
        : theme.tier === "statement" ? "Statement" : "Warning";
      alertEl.dataset.kind = theme.kind;
      alertEl.classList.remove("warning", "watch", "statement");
      alertEl.classList.add(theme.tier);
      alertEl.innerHTML = `<div class="alertHead">`
        + `<span class="alertGlyph">${theme.icon}</span>`
        + `<span class="alertLabel">${tierLabel}</span></div>`
        + `<div class="alertTag">${esc(sentenceCase(state.alert.alphaTag))}</div>`
        + (state.alert.counties ? `<div class="alertCounties">${esc(state.alert.counties)}</div>` : "");
      alertEl.classList.add("on");
      // One repaint exactly at expiry — no polling.
      if (alertTimer) clearTimeout(alertTimer);
      alertTimer = setTimeout(paintAlert, Math.max(0, state.alert.until - Date.now()) + 50);
    } else {
      alertEl.classList.remove("on");
      alertEl.innerHTML = "";
      if (alertTimer) { clearTimeout(alertTimer); alertTimer = null; }
    }
  }

  // ── The corner (spec 2026-10-01): the idle pill or the wall-size glass.
  // cornerView decides what shows; cornerPaint decides what to rebuild; the
  // .is-glass class drives the CSS grow/release transitions. Signal ticks on
  // the same channel only move the segments and the dB text.
  const cornerEl = root.querySelector<HTMLElement>("#corner")!;
  const pillHost = root.querySelector<HTMLElement>("#pillHost")!;
  const glassHost = root.querySelector<HTMLElement>("#glassHost")!;
  const slotEl = root.querySelector<HTMLElement>(".kc-corner__slot")!;
  let memo: CornerMemo | null = null;
  let segEls: HTMLElement[] = [];
  let dbEl: HTMLElement | null = null;

  function paint(): void {
    paintAlert();
    const v = cornerView({
      warmed: state.warmed, warmupPhase: state.warmupPhase, warmupStep: state.warmupStep, warmupOf: state.warmupOf,
      error: state.error, engineState: state.engineState, nowPlaying: state.nowPlaying, tunedHz: state.tunedHz,
      scanCount, muted, mode, breakIn,
    });
    const p = cornerPaint(memo, v);
    memo = p.memo;
    if (v.show === "pill") {
      if (p.rebuildPill) pillHost.innerHTML = pillHtml(v);
      else {
        // A window hop: patch the text, keep the node (and its running sweep).
        const d = pillHost.querySelector<HTMLElement>(".kc-pill__detail");
        const text = pillDetailText(v.detail);
        if (d && d.textContent !== text) d.textContent = text;
      }
    }
    if (v.show === "glass") {
      if (p.rebuildGlass) {
        glassHost.innerHTML = glassHtml(v, state.signalDb);
        segEls = Array.from(glassHost.querySelectorAll<HTMLElement>(".kc-lcd__seg i"));
        dbEl = glassHost.querySelector<HTMLElement>(".kc-lcd__db");
      } else {
        const lit = segmentsLit(meterFill(state.signalDb), METER_SEGMENTS);
        segEls.forEach((el, i) => el.classList.toggle("on", i < lit));
        if (dbEl) dbEl.textContent = dbText(state.signalDb);
      }
    }
    const wasGlass = cornerEl.classList.contains("is-glass");
    if (wasGlass !== (v.show === "glass") && alertEl.classList.contains("on")) {
      // FLIP the alert card so it rides with the growing/shrinking glass
      // instead of jumping by the slot's height change.
      const before = slotEl.offsetHeight;
      cornerEl.classList.toggle("is-glass", v.show === "glass");
      const flip = alertFlip(before, slotEl.offsetHeight, v.show);
      if (flip) {
        alertEl.style.transition = "none";
        alertEl.style.transform = `translateY(${flip.offsetPx}px)`;
        void alertEl.offsetHeight; // commit the start position
        alertEl.style.transition = `transform var(${flip.durationVar}) cubic-bezier(0.2, 0.8, 0.2, 1)`;
        alertEl.style.transform = "";
      }
    } else {
      cornerEl.classList.toggle("is-glass", v.show === "glass");
    }
    // Only the showing host is in the status region; the other is still
    // mounted (it animates out) but must not be read.
    pillHost.setAttribute("aria-hidden", String(v.show === "glass"));
    glassHost.setAttribute("aria-hidden", String(v.show === "pill"));
    paintLog();
  }

  // Under the full-screen map layout the Recent log is display:none — skip the
  // 100-row innerHTML rebuild entirely (it was burning CPU to draw nothing).
  function paintLog(): void {
    if (mapMounted) return;
    logEl.innerHTML = state.log
      .map((r) => `<li><span class="t">${fmtTime(r.ts)}</span> ${fmtFreq(r.freq)} ${esc(r.alphaTag)}</li>`)
      .join("");
  }

  // Clock: tick on the minute boundary (kiosk readout, no seconds noise).
  const clockEl = root.querySelector<HTMLElement>("#clock")!;
  const dateEl = root.querySelector<HTMLElement>("#clockDate")!;
  function paintClock(): void {
    const now = new Date();
    clockEl.textContent = now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    dateEl.textContent = now.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
    // Re-tick at the next minute boundary, not every 5s — the readout has no
    // seconds, so 12 wakeups/min were 11 wasted (+1s guard past the rollover).
    setTimeout(paintClock, 60_000 - (Date.now() % 60_000) + 1000);
  }
  paintClock();

  // Weather: NWS via the backend cache; absent/failed = the block just hides.
  const wxEl = root.querySelector<HTMLElement>("#wx")!;

  const WX_ICONS: Record<string, string> = {
    sun: icoSun, moon: icoMoon, cloud: icoCloud, cloudsun: icoCloudSun, rain: icoRain,
    storm: icoStorm, snow: icoSnow, fog: icoFog, wind: icoWind,
  };

  function wxIcon(condition: string, day: boolean): string {
    const c = condition.toLowerCase();
    const name =
      /thunder|t-storm|tstm/.test(c) ? "storm"
      : /snow|sleet|ice|flurr|wintry/.test(c) ? "snow"
      : /rain|shower|drizzle/.test(c) ? "rain"
      : /fog|mist|haze|smoke/.test(c) ? "fog"
      : /wind|breezy|blustery/.test(c) ? "wind"
      : /partly|mostly sunny|mostly clear/.test(c) ? (day ? "cloudsun" : "moon")
      : /cloud|overcast/.test(c) ? "cloud"
      : day ? "sun" : "moon";
    return `<span class="kc-wx__icon" aria-hidden="true">${WX_ICONS[name]}</span>`;
  }

  // Wind → a direction ARROW (icon) + speed NUMBER, no words. NWS gives the
  // direction the wind comes FROM ("SW 3 mph"); the arrow points where it BLOWS.
  const COMPASS: Record<string, number> = {
    N: 0, NNE: 22, NE: 45, ENE: 67, E: 90, ESE: 112, SE: 135, SSE: 157,
    S: 180, SSW: 202, SW: 225, WSW: 247, W: 270, WNW: 292, NW: 315, NNW: 337,
  };
  function windBlock(wind: string): string {
    const speed = /(\d+)/.exec(wind)?.[1];
    if (!speed) return "";
    const fromDeg = COMPASS[(/\b([NSEW]{1,3})\b/.exec(wind) ?? [])[1] ?? ""];
    const arrow = fromDeg === undefined ? ""
      : `<span class="kc-wx__arrow" aria-hidden="true" style="transform:rotate(${(fromDeg + 180) % 360}deg)">${icoArrow}</span>`;
    return `<span class="kc-wx__wind">${arrow}<span>${speed}</span></span>`;
  }

  function paintWeather(): Promise<void> {
    return fetch("/api/weather")
      .then((r) => (r.ok ? r.json() : null))
      .then((wx: { tempF: number; condition: string; wind: string; isDaytime: boolean } | null) => {
        // Glanceable: condition ICON + temp NUMBER + wind arrow + speed. The
        // condition WORDS are dropped — the icon already says it from across the room.
        wxEl.innerHTML = wx
          ? `${wxIcon(wx.condition, wx.isDaytime)}<span class="kc-wx__temp">${Math.round(wx.tempF)}°</span>${wx.wind ? windBlock(wx.wind) : ""}`
          : "";
      })
      .catch(() => {});
  }
  poller.poll("weather", paintWeather, POLL_MS.weather);

  api.getLogs().then((rows) => { state = { ...state, log: mergeLogs(state.log, rows) }; paint(); }).catch(() => {});
  const proto = location.protocol === "https:" ? "wss" : "ws";
  new ReconnectingWs(`${proto}://${location.host}/ws`, (ev) => {
    if (ev.type === "reload") { location.reload(); return; }
    if (ev.type === "warmup") sawWarmupEvent = true; // WS now owns `warmed`
    state = reduce(state, ev);
    // Mode, mute and break-in can change on these: re-poll status through the
    // lane (a break-in is a retune, so only the alert announces it).
    if (ev.type === "status" || ev.type === "alert") poller.request("status");
    schedule(); // coalesce: a burst of events in one frame => one paint()
  }).connect();
  paint();

  // One timer drives every poll registered above, sequentially.
  setInterval(() => { void poller.tick(); }, POLL_TICK_MS);
  void poller.tick();
}
