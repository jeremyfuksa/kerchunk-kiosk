// Live radio state for the admin, as pure functions (the classic admin kept
// this in closure locals inside a 2,900-line function). Mirrors the classic
// Now panel's rules exactly: `audible` (speaker ownership) wins once seen;
// before that `active`/`idle` drive the display; `status` resets and resyncs.
import type { EngineEvent } from "../../backend/engine/ScannerEngine.js";
import type { Channel } from "../../backend/config/schema.js";
import { fmtFreq } from "../lib/format.js";

export interface Tuned { freq: number; alphaTag: string; mode?: Channel["mode"] }

export interface LiveState {
  mode: "scan" | "weather" | "monitor";
  breakIn: boolean;
  monitoring: Tuned | null;
  nowPlaying: Tuned | null;
  audibleDriven: boolean;
  weatherChannel: Tuned | null;
  muted: boolean;
  volume: number;
  remoteListening: boolean;
  dbfs: number | null;
  /** Backend process start (from /api/status) — uptime, and the
   *  system-action watcher's baseline. */
  startedAt: number | null;
}

export const initialLive: LiveState = {
  mode: "scan", breakIn: false, monitoring: null, nowPlaying: null, audibleDriven: false,
  weatherChannel: null, muted: false, volume: 100, remoteListening: false, dbfs: null,
  startedAt: null,
};

const tuned = (c: Channel): Tuned => ({ freq: c.freq, alphaTag: c.alphaTag, mode: c.mode });

export function reduceEvent(s: LiveState, ev: EngineEvent): { state: LiveState; resync: boolean; alert: boolean } {
  switch (ev.type) {
    case "audible":
      return { state: { ...s, audibleDriven: true, nowPlaying: ev.channel ? tuned(ev.channel) : null }, resync: false, alert: false };
    case "active":
      return s.audibleDriven ? { state: s, resync: false, alert: false }
        : { state: { ...s, nowPlaying: { ...tuned(ev.channel), freq: ev.freq } }, resync: false, alert: false };
    case "idle":
      return s.audibleDriven ? { state: s, resync: false, alert: false }
        : { state: { ...s, nowPlaying: null }, resync: false, alert: false };
    case "status":
      return { state: { ...s, nowPlaying: null, audibleDriven: false }, resync: true, alert: false };
    case "signal":
      return { state: { ...s, dbfs: ev.dbfs }, resync: false, alert: false };
    case "alert":
      return { state: s, resync: false, alert: true };
    default:
      return { state: s, resync: false, alert: false };
  }
}

export function withStatus(s: LiveState, st: { mode: LiveState["mode"]; monitor: Channel | null; breakIn?: boolean; startedAt?: number }): LiveState {
  return {
    ...s,
    mode: st.mode,
    breakIn: st.breakIn === true,
    monitoring: st.mode === "monitor" && st.monitor ? tuned(st.monitor) : null,
    startedAt: typeof st.startedAt === "number" ? st.startedAt : s.startedAt,
  };
}

export function withAudio(s: LiveState, a: { volume: number; muted: boolean; remoteListening?: boolean }): LiveState {
  return { ...s, volume: a.volume, muted: a.muted, remoteListening: a.remoteListening ?? false };
}

export interface LcdView {
  // "detail": a Library channel shown on the glass — static, no meter
  state: "live" | "scanning" | "monitor" | "weather" | "breakin" | "detail";
  meta: string;
  name: string;
  freq: string;
  silent: "Muted" | "Volume 0" | null;
  canLock: boolean;
}

const label = (t: Tuned): string => t.alphaTag || fmtFreq(t.freq);
const modeTag = (t: Tuned): string => (t.mode ? ` · ${t.mode.toUpperCase()}` : "");

export function lcdView(s: LiveState): LcdView {
  const silent = s.muted ? "Muted" : s.volume === 0 ? "Volume 0" : null;
  if (s.monitoring) {
    return { state: "monitor", meta: `Listening to one channel${modeTag(s.monitoring)}`, name: label(s.monitoring), freq: fmtFreq(s.monitoring.freq), silent, canLock: false };
  }
  if (s.mode === "weather") {
    const wx = s.weatherChannel;
    return {
      state: s.breakIn ? "breakin" : "weather",
      meta: s.breakIn ? "Weather alert" : "Weather only",
      name: wx ? label(wx) : "NOAA weather",
      freq: wx ? fmtFreq(wx.freq) : "",
      silent, canLock: false,
    };
  }
  if (s.nowPlaying) {
    return { state: "live", meta: `Live${modeTag(s.nowPlaying)}`, name: label(s.nowPlaying), freq: fmtFreq(s.nowPlaying.freq), silent, canLock: true };
  }
  return { state: "scanning", meta: "Scanning", name: "Scanning…", freq: "", silent, canLock: false };
}

/** Identity of what the LCD shows, minus the signal level: the Radio tab
 *  rebuilds the LCD markup only when this changes (dbfs moves ~4×/s during a
 *  transmission and is patched in place instead). `canLock` is derived from
 *  `state`, so it isn't part of the key. */
export function lcdKey(v: LcdView): string {
  return [v.state, v.meta, v.name, v.freq, v.silent ?? ""].join("\u0000");
}
