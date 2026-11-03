import { describe, it, expect, vi, afterEach } from "vitest";
import request from "supertest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../src/backend/server.js";
import { ConfigStore } from "../src/backend/config/ConfigStore.js";
import { ActivityLog } from "../src/backend/activityLog.js";
import { WsHub } from "../src/backend/ws.js";
import { FakeEngine } from "../src/backend/engine/FakeEngine.js";

// SystemStats lists /sys/class/thermal directly, and that only exists on Linux.
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, readdirSync: ((p: string, ...rest: unknown[]) => (p === "/sys/class/thermal" ? ["thermal_zone0"] : (fs.readdirSync as (...a: unknown[]) => unknown)(p, ...rest))) as typeof fs.readdirSync };
});

describe("thermal shed", () => {
  let dir: string;
  afterEach(() => {
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Engine stops and starts when the box trips in this mode. */
  async function heatIn(mode: "scan" | "cb" | "hf"): Promise<number> {
    // The sampler runs on a 2.5 s interval. Only that is faked: supertest needs real timers.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    dir = mkdtempSync(join(tmpdir(), "kshed-"));
    const engine = new FakeEngine();
    let milliC = 50_000;
    const { server } = createServer({
      configStore: new ConfigStore(join(dir, "config.json")), engine, activityLog: new ActivityLog(100), wsHub: new WsHub(),
      staticDir: dir, selfProtect: true,
      statsReadFile: (p) => { if (p.endsWith("/temp")) return String(milliC); throw new Error("not faked"); },
    });
    const cfg = (await request(server).get("/api/config")).body;
    await request(server).put("/api/config").send({ ...cfg, scan: { ...cfg.scan, closeCall: true }, spyserver: { host: "airspy.local" } });
    await request(server).post("/api/channels").send({ freq: 145_130_000, alphaTag: "S", mode: "nfm", enabled: true });
    await request(server).post("/api/scan/start");
    await request(server).post("/api/mode").send({ mode });
    let cycles = 0;
    const stop = engine.stop.bind(engine);
    const start = engine.start.bind(engine);
    engine.stop = async () => { cycles++; return stop(); };
    engine.start = async (c) => { cycles++; return start(c); };
    milliC = 95_000;
    vi.advanceTimersByTime(2_500);
    await new Promise((r) => setTimeout(r, 30));
    return cycles;
  }

  it("a trip in CB leaves the engine alone: nothing to shed", async () => {
    expect(await heatIn("cb")).toBe(0);
  });

  it("a trip in HF leaves the engine alone too", async () => {
    expect(await heatIn("hf")).toBe(0);
  });

  it("a trip while scanning with Close Call on restarts, to shed it", async () => {
    expect(await heatIn("scan")).toBe(2);
  });
});
