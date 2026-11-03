import { describe, it, expect, afterEach, vi } from "vitest";
import request from "supertest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, isSharedActivity, nothingToShed, toScanConfig } from "../src/backend/server.js";
import { ModeStore } from "../src/backend/modeStore.js";
import { ReceptionLog } from "../src/backend/hf/receptionLog.js";
import { ConfigStore } from "../src/backend/config/ConfigStore.js";
import { ActivityLog } from "../src/backend/activityLog.js";
import { HistoryStore } from "../src/backend/history.js";
import { WsHub } from "../src/backend/ws.js";
import { FakeEngine } from "../src/backend/engine/FakeEngine.js";
import { configSchema, defaultConfig } from "../src/backend/config/schema.js";

const TOR = "EAS: ZCZC-WXR-TOR-029047+0030-1561800-KEAX/NWS-";
const EOM = "EAS: NNNN";
const FIRST = 2_397_500;   // 120 m window
const spy = { host: "airspy.local", port: 5555, audioBufferMs: 500 };
let dir: string;
let history: HistoryStore | undefined;

async function app(withSpy = true) {
  dir = mkdtempSync(join(tmpdir(), "khf-"));
  const engine = new FakeEngine();
  history = new HistoryStore({ path: ":memory:" });
  const { server, bootScanConfig } = createServer({
    configStore: new ConfigStore(join(dir, "config.json")), engine, activityLog: new ActivityLog(100),
    wsHub: new WsHub(), staticDir: dir, modeStore: new ModeStore(join(dir, "mode.json")), history,
  });
  const c = (await request(server).get("/api/config")).body;
  await request(server).put("/api/config").send({
    ...c, ...(withSpy ? { spyserver: { host: "airspy.local" } } : {}),
    weatherChannel: { id: "wx", freq: 162_550_000, alphaTag: "NWR", mode: "nfm", enabled: true },
  });
  await request(server).post("/api/channels").send({ freq: 145_130_000, alphaTag: "SCAN", mode: "nfm", enabled: true });
  await request(server).post("/api/scan/start");
  return { server, engine, bootScanConfig };
}
const last = (e: FakeEngine) => e.tunes.at(-1)!;
afterEach(() => { vi.useRealTimers(); if (dir) rmSync(dir, { recursive: true, force: true }); });

describe("toScanConfig hf", () => {
  const cfg = { ...defaultConfig(), spyserver: spy };
  it("a sweep window has no channels until a station is chosen", () => {
    const s = toScanConfig(cfg, "hf", null, { stage: "sweep", centerHz: FIRST, listenHz: null, band: "120m" });
    expect(s.channels).toEqual([]);
    expect(s.fixedCenterHz).toBe(FIRST);
    expect(s.spyserver).toEqual(spy);
    expect(s.closeCall).toBe(false);
    expect(s.sweepRanges).toEqual([]);
    expect(s.sameEnable).toBe(false);
  });
  it("a chosen station is one AM channel held open, tagged hf", () => {
    const s = toScanConfig(cfg, "hf", null, { stage: "sweep", centerHz: FIRST, listenHz: 2_350_000, band: "120m" });
    expect(s.monitor).toBe(true);
    expect(s.channels).toHaveLength(1);
    expect(s.channels[0]).toMatchObject({ freq: 2_350_000, mode: "am", audible: true, tags: ["hf"], alphaTag: "2350 kHz" });
    expect(s.fixedCenterHz).toBe(FIRST);
  });
  it("a CB hold is CB, with no fixed center", () => {
    const s = toScanConfig(cfg, "hf", null, { stage: "cb", centerHz: 27_195_000, listenHz: null, band: "CB" });
    expect(s.channels[0]?.tags).toEqual(["cb"]);
    expect(s.fixedCenterHz).toBeUndefined();
    expect(s.monitor).toBe(false);
  });
  it("has nothing to shed when overheated", () => {
    const c = defaultConfig();
    c.scan.closeCall = true;
    expect(nothingToShed(c, "hf")).toBe(true);
  });
  it("config.hf validates", () => {
    expect(configSchema.safeParse({ ...defaultConfig(), hf: { windowMs: 60_000, minListenDb: 15 } }).success).toBe(true);
    expect(configSchema.safeParse({ ...defaultConfig(), hf: { windowMs: 100 } }).success).toBe(false);
    expect(configSchema.safeParse({ ...defaultConfig(), hf: { bands: [{ name: "x", loHz: 5, hiHz: 1 }] } }).success).toBe(false);
  });
});

