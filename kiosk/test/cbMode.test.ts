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
import { CB_FREQ_HZ, CB_ALL, cbChannels, cbNetConfig, cbNumberForFreq, cbLabel, CB_NAMES_DEFAULT } from "../src/backend/config/cb.js";
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

  it("cbChannels: AM except the LSB default (38), audible, cb-tagged, no location; narrows + dedupes", () => {
    const all = cbChannels();
    expect(all).toHaveLength(40);
    for (const c of all) {
      expect(c).toMatchObject({ mode: c.id === "cb_38" ? "lsb" : "am", enabled: true, audible: true, tags: ["cb"] });
      expect(c.location).toBeUndefined();
    }
    expect(cbChannels([19, 9, 19]).map((c) => c.alphaTag)).toEqual(["CB 9 · Emergency", "CB 19 · Highway"]);
    expect(cbChannels([14], {}).map((c) => c.alphaTag)).toEqual(["CB 14"]);
  });

  it("cbChannels: third arg is the modes map (explicit map replaces the default)", () => {
    expect(cbChannels([38], undefined, {})[0]).toMatchObject({ mode: "am" });
    expect(cbChannels([38])[0]).toMatchObject({ mode: "lsb" });
  });

  it("config.cb SSB knobs and radios[].ppm validate", () => {
    const base = defaultConfig();
    const ok = (v: unknown) => configSchema.safeParse(v).success;
    const parsed = configSchema.parse({ ...base, cb: { modes: { "38": "lsb", "36": "am" }, ssbHangMs: 1500 } });
    expect(parsed.cb).toEqual({ modes: { "38": "lsb", "36": "am" }, ssbHangMs: 1500 });
    expect(ok({ ...base, cb: { modes: { "38": "usb" } } })).toBe(false);
    expect(ok({ ...base, cb: { modes: { "41": "lsb" } } })).toBe(false);
    const radio = (ppm: number) => ({ ...base, radios: [{ serial: "KIOSK01", role: "scan", ppm }] });
    expect(configSchema.parse(radio(-12)).radios?.[0]?.ppm).toBe(-12);
    expect(ok(radio(1.5))).toBe(false);
    expect(ok(radio(201))).toBe(false);
  });

  it("config.cb.channels validates 1–40", () => {
    const base = defaultConfig();
    expect(configSchema.safeParse({ ...base, cb: { channels: [9, 19] } }).success).toBe(true);
    expect(configSchema.safeParse({ ...base, cb: { channels: [41] } }).success).toBe(false);
    expect(configSchema.safeParse({ ...base, cb: { channels: [] } }).success).toBe(false);
  });
});

describe("toScanConfig cb mode", () => {
  const base = defaultConfig();
  it("parks the helper on PCM-in: no channels, no Close Call, no sweep", () => {
    const sc = toScanConfig(base, "cb");
    expect(sc.channels).toEqual([]);
    expect(sc.pcmIn).toBe(true);
    expect(sc.closeCall).toBe(false);
    expect(sc.sweepRanges).toEqual([]);
  });
  it("other modes never set pcmIn; every mode carries the PCM buffer knobs", () => {
    const sc = toScanConfig(base, "scan");
    expect(sc.pcmIn).toBe(false);
    expect([sc.pcmBufferMs, sc.pcmMaxBufferMs]).toEqual([120, 400]);
    const tuned = configSchema.parse({ ...base, cb: { fernsdr: { bufferMs: 150, maxBufferMs: 500 } } });
    expect([toScanConfig(tuned, "cb").pcmBufferMs, toScanConfig(tuned, "cb").pcmMaxBufferMs]).toEqual([150, 500]);
  });
  it("CB never enters the scan rotation or knownHz", () => {
    const sc = toScanConfig(base, "scan");
    expect(freqs(sc)).not.toContain(CB19);
    expect(sc.knownHz).not.toContain(CB19);
  });
});

