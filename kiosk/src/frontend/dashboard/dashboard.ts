import type { EngineEvent } from "../../backend/engine/ScannerEngine.js";
import { ReconnectingWs } from "../lib/wsClient.js";
import { api } from "../lib/api.js";
import "./dashboard.css";

export interface NowPlaying { freq: number; alphaTag: string; }
export interface LogRow { freq: number; alphaTag: string; ts: number; }
export interface DashState {
  nowPlaying: NowPlaying | null;
  log: LogRow[];
  error: string | null;
  /** Latest signal level (dB) of the audible channel; null when silent. */
  signalDb: number | null;
  // True once an "audible" event has been seen: the engine reports speaker
  // ownership explicitly (wideband), so "active" stops driving nowPlaying —
  // many channels can be active while exactly one is audible. RtlFm never
  // emits audible, so there active keeps driving (its active IS audible).
  audibleDriven: boolean;
}

export function initialState(): DashState {
  return { nowPlaying: null, log: [], error: null, signalDb: null, audibleDriven: false };
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
        ? { ...s, error: null, nowPlaying: null, signalDb: null, audibleDriven: false }
        : { ...s, nowPlaying: null, signalDb: null, audibleDriven: false };
    default:
      return s;
  }
}

function fmtFreq(hz: number): string { return (hz / 1e6).toFixed(3); }
function fmtTime(ts: number): string { return new Date(ts).toLocaleTimeString(); }

// alphaTag and error messages are operator-supplied (typed in admin, persisted
// to config) and rendered via innerHTML, so escape them to prevent stored XSS.
export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export function renderDashboard(root: HTMLElement): void {
  let state = initialState();

  root.innerHTML = `
    <div class="dash">
      <div id="modeBadge" class="modeBadge"></div>
      <section class="now" id="now"></section>
      <aside class="log"><h2>Recent</h2><ul id="logList"></ul></aside>
    </div>`;
  const nowEl = root.querySelector<HTMLElement>("#now")!;
  const logEl = root.querySelector<HTMLElement>("#logList")!;
  const modeBadge = root.querySelector<HTMLElement>("#modeBadge")!;
  api.getStatus()
    .then((s) => { modeBadge.textContent = s.mode === "weather" ? "WEATHER" : ""; })
    .catch(() => {});

  function paint(): void {
    if (state.error) {
      nowEl.innerHTML = `<div class="err">${esc(state.error)}</div>`;
    } else if (state.nowPlaying) {
      // Signal meter: map the audible channel's level (helper power telemetry)
      // onto a bar. -35 dB = floor-ish, +5 dB = hot; clamp outside.
      const db = state.signalDb;
      const pct = db === null ? 0 : Math.max(0, Math.min(100, ((db + 35) / 40) * 100));
      nowEl.innerHTML = `<div class="active">● ACTIVE</div>
        <div class="freq">${fmtFreq(state.nowPlaying.freq)}</div>
        <div class="tag">${esc(state.nowPlaying.alphaTag)}</div>
        <div class="meter"><div class="meterFill" style="width:${pct.toFixed(0)}%"></div></div>
        <div class="meterDb">${db === null ? "" : db.toFixed(1) + " dB"}</div>`;
    } else {
      nowEl.innerHTML = `<div class="scanning">scanning…</div>`;
    }
    logEl.innerHTML = state.log
      .map((r) => `<li><span class="t">${fmtTime(r.ts)}</span> ${fmtFreq(r.freq)} ${esc(r.alphaTag)}</li>`)
      .join("");
  }

  api.getLogs().then((rows) => { state = { ...state, log: rows }; paint(); }).catch(() => {});
  const proto = location.protocol === "https:" ? "wss" : "ws";
  new ReconnectingWs(`${proto}://${location.host}/ws`, (ev) => { state = reduce(state, ev); paint(); }).connect();
  paint();
}
