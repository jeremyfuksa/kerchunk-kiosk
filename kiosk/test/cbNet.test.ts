import { describe, it, expect } from "vitest";
import { CbNet, type FernClientLike } from "../src/backend/fernsdr/cbNet.js";
import { cbNetConfig } from "../src/backend/config/cb.js";
import { defaultConfig } from "../src/backend/config/schema.js";
import type { FernEvent, FernClientOpts } from "../src/backend/fernsdr/client.js";
import type { EngineEvent } from "../src/backend/engine/ScannerEngine.js";

const LOW = 26_957_000, HIGH = 27_413_000, W = 456;
const row = (hot: number[] = []): FernEvent => {
  const levels = new Array<number>(W).fill(-100);
  for (const f of hot) levels[Math.floor(((f - LOW) / (HIGH - LOW)) * W)] = -70;
  return { type: "row", lowHz: LOW, highHz: HIGH, levels };
};

function rig() {
  const clients: Array<{ opts: FernClientOpts; emit: (e: FernEvent) => void; tunes: [number, string][]; started: number; stopped: number }> = [];
  const pcm: Buffer[] = [];
  let t = 0;
  const state = { retrying: true, offAir: null as { note: string | null; untilMs: number | null } | null };
  const net = new CbNet({
    writePcm: (b) => pcm.push(b),
    now: () => t,
    clientFactory: (opts, onEvent) => {
      const c = { opts, emit: onEvent, tunes: [] as [number, string][], started: 0, stopped: 0 };
      clients.push(c);
      const like: FernClientLike = {
        start: () => { c.started++; }, stop: () => { c.stopped++; },
        tune: (f, m) => { c.tunes.push([f, m]); },
        get connected() { return true; }, get error() { return null; }, get retrying() { return state.retrying; }, get offAir() { return state.offAir; },
      };
      return like;
    },
  });
  const events: EngineEvent[] = [];
  net.on((e) => events.push(e));
  const rows = (hot: number[], n: number) => { for (let i = 0; i < n; i++) { t += 100; clients.at(-1)!.emit(row(hot)); } };
  return { net, clients, pcm, events, rows, state, tick: (ms: number) => { t += ms; } };
}
const cfg = cbNetConfig(defaultConfig());
const CB19 = 27_185_000, CB38 = 27_385_000;

