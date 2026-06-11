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
import { HistoryStore } from "../src/backend/history.js";

let dir: string;
function makeApp() {
  dir = mkdtempSync(join(tmpdir(), "ksrv-"));
  const configStore = new ConfigStore(join(dir, "config.json"));
  const engine = new FakeEngine();
  const activityLog = new ActivityLog(100);
  const wsHub = new WsHub();
  const { server } = createServer({ configStore, engine, activityLog, wsHub, staticDir: dir });
  return { server, engine, configStore, wsHub };
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

  it("GET /api/system includes a health verdict and core count", async () => {
    const { server } = makeApp();
    const res = await request(server).get("/api/system");
    expect(res.status).toBe(200);
    expect(res.body.health).toBeDefined();
    expect(["healthy", "stressed", "trouble"]).toContain(res.body.health.verdict);
    expect(typeof res.body.health.reason).toBe("string");
    expect(typeof res.body.coreCount).toBe("number");
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

  it("POST /api/channels rejects a duplicate non-GMRS frequency with 409", async () => {
    const { server } = makeApp();
    await request(server).post("/api/channels")
      .send({ freq: 146520000, alphaTag: "FIRST", mode: "nfm", enabled: true });
    const dup = await request(server).post("/api/channels")
      .send({ freq: 146520000, alphaTag: "SECOND", mode: "nfm", enabled: true });
    expect(dup.status).toBe(409);
    expect(dup.body.conflictsWith.alphaTag).toBe("FIRST");
  });

  it("POST /api/channels ALLOWS a duplicate GMRS frequency", async () => {
    const { server } = makeApp();
    await request(server).post("/api/channels")
      .send({ freq: 462550000, alphaTag: "GMRS-A", mode: "nfm", enabled: true });
    const dup = await request(server).post("/api/channels")
      .send({ freq: 462550000, alphaTag: "GMRS-B", mode: "nfm", enabled: true });
    expect(dup.status).toBe(201);
  });

  it("PUT /api/channels/:id rejects moving onto an occupied non-GMRS freq", async () => {
    const { server } = makeApp();
    await request(server).post("/api/channels")
      .send({ freq: 146520000, alphaTag: "A", mode: "nfm", enabled: true });
    const b = await request(server).post("/api/channels")
      .send({ freq: 147000000, alphaTag: "B", mode: "nfm", enabled: true });
    const moved = await request(server).put(`/api/channels/${b.body.id}`)
      .send({ freq: 146520000 });
    expect(moved.status).toBe(409);
  });

  it("PUT /api/channels/:id can edit a channel without colliding with itself", async () => {
    const { server } = makeApp();
    const a = await request(server).post("/api/channels")
      .send({ freq: 146520000, alphaTag: "A", mode: "nfm", enabled: true });
    const edit = await request(server).put(`/api/channels/${a.body.id}`)
      .send({ alphaTag: "A2" });
    expect(edit.status).toBe(200);
    expect(edit.body.alphaTag).toBe("A2");
  });

  it("GET /api/channels/duplicates lists non-GMRS duplicate sets, richest first", async () => {
    // The block rule (Task 2) stops NEW dupes via the API, so duplicates only
    // pre-exist in configs that predate the rule. Seed that state by writing
    // the config store directly, then read it back through a fresh server.
    const { configStore } = makeApp();
    const cfg = configStore.load();
    configStore.save({ ...cfg, channels: [
      { id: "a", freq: 146520000, alphaTag: "BARE", mode: "nfm", enabled: true },
      { id: "b", freq: 146520000, alphaTag: "RICH", mode: "nfm", enabled: true, location: { lat: 39, lon: -94, source: "test" } },
      { id: "g1", freq: 462550000, alphaTag: "G1", mode: "nfm", enabled: true },
      { id: "g2", freq: 462550000, alphaTag: "G2", mode: "nfm", enabled: true },
    ] });
    // createServer reads the store at construction; build the server AFTER the seed.
    const { server } = createServer({
      configStore, engine: new FakeEngine(), activityLog: new ActivityLog(100),
      wsHub: new WsHub(), staticDir: dir,
    });
    const res = await request(server).get("/api/channels/duplicates");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1); // GMRS pair excluded
    expect(res.body[0].freq).toBe(146520000);
    expect(res.body[0].channels[0].channel.id).toBe("b"); // richest first
  });

  it("POST /api/channels/duplicates/resolve keeps the richest, deletes losers, spares GMRS", async () => {
    // Seed pre-existing dupes in the store, THEN build the server — createServer
    // snapshots config at construction (server.ts: `let config = configStore.load()`).
    const { configStore } = makeApp();
    const cfg = configStore.load();
    configStore.save({ ...cfg, channels: [
      { id: "a", freq: 146520000, alphaTag: "BARE", mode: "nfm", enabled: true },
      { id: "b", freq: 146520000, alphaTag: "RICH", mode: "nfm", enabled: true, location: { lat: 39, lon: -94, source: "test" } },
      { id: "g1", freq: 462550000, alphaTag: "G1", mode: "nfm", enabled: true },
      { id: "g2", freq: 462550000, alphaTag: "G2", mode: "nfm", enabled: true },
    ] });
    const { server } = createServer({
      configStore, engine: new FakeEngine(), activityLog: new ActivityLog(100),
      wsHub: new WsHub(), staticDir: dir,
    });
    const res = await request(server).post("/api/channels/duplicates/resolve");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ removed: 1, setsResolved: 1 });
    const after = (await request(server).get("/api/channels")).body as Array<{ id: string }>;
    const ids = after.map((c) => c.id).sort();
    expect(ids).toEqual(["b", "g1", "g2"]); // bare "a" deleted; GMRS pair untouched
  });

  it("resolve is a no-op when there are no duplicates", async () => {
    const { server } = makeApp();
    await request(server).post("/api/channels")
      .send({ freq: 146520000, alphaTag: "ONLY", mode: "nfm", enabled: true });
    const res = await request(server).post("/api/channels/duplicates/resolve");
    expect(res.body).toEqual({ removed: 0, setsResolved: 0 });
  });

  it("resolve on a 3-row duplicate set removes both losers, keeps the richest", async () => {
    const { configStore } = makeApp();
    const cfg = configStore.load();
    configStore.save({ ...cfg, channels: [
      { id: "x1", freq: 151000000, alphaTag: "BARE1", mode: "nfm", enabled: true },
      { id: "x2", freq: 151000000, alphaTag: "BARE2", mode: "nfm", enabled: true },
      { id: "x3", freq: 151000000, alphaTag: "RICH", mode: "nfm", enabled: true, location: { lat: 39, lon: -94, source: "test" } },
    ] });
    const { server } = createServer({
      configStore, engine: new FakeEngine(), activityLog: new ActivityLog(100),
      wsHub: new WsHub(), staticDir: dir,
    });
    const res = await request(server).post("/api/channels/duplicates/resolve");
    expect(res.body).toEqual({ removed: 2, setsResolved: 1 });
    const after = (await request(server).get("/api/channels")).body as Array<{ id: string }>;
    expect(after.map((c) => c.id)).toEqual(["x3"]); // only the richest survives
  });

  it("resolve is idempotent — a second call removes nothing", async () => {
    const { configStore } = makeApp();
    const cfg = configStore.load();
    configStore.save({ ...cfg, channels: [
      { id: "a", freq: 152000000, alphaTag: "A", mode: "nfm", enabled: true },
      { id: "b", freq: 152000000, alphaTag: "B", mode: "nfm", enabled: true },
    ] });
    const { server } = createServer({
      configStore, engine: new FakeEngine(), activityLog: new ActivityLog(100),
      wsHub: new WsHub(), staticDir: dir,
    });
    const first = await request(server).post("/api/channels/duplicates/resolve");
    expect(first.body.removed).toBe(1);
    const second = await request(server).post("/api/channels/duplicates/resolve");
    expect(second.body).toEqual({ removed: 0, setsResolved: 0 });
  });

  it("GET /api/stream.wav 404s 'remote listening disabled' by default", async () => {
    const { server } = makeApp();
    const res = await request(server).get("/api/stream.wav");
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("remote listening disabled");
  });

  it("GET /api/stream.wav passes the flag gate once enabled", async () => {
    const { server } = makeApp();
    const cfg = (await request(server).get("/api/config")).body;
    await request(server).put("/api/config").send({ ...cfg, audio: { ...cfg.audio, remoteListening: true } });
    const res = await request(server).get("/api/stream.wav");
    // FakeEngine has no onAudio tee, so the route now falls through to the
    // engine-capability 404 — proving the remote-listening gate was passed.
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("engine has no audio tee");
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

describe("SAME weather break-in", () => {
  const COVERED = "EAS: ZCZC-WXR-SVR-029047-029165-029095+0030-1561800-KEAX/NWS-";

  it("retunes (no restart) and rides the banner with the covered counties", async () => {
    const { server, engine, wsHub } = makeApp();
    await request(server).put("/api/weather-channel")
      .send({ freq: 162550000, alphaTag: "NOAA", mode: "nfm", enabled: true });
    // Scope to Clay + Platte: Jackson (also in the alert) must be dropped.
    await request(server).put("/api/config").send({
      ...(await request(server).get("/api/config")).body,
      alerts: { sameFips: ["029047", "029165"] },
    });
    // Engine must be live for a retune to re-point in place (a stopped engine
    // has no graph and would fall back to start) — matches the booted appliance.
    await request(server).post("/api/scan/start");

    let starts = 0;
    const realStart = engine.start.bind(engine);
    engine.start = async (sc) => { starts++; return realStart(sc); };
    const alerts: any[] = [];
    const realBroadcast = wsHub.broadcast.bind(wsHub);
    wsHub.broadcast = (m: any) => { if (m.type === "alert") alerts.push(m); return realBroadcast(m); };

    engine.emitSame(COVERED);
    await new Promise((r) => setTimeout(r, 10));

    // The break-in was applied via retune, NOT a stop()+start() (no warm-up
    // overlay, no cold-start chop).
    expect(engine.retunes.length).toBe(1);
    expect(engine.retunes[0]!.monitor).toBe(true);
    expect(starts).toBe(0);
    // The banner carries the alert type + the COVERED counties only.
    expect(alerts).toHaveLength(1);
    expect(alerts[0].channel.alphaTag).toBe("SEVERE THUNDERSTORM WARNING");
    expect(alerts[0].counties).toBe("Clay, Platte");
  });

  it("an out-of-area alert neither retunes nor banners", async () => {
    const { server, engine, wsHub } = makeApp();
    await request(server).put("/api/weather-channel")
      .send({ freq: 162550000, alphaTag: "NOAA", mode: "nfm", enabled: true });
    await request(server).put("/api/config").send({
      ...(await request(server).get("/api/config")).body,
      alerts: { sameFips: ["020091"] }, // Johnson KS only — alert is all MO
    });
    const alerts: any[] = [];
    const realBroadcast = wsHub.broadcast.bind(wsHub);
    wsHub.broadcast = (m: any) => { if (m.type === "alert") alerts.push(m); return realBroadcast(m); };

    engine.emitSame(COVERED);
    await new Promise((r) => setTimeout(r, 10));

    expect(engine.retunes.length).toBe(0);
    expect(alerts).toHaveLength(0);
  });
});

describe("close call filing", () => {
  it("filing a discovery never restarts the engine", async () => {
    const { server, engine } = makeApp();
    let starts = 0;
    const realStart = engine.start.bind(engine);
    engine.start = async (sc) => { starts++; return realStart(sc); };
    engine.emitCloseCall(462887500);
    engine.emitCloseCall(462887500); // persistence-before-filing: second hit files
    await new Promise((r) => setTimeout(r, 20));
    expect((await request(server).get("/api/config")).body.discoveries).toHaveLength(1);
    expect(starts).toBe(0);
  });

  it("a frequency already configured as a channel is not filed as a discovery", async () => {
    const { server, engine } = makeApp();
    await request(server).post("/api/channels")
      .send({ freq: 462887500, alphaTag: "Known", mode: "nfm", enabled: true });
    engine.emitCloseCall(462887500);
    engine.emitCloseCall(462887500); // persistence-before-filing: second hit files
    await new Promise((r) => setTimeout(r, 20));
    expect((await request(server).get("/api/config")).body.discoveries ?? []).toHaveLength(0);
  });
});

describe("POST /api/scan/skip", () => {
  it("forwards to the engine", async () => {
    const { server, engine } = makeApp();
    const res = await request(server).post("/api/scan/skip");
    expect(res.status).toBe(200);
    expect((engine as { skips?: number }).skips).toBe(1);
  });

  it("passes holdoffSeconds through (temp lockout)", async () => {
    const { server, engine } = makeApp();
    const res = await request(server).post("/api/scan/skip")
      .send({ holdoffSeconds: 1800 });
    expect(res.status).toBe(200);
    expect((engine as { lastHoldoff?: number }).lastHoldoff).toBe(1800);
  });
});

describe("close call RepeaterBook enrichment", () => {
  it("renames the filed DISCOVERY when the frequency matches a repeater", async () => {
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
    engine.emitCloseCall(462675000); // persistence-before-filing: second hit files
    await new Promise((r) => setTimeout(r, 30));
    const d = (await request(server).get("/api/config")).body.discoveries
      .find((x: { freq: number }) => x.freq === 462675000);
    expect(d.alphaTag).toBe("WQXX123 Kansas City MO · PL 141.3");
  });

  it("keeps the plain name on a miss", async () => {
    dir = mkdtempSync(join(tmpdir(), "ksrv-"));
    const configStore = new ConfigStore(join(dir, "config.json"));
    const engine = new FakeEngine();
    const lookup = { lookup: async () => null };
    const { server } = createServer({ configStore, engine, activityLog: new ActivityLog(10), wsHub: new WsHub(), staticDir: dir, lookup });
    engine.emitCloseCall(464175000);
    engine.emitCloseCall(464175000); // persistence-before-filing: second hit files
    await new Promise((r) => setTimeout(r, 30));
    const d = (await request(server).get("/api/config")).body.discoveries
      .find((x: { freq: number }) => x.freq === 464175000);
    expect(d.alphaTag).toBe("Close Call 464.1750");
  });
});

describe("leveler trim persistence (server)", () => {
  it("a level event saves the channel's trim WITHOUT restarting the engine", async () => {
    const { server, engine } = makeApp();
    const created = (await request(server).post("/api/channels")
      .send({ freq: 464275000, alphaTag: "WOF", mode: "nfm", enabled: true })).body;
    let starts = 0;
    const realStart = engine.start.bind(engine);
    engine.start = async (sc) => { starts++; return realStart(sc); };
    engine.emitLevel(created.id, -8.5);
    await new Promise((r) => setTimeout(r, 20));
    const channels = (await request(server).get("/api/channels")).body;
    expect(channels[0].levelTrimDb).toBe(-8.5);
    expect(starts).toBe(0);
  });

  it("ignores level events for unknown channels (cc lanes)", async () => {
    const { server, engine } = makeApp();
    engine.emitLevel("cc_462887500", -3);
    await new Promise((r) => setTimeout(r, 20));
    expect((await request(server).get("/api/channels")).body).toEqual([]);
  });
});

describe("discoveries workflow", () => {
  it("a closecall files a DISCOVERY, not a channel", async () => {
    const { server, engine } = makeApp();
    engine.emitCloseCall(462887500);
    engine.emitCloseCall(462887500); // persistence-before-filing: second hit files
    await new Promise((r) => setTimeout(r, 20));
    expect((await request(server).get("/api/channels")).body).toEqual([]);
    const cfg = (await request(server).get("/api/config")).body;
    expect(cfg.discoveries).toHaveLength(1);
    expect(cfg.discoveries[0].freq).toBe(462887500);
    expect(cfg.discoveries[0].alphaTag).toBe("Close Call 462.8875");
  });

  it("re-discovery of the same frequency does not duplicate", async () => {
    const { server, engine } = makeApp();
    engine.emitCloseCall(462887500);
    engine.emitCloseCall(462887500);
    await new Promise((r) => setTimeout(r, 20));
    expect((await request(server).get("/api/config")).body.discoveries).toHaveLength(1);
  });

  it("migrates legacy disabled cc_ channels into discoveries at boot", async () => {
    dir = mkdtempSync(join(tmpdir(), "ksrv-"));
    const configStore = new ConfigStore(join(dir, "config.json"));
    const legacy = configStore.load();
    legacy.channels.push(
      { id: "cc_aabbccdd", freq: 463100000, alphaTag: "Close Call 463.1000", mode: "nfm", enabled: false },
      { id: "ch_real", freq: 146790000, alphaTag: "W0TE", mode: "nfm", enabled: true },
    );
    configStore.save(legacy);
    const { server } = createServer({ configStore, engine: new FakeEngine(), activityLog: new ActivityLog(10), wsHub: new WsHub(), staticDir: dir });
    const cfg = (await request(server).get("/api/config")).body;
    expect(cfg.discoveries).toHaveLength(1);
    expect(cfg.discoveries[0].freq).toBe(463100000);
    expect(cfg.channels.map((c: { id: string }) => c.id)).toEqual(["ch_real"]);
  });

  it("monitor mode: POST /api/monitor parks the engine on one frequency unsquelched", async () => {
    const { server, engine } = makeApp();
    let lastStart: any = null;
    const realStart = engine.start.bind(engine);
    engine.start = async (sc) => { lastStart = sc; return realStart(sc); };
    const res = await request(server).post("/api/monitor")
      .send({ freq: 462887500, alphaTag: "Close Call 462.8875" });
    expect(res.status).toBe(200);
    expect(res.body.mode).toBe("monitor");
    expect(lastStart.monitor).toBe(true);
    expect(lastStart.channels).toHaveLength(1);
    expect(lastStart.channels[0].freq).toBe(462887500);
    const st = await request(server).get("/api/status");
    expect(st.body.mode).toBe("monitor");

    const stop = await request(server).post("/api/monitor/stop");
    expect(stop.body.mode).toBe("scan");
    expect(lastStart.monitor).toBe(false);
  });

  it("knownHz passed to the engine covers channels, discoveries, and lockouts", async () => {
    const { server, engine } = makeApp();
    await request(server).post("/api/channels")
      .send({ freq: 146790000, alphaTag: "W0TE", mode: "nfm", enabled: true });
    engine.emitCloseCall(462887500);
    engine.emitCloseCall(462887500); // persistence-before-filing: second hit files
    await new Promise((r) => setTimeout(r, 20));
    const cfg = (await request(server).get("/api/config")).body;
    cfg.scan.lockoutHz = [464999999];
    await request(server).put("/api/config").send(cfg);
    let lastStart: any = null;
    const realStart = engine.start.bind(engine);
    engine.start = async (sc) => { lastStart = sc; return realStart(sc); };
    await request(server).post("/api/scan/start");
    expect(lastStart.knownHz).toContain(146790000);
    expect(lastStart.knownHz).toContain(462887500);
    expect(lastStart.knownHz).toContain(464999999);
  });
});

describe("review fixes: engine lifecycle", () => {
  it("toScanConfig is exported and includes knownHz + lockouts for the boot path", async () => {
    const { toScanConfig } = await import("../src/backend/server.js");
    const cfg = {
      ...JSON.parse(JSON.stringify((await import("../src/backend/config/schema.js")).defaultConfig())),
      channels: [{ id: "c1", freq: 146790000, alphaTag: "A", mode: "nfm", enabled: true }],
      discoveries: [{ id: "d1", freq: 462887500, alphaTag: "CC", ts: 1 }],
    };
    cfg.scan.lockoutHz = [464999999];
    const sc = toScanConfig(cfg, "scan");
    expect(sc.knownHz).toEqual(expect.arrayContaining([146790000, 462887500, 464999999]));
    expect(sc.lockoutHz).toEqual([464999999]);
  });

  it("PUT /api/config with only metadata changes does NOT restart the engine", async () => {
    const { server, engine } = makeApp();
    engine.emitCloseCall(462887500);
    engine.emitCloseCall(462887500); // persistence-before-filing: second hit files
    await new Promise((r) => setTimeout(r, 20));
    let starts = 0;
    const realStart = engine.start.bind(engine);
    engine.start = async (sc) => { starts++; return realStart(sc); };
    const cfg = (await request(server).get("/api/config")).body;
    cfg.discoveries = []; // dismiss-all: scan-irrelevant except knownHz
    const res = await request(server).put("/api/config").send(cfg);
    expect(res.status).toBe(200);
    expect(starts).toBe(0); // knownHz updated live instead
    expect((engine as { knownHzUpdates?: number[][] }).knownHzUpdates?.length).toBe(1);
  });

  it("PUT /api/config with scan-relevant changes still restarts", async () => {
    const { server, engine } = makeApp();
    let starts = 0;
    const realStart = engine.start.bind(engine);
    engine.start = async (sc) => { starts++; return realStart(sc); };
    const cfg = (await request(server).get("/api/config")).body;
    cfg.scan.groupDwellMs = 999;
    await request(server).put("/api/config").send(cfg);
    expect(starts).toBe(1);
  });

  it("dismissing the monitored discovery exits monitor mode", async () => {
    const { server, engine } = makeApp();
    engine.emitCloseCall(462887500);
    engine.emitCloseCall(462887500); // persistence-before-filing: second hit files
    await new Promise((r) => setTimeout(r, 20));
    await request(server).post("/api/monitor").send({ freq: 462887500, alphaTag: "CC" });
    expect((await request(server).get("/api/status")).body.mode).toBe("monitor");
    const cfg = (await request(server).get("/api/config")).body;
    cfg.discoveries = [];
    await request(server).put("/api/config").send(cfg);
    const st = (await request(server).get("/api/status")).body;
    expect(st.mode).toBe("scan");
  });

  it("GET /api/status is slim: no embedded config", async () => {
    const { server } = makeApp();
    const st = (await request(server).get("/api/status")).body;
    expect(st.config).toBeUndefined();
    expect(st.mode).toBe("scan");
    expect(st.state).toBeDefined();
  });
});

describe("location capture", () => {
  it("a closecall discovery stores the lookup hit's location", async () => {
    dir = mkdtempSync(join(tmpdir(), "ksrv-"));
    const configStore = new ConfigStore(join(dir, "config.json"));
    const engine = new FakeEngine();
    const lookup = { lookup: async () => ({
      tag: "W0ABC Olathe KS",
      location: { lat: 38.88, lon: -94.82, city: "Olathe", state: "KS", source: "repeaterbook" },
    }) };
    const { server } = createServer({ configStore, engine, activityLog: new ActivityLog(10), wsHub: new WsHub(), staticDir: dir, lookup });
    engine.emitCloseCall(462887500);
    engine.emitCloseCall(462887500); // persistence-before-filing: second hit files
    await new Promise((r) => setTimeout(r, 30));
    const d = (await request(server).get("/api/config")).body.discoveries[0];
    expect(d.location).toEqual({ lat: 38.88, lon: -94.82, city: "Olathe", state: "KS", source: "repeaterbook" });
  });

  it("the boot pass enriches existing channels missing location and stamps lookedUpAt", async () => {
    dir = mkdtempSync(join(tmpdir(), "ksrv-"));
    const configStore = new ConfigStore(join(dir, "config.json"));
    const seed = configStore.load();
    seed.channels.push(
      { id: "c1", freq: 145130000, alphaTag: "W0ABC", mode: "nfm", enabled: true },
      { id: "c2", freq: 464175000, alphaTag: "no match", mode: "nfm", enabled: true },
    );
    configStore.save(seed);
    const engine = new FakeEngine();
    const lookup = { lookup: async (f: number) =>
      f === 145130000 ? { tag: "x", location: { city: "Olathe", state: "KS", source: "repeaterbook" } } : null };
    const { server } = createServer({
      configStore, engine, activityLog: new ActivityLog(10), wsHub: new WsHub(), staticDir: dir,
      lookup, lookupPass: { initialDelayMs: 1, spacingMs: 1 },
    });
    await new Promise((r) => setTimeout(r, 100));
    const channels = (await request(server).get("/api/channels")).body;
    const hit = channels.find((c: { id: string }) => c.id === "c1");
    const miss = channels.find((c: { id: string }) => c.id === "c2");
    expect(hit.location?.city).toBe("Olathe");
    expect(hit.lookedUpAt).toBeGreaterThan(0);
    expect(miss.location).toBeUndefined();
    expect(miss.lookedUpAt).toBeGreaterThan(0); // miss recorded: no re-query every boot
  });
});

describe("discovery mode capture", () => {
  it("stores the identified mode on the discovery", async () => {
    dir = mkdtempSync(join(tmpdir(), "ksrv-"));
    const configStore = new ConfigStore(join(dir, "config.json"));
    const engine = new FakeEngine();
    const lookup = { lookup: async () => ({ tag: "MoDOT DMR", mode: "DMR" }) };
    const { server } = createServer({ configStore, engine, activityLog: new ActivityLog(10), wsHub: new WsHub(), staticDir: dir, lookup });
    engine.emitCloseCall(462887500);
    engine.emitCloseCall(462887500); // persistence-before-filing: second hit files
    await new Promise((r) => setTimeout(r, 30));
    const d = (await request(server).get("/api/config")).body.discoveries[0];
    expect(d.mode).toBe("DMR");
  });

  it("the boot pass backfills mode/location on existing discoveries", async () => {
    dir = mkdtempSync(join(tmpdir(), "ksrv-"));
    const configStore = new ConfigStore(join(dir, "config.json"));
    const seed = configStore.load();
    seed.discoveries = [{ id: "cc_old", freq: 462887500, alphaTag: "Close Call 462.8875", ts: 1 }];
    configStore.save(seed);
    const engine = new FakeEngine();
    const lookup = { lookup: async () => ({ tag: "WQXX123 KC MO", mode: "FMN" }) };
    const { server } = createServer({
      configStore, engine, activityLog: new ActivityLog(10), wsHub: new WsHub(), staticDir: dir,
      lookup, lookupPass: { initialDelayMs: 1, spacingMs: 1 },
    });
    await new Promise((r) => setTimeout(r, 100));
    const d = (await request(server).get("/api/config")).body.discoveries[0];
    expect(d.mode).toBe("FMN");
    expect(d.alphaTag).toBe("WQXX123 KC MO"); // plain Close Call name upgraded
    expect(d.lookedUpAt).toBeGreaterThan(0);
  });
});

describe("GET /api/weather", () => {
  it("serves current conditions from the injected provider", async () => {
    dir = mkdtempSync(join(tmpdir(), "ksrv-"));
    const configStore = new ConfigStore(join(dir, "config.json"));
    const weather = { current: async () => ({ tempF: 38, condition: "Partly Cloudy", wind: "NW 10 mph", isDaytime: false }) };
    const { server } = createServer({ configStore, engine: new FakeEngine(), activityLog: new ActivityLog(10), wsHub: new WsHub(), staticDir: dir, weather });
    const res = await request(server).get("/api/weather");
    expect(res.status).toBe(200);
    expect(res.body.tempF).toBe(38);
  });

  it("404s when no weather provider is configured", async () => {
    const { server } = makeApp();
    expect((await request(server).get("/api/weather")).status).toBe(404);
  });
});

describe("monitor demod mode", () => {
  it("uses the configured channel's mode for the monitored frequency (AM airband)", async () => {
    const { server, engine } = makeApp();
    await request(server).post("/api/channels")
      .send({ freq: 128375000, alphaTag: "MCI ATIS", mode: "am", enabled: true });
    let lastStart: any = null;
    const realStart = engine.start.bind(engine);
    engine.start = async (sc) => { lastStart = sc; return realStart(sc); };
    await request(server).post("/api/monitor").send({ freq: 128375000, alphaTag: "ATIS" });
    expect(lastStart.channels[0].mode).toBe("am");
  });

  it("honors an explicit mode and defaults to nfm for unknown frequencies", async () => {
    const { server, engine } = makeApp();
    let lastStart: any = null;
    const realStart = engine.start.bind(engine);
    engine.start = async (sc) => { lastStart = sc; return realStart(sc); };
    await request(server).post("/api/monitor").send({ freq: 123450000, mode: "am" });
    expect(lastStart.channels[0].mode).toBe("am");
    await request(server).post("/api/monitor").send({ freq: 123450000 });
    expect(lastStart.channels[0].mode).toBe("nfm");
  });
});

describe("banks are collections, not hidden overrides", () => {
  it("a legacy-disabled bank does not exclude individually enabled channels", async () => {
    const { server, engine } = makeApp();
    await request(server).post("/api/channels").send({ freq: 146790000, alphaTag: "VHF ham", mode: "nfm", enabled: true });
    await request(server).post("/api/channels").send({ freq: 464275000, alphaTag: "UHF biz", mode: "nfm", enabled: true });
    const cfg = (await request(server).get("/api/config")).body;
    cfg.banks = [{ id: "b_vhf", name: "VHF", enabled: false, band: "vhf" }];
    cfg.channels[0].alphaTag = "VHF ham updated";
    let lastStart: any = null;
    const realStart = engine.start.bind(engine);
    engine.start = async (sc) => { lastStart = sc; return realStart(sc); };
    await request(server).put("/api/config").send(cfg);
    expect(lastStart.channels.map((c: { freq: number }) => c.freq)).toEqual([146790000, 464275000]);
    expect(lastStart.knownHz).toEqual(expect.arrayContaining([146790000, 464275000]));
  });
});

describe("activity history (Idea 5)", () => {
  function makeWithHistory() {
    dir = mkdtempSync(join(tmpdir(), "ksrv-"));
    const configStore = new ConfigStore(join(dir, "config.json"));
    const engine = new FakeEngine();
    const recorded: any[] = [];
    const released: any[] = [];
    const history = {
      record: (e: any) => recorded.push(e),
      release: (id: string, ts: number) => released.push([id, ts]),
      query: () => [{ id: 1, ts: 5, kind: "active", freq: 464275000, alphaTag: "WoF", mode: "nfm", band: "uhf", tags: ["business"], lat: null, lon: null, durationMs: 1500 }],
      sites: () => [{ lat: 39.17, lon: -94.48, hits: 3, lastTs: 5, names: ["WoF"] }],
      stats: () => ({ totalHits: 3, totalAirtimeMs: 12000, discoveries: 1, topChannels: [], byTag: [], byBand: [], byHour: Array(24).fill(0) }),
    };
    const { server } = createServer({ configStore, engine, activityLog: new ActivityLog(10), wsHub: new WsHub(), staticDir: dir, history });
    return { server, engine, recorded, released };
  }

  it("tees active/release/closecall into the store with channel context", async () => {
    const { engine, recorded, released } = makeWithHistory();
    engine.emitActive({ id: "c1", freq: 464275000, alphaTag: "WoF", mode: "nfm", enabled: true, tags: ["business"] });
    engine.emitRelease("c1");
    engine.emitCloseCall(462887500);
    await new Promise((r) => setTimeout(r, 20));
    expect(recorded).toHaveLength(2);
    expect(recorded[0]).toMatchObject({ kind: "active", freq: 464275000, tags: ["business"] });
    expect(recorded[1]).toMatchObject({ kind: "closecall", freq: 462887500 });
    expect(released).toHaveLength(1);
    expect(released[0][0]).toBe("c1");
  });

  it("GET /api/history serves the store", async () => {
    const { server } = makeWithHistory();
    const res = await request(server).get("/api/history?since=1&limit=10");
    expect(res.status).toBe(200);
    expect(res.body[0].alphaTag).toBe("WoF");
  });

  it("404s without a store", async () => {
    const { server } = makeApp();
    expect((await request(server).get("/api/history")).status).toBe(404);
  });
});

describe("alert feed deletion (Idea 6)", () => {
  function makeWithRealHistory() {
    dir = mkdtempSync(join(tmpdir(), "ksrv-"));
    const configStore = new ConfigStore(join(dir, "config.json"));
    const history = new HistoryStore({ path: ":memory:" });
    history.record({ ts: 1000, kind: "alert", channelId: "c1", freq: 154130000, alphaTag: "Fire" });
    history.record({ ts: 2000, kind: "alert", channelId: "c2", freq: 155340000, alphaTag: "EMS" });
    history.record({ ts: 3000, kind: "active", channelId: "c3", freq: 146520000, alphaTag: "Ham" });
    const { server } = createServer({
      configStore, engine: new FakeEngine(), activityLog: new ActivityLog(10),
      wsHub: new WsHub(), staticDir: dir, history,
    });
    return { server, history };
  }

  it("DELETE /api/history/alerts/:id dismisses one alert", async () => {
    const { server, history } = makeWithRealHistory();
    const id = history.query({ kind: "alert", freq: 154130000 })[0]!.id;
    const res = await request(server).delete(`/api/history/alerts/${id}`);
    expect(res.status).toBe(204);
    expect(history.query({ kind: "alert" }).map((r) => r.alphaTag)).toEqual(["EMS"]);
  });

  it("DELETE /api/history/alerts/:id 404s for a row that isn't an alert", async () => {
    const { server, history } = makeWithRealHistory();
    const activeId = history.query({ kind: "active" })[0]!.id;
    const res = await request(server).delete(`/api/history/alerts/${activeId}`);
    expect(res.status).toBe(404);
    expect(history.query({ kind: "active" })).toHaveLength(1); // hit row survives
  });

  it("DELETE /api/history/alerts clears the feed and reports the count", async () => {
    const { server, history } = makeWithRealHistory();
    const res = await request(server).delete("/api/history/alerts");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ removed: 2 });
    expect(history.query({ kind: "alert" })).toHaveLength(0);
    expect(history.query({ kind: "active" })).toHaveLength(1); // hits untouched
  });

  it("alert-deletion routes 404 without a history store", async () => {
    const { server } = makeApp();
    expect((await request(server).delete("/api/history/alerts")).status).toBe(404);
    expect((await request(server).delete("/api/history/alerts/1")).status).toBe(404);
  });
});

