// Owns the live radio state for admin-next: one WebSocket (the same feed the
// dashboard uses; the hub replays the current audible channel on connect),
// plus /api/status and the audio slice of /api/config, merged through the
// pure reducers in live.ts. Every consumer (LCD, keys, mini-player) renders
// from `state` via subscribe — one source, no drift between them.
import { api } from "../lib/api.js";
import { ReconnectingWs } from "../lib/wsClient.js";
import { initialLive, reduceEvent, withAudio, withStatus, type LiveState } from "./live.js";

export class LiveStore {
  state: LiveState = initialLive;
  private readonly subs = new Set<(s: LiveState) => void>();
  private readonly alertSubs = new Set<() => void>();

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
      if (r.resync) void this.syncStatus();
      if (r.alert) for (const fn of this.alertSubs) fn();
    }).connect();
  }

  async syncStatus(): Promise<void> {
    try { this.set(withStatus(this.state, await api.getStatus())); } catch { /* transient */ }
  }

  async syncAudio(): Promise<void> {
    try { this.set(withAudio(this.state, (await api.getConfig()).audio)); } catch { /* transient */ }
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
