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

  it("PUT /api/config rejects an invalid body with 400", async () => {
    const { server } = makeApp();
    const res = await request(server).put("/api/config").send({ nope: true });
    expect(res.status).toBe(400);
  });

  it("POST /api/audio/volume calls the engine", async () => {
    const { server, engine } = makeApp();
    let got = -1;
    engine.setVolume = async (p: number) => { got = p; };
    const res = await request(server).post("/api/audio/volume").send({ percent: 55 });
    expect(res.status).toBe(200);
    expect(got).toBe(55);
  });

  it("GET /api/status returns engine state", async () => {
    const { server } = makeApp();
    const res = await request(server).get("/api/status");
    expect(res.status).toBe(200);
    expect(res.body.state).toBeTruthy();
  });

  it("GET /api/logs returns an array", async () => {
    const { server } = makeApp();
    const res = await request(server).get("/api/logs");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});
