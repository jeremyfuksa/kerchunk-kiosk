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