describe("POST /api/mode hf", () => {
  it("is refused with no SpyServer configured", async () => {
    const { server } = await app(false);
    expect((await request(server).post("/api/mode").send({ mode: "hf" })).status).toBe(400);
  });

  it("starts the sweep on the first window, and reports it in status", async () => {
    const { server, engine } = await app();
    const res = await request(server).post("/api/mode").send({ mode: "hf" });
    expect(res.body.mode).toBe("hf");
    expect(last(engine).fixedCenterHz).toBe(FIRST);
    const s = (await request(server).get("/api/status")).body;
    expect(s.mode).toBe("hf");
    expect(s.hf).toMatchObject({ stage: "sweep", band: "120m", centerHz: FIRST, listenHz: null });
  });

  it("status has no hf block outside HF mode", async () => {
    const { server } = await app();
    expect((await request(server).get("/api/status")).body.hf).toBeUndefined();
  });

  it("a survey picks the station, and the window timer moves on", async () => {
    const { server, engine } = await app();
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    await request(server).post("/api/mode").send({ mode: "hf" });
    const center = last(engine).fixedCenterHz!;
    engine.emitCarriers(center, [{ hz: center - 2_500, db: 40 }]);
    expect(last(engine).channels[0]?.freq).toBe(center - 2_500);
    vi.advanceTimersByTime(61_000);
    expect(last(engine).fixedCenterHz).not.toBe(center);
    expect(last(engine).channels).toEqual([]);
    vi.useRealTimers();
  });

  it("status names the likely station while one plays", async () => {
    dir = mkdtempSync(join(tmpdir(), "khf-"));
    const engine = new FakeEngine();
    const { server } = createServer({
      configStore: new ConfigStore(join(dir, "config.json")), engine, activityLog: new ActivityLog(10),
      wsHub: new WsHub(), staticDir: dir,
      hfCandidates: (hz) => hz === 2_350_000 ? [{ station: "Radio X", country: "Y" }, { station: "Other" }] : [],
    });
    const c = (await request(server).get("/api/config")).body;
    await request(server).put("/api/config").send({ ...c, spyserver: { host: "airspy.local" } });
    await request(server).post("/api/channels").send({ freq: 145_130_000, alphaTag: "S", mode: "nfm", enabled: true });
    await request(server).post("/api/scan/start");
    await request(server).post("/api/mode").send({ mode: "hf" });
    engine.emitCarriers(2_397_500, [{ hz: 2_400_000, db: 60 }, { hz: 2_350_000, db: 30 }]);
    const s = (await request(server).get("/api/status")).body;
    expect(s.hf.listenHz).toBe(2_350_000);     // matched plays ahead of the stronger unidentified
    expect(s.hf.candidate).toMatchObject({ station: "Radio X" });
    expect(s.hf.others).toEqual(["Other"]);
    await request(server).post("/api/mode").send({ mode: "scan" });
  });

  it("a utility station's schedule entry doesn't jump the queue", async () => {
    dir = mkdtempSync(join(tmpdir(), "khf-"));
    const engine = new FakeEngine();
    const { server } = createServer({
      configStore: new ConfigStore(join(dir, "config.json")), engine, activityLog: new ActivityLog(10),
      wsHub: new WsHub(), staticDir: dir,
      hfCandidates: (hz) => hz === 2_350_000 ? [{ station: "Navy USB/FSK" }] : [],
    });
    const c = (await request(server).get("/api/config")).body;
    await request(server).put("/api/config").send({ ...c, spyserver: { host: "airspy.local" } });
    await request(server).post("/api/channels").send({ freq: 145_130_000, alphaTag: "S", mode: "nfm", enabled: true });
    await request(server).post("/api/scan/start");
    await request(server).post("/api/mode").send({ mode: "hf" });
    engine.emitCarriers(2_397_500, [{ hz: 2_400_000, db: 60 }, { hz: 2_350_000, db: 30 }]);
    expect((await request(server).get("/api/status")).body.hf.listenHz).toBe(2_400_000);
    await request(server).post("/api/mode").send({ mode: "scan" });
  });

  it("skip moves on early", async () => {
    const { server, engine } = await app();
    await request(server).post("/api/mode").send({ mode: "hf" });
    await request(server).post("/api/scan/skip");
    expect(last(engine).fixedCenterHz).not.toBe(FIRST);
  });

  it("leaving HF stops the sweep: no more retunes", async () => {
    const { server, engine } = await app();
    await request(server).post("/api/mode").send({ mode: "hf" });
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    await request(server).post("/api/mode").send({ mode: "scan" });
    const n = engine.tunes.length;
    vi.advanceTimersByTime(200_000);
    engine.emitCarriers(FIRST, [{ hz: FIRST - 2_500, db: 40 }]);
    expect(engine.tunes.length).toBe(n);
    vi.useRealTimers();
  });

  it("a SAME break-in pauses the sweep and resumes the same window after EOM", async () => {
    const { server, engine } = await app();
    await request(server).post("/api/mode").send({ mode: "hf" });
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date", "setTimeout", "clearTimeout"] });
    engine.emitSame(TOR);
    expect(last(engine).channels[0]?.freq).toBe(162_550_000);
    expect(last(engine).spyserver).toBeUndefined();
    const n = engine.tunes.length;
    vi.advanceTimersByTime(70_000);      // well past the window timer
    engine.emitCarriers(FIRST, [{ hz: FIRST - 2_500, db: 40 }]);
    expect(engine.tunes.length).toBe(n);   // the sweep doesn't drive the radio during the alert
    engine.emitSame(EOM);
    vi.advanceTimersByTime(9_000);
    expect(last(engine).fixedCenterHz).toBe(FIRST);
    expect(last(engine).spyserver?.host).toBe("airspy.local");
    vi.useRealTimers();
    expect((await request(server).get("/api/status")).body.mode).toBe("hf");
  });

  it("the sweep isn't stranded on a break-in: its timer runs again afterward", async () => {
    const { server, engine } = await app();
    await request(server).post("/api/mode").send({ mode: "hf" });
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date", "setTimeout", "clearTimeout"] });
    engine.emitSame(TOR);
    engine.emitSame(EOM);
    vi.advanceTimersByTime(9_000);
    vi.advanceTimersByTime(61_000);
    expect(last(engine).fixedCenterHz).not.toBe(FIRST);
    vi.useRealTimers();
    await request(server).post("/api/mode").send({ mode: "scan" });
  });

  it("selecting weather during an HF break-in doesn't strand the sweep when the alert ends", async () => {
    const { server, engine } = await app();
    await request(server).post("/api/mode").send({ mode: "hf" });
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date", "setTimeout", "clearTimeout"] });
    engine.emitSame(TOR);
    await request(server).post("/api/mode").send({ mode: "weather" });
    engine.emitSame(EOM);
    vi.advanceTimersByTime(9_000);
    vi.useRealTimers();
    const s = (await request(server).get("/api/status")).body;
    expect(s.mode).toBe("weather");        // the operator's choice wins over the revert
    expect(s.breakIn).toBe(false);
    await request(server).post("/api/mode").send({ mode: "scan" });
  });

  it("a stopped engine stays stopped: the sweep doesn't restart it", async () => {
    const { server, engine } = await app();
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    await request(server).post("/api/mode").send({ mode: "hf" });
    await request(server).post("/api/scan/stop");
    const n = engine.tunes.length;
    vi.advanceTimersByTime(70_000);
    expect(engine.tunes.length).toBe(n);
    expect(engine.state).toBe("stopped");
    vi.useRealTimers();
  });

  it("a CB hold only triggers on the channels it would tune", async () => {
    const { server, engine } = await app();
    const c = (await request(server).get("/api/config")).body;
    await request(server).put("/api/config").send({ ...c, cb: { channels: [19] }, hf: { cbOpenMs: 0, bands: [{ name: "49m", loHz: 5_900_000, hiHz: 6_200_000 }] } });
    await request(server).post("/api/mode").send({ mode: "hf" });
    await request(server).post("/api/scan/skip");
    engine.emitCarriers(27_195_000, [{ hz: 27_255_000, db: 40 }]);
    expect((await request(server).get("/api/status")).body.hf.stage).toBe("cbStop");
    engine.emitCarriers(27_195_000, [{ hz: 27_185_000, db: 40 }]);
    expect((await request(server).get("/api/status")).body.hf.stage).toBe("cb");
    await request(server).post("/api/mode").send({ mode: "scan" });
  });

  it("a reception log failure doesn't take down the event path", async () => {
    dir = mkdtempSync(join(tmpdir(), "khf-"));
    const engine = new FakeEngine();
    const receptionLog = new ReceptionLog({ path: ":memory:" });
    const { server } = createServer({
      configStore: new ConfigStore(join(dir, "config.json")), engine, activityLog: new ActivityLog(10),
      wsHub: new WsHub(), staticDir: dir, receptionLog,
    });
    const c = (await request(server).get("/api/config")).body;
    await request(server).put("/api/config").send({ ...c, spyserver: { host: "airspy.local" } });
    await request(server).post("/api/channels").send({ freq: 145_130_000, alphaTag: "S", mode: "nfm", enabled: true });
    await request(server).post("/api/scan/start");
    await request(server).post("/api/mode").send({ mode: "hf" });
    receptionLog.close();
    expect(() => engine.emitCarriers(FIRST, [{ hz: FIRST - 2_500, db: 40 }])).not.toThrow();
    expect((await request(server).get("/api/status")).body.hf.listenHz).toBe(FIRST - 2_500);
    await request(server).post("/api/mode").send({ mode: "scan" });
  });

  it("restart returns to HF", async () => {
    const a = await app();
    await request(a.server).post("/api/mode").send({ mode: "hf" });
    const engine = new FakeEngine();
    const b = createServer({
      configStore: new ConfigStore(join(dir, "config.json")), engine, activityLog: new ActivityLog(100),
      wsHub: new WsHub(), staticDir: dir, modeStore: new ModeStore(join(dir, "mode.json")),
    });
    expect((await request(b.server).get("/api/status")).body.mode).toBe("hf");
    expect(b.bootScanConfig().fixedCenterHz).toBe(FIRST);
    await request(b.server).post("/api/mode").send({ mode: "scan" });
  });

  it("a saved HF mode falls back to scan if SpyServer was removed", async () => {
    dir = mkdtempSync(join(tmpdir(), "khf-"));
    new ModeStore(join(dir, "mode.json")).save({ mode: "hf", monitor: null });
    const b = createServer({
      configStore: new ConfigStore(join(dir, "config.json")), engine: new FakeEngine(), activityLog: new ActivityLog(100),
      wsHub: new WsHub(), staticDir: dir, modeStore: new ModeStore(join(dir, "mode.json")),
    });
    expect((await request(b.server).get("/api/status")).body.mode).toBe("scan");
  });

  it("shortwave never reaches /api/logs or the activity history", async () => {
    const { server, engine } = await app();
    await request(server).post("/api/mode").send({ mode: "hf" });
    const ch = { id: "hf_2350000", freq: 2_350_000, alphaTag: "2350 kHz", mode: "am" as const, enabled: true, tags: ["hf"] };
    engine.emitActive(ch);
    expect(isSharedActivity({ channel: ch })).toBe(false);
    expect(isSharedActivity({ channel: { tags: ["cb"] } })).toBe(true);
    expect((await request(server).get("/api/history")).body).toEqual([]);
    await request(server).post("/api/mode").send({ mode: "scan" });
  });
});
