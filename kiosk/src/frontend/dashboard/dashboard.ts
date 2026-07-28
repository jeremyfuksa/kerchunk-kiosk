import type { EngineEvent } from "../../backend/engine/ScannerEngine.js";
import { ReconnectingWs } from "../lib/wsClient.js";
import { api } from "../lib/api.js";
import { fmtFreq, esc } from "../lib/format.js";
import icoVolumeX from "lucide-static/icons/volume-x.svg?raw";
import { alertTheme } from "./alertTheme.js";
import { mountActivityMap } from "../map/map.js";
import { matchesBank, spectrumLabelFor } from "../../backend/config/banks.js";
import type { Bank, Channel } from "../../backend/config/schema.js";
import "./dashboard.css";

export interface NowPlaying { freq: number; alphaTag: string; }
export interface LogRow { freq: number; alphaTag: string; ts: number; }
export interface AlertBanner { freq: number; alphaTag: string; until: number; counties?: string; }
export interface DashState {
  nowPlaying: NowPlaying | null;
  /** Channel ids in the currently-tuned window (drives the bank rail). */
  tunedIds: string[];
  /** Center frequency of the tuned window (drives the spectrum chip). */
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
  return { nowPlaying: null, tunedIds: [], tunedHz: null, alert: null, log: [], error: null, signalDb: null, engineState: "running", audibleDriven: false, warmed: true, warmupPhase: null, warmupStep: 0, warmupOf: 4 };
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
    case "tuned":
      return { ...s, tunedIds: ev.channelIds, tunedHz: ev.freqHz };
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
      <div id="systemRisk" class="systemRisk"></div>
      <div id="alertBar" class="alertBar"></div>
      <div class="dashBody">
        <section class="now" id="now"></section>
        <aside class="log"><h2>Recent</h2><ul id="logList"></ul></aside>
      </div>
      <div id="bankRail" class="bankRail"></div>
      <div id="bootMsg" class="bootMsg hidden">
        <div class="bootText">WARMING UP</div>
        <div class="bootBar"><div class="bootBarFill"></div></div>
        <div class="bootPhase"></div>
      </div>
    </div>`;
  // ── Poll budget ─────────────────────────────────────────────────────────
  // Three independent timers (status 5 s, system 10 s, weather 10 min) used to
  // collide every 10 s, and the appliance has been observed to deadlock on 2+
  // concurrent requests (see CLAUDE.md). One ticker now runs them strictly one
  // at a time. Cadences are the knobs.
  const POLL_MS = { status: 5_000, systemRisk: 10_000, weather: 600_000 };
  const POLL_TICK_MS = 1_000;
  type Poll = { run: () => Promise<void>; everyMs: number; lastAt: number };
  const polls: Poll[] = [];
  function poll(run: () => Promise<void>, everyMs: number): void {
    polls.push({ run, everyMs, lastAt: 0 });
  }
  let ticking = false;
  async function tick(): Promise<void> {
    if (ticking) return;
    ticking = true;
    try {
      for (const p of polls) {
        if (Date.now() - p.lastAt < p.everyMs) continue;
        p.lastAt = Date.now();
        await p.run().catch(() => {});
      }
    } finally { ticking = false; }
  }

  const dashEl = root.querySelector<HTMLElement>(".dash")!;
  const systemRisk = root.querySelector<HTMLElement>("#systemRisk")!;
  // True once the WebGL map mounts (the .mapStage layout). Under it, the Recent
  // log is display:none, so paint() skips rebuilding it.
  let mapMounted = false;
  void mountActivityMap(root.querySelector<HTMLElement>("#mapBase")!, { interactive: false })
    .then((mounted) => { if (mounted) { mapMounted = true; dashEl.classList.add("mapStage"); } })
    .catch(() => { /* no map = classic dashboard, nothing lost */ });
  let lastRiskSig = "";
  function paintSystemRisk(): Promise<void> {
    return fetch("/api/system").then((r) => r.ok ? r.json() : null).then((s) => {
      const severe = s?.alerts?.filter((a: { severity: string }) => a.severity === "severe") ?? [];
      const sig = severe.map((a: { title: string }) => a.title).join("|");
      if (sig === lastRiskSig) return; // unchanged — skip the innerHTML write (usually "")
      lastRiskSig = sig;
      systemRisk.innerHTML = severe.length
        ? `<strong>MACHINE WARNING</strong> ${severe.map((a: { title: string }) => esc(a.title)).join(" · ")}`
        : "";
      systemRisk.classList.toggle("on", severe.length > 0);
    }).catch(() => {});
  }
  poll(paintSystemRisk, POLL_MS.systemRisk);

  const nowEl = root.querySelector<HTMLElement>("#now")!;
  const logEl = root.querySelector<HTMLElement>("#logList")!;
  const modeBadge = root.querySelector<HTMLElement>("#modeBadge")!;
  // Badge follows the runtime mode — refreshed on engine status transitions
  // (mode flips always restart the engine), so MONITORING/WEATHER are never
  // stale on the kiosk screen (review finding: monitor mode was invisible).
  // Coalesce repaints to one per animation frame: a burst of WS events in a
  // single frame collapses to ONE paint() instead of N full renders.
  let rafPending = false;
  function schedule(): void {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => { rafPending = false; paint(); });
  }
  let lastMode: string | undefined;
  function paintBadge(): Promise<void> {
    return api.getStatus()
      .then((s) => {
        modeBadge.textContent =
          s.mode === "weather" ? "WEATHER"
          : s.mode === "monitor" ? "MONITORING" : "";
        const sc = s.scanCount ?? -1;
        const mu = s.muted ?? false;
        // Late-load correction ONLY: a page that opened after warm-up never sees
        // the WS warmup events, so trust the server flag. But once we've observed
        // the live WS warmup stream, IT is authoritative — otherwise an in-flight
        // poll (snapshotted warmed=true) could land after a fresh "booting" and
        // wrongly hide the overlay mid-restart.
        const wm = (!sawWarmupEvent && typeof s.warmed === "boolean") ? s.warmed : state.warmed;
        // The 5s poll usually reads identical values — only repaint on a change
        // (was 12 full now-card renders/min of byte-identical content).
        const changed = s.mode !== lastMode || sc !== scanCount || mu !== muted || wm !== state.warmed;
        lastMode = s.mode; scanCount = sc; muted = mu;
        if (wm !== state.warmed) state = { ...state, warmed: wm };
        if (changed) schedule();
      })
      .catch(() => {});
  }
  // Mute flips in the admin without an engine restart — polled so the kiosk's
  // MUTED badge tracks it within a few seconds.
  poll(paintBadge, POLL_MS.status);

  let scanCount = -1; // unknown until the first status fetch
  // Once the live WS warmup stream is seen, it owns `warmed` (the /api/status
  // poll stops correcting it) — prevents a stale in-flight poll from clobbering
  // a fresh booting/ready during a restart.
  let sawWarmupEvent = false;
  let muted = false;

  // ── Bank rail: hardware-scanner bank LEDs. Every bank collection is a chip;
  // the chips covering the currently-tuned window light up as the radio
  // hops (~groupDwellMs cadence). Needs the config snapshot for bank
  // predicates; status transitions refetch it (config edits restart the
  // engine, so the snapshot can never go stale silently).
  const railEl = root.querySelector<HTMLElement>("#bankRail")!;
  let cfgBanks: Bank[] = [];
  let cfgChannels: Channel[] = [];
  function loadBanks(): void {
    void api.getConfig().then((cfg) => {
      cfgBanks = cfg.banks ?? [];
      cfgChannels = cfg.channels ?? [];
      paintRail();
    }).catch(() => {});
  }
  loadBanks();

  function paintRail(): void {
    // Spectrum chip: computed from the tuned window's center — information
    // about WHERE in the spectrum the radio is, not a toggle.
    const spectrum = state.tunedHz !== null
      ? `<span class="bankChipK spectrum">${esc(spectrumLabelFor(state.tunedHz))} · ${(state.tunedHz / 1e6).toFixed(1)}</span>`
      : "";
    const tuned = cfgChannels.filter((c) => state.tunedIds.includes(c.id));
    const chips = cfgBanks.map((b) => {
      const lit = tuned.some((c) => matchesBank(c, b));
      return `<span class="bankChipK${lit ? " lit" : ""}">${esc(b.name)}</span>`;
    }).join("");
    railEl.innerHTML = spectrum + chips;
  }

  // ── Warm-up overlay: full-screen "WARMING UP" + stepped bar shown until the
  // engine reports a warm first sweep. Holds over the animating map (opaque, no
  // blur) so the kiosk doesn't present a live-looking but uncalibrated screen.
  const bootEl = root.querySelector<HTMLElement>("#bootMsg")!;
  const bootFill = bootEl.querySelector<HTMLElement>(".bootBarFill")!;
  const bootPhaseEl = bootEl.querySelector<HTMLElement>(".bootPhase")!;
  const BOOT_LABELS: Record<string, string> = {
    booting: "starting radio",
    spawning: "building signal processing",
    tuned: "acquiring channels",
    ready: "ready",
  };
  function paintBoot(): void {
    bootEl.classList.toggle("hidden", state.warmed);
    if (state.warmed) return;
    const pct = state.warmupOf > 0 ? Math.round((state.warmupStep / state.warmupOf) * 100) : 0;
    bootFill.style.transform = `scaleX(${pct / 100})`;
    bootPhaseEl.textContent = state.warmupPhase ? (BOOT_LABELS[state.warmupPhase] ?? state.warmupPhase) : BOOT_LABELS.booting!;
  }

  const alertEl = root.querySelector<HTMLElement>("#alertBar")!;
  let alertTimer: ReturnType<typeof setTimeout> | null = null;

  function paintAlert(): void {
    if (state.alert && Date.now() >= state.alert.until) {
      state = { ...state, alert: null };
    }
    if (state.alert) {
      // Lower-right overlay card: a header strip, then the alert TYPE big, then
      // the affected counties as a prominent second line (no frequency — the
      // NWR channel number means nothing to someone glancing across the room).
      // The theme (severity tier + storm kind) sets size, color, and icon; CSS
      // keys the palette off the `tier` class + `data-kind` attribute.
      const theme = alertTheme(state.alert.alphaTag);
      const tierLabel = theme.tier === "watch" ? "WATCH"
        : theme.tier === "statement" ? "STATEMENT" : "WARNING";
      alertEl.dataset.kind = theme.kind;
      alertEl.classList.remove("warning", "watch", "statement");
      alertEl.classList.add(theme.tier);
      alertEl.innerHTML = `<div class="alertHead">`
        + `<span class="alertGlyph">${theme.icon}</span>`
        + `<span class="alertLabel">${tierLabel}</span></div>`
        + `<div class="alertTag">${esc(state.alert.alphaTag)}</div>`
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

  // Now-card render. The chrome (ACTIVE/SCANNING/etc.) is rebuilt only when the
  // VIEW changes (channel hop, scanning<->active<->error). On repeat signal
  // ticks for the SAME channel we only nudge the meter width + dB on the
  // persistent nodes — far less DOM churn AND it lets the meter's CSS width
  // transition finally glide instead of snap (the node used to be recreated
  // every tick, killing the transition).
  let lastView: string | null = null;
  let meterFillEl: HTMLElement | null = null;
  let meterDbEl: HTMLElement | null = null;
  // Signal meter: -35 dB = floor-ish, +5 dB = hot; clamp outside.
  const meterPct = (db: number | null): string =>
    (db === null ? 0 : Math.max(0, Math.min(100, ((db + 35) / 40) * 100))).toFixed(0);

  function paint(): void {
    paintBoot();
    paintAlert();
    nowEl.classList.toggle("isMuted", muted);

    const view =
      (state.engineState === "starting" && !state.nowPlaying && !state.error) ? "retuning"
      : state.error ? `error:${state.error}`
      : state.nowPlaying ? `active:${state.nowPlaying.freq}:${state.nowPlaying.alphaTag}`
      : scanCount === 0 ? "standby" : "scanning";

    if (view === lastView && state.nowPlaying && meterFillEl && meterDbEl) {
      // Same active channel — surgical update, let the meter glide.
      const db = state.signalDb;
      meterFillEl.style.transform = `scaleX(${Number(meterPct(db)) / 100})`;
      meterDbEl.textContent = db === null ? "" : db.toFixed(1) + " dB";
    } else {
      lastView = view;
      meterFillEl = null; meterDbEl = null;
      if (view === "retuning") {
        nowEl.innerHTML = `<div class="scanning"><div class="scanText">RETUNING</div>
          <div class="sweep"><div class="sweepBar"></div></div></div>`;
      } else if (state.error) {
        nowEl.innerHTML = `<div class="err"><div>Radio error: ${esc(state.error)}</div>
          <div class="errHint">Scanning resumes automatically. If this stays up, restart the radio backend from the admin page.</div></div>`;
      } else if (state.nowPlaying) {
        const db = state.signalDb;
        // Tag-first hierarchy: the NAME reads across the room; freq supports it.
        const hero = state.nowPlaying.alphaTag || fmtFreq(state.nowPlaying.freq);
        const freqLine = state.nowPlaying.alphaTag
          ? `<div class="freq">${fmtFreq(state.nowPlaying.freq)}<span class="unit">MHz</span></div>`
          : "";
        nowEl.innerHTML = `<div class="active"><span class="dot"></span>ACTIVE</div>
          <div class="tag">${esc(hero)}</div>
          ${freqLine}
          <div class="meter"><div class="meterFill" style="transform:scaleX(${Number(meterPct(db)) / 100})"></div></div>
          <div class="meterDb">${db === null ? "" : db.toFixed(1) + " dB"}</div>`;
        meterFillEl = nowEl.querySelector<HTMLElement>(".meterFill");
        meterDbEl = nowEl.querySelector<HTMLElement>(".meterDb");
      } else {
        nowEl.innerHTML = scanCount === 0
          ? `<div class="scanning"><div class="scanText standby">STANDBY</div>
             <div class="standbyHint">No channels are enabled — turn a bank on in the admin.</div></div>`
          : `<div class="scanning"><div class="scanText">SCANNING</div>
             <div class="sweep"><div class="sweepBar"></div></div></div>`;
      }
    }
    syncMutedBadge();
    paintLog();
  }

  // MUTED badge: reconcile on every paint (works on both the rebuild and the
  // surgical path) instead of re-appending on each render.
  function syncMutedBadge(): void {
    const existing = nowEl.querySelector(".mutedBadge");
    if (muted && !existing) {
      const b = document.createElement("div");
      b.className = "mutedBadge";
      b.innerHTML = `${icoVolumeX} MUTED`;
      nowEl.appendChild(b);
    } else if (!muted && existing) {
      existing.remove();
    }
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
      : `<svg class="wxWindArrow" viewBox="0 0 24 24" fill="currentColor" style="transform:rotate(${(fromDeg + 180) % 360}deg)"><path d="M12 3l6 17-6-4-6 4z"/></svg>`;
    return `<span class="wxWind">${arrow}<span class="wxWindSpd">${speed}</span></span>`;
  }

  function paintWeather(): Promise<void> {
    return fetch("/api/weather")
      .then((r) => (r.ok ? r.json() : null))
      .then((wx: { tempF: number; condition: string; wind: string; isDaytime: boolean } | null) => {
        // Glanceable: condition ICON + temp NUMBER + wind arrow + speed. The
        // condition WORDS are dropped — the icon already says it from across the room.
        wxEl.innerHTML = wx
          ? `${wxIcon(wx.condition, wx.isDaytime)}<span class="wxTemp">${Math.round(wx.tempF)}°</span>${wx.wind ? windBlock(wx.wind) : ""}`
          : "";
      })
      .catch(() => {});
  }
  poll(paintWeather, POLL_MS.weather);

  api.getLogs().then((rows) => { state = { ...state, log: mergeLogs(state.log, rows) }; paint(); }).catch(() => {});
  const proto = location.protocol === "https:" ? "wss" : "ws";
  new ReconnectingWs(`${proto}://${location.host}/ws`, (ev) => {
    if (ev.type === "reload") { location.reload(); return; }
    if (ev.type === "warmup") sawWarmupEvent = true; // WS now owns `warmed`
    state = reduce(state, ev);
    if (ev.type === "status") { paintBadge(); loadBanks(); }
    if (ev.type === "tuned") paintRail();
    schedule(); // coalesce: a burst of events in one frame => one paint()
  }).connect();
  paint();

  // One timer drives every poll registered above, sequentially.
  setInterval(() => { void tick(); }, POLL_TICK_MS);
  void tick();
}
