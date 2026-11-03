import { describe, it, expect, afterEach, vi } from "vitest";
import request from "supertest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../src/backend/server.js";
import { ModeStore } from "../src/backend/modeStore.js";
import { ConfigStore } from "../src/backend/config/ConfigStore.js";
import { ActivityLog } from "../src/backend/activityLog.js";
import { WsHub } from "../src/backend/ws.js";
import { FakeEngine } from "../src/backend/engine/FakeEngine.js";

const TOR = "EAS: ZCZC-WXR-TOR-029047+0030-1561800-KEAX/NWS-";
let dir: string;
function app() {
  const engine = new FakeEngine();
  const { server, bootScanConfig } = createServer({
    configStore: new ConfigStore(join(dir, "config.json")), engine, activityLog: new ActivityLog(100),
    wsHub: new WsHub(), staticDir: dir, modeStore: new ModeStore(join(dir, "mode.json")),
  });
  return { server, engine, bootScanConfig };
}
const wx = { freq: 162_550_000, alphaTag: "NWR", mode: "nfm", enabled: true };
const setup = () => { dir = mkdtempSync(join(tmpdir(), "kmode-")); };
afterEach(() => { vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }); });

describe("mode persistence", () => {
  it("starts in scan with no saved mode", () => {
    setup();
    expect(app().bootScanConfig().channels).toEqual([]);
  });

  it("a restart returns to CB, through toScanConfig", async () => {
    setup();
    const first = app();
    await request(first.server).post("/api/mode").send({ mode: "cb" });
    const second = app();
    expect((await request(second.server).get("/api/status")).body.mode).toBe("cb");
    expect(second.bootScanConfig().channels[0]?.tags).toEqual(["cb"]);
  });

  it("a restart returns to a direct tune", async () => {
    setup();
    const first = app();
    await request(first.server).post("/api/monitor").send({ freq: 9_650_000, mode: "am", alphaTag: "9650" });
    const second = app();
    const s = (await request(second.server).get("/api/status")).body;
    expect(s.mode).toBe("monitor");
    expect(s.monitor.freq).toBe(9_650_000);
    expect(second.bootScanConfig().channels[0]?.freq).toBe(9_650_000);
  });

  it("stopping a direct tune saves scan", async () => {
    setup();
    const first = app();
    await request(first.server).post("/api/monitor").send({ freq: 9_650_000, mode: "am" });
    await request(first.server).post("/api/monitor/stop");
    expect((await request(app().server).get("/api/status")).body.mode).toBe("scan");
  });

  it("a SAME break-in is never saved: a restart mid-alert returns to the operator's mode", async () => {
    setup();
    const first = app();
    await request(first.server).put("/api/weather-channel").send(wx);
    await request(first.server).post("/api/scan/start");
    await request(first.server).post("/api/mode").send({ mode: "cb" });
    first.engine.emitSame(TOR);
    expect((await request(first.server).get("/api/status")).body.mode).toBe("weather");
    expect((await request(app().server).get("/api/status")).body.mode).toBe("cb");
  });

  it("falls back to scan on a corrupt file or a saved mode that can't run", async () => {
    setup();
    writeFileSync(join(dir, "mode.json"), "{not json");
    expect((await request(app().server).get("/api/status")).body.mode).toBe("scan");
    writeFileSync(join(dir, "mode.json"), JSON.stringify({ mode: "bogus" }));
    expect((await request(app().server).get("/api/status")).body.mode).toBe("scan");
    writeFileSync(join(dir, "mode.json"), JSON.stringify({ mode: "weather" }));   // no weather channel configured
    expect((await request(app().server).get("/api/status")).body.mode).toBe("scan");
    writeFileSync(join(dir, "mode.json"), JSON.stringify({ mode: "monitor" }));   // no channel
    expect((await request(app().server).get("/api/status")).body.mode).toBe("scan");
  });
});