describe("alerts (ROADMAP Idea 6)", () => {
  function makeAlertApp(alertsCfg?: Record<string, unknown>) {
    dir = mkdtempSync(join(tmpdir(), "ksrv-"));
    const configStore = new ConfigStore(join(dir, "config.json"));
    const engine = new FakeEngine();
    const wsHub = new WsHub();
    const sent: unknown[] = [];
    wsHub.add({ readyState: 1, OPEN: 1, send: (d: string) => sent.push(JSON.parse(d)) });
    const recorded: unknown[] = [];
    const history = {
      record: (ev: unknown) => recorded.push(ev),
      release: () => {}, query: () => [], sites: () => [],
      stats: () => ({ totalHits: 0, totalAirtimeMs: 0, discoveries: 0, topChannels: [], byTag: [], byBand: [], byHour: [] }),
    };
    const unmutes: Array<[string, number]> = [];
    (engine as unknown as { alertUnmute(id: string, s: number): void }).alertUnmute =
      (id, s) => unmutes.push([id, s]);
    const { server } = createServer({
      configStore, engine, activityLog: new ActivityLog(10), wsHub, staticDir: dir,
      history: history as never,
    });
    return { server, engine, configStore, sent, recorded, unmutes, alertsCfg };
  }

  const alertCh = {
    id: "al1", freq: 155475000, alphaTag: "Watched Tac", mode: "nfm" as const,
    enabled: true, audible: false, alert: true,
  };

  it("a hit on a flagged see-only channel broadcasts, records, and unmutes", async () => {
    const { server, engine, sent, recorded, unmutes } = makeAlertApp();
    await request(server).post("/api/channels").send(alertCh).expect(201);
    const res = await request(server).get("/api/channels");
    const ch = res.body.find((c: { freq: number }) => c.freq === alertCh.freq);
    engine.emitActive(ch);
    const alertEvs = sent.filter((e) => (e as { type: string }).type === "alert");
    expect(alertEvs).toHaveLength(1);
    expect((alertEvs[0] as { holdSeconds: number }).holdSeconds).toBe(30);
    expect(recorded.filter((r) => (r as { kind: string }).kind === "alert")).toHaveLength(1);
    expect(unmutes).toEqual([[ch.id, 30]]);
  });

  it("cooldown suppresses repeats; an audible channel never unmutes", async () => {
    const { server, engine, sent, unmutes } = makeAlertApp();
    await request(server).post("/api/channels").send({ ...alertCh, audible: true }).expect(201);
    const ch = (await request(server).get("/api/channels")).body
      .find((c: { freq: number }) => c.freq === alertCh.freq);
    engine.emitActive(ch);
    engine.emitActive(ch); // within cooldown — must not re-fire
    expect(sent.filter((e) => (e as { type: string }).type === "alert")).toHaveLength(1);
    expect(unmutes).toHaveLength(0); // already audible: nothing to pull in
  });

  it("unflagged channels never alert", async () => {
    const { server, engine, sent } = makeAlertApp();
    await request(server).post("/api/channels").send({ ...alertCh, alert: false }).expect(201);
    const ch = (await request(server).get("/api/channels")).body
      .find((c: { freq: number }) => c.freq === alertCh.freq);
    engine.emitActive(ch);
    expect(sent.filter((e) => (e as { type: string }).type === "alert")).toHaveLength(0);
  });
});

