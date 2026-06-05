import type { Channel } from "../config/schema.js";

export interface ScanConfig {
  channels: Channel[];
  sampleRate: number;
  squelchLevel: number;
  dwellMs: number;
  gain: number | "auto";
  audioSink: string;
  // Wideband engine tuning (optional; RtlFmEngine/FakeEngine ignore these).
  windowBandwidthHz?: number;
  groupDwellMs?: number;
  openAboveFloorDb?: number;
  noiseQuietDb?: number;
  // Monitor mode (weather-only): hold the channel open and audible with NO
  // squelch. A lone continuously-keyed station (NOAA) can't be squelched
  // against its own carrier — and the operator chose to listen to exactly
  // this channel, so gating it is wrong anyway.
  monitor?: boolean;
  // Close Call (wideband only): discover + play strong non-configured
  // transmissions in the window. knownHz suppression is built from ALL
  // config channels by the engine.
  closeCall?: boolean;
  closeCallDb?: number;
  lockoutHz?: number[];
  // Frequencies Close Call must never fire on (channels + discoveries +
  // lockouts). Computed by the server, which owns all three lists.
  knownHz?: number[];
}

export type EngineState = "stopped" | "starting" | "running" | "error";

export type EngineEvent =
  | { type: "active"; channel: Channel; freq: number; ts: number }
  // Which channel OWNS THE SPEAKER right now (null = silence). Distinct from
  // "active": the wideband engine monitors many channels at once, so several
  // can be active while exactly one is audible (first-active-wins hold).
  // RtlFmEngine never emits this — there, active IS audible.
  | { type: "audible"; channel: Channel | null; ts: number }
  // Per-channel squelch close (idle fires only when ALL channels close) —
  // lets history pair openings with closings for durations.
  | { type: "release"; channelId: string; ts: number }
  | { type: "idle"; ts: number }
  // Close Call discovery: strong RF on a non-configured frequency in the
  // tuned window. The server persists it as a disabled channel; any audio
  // from it arrives via normal active/audible events (synthesized channel).
  | { type: "closecall"; freqHz: number; ts: number }
  // Leveler telemetry: a channel's learned loudness trim changed. The server
  // persists it (channel.levelTrimDb) so trims survive hops and restarts.
  | { type: "level"; channelId: string; db: number; ts: number }
  | { type: "signal"; dbfs: number; ts: number }
  // The engine (re)tuned its window: which channels are under demod RIGHT
  // NOW. Fires on every group hop (~groupDwellMs) — drives the kiosk's
  // bank indicator (which bank is being scanned, hardware-scanner style).
  | { type: "tuned"; freqHz: number; channelIds: string[]; ts: number }
  // Alert fired (ROADMAP Idea 6): a hit on a channel flagged alert, outside
  // its cooldown. Synthesized by the SERVER (which owns alert config), not
  // the engine — it rides the same union so the WS hub and dashboards treat
  // it like any other event.
  | { type: "alert"; channel: Channel; freq: number; holdSeconds: number; ts: number }
  | { type: "status"; state: EngineState; ts: number }
  // Operator pressed "Reload kiosk" in the admin: dashboard pages reload
  // themselves (fresh JS/CSS/map style without touching the display
  // service). Synthesized by the server, like "alert".
  | { type: "reload"; ts: number }
  | { type: "error"; code: string; message: string; ts: number };

export type EngineListener = (event: EngineEvent) => void;

export interface ScannerEngine {
  start(config: ScanConfig): Promise<void>;
  stop(): Promise<void>;
  /** Bump the current audio: force-close the audible channel (scanner SKIP key). A long holdoffSeconds = temp lockout. Optional — engines without live audio control may omit it. */
  skip?(holdoffSeconds?: number): void;
  /** Update Close Call suppression live (no restart, no audio impact). Optional. */
  updateKnownHz?(knownHz: number[]): void;
  /** Alert pull-in: open a see-only channel's audio for holdSeconds (its lane is already demodulating — this just routes it to the speaker). Optional. */
  alertUnmute?(channelId: string, holdSeconds: number): void;
  setVolume(percent: number): Promise<void>;
  setMuted(muted: boolean): Promise<void>;
  readonly state: EngineState;
  on(listener: EngineListener): void;
  off(listener: EngineListener): void;
}
