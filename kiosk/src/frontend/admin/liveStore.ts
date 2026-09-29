// Owns the live radio state for the admin: one WebSocket (the same feed the
// dashboard uses; the hub replays the current audible channel on connect),
// plus /api/status and the audio slice of /api/config, merged through the
// pure reducers in live.ts. Every consumer (LCD, keys, mini-player) renders
// from `state` via subscribe — one source, no drift between them.
import { api } from "../lib/api.js";
import { ReconnectingWs } from "../lib/wsClient.js";
import { initialLive, reduceEvent, withStatus, type LiveState } from "./live.js";

export class LiveStore {
  state: LiveState = initialLive;
  private readonly subs = new Set<(s: LiveState) => void>();
  private readonly alertSubs = new Set<() => void>();

  // Set when a WS `status` event says the store needs a fresh /api/status —
  // never fetched directly from here. This appliance deadlocks on concurrent
  // requests, so the resync rides the same sequential Poller as everything
  // else; a poll with `when: () => live.resyncPending` picks this up within
  // one tick (1s).
  resyncPending = true;
  requestResync(): void { this.resyncPending = true; }
  /** When /api/status was last fetched — the status poll also runs on a
   *  minimum cadence, in case a WS event was missed. */
  statusAt = Number.NEGATIVE_INFINITY;
  statusDue(now: number, everyMs: number): boolean {
    return this.resyncPending || now - this.statusAt >= everyMs;
  }

  subscribe(fn: (s: LiveState) => void): () => void {
    this.subs.add(fn); fn(this.state);
    return () => this.subs.delete(fn);
  }
  onAlert(fn: () => void): void { this.alertSubs.add(fn); }

  set(patch: Partial<LiveState>): void {
    this.state = { ...this.state, ...patch };
    for (const fn of this.subs) fn(this.state);
  }

  connect(): void {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    new ReconnectingWs(`${proto}://${location.host}/ws`, (ev) => {
      const r = reduceEvent(this.state, ev);
      if (r.state !== this.state) this.set(r.state);
      if (r.resync) this.requestResync();
      if (r.alert) for (const fn of this.alertSubs) fn();
    }, { onOpen: () => this.onSocketOpen() }).connect();
  }

  /** (Re)connected: anything that happened while the socket was down is
   *  lost, so drop what's playing (the hub replays the current audible
   *  channel on connect) and queue a sequential /api/status resync. */
  onSocketOpen(): void {
    this.set({ nowPlaying: null, audibleDriven: false });
    this.requestResync();
  }

  async syncStatus(now = Date.now()): Promise<void> {
    this.resyncPending = false;
    this.statusAt = now;
    try { this.set(withStatus(this.state, await api.getStatus())); } catch { /* transient */ }
  }

  // In-browser listening: one <audio> on the endless-WAV stream, recreated per
  // press (reusing a stalled element resumes seconds in the past). Shared by
  // the Radio key and the mini-player.
  private stream: HTMLAudioElement | null = null;
  get streaming(): boolean { return this.stream !== null; }
  toggleStream(): void {
    if (this.stream) { this.stream.pause(); this.stream.src = ""; this.stream = null; }
    else if (this.state.remoteListening) {
      const a = new Audio(`/api/stream.wav?t=${Date.now()}`);
      this.stream = a;
      void a.play().catch(() => { if (this.stream === a) { this.stream = null; this.set({}); } });
    }
    this.set({});
  }

  async loadWeatherChannel(): Promise<void> {
    try {
      const { weatherChannel: w } = await api.getWeatherChannel();
      this.set({ weatherChannel: w ? { freq: w.freq, alphaTag: w.alphaTag, mode: w.mode } : null });
    } catch { /* transient */ }
  }
}