describe("kiosk reload", () => {
  it("POST /api/kiosk/reload broadcasts a reload event to WS clients", async () => {
    const { server } = makeApp();
    // makeApp's hub has no client; attach one through a fresh app instead.
    dir = mkdtempSync(join(tmpdir(), "ksrv-"));
    const configStore = new ConfigStore(join(dir, "config.json"));
    const wsHub = new WsHub();
    const sent: unknown[] = [];
    wsHub.add({ readyState: 1, OPEN: 1, send: (d: string) => sent.push(JSON.parse(d)) });
    const { server: srv } = createServer({ configStore, engine: new FakeEngine(), activityLog: new ActivityLog(10), wsHub, staticDir: dir });
    await request(srv).post("/api/kiosk/reload").expect(200);
    expect(sent.some((e) => (e as { type: string }).type === "reload")).toBe(true);
    void server;
  });
});

describe("backend restart", () => {
  it("POST /api/backend/restart requests a supervised process restart", async () => {
    dir = mkdtempSync(join(tmpdir(), "ksrv-"));
    const configStore = new ConfigStore(join(dir, "config.json"));
    let requested = false;
    const { server } = createServer({
      configStore,
      engine: new FakeEngine(),
      activityLog: new ActivityLog(10),
      wsHub: new WsHub(),
      staticDir: dir,
      restartBackend: () => { requested = true; },
    });
    await request(server).post("/api/backend/restart").expect(202);
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(requested).toBe(true);
  });

  it("returns unavailable when no process supervisor hook is configured", async () => {
    const { server } = makeApp();
    await request(server).post("/api/backend/restart").expect(503);
  });
});

