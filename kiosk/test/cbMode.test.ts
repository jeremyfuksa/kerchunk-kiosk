import { describe, it, expect, afterEach, vi } from "vitest";
import request from "supertest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, toScanConfig } from "../src/backend/server.js";
import { ConfigStore } from "../src/backend/config/ConfigStore.js";
import { ActivityLog } from "../src/backend/activityLog.js";
import { WsHub } from "../src/backend/ws.js";
import { FakeEngine } from "../src/backend/engine/FakeEngine.js";
import { CB_FREQ_HZ, cbChannels } from "../src/backend/config/cb.js";
import { configSchema, defaultConfig } from "../src/backend/config/schema.js";

const SCAN_FREQ = 145_130_000;
const WX_FREQ = 162_550_000;
const CB19 = 27_185_000;
const TOR = "EAS: ZCZC-WXR-TOR-029047+0030-1561800-KEAX/NWS-";
const EOM = "EAS: NNNN";

let dir: string;
function makeApp() {
  dir = mkdtempSync(join(tmpdir(), "ksrv-cb-"));
  const configStore = new ConfigStore(join(dir, "config.json"));
  const engine = new FakeEngine();
  const { server } = createServer({
    configStore, engine, activityLog: new ActivityLog(100),
    wsHub: new WsHub(), staticDir: dir,
  });
  return { server, engine };
}

const freqs = (cfg: { channels: { freq: number }[] } | undefined) =>
  (cfg?.channels ?? []).map((c) => c.freq);

afterEach(() => {
  vi.useRealTimers();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("CB channel table", () => {
  it("has the 40 FCC channels, 23 out of order", () => {
    expect(Object.keys(CB_FREQ_HZ)).toHaveLength(40);
    expect(CB_FREQ_HZ[1]).toBe(26_965_000);
    expect(CB_FREQ_HZ[19]).toBe(CB19);
    expect(CB_FREQ_HZ[23]).toBe(27_255_000);
    expect(CB_FREQ_HZ[24]).toBe(27_235_000);
    expect(CB_FREQ_HZ[40]).toBe(27_405_000);
    // All 40 fit one scan window (≤ 2 MHz).
    const all = Object.values(CB_FREQ_HZ);
    expect(Math.max(...all) - Math.min(...all)).toBeLessThan(2_000_000);
  });

  it("cbChannels: AM, audible, cb-tagged, no location; narrows + dedupes by number", () => {
    const all = cbChannels();
    expect(all).toHaveLength(40);
    for (const c of all) {
      expect(c).toMatchObject({ mode: "am", enabled: true, audible: true, tags: ["cb"] });
      expect(c.location).toBeUndefined();
    }
    expect(cbChannels([19, 9, 19]).map((c) => c.alphaTag)).toEqual(["CB 9", "CB 19"]);
  });

  it("config.cb.channels validates 1–40", () => {
    const base = defaultConfig();
    expect(configSchema.safeParse({ ...base, cb: { channels: [9, 19] } }).success).toBe(true);
    expect(configSchema.safeParse({ ...base, cb: { channels: [41] } }).success).toBe(false);
    expect(configSchema.safeParse({ ...base, cb: { channels: [] } }).success).toBe(false);
  });
});

describe("toScanConfig cb mode", () => {
  const cfg = () => ({
    ...defaultConfig(),
    channels: [{ id: "ham", freq: SCAN_FREQ, alphaTag: "H", mode: "nfm" as const, enabled: true }],
  });

  it("tunes only the CB set, squelched, with no Close Call or sweep", () => {
    const c = cfg();
    c.scan.closeCall = true;
    const sc = toScanConfig(c, "cb");
    expect(sc.channels).toHaveLength(40);
    expect(freqs(sc)).not.toContain(SCAN_FREQ);
    expect(sc.monitor).toBe(false);
    expect(sc.closeCall).toBe(false);
    expect(sc.sweepRanges).toEqual([]);
    expect(sc.ccAudibleHz).toBeUndefined();
  });

  it("honors config.cb.channels", () => {
    const c = { ...cfg(), cb: { channels: [19] } };
    expect(freqs(toScanConfig(c, "cb"))).toEqual([CB19]);
  });

  it("CB never enters the scan rotation or knownHz", () => {
    const sc = toScanConfig(cfg(), "scan");
    expect(freqs(sc).some((f) => f >= 26_960_000 && f <= 27_410_000)).toBe(false);
    expect(sc.knownHz).not.toContain(CB19);
  });
});

describe("POST /api/mode cb", () => {
  it("switches to CB, reports it in status, and resumes scan", async () => {
    const { server, engine } = makeApp();
    await request(server).post("/api/channels").send({ freq: SCAN_FREQ, alphaTag: "SCAN", mode: "nfm", enabled: true });
    const res = await request(server).post("/api/mode").send({ mode: "cb" });
    expect(res.status).toBe(200);
    expect(res.body.mode).toBe("cb");
    expect(freqs(engine.tunes.at(-1))).toContain(CB19);
    expect(freqs(engine.tunes.at(-1))).not.toContain(SCAN_FREQ);
    const st = await request(server).get("/api/status");
    expect(st.body).toMatchObject({ mode: "cb", scanCount: 40 });
    await request(server).post("/api/mode").send({ mode: "scan" });
    expect(freqs(engine.tunes.at(-1))).toContain(SCAN_FREQ);
  });

  it("rejects an unknown mode", async () => {
    const { server } = makeApp();
    expect((await request(server).post("/api/mode").send({ mode: "ssb" })).status).toBe(400);
  });
});

describe("SAME break-in from CB mode", () => {
  async function setupCb() {
    const { server, engine } = makeApp();
    await request(server).post("/api/channels").send({ freq: SCAN_FREQ, alphaTag: "SCAN", mode: "nfm", enabled: true });
    await request(server).put("/api/weather-channel").send({ freq: WX_FREQ, alphaTag: "NWR", mode: "nfm", enabled: true });
    await request(server).post("/api/scan/start");
    await request(server).post("/api/mode").send({ mode: "cb" });
    return { server, engine };
  }

  it("breaks in on a covered alert, then returns to CB (not scan) after EOM", async () => {
    const { server, engine } = await setupCb();
    vi.useFakeTimers();
    engine.emitSame(TOR);
    expect(freqs(engine.retunes.at(-1))).toEqual([WX_FREQ]);
    engine.emitSame(EOM);
    vi.advanceTimersByTime(9_000);
    const back = freqs(engine.retunes.at(-1));
    expect(back).toContain(CB19);
    expect(back).not.toContain(SCAN_FREQ);
    vi.useRealTimers();
    expect((await request(server).get("/api/status")).body.mode).toBe("cb");
  });

  it("a break-in from scan still returns to scan after an earlier CB session", async () => {
    const { server, engine: e2 } = makeApp();
    await request(server).post("/api/channels").send({ freq: SCAN_FREQ, alphaTag: "SCAN", mode: "nfm", enabled: true });
    await request(server).put("/api/weather-channel").send({ freq: WX_FREQ, alphaTag: "NWR", mode: "nfm", enabled: true });
    await request(server).post("/api/scan/start");
    await request(server).post("/api/mode").send({ mode: "cb" });
    await request(server).post("/api/mode").send({ mode: "scan" });
    vi.useFakeTimers();
    e2.emitSame(TOR);
    e2.emitSame(EOM);
    vi.advanceTimersByTime(9_000);
    expect(freqs(e2.retunes.at(-1))).toContain(SCAN_FREQ);
  });
});
