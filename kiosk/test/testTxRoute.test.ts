import { describe, it, expect, afterEach } from "vitest";
import request from "supertest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../src/backend/server.js";
import { ConfigStore } from "../src/backend/config/ConfigStore.js";
import { ActivityLog } from "../src/backend/activityLog.js";
import { WsHub } from "../src/backend/ws.js";
import { FakeEngine } from "../src/backend/engine/FakeEngine.js";
import { defaultConfig } from "../src/backend/config/schema.js";
import type { EngineEvent } from "../src/backend/engine/ScannerEngine.js";

let dir: string;
function makeApp() {
  dir = mkdtempSync(join(tmpdir(), "ktx-"));
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify({
    ...defaultConfig(),
    channels: [
      { id: "loc", freq: 462_550_000, alphaTag: "Located", mode: "nfm", enabled: true, location: { lat: 39.1, lon: -94.5, source: "manual" } },
      { id: "noloc", freq: 462_575_000, alphaTag: "Nowhere", mode: "nfm", enabled: true },
    ],
  }));
  const wsHub = new WsHub();
  const sent: EngineEvent[] = [];
  const real = wsHub.broadcast.bind(wsHub);
  wsHub.broadcast = (e: EngineEvent) => { sent.push(e); real(e); };
  const { server } = createServer({ configStore: new ConfigStore(path), engine: new FakeEngine(), activityLog: new ActivityLog(100), wsHub, staticDir: dir });
  return { server, sent };
}
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("POST /api/test/tx", () => {
  it("plays active → audible → signal… → release → audible(null) for a located channel", async () => {
    // Real timers (fake ones stall supertest's sockets); holdMs clamps to >= 1000.
    const { server, sent } = makeApp();
    const res = await request(server).post("/api/test/tx").send({ channelId: "loc", holdMs: 1000 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, channelId: "loc", holdMs: 1000 });
    expect(sent.slice(0, 2).map((e) => e.type)).toEqual(["active", "audible"]);
    await new Promise((r) => setTimeout(r, 1150));
    const types = sent.map((e) => e.type);
    expect(types.filter((t) => t === "signal").length).toBeGreaterThanOrEqual(2);
    expect(types.slice(-2)).toEqual(["release", "audible"]);
    const last = sent.at(-1) as Extract<EngineEvent, { type: "audible" }>;
    expect(last.channel).toBeNull();
  });

  it("lat/lon override the broadcast location (off-frame previews)", async () => {
    const { server, sent } = makeApp();
    await request(server).post("/api/test/tx").send({ channelId: "loc", holdMs: 1000, lat: 39.9, lon: -94.4 }).expect(200);
    const active = sent[0] as Extract<EngineEvent, { type: "active" }>;
    expect(active.channel.location).toMatchObject({ lat: 39.9, lon: -94.4 });
    const audible = sent[1] as Extract<EngineEvent, { type: "audible" }>;
    expect(audible.channel?.location).toMatchObject({ lat: 39.9, lon: -94.4 });
  });

  it("404 for an unknown or unlocated channel", async () => {
    const { server } = makeApp();
    expect((await request(server).post("/api/test/tx").send({ channelId: "noloc" })).status).toBe(404);
    expect((await request(server).post("/api/test/tx").send({ channelId: "zzz" })).status).toBe(404);
  });

  it("no channelId picks a located channel; holdMs is clamped", async () => {
    const { server } = makeApp();
    const res = await request(server).post("/api/test/tx").send({ holdMs: 999_999 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, channelId: "loc", holdMs: 60_000 });
  });
});