describe("Close Call persistence-before-filing", () => {
  it("first hit files nothing; the second files the discovery", async () => {
    const { server, engine } = makeApp();
    engine.emitCloseCall(462887500);
    let res = await request(server).get("/api/config");
    expect((res.body.discoveries ?? []).some((d: { freq: number }) => d.freq === 462887500)).toBe(false);
    engine.emitCloseCall(462887500);
    res = await request(server).get("/api/config");
    expect((res.body.discoveries ?? []).some((d: { freq: number }) => d.freq === 462887500)).toBe(true);
  });

  it("suppresses a repeatedly rediscovered unidentified carrier and keeps it restorable", async () => {
    const { server, engine } = makeApp();
    for (let i = 0; i < 6; i++) engine.emitCloseCall(462887500);
    const cfg = (await request(server).get("/api/config")).body;
    const d = cfg.discoveries.find((x: { freq: number }) => x.freq === 462887500);
    expect(d).toMatchObject({
      hitCount: 6,
      suppressionReason: "Repeated unidentified carrier",
    });
    expect(d.suppressedAt).toBeTypeOf("number");
  });
});

describe("archive recommendations", () => {
  it("suggests enabled unheard channels while excluding priority and manually located channels", async () => {
    dir = mkdtempSync(join(tmpdir(), "ksrv-"));
    const configStore = new ConfigStore(join(dir, "config.json"));
    const cfg = configStore.load();
    cfg.channels = [
      { id: "old", freq: 100, alphaTag: "Old", mode: "nfm", enabled: true },
      { id: "priority", freq: 200, alphaTag: "Priority", mode: "nfm", enabled: true, priority: true },
      { id: "manual", freq: 300, alphaTag: "Manual", mode: "nfm", enabled: true, location: { lat: 1, lon: 2, source: "operator" } },
    ];
    configStore.save(cfg);
    const history = {
      record: () => {}, release: () => {},
      query: (q: { untilMs?: number }) => q.untilMs ? [{ freq: 100 }] : [],
      sites: () => [], stats: () => ({}),
    };
    const { server } = createServer({
      configStore, engine: new FakeEngine(), activityLog: new ActivityLog(10),
      wsHub: new WsHub(), staticDir: dir, history: history as never,
    });
    const res = await request(server).get("/api/recommendations/archive").expect(200);
    expect(res.body.map((c: { id: string }) => c.id)).toEqual(["old"]);
  });
});

