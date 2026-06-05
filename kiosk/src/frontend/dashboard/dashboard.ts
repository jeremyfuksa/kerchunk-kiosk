import type { EngineEvent } from "../../backend/engine/ScannerEngine.js";
import { ReconnectingWs } from "../lib/wsClient.js";
import { api } from "../lib/api.js";
import { fmtFreq, esc } from "../lib/format.js";
import icoBellRing from "lucide-static/icons/bell-ring.svg?raw";
import "./dashboard.css";

const ICO_BELL = icoBellRing;

export interface NowPlaying { freq: number; alphaTag: string; }
export interface LogRow { freq: number; alphaTag: string; ts: number; }
export interface AlertBanner { freq: number; alphaTag: string; until: number; }
export interface DashState {
  nowPlaying: NowPlaying | null;
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
}

export function initialState(): DashState {
  return { nowPlaying: null, alert: null, log: [], error: null, signalDb: null, engineState: "running", audibleDriven: false };
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
        nowPlaying: s.audibleDriven ? s.nowPlaying : { freq: ev.freq, alphaTag: ev.channel.alphaTag },
        log: [{ freq: ev.freq, alphaTag: ev.channel.alphaTag, ts: ev.ts }, ...s.log].slice(0, 100),
      };
    case "audible":
      return {
        ...s,
        error: null,
        audibleDriven: true,
        nowPlaying: ev.channel ? { freq: ev.channel.freq, alphaTag: ev.channel.alphaTag } : null,
        signalDb: ev.channel ? s.signalDb : null,
      };
    case "signal":
      return { ...s, signalDb: ev.dbfs };
    case "alert":
      // The banner outlives the transmission: holdSeconds is the operator's
      // attention window, not the squelch's.
      return { ...s, alert: {
        freq: ev.freq, alphaTag: ev.channel.alphaTag,
        until: ev.ts + ev.holdSeconds * 1000,
      } };
    case "idle":
      return { ...s, error: null, nowPlaying: s.audibleDriven ? s.nowPlaying : null };
    case "error":
      return { ...s, error: ev.message };
    case "status":
      // Any engine state transition means playback context reset: a restart
      // (e.g. channel edit) kills the helper without squelch-close events, so
      // now-playing must not survive it — a fresh active/audible
      // re-establishes it (audibleDriven resets too: the engine kind may change).
      return ev.state === "running"
        ? { ...s, error: null, nowPlaying: null, alert: null, signalDb: null, engineState: ev.state, audibleDriven: false }
        : { ...s, nowPlaying: null, alert: null, signalDb: null, engineState: ev.state, audibleDriven: false };
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
      <header class="topbar">
        <div id="modeBadge" class="modeBadge"></div>
        <div class="topbarSpacer"></div>
        <div id="wx" class="wx"></div>
        <div class="topbarDivider"></div>
        <div class="clockBlock">
          <div id="clock" class="clock"></div>
          <div id="clockDate" class="clockDate"></div>
        </div>
      </header>
      <div id="alertBar" class="alertBar"></div>
      <div class="dashBody">
        <section class="now" id="now"></section>
        <aside class="log"><h2>Recent</h2><ul id="logList"></ul></aside>
      </div>
    </div>`;
  const nowEl = root.querySelector<HTMLElement>("#now")!;
  const logEl = root.querySelector<HTMLElement>("#logList")!;
  const modeBadge = root.querySelector<HTMLElement>("#modeBadge")!;
  // Badge follows the runtime mode — refreshed on engine status transitions
  // (mode flips always restart the engine), so MONITORING/WEATHER are never
  // stale on the kiosk screen (review finding: monitor mode was invisible).
  function paintBadge(): void {
    api.getStatus()
      .then((s) => {
        modeBadge.textContent =
          s.mode === "weather" ? "WEATHER"
          : s.mode === "monitor" ? "MONITORING" : "";
        scanCount = s.scanCount ?? -1;
        paint();
      })
      .catch(() => {});
  }
  paintBadge();

  let scanCount = -1; // unknown until the first status fetch

  const alertEl = root.querySelector<HTMLElement>("#alertBar")!;
  let alertTimer: ReturnType<typeof setTimeout> | null = null;

  function paintAlert(): void {
    if (state.alert && Date.now() >= state.alert.until) {
      state = { ...state, alert: null };
    }
    if (state.alert) {
      alertEl.innerHTML = `<span class="alertGlyph">${ICO_BELL}</span>
        <span class="alertLabel">ALERT</span>
        <span class="alertFreq">${fmtFreq(state.alert.freq)}</span>
        <span class="alertTag">${esc(state.alert.alphaTag)}</span>`;
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

  function paint(): void {
    paintAlert();
    if (state.engineState === "starting" && !state.nowPlaying && !state.error) {
      nowEl.innerHTML = `<div class="scanning">
        <div class="scanText">RETUNING</div>
        <div class="sweep"><div class="sweepBar"></div></div>
      </div>`;
      return;
    }
    if (state.error) {
      nowEl.innerHTML = `<div class="err">${esc(state.error)}</div>`;
    } else if (state.nowPlaying) {
      // Signal meter: map the audible channel's level (helper power telemetry)
      // onto a bar. -35 dB = floor-ish, +5 dB = hot; clamp outside.
      const db = state.signalDb;
      const pct = db === null ? 0 : Math.max(0, Math.min(100, ((db + 35) / 40) * 100));
      nowEl.innerHTML = `<div class="active"><span class="dot"></span>ACTIVE</div>
        <div class="freq">${fmtFreq(state.nowPlaying.freq)}<span class="unit">MHz</span></div>
        <div class="tag">${esc(state.nowPlaying.alphaTag)}</div>
        <div class="meter"><div class="meterFill" style="width:${pct.toFixed(0)}%"></div></div>
        <div class="meterDb">${db === null ? "" : db.toFixed(1) + " dB"}</div>`;
    } else {
      nowEl.innerHTML = scanCount === 0
        ? `<div class="scanning"><div class="scanText standby">STANDBY</div>
           <div class="standbyHint">no channels enabled — check banks</div></div>`
        : `<div class="scanning">
        <div class="scanText">SCANNING</div>
        <div class="sweep"><div class="sweepBar"></div></div>
      </div>`;
    }
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
  }
  paintClock();
  setInterval(paintClock, 5000);

  // Weather: NWS via the backend cache; absent/failed = the block just hides.
  const wxEl = root.querySelector<HTMLElement>("#wx")!;

  const WX_ICONS: Record<string, string> = {
    sun: '<circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="4"/><line x1="12" y1="20" x2="12" y2="23"/><line x1="4.2" y1="4.2" x2="6.3" y2="6.3"/><line x1="17.7" y1="17.7" x2="19.8" y2="19.8"/><line x1="1" y1="12" x2="4" y2="12"/><line x1="20" y1="12" x2="23" y2="12"/><line x1="4.2" y1="19.8" x2="6.3" y2="17.7"/><line x1="17.7" y1="6.3" x2="19.8" y2="4.2"/>',
    moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z"/>',
    cloud: '<path d="M18 10h-1.3A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/>',
    cloudsun: '<path d="M12 2v2"/><path d="m4.9 4.9 1.4 1.4"/><path d="M20 12h2"/><path d="m19.1 4.9-1.4 1.4"/><path d="M15.5 8.5a4 4 0 0 0-7.4 1.8"/><path d="M16 16h.5a4.5 4.5 0 1 0-.4-9"/><path d="M7 16a4 4 0 0 0 0 8h8a4 4 0 0 0 .6-7.95"/>',
    rain: '<path d="M18 9h-1.3A8 8 0 1 0 9 19"/><line x1="11" y1="15" x2="10" y2="21"/><line x1="15" y1="15" x2="14" y2="21"/><line x1="19" y1="15" x2="18" y2="21"/>',
    storm: '<path d="M18 9h-1.3A8 8 0 1 0 9 19"/><polyline points="13 12 10 17 14 17 11 22"/>',
    snow: '<path d="M18 9h-1.3A8 8 0 1 0 9 19"/><line x1="11" y1="16" x2="11" y2="16.01"/><line x1="15" y1="16" x2="15" y2="16.01"/><line x1="13" y1="19" x2="13" y2="19.01"/><line x1="11" y1="22" x2="11" y2="22.01"/><line x1="15" y1="22" x2="15" y2="22.01"/>',
    fog: '<path d="M18 9h-1.3A8 8 0 1 0 9 17"/><line x1="6" y1="20" x2="20" y2="20"/><line x1="8" y1="23" x2="18" y2="23"/>',
    wind: '<path d="M9.6 4.6A2 2 0 1 1 11 8H2"/><path d="M12.6 19.4A2 2 0 1 0 14 16H2"/><path d="M17.7 7.7A2.5 2.5 0 1 1 19.5 12H2"/>',
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
    return `<svg class="wxIcon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${WX_ICONS[name]}</svg>`;
  }

  function paintWeather(): void {
    fetch("/api/weather")
      .then((r) => (r.ok ? r.json() : null))
      .then((wx: { tempF: number; condition: string; wind: string; isDaytime: boolean } | null) => {
        wxEl.innerHTML = wx
          ? `${wxIcon(wx.condition, wx.isDaytime)}<span class="wxTemp">${Math.round(wx.tempF)}°</span><span class="wxCond">${esc(wx.condition)}</span>${wx.wind ? `<span class="wxWind">${esc(wx.wind)}</span>` : ""}`
          : "";
      })
      .catch(() => {});
  }
  paintWeather();
  setInterval(paintWeather, 10 * 60 * 1000);

  api.getLogs().then((rows) => { state = { ...state, log: rows }; paint(); }).catch(() => {});
  const proto = location.protocol === "https:" ? "wss" : "ws";
  new ReconnectingWs(`${proto}://${location.host}/ws`, (ev) => {
    state = reduce(state, ev);
    if (ev.type === "status") paintBadge();
    paint();
  }).connect();
  paint();
}