describe("cbNetConfig", () => {
  it("defaults: all 40 channels, 38 LSB, priority 6/9/19, receiver knobs", () => {
    const c = cbNetConfig(defaultConfig());
    expect(c.channels.map((ch) => Number(ch.id.slice(3)))).toEqual(CB_ALL);
    expect(c.channels.find((ch) => ch.id === "cb_38")?.mode).toBe("lsb");
    expect(c.priority).toEqual([6, 9, 19]);
    expect(c).toMatchObject({ url: "ws://192.168.1.30:8073/ws", band: "cb-radio", openDb: 10, openRows: 2, hangMs: 2000, ssbHangMs: 1500, maxOpenMs: 180_000, backoffMaxMs: 60_000 });
  });
  it("honours config.cb", () => {
    const cfg = configSchema.parse({ ...defaultConfig(), cb: { channels: [19, 9], priority: [9], ssbHangMs: 900, modes: {}, fernsdr: { url: "ws://x:1/ws", openDb: 8 } } });
    const c = cbNetConfig(cfg);
    expect(c.channels.map((ch) => ch.id)).toEqual(["cb_9", "cb_19"]);
    expect(c.channels.every((ch) => ch.mode === "am")).toBe(true);
    expect(c).toMatchObject({ priority: [9], ssbHangMs: 900, url: "ws://x:1/ws", openDb: 8 });
  });
  it("rejects bad receiver knobs", () => {
    expect(() => configSchema.parse({ ...defaultConfig(), cb: { fernsdr: { url: "http://x" } } })).toThrow();
    expect(() => configSchema.parse({ ...defaultConfig(), cb: { fernsdr: { bufferMs: 300, maxBufferMs: 200 } } })).toThrow();
    expect(() => configSchema.parse({ ...defaultConfig(), cb: { priority: [41] } })).toThrow();
  });
});

describe("POST /api/mode cb", () => {
  it("switches to CB, reports it in status, and resumes scan", async () => {
    const { server, engine } = makeApp();
    await request(server).post("/api/channels").send({ freq: SCAN_FREQ, alphaTag: "SCAN", mode: "nfm", enabled: true });
    const res = await request(server).post("/api/mode").send({ mode: "cb" });
    expect(res.status).toBe(200);
    expect(res.body.mode).toBe("cb");
    expect(engine.tunes.at(-1)?.pcmIn).toBe(true);
    expect(freqs(engine.tunes.at(-1))).toEqual([]);
    const st = await request(server).get("/api/status");
    expect(st.body.mode).toBe("cb");
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
    // CB parks the helper on PCM-in: back to no channels, never the scan set
    // (FakeEngine routes an empty channel set through start(), not retune()).
    expect(engine.tunes.at(-1)?.pcmIn).toBe(true);
    expect(freqs(engine.tunes.at(-1))).toEqual([]);
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

describe("CB names and lookups", () => {
  it("default names, labels, and freq → channel number", () => {
    expect(CB_NAMES_DEFAULT).toEqual({ "6": "Super Bowl", "9": "Emergency", "19": "Highway" });
    expect(cbLabel(19)).toBe("CB 19 · Highway");
    expect(cbLabel(14)).toBe("CB 14");
    expect(cbLabel(19, { "19": "Trucks" })).toBe("CB 19 · Trucks");
    expect(cbNumberForFreq(27_185_000)).toBe(19);
    expect(cbNumberForFreq(27_255_000)).toBe(23);
    expect(cbNumberForFreq(146_790_000)).toBeNull();
  });

  it("config.cb.names validates channel-number keys; toScanConfig uses them", () => {
    const base = defaultConfig();
    expect(configSchema.safeParse({ ...base, cb: { names: { "19": "Trucks" } } }).success).toBe(true);
    expect(configSchema.safeParse({ ...base, cb: { names: { "41": "x" } } }).success).toBe(false);
    expect(configSchema.safeParse({ ...base, cb: { names: { "19": "" } } }).success).toBe(false);
    const net = cbNetConfig({ ...base, cb: { channels: [19], names: { "19": "Trucks" } } });
    expect(net.channels[0]?.alphaTag).toBe("CB 19 · Trucks");
  });

  it("display.cb defaults and bounds", () => {
    // defaultConfig() has no display block; give it the two required fields.
    const display = { weatherLat: 39.1, weatherLon: -94.58 };
    const parsed = configSchema.parse({ ...defaultConfig(), display });
    expect(parsed.display?.cb).toEqual({ fadeStepsMin: [2, 10, 20, 30], stepTickMs: 60_000, logRows: 5 });
    const withCb = (cb: unknown) => configSchema.safeParse({ ...defaultConfig(), display: { ...display, cb } }).success;
    expect(withCb({ fadeStepsMin: [1, 5, 9, 12] })).toBe(true);
    expect(withCb({ fadeStepsMin: [5, 2, 9, 12] })).toBe(false);   // must ascend
    expect(withCb({ fadeStepsMin: [2, 10, 20] })).toBe(false);      // exactly 4
    expect(withCb({ stepTickMs: 1000 })).toBe(false);               // ≥ 5 s
    expect(withCb({ logRows: 0 })).toBe(false);
  });
});

describe("POST /api/test/tx cb_<n>", () => {
  it("plays a synthetic CB transmission with the CB label", async () => {
    const { server } = makeApp();
    const res = await request(server).post("/api/test/tx").send({ channelId: "cb_19", holdMs: 1000 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, channelId: "cb_19", holdMs: 1000 });
    expect((await request(server).post("/api/test/tx").send({ channelId: "cb_41" })).status).toBe(404);
  });
});