describe("SAME alerts (Idea 11)", () => {
  it("a decoded warning banners + records; out-of-area only records", async () => {
    dir = mkdtempSync(join(tmpdir(), "ksrv-"));
    const configStore = new ConfigStore(join(dir, "config.json"));
    const engine = new FakeEngine();
    const wsHub = new WsHub();
    const sent: unknown[] = [];
    wsHub.add({ readyState: 1, OPEN: 1, send: (d: string) => sent.push(JSON.parse(d)) });
    const recorded: unknown[] = [];
    const history = { record: (e: unknown) => recorded.push(e), release: () => {}, query: () => [], sites: () => [], stats: () => ({}) };
    createServer({ configStore, engine, activityLog: new ActivityLog(10), wsHub, staticDir: dir, history: history as never });
    engine.emitSame("EAS: ZCZC-WXR-TOR-029047+0030-1561800-KEAX/NWS-");
    const alerts = sent.filter((e) => (e as { type: string }).type === "alert");
    expect(alerts).toHaveLength(1);
    expect((alerts[0] as { channel: { alphaTag: string } }).channel.alphaTag).toContain("TORNADO WARNING");
    expect(recorded.filter((r) => (r as { mode?: string }).mode === "SAME")).toHaveLength(1);
    // repeat within 90 s = deduped
    engine.emitSame("EAS: ZCZC-WXR-TOR-029047+0030-1561800-KEAX/NWS-");
    expect(sent.filter((e) => (e as { type: string }).type === "alert")).toHaveLength(1);
  });
  it("scan config carries the background NWR channel", async () => {
    const { server } = makeApp();
    const res = await request(server).get("/api/config");
    void server; void res;
    const { toScanConfig } = await import("../src/backend/server.js");
    const cfg = res.body;
    cfg.weatherChannel = { id: "wx", freq: 162550000, alphaTag: "NOAA", mode: "nfm", enabled: true };
    const sc = toScanConfig(cfg, "scan");
    const bg = sc.channels.find((c) => (c as { background?: boolean }).background);
    expect(bg?.freq).toBe(162550000);
    expect(bg?.audible).toBe(false);
    expect(sc.knownHz).toContain(162550000);
  });
});

