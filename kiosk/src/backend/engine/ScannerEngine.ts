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
}

export type EngineState = "stopped" | "starting" | "running" | "error";

export type EngineEvent =
  | { type: "active"; channel: Channel; freq: number; ts: number }
  // Which channel OWNS THE SPEAKER right now (null = silence). Distinct from
  // "active": the wideband engine monitors many channels at once, so several
  // can be active while exactly one is audible (first-active-wins hold).
  // RtlFmEngine never emits this — there, active IS audible.
  | { type: "audible"; channel: Channel | null; ts: number }
  | { type: "idle"; ts: number }
  // Close Call discovery: strong RF on a non-configured frequency in the
  // tuned window. The server persists it as a disabled channel; any audio
  // from it arrives via normal active/audible events (synthesized channel).
  | { type: "closecall"; freqHz: number; ts: number }
  | { type: "signal"; dbfs: number; ts: number }
  | { type: "status"; state: EngineState; ts: number }
  | { type: "error"; code: string; message: string; ts: number };

export type EngineListener = (event: EngineEvent) => void;

export interface ScannerEngine {
  start(config: ScanConfig): Promise<void>;
  stop(): Promise<void>;
  setVolume(percent: number): Promise<void>;
  setMuted(muted: boolean): Promise<void>;
  readonly state: EngineState;
  on(listener: EngineListener): void;
  off(listener: EngineListener): void;
}
