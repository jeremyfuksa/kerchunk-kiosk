import type { Channel } from "../config/schema.js";

export interface ScanConfig {
  channels: Channel[];
  sampleRate: number;
  squelchLevel: number;
  gain: number | "auto";
  audioSink: string;
}

export type EngineState = "stopped" | "starting" | "running" | "error";

export type EngineEvent =
  | { type: "active"; channel: Channel; freq: number; ts: number }
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
