import { describe, it, expect, afterEach, vi } from "vitest";
import request from "supertest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../src/backend/server.js";
import { ConfigStore } from "../src/backend/config/ConfigStore.js";
import { ActivityLog } from "../src/backend/activityLog.js";
import { WsHub } from "../src/backend/ws.js";
import { FakeEngine } from "../src/backend/engine/FakeEngine.js";

const SCAN_FREQ = 145_130_000;
const WX_FREQ = 162_550_000;
// Two distinct covered alerts (different raw text → both clear the 90s dedupe).
const TOR = "EAS: ZCZC-WXR-TOR-029047+0030-1561800-KEAX/NWS-";
const SVR = "EAS: ZCZC-WXR-SVR-029047+0045-1561800-KEAX/NWS-";
const EOM = "EAS: NNNN";

let dir: string;
function makeApp() {
  dir = mkdtempSync(join(tmpdir(), "ksrv-eom-"));
  const configStore = new ConfigStore(join(dir, "config.json"));
  const engine = new FakeEngine();
  const { server } = createServer({
    configStore, engine, activityLog: new ActivityLog(100),
    wsHub: new WsHub(), staticDir: dir,
  });
  return { server, engine };
}

// Configure a scan channel + a weather channel so a covered SAME alert breaks in.
async function setup() {
  const { server, engine } = makeApp();
  await request(server).post("/api/channels")
    .send({ freq: SCAN_FREQ, alphaTag: "SCAN", mode: "nfm", enabled: true });
  await request(server).put("/api/weather-channel")
    .send({ freq: WX_FREQ, alphaTag: "NWR", mode: "nfm", enabled: true });
  // The engine must be live (running) so a break-in re-points the graph in
  // place via retune instead of falling back to a fresh start().
  await request(server).post("/api/scan/start");
  return { engine };
}

const freqs = (cfg: { channels: { freq: number }[] } | undefined) =>
  (cfg?.channels ?? []).map((c) => c.freq);

afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

describe("SAME EOM-triggered scan resume", () => {
  it("breaks in on a covered alert, then resumes scanning after the EOM grace window", async () => {
    const { engine } = await setup();
    vi.useFakeTimers();

    engine.emitSame(TOR);
    // Break-in: retuned to the weather channel only (no scan freq).
    const wx = engine.retunes.at(-1);
    expect(freqs(wx)).toContain(WX_FREQ);
    expect(freqs(wx)).not.toContain(SCAN_FREQ);

    engine.emitSame(EOM);
    const beforeAdvance = engine.retunes.length;
    // Grace window not yet elapsed → still holding weather.
    vi.advanceTimersByTime(7_000);
    expect(engine.retunes.length).toBe(beforeAdvance);
    // Grace window elapses → resume scanning (retuned back to the scan list).
    vi.advanceTimersByTime(2_000);
    expect(freqs(engine.retunes.at(-1))).toContain(SCAN_FREQ);
  });

  it("holds through a clustered second alert and resumes only after the final EOM", async () => {
    const { engine } = await setup();
    vi.useFakeTimers();

    engine.emitSame(TOR);
    engine.emitSame(EOM);          // grace armed
    vi.advanceTimersByTime(4_000); // mid-grace
    const beforeCluster = engine.retunes.length;

    engine.emitSame(SVR);          // new covered alert → cancels the pending resume
    vi.advanceTimersByTime(10_000);
    // Held through: no resume retune happened from the cancelled grace timer.
    expect(engine.retunes.length).toBe(beforeCluster);

    engine.emitSame(EOM);          // grace re-armed off the final message
    vi.advanceTimersByTime(8_001);
    expect(freqs(engine.retunes.at(-1))).toContain(SCAN_FREQ);
  });

  it("still reverts on the long safety-net timer when no EOM is ever received", async () => {
    const { engine } = await setup();
    vi.useFakeTimers();

    engine.emitSame(TOR);          // purge 0030 → 30 min, clamped to the 10 min cap
    expect(freqs(engine.retunes.at(-1))).not.toContain(SCAN_FREQ);
    // No EOM. Advance past the 10-minute cap → safety-net revert.
    vi.advanceTimersByTime(10 * 60_000 + 1_000);
    expect(freqs(engine.retunes.at(-1))).toContain(SCAN_FREQ);
  });
});