describe("admin test-alert trigger (banner design tool)", () => {
  function makeWithClient() {
    dir = mkdtempSync(join(tmpdir(), "ksrv-"));
    const configStore = new ConfigStore(join(dir, "config.json"));
    const wsHub = new WsHub();
    const sent: any[] = [];
    wsHub.add({ readyState: 1, OPEN: 1, send: (d: string) => sent.push(JSON.parse(d)) });
    const { server } = createServer({
      configStore, engine: new FakeEngine(), activityLog: new ActivityLog(10),
      wsHub, staticDir: dir,
    });
    return { server, sent };
  }

  it("POST /api/test/alert broadcasts a canned weather alert with counties and a long hold", async () => {
    const { server, sent } = makeWithClient();
    await request(server).post("/api/test/alert").expect(200);
    const alerts = sent.filter((e) => e.type === "alert");
    expect(alerts).toHaveLength(1);
    expect(alerts[0].channel.alphaTag).toBe("TORNADO WARNING");
    expect(typeof alerts[0].counties).toBe("string");
    expect(alerts[0].counties.length).toBeGreaterThan(0);
    expect(alerts[0].holdSeconds).toBeGreaterThan(60); // long enough to design against
  });

  it("POST /api/test/alert with {clear:true} broadcasts an instantly-expired alert", async () => {
    const { server, sent } = makeWithClient();
    await request(server).post("/api/test/alert").send({ clear: true }).expect(200);
    const alerts = sent.filter((e) => e.type === "alert");
    expect(alerts).toHaveLength(1);
    expect(alerts[0].holdSeconds).toBe(0); // until = ts → dashboard drops it on next paint
  });

  it("POST /api/test/alert honors a requested alphaTag (banner-design cycling)", async () => {
    const { server, sent } = makeWithClient();
    await request(server).post("/api/test/alert").send({ alphaTag: "SEVERE THUNDERSTORM WARNING" }).expect(200);
    const alerts = sent.filter((e) => e.type === "alert");
    expect(alerts).toHaveLength(1);
    expect(alerts[0].channel.alphaTag).toBe("SEVERE THUNDERSTORM WARNING");
  });
});
