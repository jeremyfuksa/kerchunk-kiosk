import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../src/backend/server.js";
import { ConfigStore } from "../src/backend/config/ConfigStore.js";
import { ActivityLog } from "../src/backend/activityLog.js";
import { WsHub } from "../src/backend/ws.js";
import { FakeEngine } from "../src/backend/engine/FakeEngine.js";

let dir: string;
function makeApp() {
  dir = mkdtempSync(join(tmpdir(), "ksrv-"));
  const configStore = new ConfigStore(join(dir, "config.json"));
  const engine = new FakeEngine();
  const activityLog = new ActivityLog(100);
  const wsHub = new WsHub();
  const { server } = createServer({ configStore, engine, activityLog, wsHub, staticDir: dir });
  return { server, engine, configStore };
}
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("HTTP API", () => {
  it("GET /api/config returns the current config", async () => {
    const { server } = makeApp();
    const res = await request(server).get("/api/config");
    expect(res.status).toBe(200);
    expect(res.body.version).toBe(1);
  });

  it("POST /api/channels adds a channel and persists it", async () => {
    const { server } = makeApp();
    const res = await request(server)
      .post("/api/channels")
      .send({ freq: 145130000, alphaTag: "KC0KW", mode: "nfm", enabled: true });
    expect(res.status).toBe(201);
    expect(res.body.id).toBeTruthy();
    const after = await request(server).get("/api/channels");
    expect(after.body.length).toBe(1);
  });

  it("restarts the scanner when channels change so edits take effect live", async () => {
    const { server, engine } = makeApp();
    let starts = 0;
    const realStart = engine.start.bind(engine);
    engine.start = async (cfg) => { starts++; return realStart(cfg); };
    await request(server)
      .post("/api/channels")
      .send({ freq: 162400000, alphaTag: "WX", mode: "nfm", enabled: true });
    expect(starts).toBeGreaterThan(0); // engine was (re)started with the new list
    // The freshly added channel is what the engine would scan.
    const chans = (await request(server).get("/api/channels")).body;
    expect(chans[0].freq).toBe(162400000);
  });

  it("PUT /api/config rejects an invalid body with 400", async () => {
    const { server } = makeApp();
    const res = await request(server).put("/api/config").send({ nope: true });
    expect(res.status).toBe(400);
  });

  it("POST /api/audio/volume accepts and persists the level", async () => {
    const { server } = makeApp();
    const res = await request(server).post("/api/audio/volume").send({ percent: 55 });
    expect(res.status).toBe(200);
    expect(res.body.volume).toBe(55);
    // Persisted: a fresh read reflects the new level.
    const cfg = await request(server).get("/api/config");
    expect(cfg.body.audio.volume).toBe(55);
  });

  it("GET /api/status returns engine state", async () => {
    const { server } = makeApp();
    const res = await request(server).get("/api/status");
    expect(res.status).toBe(200);
    expect(res.body.state).toBeTruthy();
  });

  it("GET /api/status includes the current mode (defaults to scan)", async () => {
    const { server } = makeApp();
    const res = await request(server).get("/api/status");
    expect(res.status).toBe(200);
    expect(res.body.mode).toBe("scan");
  });

  it("GET /api/logs returns an array", async () => {
    const { server } = makeApp();
    const res = await request(server).get("/api/logs");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  const WX = { freq: 162550000, alphaTag: "NOAA WX", mode: "nfm", enabled: true };

  it("PUT /api/weather-channel saves and assigns an id", async () => {
    const { server } = makeApp();
    const res = await request(server).put("/api/weather-channel").send(WX);
    expect(res.status).toBe(200);
    expect(res.body.weatherChannel.id).toMatch(/^wx_/);
    expect(res.body.weatherChannel.freq).toBe(162550000);
    const cfg = await request(server).get("/api/config");
    expect(cfg.body.weatherChannel.freq).toBe(162550000);
  });

  it("GET /api/weather-channel returns null when none is configured", async () => {
    const { server } = makeApp();
    const res = await request(server).get("/api/weather-channel");
    expect(res.status).toBe(200);
    expect(res.body.weatherChannel).toBeNull();
  });

  it("GET /api/weather-channel returns the saved channel after a PUT", async () => {
    const { server } = makeApp();
    await request(server).put("/api/weather-channel").send({ freq: 162550000, alphaTag: "NOAA WX", mode: "nfm", enabled: true });
    const res = await request(server).get("/api/weather-channel");
    expect(res.status).toBe(200);
    expect(res.body.weatherChannel.freq).toBe(162550000);
    expect(res.body.weatherChannel.id).toMatch(/^wx_/);
  });

  it("PUT /api/weather-channel rejects an invalid body with 400", async () => {
    const { server } = makeApp();
    const res = await request(server).put("/api/weather-channel").send({ freq: -1, alphaTag: "x", mode: "fm", enabled: true });
    expect(res.status).toBe(400);
  });

  it("POST /api/mode weather holds the weather channel (engine restarted, single channel)", async () => {
    const { server, engine } = makeApp();
    await request(server).put("/api/weather-channel").send(WX);
    let lastStartChannels: any[] | null = null;
    const realStart = engine.start.bind(engine);
    engine.start = async (cfg) => { lastStartChannels = cfg.channels; return realStart(cfg); };
    const res = await request(server).post("/api/mode").send({ mode: "weather" });
    expect(res.status).toBe(200);
    expect(res.body.mode).toBe("weather");
    expect(lastStartChannels).toHaveLength(1);
    expect(lastStartChannels![0].freq).toBe(162550000);
    expect(lastStartChannels![0].enabled).toBe(true);
  });

  it("POST /api/mode weather with NO weather channel returns 400 and does not switch", async () => {
    const { server } = makeApp();
    const res = await request(server).post("/api/mode").send({ mode: "weather" });
    expect(res.status).toBe(400);
    const st = await request(server).get("/api/status");
    expect(st.body.mode).toBe("scan");
  });

  it("POST /api/mode scan restarts the engine with the scan channel list", async () => {
    const { server, engine } = makeApp();
    await request(server).post("/api/channels").send({ freq: 145130000, alphaTag: "A", mode: "nfm", enabled: true });
    let lastStartChannels: any[] | null = null;
    const realStart = engine.start.bind(engine);
    engine.start = async (cfg) => { lastStartChannels = cfg.channels; return realStart(cfg); };
    const res = await request(server).post("/api/mode").send({ mode: "scan" });
    expect(res.status).toBe(200);
    expect(res.body.mode).toBe("scan");
    expect(lastStartChannels![0].freq).toBe(145130000);
  });

  it("POST /api/mode rejects an invalid mode value with 400", async () => {
    const { server } = makeApp();
    const res = await request(server).post("/api/mode").send({ mode: "banana" });
    expect(res.status).toBe(400);
  });
});

describe("wideband config passthrough", () => {
  it("passes scan.windowBandwidthHz/groupDwellMs/openAboveFloorDb through to engine.start", async () => {
    const { server, engine } = makeApp();
    const cfg = (await request(server).get("/api/config")).body;
    cfg.scan.windowBandwidthHz = 1_500_000;
    cfg.scan.groupDwellMs = 4000;
    cfg.scan.openAboveFloorDb = 12;
    cfg.scan.noiseQuietDb = -84;
    expect((await request(server).put("/api/config").send(cfg)).status).toBe(200);

    let lastStart: any = null;
    const realStart = engine.start.bind(engine);
    engine.start = async (sc) => { lastStart = sc; return realStart(sc); };
    await request(server).post("/api/scan/start");
    expect(lastStart.windowBandwidthHz).toBe(1_500_000);
    expect(lastStart.groupDwellMs).toBe(4000);
    expect(lastStart.openAboveFloorDb).toBe(12);
    expect(lastStart.noiseQuietDb).toBe(-84);
  });
});

describe("PUT /api/channels/:id (table inline edit)", () => {
  const CH = { freq: 464275000, alphaTag: "WOF", mode: "nfm", enabled: true };

  it("updates fields, persists, and restarts the engine", async () => {
    const { server, engine } = makeApp();
    const created = (await request(server).post("/api/channels").send(CH)).body;
    let starts = 0;
    const realStart = engine.start.bind(engine);
    engine.start = async (sc) => { starts++; return realStart(sc); };
    const res = await request(server)
      .put(`/api/channels/${created.id}`)
      .send({ alphaTag: "WOF Maint", priority: true });
    expect(res.status).toBe(200);
    expect(res.body.alphaTag).toBe("WOF Maint");
    expect(res.body.priority).toBe(true);
    expect(res.body.freq).toBe(464275000); // untouched fields survive
    expect(starts).toBe(1);
    const after = await request(server).get("/api/channels");
    expect(after.body[0].priority).toBe(true);
  });

  it("404s on an unknown id", async () => {
    const { server } = makeApp();
    const res = await request(server).put("/api/channels/nope").send({ alphaTag: "x" });
    expect(res.status).toBe(404);
  });

  it("400s on an invalid patch", async () => {
    const { server } = makeApp();
    const created = (await request(server).post("/api/channels").send(CH)).body;
    const res = await request(server).put(`/api/channels/${created.id}`).send({ freq: -5 });
    expect(res.status).toBe(400);
  });
});

describe("weather mode under wideband (monitor flag)", () => {
  it("POST /api/mode weather starts the engine with monitor: true; scan mode without", async () => {
    const { server, engine } = makeApp();
    await request(server).put("/api/weather-channel")
      .send({ freq: 162550000, alphaTag: "NOAA", mode: "nfm", enabled: true });
    let lastStart: any = null;
    const realStart = engine.start.bind(engine);
    engine.start = async (sc) => { lastStart = sc; return realStart(sc); };
    await request(server).post("/api/mode").send({ mode: "weather" });
    expect(lastStart.monitor).toBe(true);
    await request(server).post("/api/mode").send({ mode: "scan" });
    expect(lastStart.monitor).toBe(false);
  });
});

describe("close call auto-add", () => {
  it("a closecall event adds a DISABLED channel without restarting the engine", async () => {
    const { server, engine } = makeApp();
    let starts = 0;
    const realStart = engine.start.bind(engine);
    engine.start = async (sc) => { starts++; return realStart(sc); };
    engine.emitCloseCall(462887500);
    await new Promise((r) => setTimeout(r, 20));
    const channels = (await request(server).get("/api/channels")).body;
    const cc = channels.find((c: { freq: number }) => c.freq === 462887500);
    expect(cc).toBeTruthy();
    expect(cc.enabled).toBe(false);
    expect(cc.alphaTag).toBe("Close Call 462.8875");
    expect(starts).toBe(0); // disabled channel: no engine restart
  });

  it("does not re-add an existing frequency", async () => {
    const { server, engine } = makeApp();
    await request(server).post("/api/channels")
      .send({ freq: 462887500, alphaTag: "Known", mode: "nfm", enabled: true });
    engine.emitCloseCall(462887500);
    await new Promise((r) => setTimeout(r, 20));
    const channels = (await request(server).get("/api/channels")).body;
    expect(channels.filter((c: { freq: number }) => c.freq === 462887500)).toHaveLength(1);
  });
});

describe("POST /api/scan/skip", () => {
  it("forwards to the engine", async () => {
    const { server, engine } = makeApp();
    const res = await request(server).post("/api/scan/skip");
    expect(res.status).toBe(200);
    expect((engine as { skips?: number }).skips).toBe(1);
  });
});

describe("close call RepeaterBook enrichment", () => {
  it("renames the filed channel when the frequency matches a repeater", async () => {
    dir = mkdtempSync(join(tmpdir(), "ksrv-"));
    const configStore = new ConfigStore(join(dir, "config.json"));
    const engine = new FakeEngine();
    const lookup = {
      lookup: async (freqHz: number) =>
        freqHz === 462675000
          ? { callsign: "WQXX123", city: "Kansas City", state: "MO", pl: "141.3", tag: "WQXX123 Kansas City MO · PL 141.3" }
          : null,
    };
    const { server } = createServer({ configStore, engine, activityLog: new ActivityLog(10), wsHub: new WsHub(), staticDir: dir, lookup });
    engine.emitCloseCall(462675000);
    await new Promise((r) => setTimeout(r, 30));
    const channels = (await request(server).get("/api/channels")).body;
    const cc = channels.find((c: { freq: number }) => c.freq === 462675000);
    expect(cc.alphaTag).toBe("WQXX123 Kansas City MO · PL 141.3 (Close Call)");
    expect(cc.enabled).toBe(false);
  });

  it("keeps the plain name on a miss", async () => {
    dir = mkdtempSync(join(tmpdir(), "ksrv-"));
    const configStore = new ConfigStore(join(dir, "config.json"));
    const engine = new FakeEngine();
    const lookup = { lookup: async () => null };
    const { server } = createServer({ configStore, engine, activityLog: new ActivityLog(10), wsHub: new WsHub(), staticDir: dir, lookup });
    engine.emitCloseCall(464175000);
    await new Promise((r) => setTimeout(r, 30));
    const channels = (await request(server).get("/api/channels")).body;
    expect(channels.find((c: { freq: number }) => c.freq === 464175000).alphaTag).toBe("Close Call 464.1750");
  });
});
