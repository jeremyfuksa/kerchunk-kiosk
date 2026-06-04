import type { EngineEvent } from "../../backend/engine/ScannerEngine.js";
import { ReconnectingWs } from "../lib/wsClient.js";
import { api } from "../lib/api.js";
import "./dashboard.css";

export interface NowPlaying { freq: number; alphaTag: string; }
export interface LogRow { freq: number; alphaTag: string; ts: number; }
export interface DashState { nowPlaying: NowPlaying | null; log: LogRow[]; error: string | null; }

export function initialState(): DashState {
  return { nowPlaying: null, log: [], error: null };
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
        nowPlaying: { freq: ev.freq, alphaTag: ev.channel.alphaTag },
        log: [{ freq: ev.freq, alphaTag: ev.channel.alphaTag, ts: ev.ts }, ...s.log].slice(0, 100),
      };
    case "idle":
      return { ...s, error: null, nowPlaying: null };
    case "error":
      return { ...s, error: ev.message };
    case "status":
      return ev.state === "running" ? { ...s, error: null } : s;
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
      nowEl.innerHTML = `<div class="active">● ACTIVE</div>
        <div class="freq">${fmtFreq(state.nowPlaying.freq)}</div>
        <div class="tag">${esc(state.nowPlaying.alphaTag)}</div>`;
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
