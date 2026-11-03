import { describe, it, expect, afterEach } from "vitest";
import request from "supertest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../src/backend/server.js";
import { ConfigStore } from "../src/backend/config/ConfigStore.js";
import { ActivityLog } from "../src/backend/activityLog.js";
import { WsHub } from "../src/backend/ws.js";
import { FakeEngine } from "../src/backend/engine/FakeEngine.js";
import type { EngineEvent } from "../src/backend/engine/ScannerEngine.js";
import type { LightningSource } from "../src/backend/lightning/LightningFeed.js";
import type { Flash } from "../src/backend/lightning/types.js";

const fl = (t: number): Flash => ({ t, lat: 39.3, lon: -94.5, energyFj: 40, areaKm2: 250 });

class FakeLightning implements LightningSource {
  buf: Flash[] = [];
  stale = false;
  end: number | null = null;
  started = false;
  stopped = false;
  private cb: ((f: Flash[]) => void) | null = null;
  since(ms: number) { return this.buf.filter((f) => f.t > ms); }
  isStale() { return this.stale; }
  latestEnd() { return this.end; }
  onFlashes(cb: (f: Flash[]) => void) { this.cb = cb; }
  start() { this.started = true; }
  stop() { this.stopped = true; }
  fire(f: Flash[]) { this.buf.push(...f); this.cb?.(f); }
}

let dir: string;
function makeApp(lightning?: LightningSource) {
  dir = mkdtempSync(join(tmpdir(), "klightning-"));
  const wsHub = new WsHub();
  const sent: EngineEvent[] = [];
  const real = wsHub.broadcast.bind(wsHub);
  wsHub.broadcast = (e: EngineEvent) => { sent.push(e); real(e); };
  const { server } = createServer({
    configStore: new ConfigStore(join(dir, "config.json")), engine: new FakeEngine(),
    activityLog: new ActivityLog(100), wsHub, staticDir: dir, ...(lightning ? { lightning } : {}),
  });
  return { server, sent };
}
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("lightning route + WS", () => {
  it("404 when the feed is disabled", async () => {
    const { server } = makeApp();
    expect((await request(server).get("/api/lightning")).status).toBe(404);
  });

  it("returns buffered flashes after `since`, the stale flag and latestEnd", async () => {
    const lt = new FakeLightning();
    lt.buf = [fl(1000), fl(2000), fl(3000)];
    lt.end = 3500; lt.stale = true;
    const { server } = makeApp(lt);
    const res = await request(server).get("/api/lightning?since=1500");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ flashes: [fl(2000), fl(3000)], stale: true, latestEnd: 3500 });
  });

  it("a missing or junk `since` returns the whole buffer", async () => {
    const lt = new FakeLightning();
    lt.buf = [fl(1000)];
    const { server } = makeApp(lt);
    expect((await request(server).get("/api/lightning")).body.flashes).toHaveLength(1);
    expect((await request(server).get("/api/lightning?since=abc")).body.flashes).toHaveLength(1);
  });

  it("starts the feed and broadcasts fresh flashes", async () => {
    const lt = new FakeLightning();
    const { sent } = makeApp(lt);
    expect(lt.started).toBe(true);
    lt.fire([fl(5000)]);
    const ev = sent.find((e) => e.type === "lightning");
    expect(ev).toMatchObject({ type: "lightning", flashes: [fl(5000)] });
  });
});
