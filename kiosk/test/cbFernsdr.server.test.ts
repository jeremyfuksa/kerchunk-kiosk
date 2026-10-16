import { describe, it, expect, afterEach, vi } from "vitest";
import request from "supertest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type ServerDeps } from "../src/backend/server.js";
import { ConfigStore } from "../src/backend/config/ConfigStore.js";
import { ActivityLog } from "../src/backend/activityLog.js";
import { WsHub } from "../src/backend/ws.js";
import { FakeEngine } from "../src/backend/engine/FakeEngine.js";
import type { CbSource } from "../src/backend/fernsdr/cbNet.js";
import type { EngineListener } from "../src/backend/engine/ScannerEngine.js";

const WX_FREQ = 162_550_000;
const TOR = "EAS: ZCZC-WXR-TOR-029047+0030-1561800-KEAX/NWS-";
const EOM = "EAS: NNNN";

class FakeCb implements CbSource {
  calls: string[] = [];
  connected = false;
  error: string | null = "connect ECONNREFUSED";
  listeners = new Set<EngineListener>();
  start() { this.calls.push("start"); }
  pause() { this.calls.push("pause"); }
  stop() { this.calls.push("stop"); }
  status() { return { connected: this.connected, error: this.error }; }
  on(l: EngineListener) { this.listeners.add(l); }
  off(l: EngineListener) { this.listeners.delete(l); }
  emit(e: Parameters<EngineListener>[0]) { for (const l of this.listeners) l(e); }
}

let dir: string;
function makeApp() {
  dir = mkdtempSync(join(tmpdir(), "ksrv-cbnet-"));
  const configStore = new ConfigStore(join(dir, "config.json"));
  const engine = new FakeEngine();
  const cb = new FakeCb();
  const recorded: any[] = [];
  const history = { record(r: any) { recorded.push(r); return 1; }, release() {}, query: () => [], heardFreqs: () => [], sites: () => [], stats: () => ({}), deleteAlert() {}, clearAlerts() {} } as unknown as NonNullable<ServerDeps["history"]>;
  const { server } = createServer({ configStore, engine, cb, history, activityLog: new ActivityLog(100), wsHub: new WsHub(), staticDir: dir });
  return { server, engine, cb, recorded };
}
afterEach(() => { vi.useRealTimers(); if (dir) rmSync(dir, { recursive: true, force: true }); });

async function setupCb() {
  const app = makeApp();
  await request(app.server).put("/api/weather-channel").send({ freq: WX_FREQ, alphaTag: "NWR", mode: "nfm", enabled: true });
  await request(app.server).post("/api/mode").send({ mode: "cb" }).expect(200);
  return app;
}

describe("CB via FernSDR — server", () => {
  it("entering CB starts the source and parks the engine on pcmIn; leaving stops it", async () => {
    const { server, engine, cb } = makeApp();
    await request(server).post("/api/mode").send({ mode: "cb" }).expect(200);
    expect(cb.calls.at(-1)).toBe("start");
    expect(engine.tunes.at(-1)?.pcmIn).toBe(true);
    await request(server).post("/api/mode").send({ mode: "scan" }).expect(200);
    expect(cb.calls.at(-1)).toBe("stop");
    expect(engine.tunes.at(-1)?.pcmIn).toBe(false);
  });

  it("status reports the receiver and the watched channel count", async () => {
    const { server } = makeApp();
    await request(server).post("/api/mode").send({ mode: "cb" }).expect(200);
    const s = await request(server).get("/api/status").expect(200);
    expect(s.body.cb).toEqual({ connected: false, error: "connect ECONNREFUSED" });
    expect(s.body.scanCount).toBe(40);
  });

  it("CB events reach history like engine events", async () => {
    const { server, cb, recorded } = makeApp();
    await request(server).post("/api/mode").send({ mode: "cb" }).expect(200);
    cb.emit({ type: "active", channel: { id: "cb_19", freq: 27185000, alphaTag: "CB 19 · Highway", mode: "am", enabled: true, tags: ["cb"] }, freq: 27185000, ts: Date.now() });
    expect(recorded.some((r: any) => r.channelId === "cb_19")).toBe(true);
  });

  it("a break-in from CB pauses the source and resumes it after EOM", async () => {
    const { engine, cb } = await setupCb();
    vi.useFakeTimers();
    engine.emitSame(TOR);
    expect(cb.calls.at(-1)).toBe("pause");
    expect(engine.tunes.at(-1)?.pcmIn).toBe(false);
    engine.emitSame(EOM);
    vi.advanceTimersByTime(8_100);
    expect(cb.calls.at(-1)).toBe("start");
    expect(engine.tunes.at(-1)?.pcmIn).toBe(true);
  });

  it("an operator mode change during a CB break-in ends stopped, not paused", async () => {
    const { server, engine, cb } = await setupCb();
    engine.emitSame(TOR);
    expect(cb.calls.at(-1)).toBe("pause");
    await request(server).post("/api/mode").send({ mode: "scan" }).expect(200);
    expect(cb.calls.at(-1)).toBe("stop");
  });
});