describe("CbNet", () => {
  it("opens a channel from the waterfall: tunes the receiver, emits active + audible", () => {
    const r = rig();
    r.net.start(cfg);
    r.rows([], 10);
    r.rows([CB19], 2);
    expect(r.clients[0]!.tunes).toEqual([[CB19, "am"]]);
    const active = r.events.find((e) => e.type === "active");
    expect(active).toMatchObject({ type: "active", freq: CB19, channel: { id: "cb_19", tags: ["cb"] } });
    expect(r.events.find((e) => e.type === "audible")).toMatchObject({ channel: { id: "cb_19" } });
  });

  it("38 tunes as LSB", () => {
    const r = rig();
    r.net.start(cfg);
    r.rows([], 10);
    r.rows([CB38], 2);
    expect(r.clients[0]!.tunes).toEqual([[CB38, "lsb"]]);
  });

  it("writes resampled PCM only while a channel is audible", () => {
    const r = rig();
    r.net.start(cfg);
    const audio: FernEvent = { type: "audio", samples: new Float32Array(128).fill(0.1), rate: 14_250 };
    r.clients[0]!.emit(audio);
    expect(r.pcm).toHaveLength(0);
    r.rows([], 10);
    r.rows([CB19], 2);
    for (let i = 0; i < 4; i++) r.clients[0]!.emit(audio);
    expect(r.pcm.length).toBeGreaterThan(0);
    const bytes = r.pcm.reduce((s, b) => s + b.length, 0);
    // (the newest 30 ms / 1500 samples are held back for the close fade)
    expect(Math.abs(bytes / 2 + 1500 - (512 * 50_000) / 14_250)).toBeLessThan(6);
  });

  it("meter → signal only while audible", () => {
    const r = rig();
    r.net.start(cfg);
    r.clients[0]!.emit({ type: "meter", dbfs: -90 });
    expect(r.events.some((e) => e.type === "signal")).toBe(false);
    r.rows([], 10);
    r.rows([CB19], 2);
    r.tick(300);
    r.clients[0]!.emit({ type: "meter", dbfs: -60 });
    expect(r.events.find((e) => e.type === "signal")).toMatchObject({ dbfs: -60 });
  });

  const audio = (v = 0.5): FernEvent => ({ type: "audio", samples: new Float32Array(128).fill(v), rate: 14_250 });
  const samples = (bufs: Buffer[]) => { const b = Buffer.concat(bufs); return Array.from({ length: b.length >> 1 }, (_, i) => b.readInt16LE(i * 2) / 32767); };

  it("AM audio stops audioTailMs after the last hot row though the channel is still open, ending in a fade to zero", () => {
    const r = rig();
    r.net.start(cfg);
    r.rows([], 10);
    r.rows([CB19], 3);
    for (let i = 0; i < 20; i++) r.clients[0]!.emit(audio());
    const flowing = r.pcm.length;
    expect(flowing).toBeGreaterThan(0);
    r.rows([], 2);                       // 200 ms after the last hot row: inside the 300 ms tail
    r.clients[0]!.emit(audio());
    expect(r.pcm.length).toBeGreaterThan(flowing);
    r.rows([], 2);                       // 400 ms: past it, but the 2 s hang hasn't released
    expect(r.events.some((e) => e.type === "release")).toBe(false);
    const after = r.pcm.length;
    const last = r.pcm.at(-1)!;
    expect(Math.abs(last.readInt16LE(last.length - 2)) / 32767).toBeLessThan(0.01);
    for (let i = 0; i < 20; i++) r.clients[0]!.emit(audio());
    expect(r.pcm.length).toBe(after);    // nothing more written
    const s = samples(r.pcm);
    expect(Math.max(...s)).toBeGreaterThan(0.45);   // full level before the fade
  });

  it("LSB keeps writing through its hang", () => {
    const r = rig();
    r.net.start(cfg);
    r.rows([], 10);
    r.rows([CB38], 3);
    r.rows([], 8);                       // 800 ms of silence, well past audioTailMs, inside ssbHangMs
    expect(r.events.some((e) => e.type === "release")).toBe(false);
    const before = r.pcm.length;
    for (let i = 0; i < 20; i++) r.clients[0]!.emit(audio());
    expect(r.pcm.length).toBeGreaterThan(before);
  });

  it("reopening the same channel does not re-tune the receiver", () => {
    const r = rig();
    r.net.start(cfg);
    r.rows([], 10);
    r.rows([CB19], 2);
    r.rows([], 30);                      // closes
    expect(r.events.some((e) => e.type === "release")).toBe(true);
    r.rows([CB19], 2);
    expect(r.events.filter((e) => e.type === "audible" && e.channel !== null)).toHaveLength(2);
    expect(r.clients[0]!.tunes).toEqual([[CB19, "am"]]);
  });

  it("passes staleMs to the client", () => {
    const r = rig();
    r.net.start({ ...cfg, staleMs: 4321 });
    expect(r.clients[0]!.opts.staleMs).toBe(4321);
  });

  it("close emits release then idle and audible null", () => {
    const r = rig();
    r.net.start(cfg);
    r.rows([], 10);
    r.rows([CB19], 2);
    r.rows([], 30);
    const tail = r.events.map((e) => e.type);
    expect(tail.slice(-3).sort()).toEqual(["audible", "idle", "release"]);
  });

  it("stop mid-transmission releases, closes the client, and writes no more PCM", () => {
    const r = rig();
    r.net.start(cfg);
    r.rows([], 10);
    r.rows([CB19], 2);
    r.net.stop();
    expect(r.events.some((e) => e.type === "release" && e.channelId === "cb_19")).toBe(true);
    expect(r.clients[0]!.stopped).toBe(1);
    const before = r.pcm.length;
    r.clients[0]!.emit({ type: "audio", samples: new Float32Array(128), rate: 14_250 });
    expect(r.pcm.length).toBe(before);
    expect(r.net.status()).toEqual({ connected: false, error: null, retrying: false, offAir: false, offAirUntil: null });
  });

  it("start() rebuilds a client that gave up (4001/4002, bad URL) instead of staying idempotent", () => {
    const r = rig();
    r.net.start(cfg);
    r.net.start(cfg);
    expect(r.clients).toHaveLength(1);
    r.state.retrying = false;
    r.net.start(cfg);
    expect(r.clients).toHaveLength(2);
    expect(r.clients[0]!.stopped).toBe(1);
    expect(r.clients[1]!.started).toBe(1);
  });

  it("pause keeps the client, releases, ignores rows; start resumes on the same client", () => {
    const r = rig();
    r.net.start(cfg);
    r.rows([], 10);
    r.rows([CB19], 2);
    r.net.pause();
    expect(r.clients[0]!.stopped).toBe(0);
    expect(r.events.some((e) => e.type === "release")).toBe(true);
    const n = r.events.length;
    r.rows([CB19], 5);
    expect(r.events.length).toBe(n);
    r.net.start(cfg);
    expect(r.clients).toHaveLength(1);
  });

  it("a url change reconnects; a same-config start is a no-op", () => {
    const r = rig();
    r.net.start(cfg);
    r.net.start(cfg);
    expect(r.clients).toHaveLength(1);
    r.net.start({ ...cfg, url: "ws://other:1/ws" });
    expect(r.clients).toHaveLength(2);
    expect(r.clients[0]!.stopped).toBe(1);
  });

  it("stop with two channels open: one idle, after both releases", () => {
    const r = rig();
    r.net.start(cfg);
    r.rows([], 10);
    r.rows([CB19, 27_125_000], 2);
    r.net.stop();
    const types = r.events.map((e) => e.type);
    expect(types.filter((x) => x === "idle")).toHaveLength(1);
    expect(types.lastIndexOf("release")).toBeLessThan(types.indexOf("idle"));
    expect(types.filter((x) => x === "release")).toHaveLength(2);
  });

  it("disconnect releases open channels", () => {
    const r = rig();
    r.net.start(cfg);
    r.rows([], 10);
    r.rows([CB19], 2);
    r.clients[0]!.emit({ type: "disconnected", reason: "x", retrying: true } as FernEvent);
    expect(r.events.some((e) => e.type === "release" && e.channelId === "cb_19")).toBe(true);
    expect(r.events.some((e) => e.type === "audible" && e.channel === null)).toBe(true);
    expect(r.events.at(-1)!.type).toBe("idle");
  });

  it("a throwing listener does not block stop() or other listeners", () => {
    const r = rig();
    r.net.on(() => { throw new Error("boom"); });
    const seen: string[] = [];
    r.net.on((e) => seen.push(e.type));
    r.net.start(cfg);
    r.rows([], 10);
    r.rows([CB19], 2);
    r.net.stop();
    expect(r.clients[0]!.stopped).toBe(1);
    expect(seen).toContain("release");
  });

  it("receiver off the air: releases + audible null + idle, no PCM, status carries offAir; onair resumes", () => {
    const r = rig();
    r.net.start(cfg);
    r.rows([], 10);
    r.rows([CB19], 2);
    expect(r.events.some((e) => e.type === "audible" && e.channel)).toBe(true);
    r.events.length = 0;
    r.state.offAir = { note: "now on 20 m", untilMs: 123_456 };
    r.clients[0]!.emit({ type: "offair", note: "now on 20 m", untilMs: 123_456 });
    expect(r.events.map((e) => e.type)).toEqual(expect.arrayContaining(["release", "audible", "idle"]));
    expect(r.events.find((e) => e.type === "audible")).toMatchObject({ channel: null });
    expect(r.net.status()).toMatchObject({ connected: true, offAir: true, offAirUntil: 123_456 });
    r.pcm.length = 0;
    const audio: FernEvent = { type: "audio", samples: new Float32Array(128).fill(0.1), rate: 14_250 };
    r.rows([CB19], 3);
    for (let i = 0; i < 4; i++) r.clients[0]!.emit(audio);
    expect(r.pcm).toHaveLength(0);
    r.state.offAir = null;
    r.clients[0]!.emit({ type: "onair" });
    expect(r.net.status()).toMatchObject({ offAir: false, offAirUntil: null });
  });
});
