import { describe, it, expect, afterEach, vi } from "vitest";
import request from "supertest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, nothingToShed, toScanConfig } from "../src/backend/server.js";
import { ConfigStore } from "../src/backend/config/ConfigStore.js";
import { ActivityLog } from "../src/backend/activityLog.js";
import { WsHub } from "../src/backend/ws.js";
import { FakeEngine } from "../src/backend/engine/FakeEngine.js";
import { CB_FREQ_HZ, cbChannels, cbDefaultChannels, cbNumberForFreq, cbLabel, CB_NAMES_DEFAULT } from "../src/backend/config/cb.js";
import { configSchema, defaultConfig } from "../src/backend/config/schema.js";
import { groupChannels } from "../src/backend/engine/grouping.js";

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

  it("cbChannels: LSB channels carry the SSB squelch (hang default 1500, open override when set)", () => {
    const [ch38] = cbChannels([38]);
    expect(ch38).toMatchObject({ mode: "lsb", hangMs: 1500 });
    expect(ch38).not.toHaveProperty("openAboveFloorDb");
    const [tuned] = cbChannels([38], undefined, { ssbOpenDb: 6, ssbHangMs: 2500 });
    expect(tuned).toMatchObject({ mode: "lsb", openAboveFloorDb: 6, hangMs: 2500 });
    const [am19] = cbChannels([19], undefined, { ssbOpenDb: 6 });
    expect(am19).not.toHaveProperty("openAboveFloorDb");
    expect(am19).not.toHaveProperty("hangMs");
    expect(cbChannels([38], undefined, { modes: {} })[0]).toMatchObject({ mode: "am" });   // explicit map replaces the default
  });

  it("config.cb SSB knobs and radios[].ppm validate", () => {
    const base = defaultConfig();
    const ok = (v: unknown) => configSchema.safeParse(v).success;
    const parsed = configSchema.parse({ ...base, cb: { modes: { "38": "lsb", "36": "am" }, ssbOpenDb: 6, ssbHangMs: 1500 } });
    expect(parsed.cb).toEqual({ modes: { "38": "lsb", "36": "am" }, ssbOpenDb: 6, ssbHangMs: 1500 });
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

describe("cbDefaultChannels", () => {
  it("fills one window: 6/9/19 and the LSB channels always, then 1 upward", () => {
    expect(cbDefaultChannels(32)).toEqual([...Array.from({ length: 31 }, (_, i) => i + 1), 38]);
    expect(cbDefaultChannels(12)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 19, 38]);
    expect(cbDefaultChannels(2)).toEqual([6, 9]);
    expect(cbDefaultChannels(64)).toHaveLength(40);
    expect(cbDefaultChannels(32, {})).toEqual(Array.from({ length: 32 }, (_, i) => i + 1));
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
    c.scan.lanesPerGroup = 64;
    const sc = toScanConfig(c, "cb");
    expect(sc.channels).toHaveLength(40);
    expect(freqs(sc)).not.toContain(SCAN_FREQ);
    expect(sc.monitor).toBe(false);
    expect(sc.closeCall).toBe(false);
    expect(sc.sweepRanges).toEqual([]);
    expect(sc.ccAudibleHz).toBeUndefined();
  });

  it("defaults to one window's worth of lanes", () => {
    const c = cfg();
    c.scan.lanesPerGroup = 12;
    expect(freqs(toScanConfig(c, "cb"))).toHaveLength(12);
    expect(freqs(toScanConfig(c, "cb"))).toContain(CB19);
  });

  describe("on the HF+", () => {
    const spy = () => ({ ...cfg(), spyserver: { host: "airspy.local", port: 5555 } });
    it("listens to all 40 channels whatever the scan's lane count", () => {
      const c = spy();
      c.scan.lanesPerGroup = 32;
      const sc = toScanConfig(c, "cb");
      expect(sc.channels).toHaveLength(40);
      expect(sc.lanesPerGroup).toBe(40);
    });
    it("all 40 fit one window, so CB never hops", () => {
      const c = spy();
      c.scan.lanesPerGroup = 32;
      const sc = toScanConfig(c, "cb");
      expect(groupChannels(sc.channels, sc.windowBandwidthHz!, sc.lanesPerGroup!)).toHaveLength(1);
    });
    it("every HF+ mode has the same lanes, so moving between them is a retune", () => {
      const c = spy();
      c.scan.lanesPerGroup = 32;
      expect(toScanConfig(c, "hf").lanesPerGroup).toBe(40);
      expect(toScanConfig(c, "monitor", { id: "m", freq: 7_200_000, alphaTag: "m", mode: "am", enabled: true }).lanesPerGroup).toBe(40);
    });
    it("leaves the scan's lanes alone", () => {
      const c = spy();
      c.scan.lanesPerGroup = 32;
      expect(toScanConfig(c, "scan").lanesPerGroup).toBe(32);
    });
    it("never lowers a higher lane count", () => {
      const c = spy();
      c.scan.lanesPerGroup = 64;
      expect(toScanConfig(c, "cb").lanesPerGroup).toBe(64);
    });
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
    expect(st.body.mode).toBe("cb");
    expect(st.body.scanCount).toBeGreaterThan(0);
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
    const sc = toScanConfig({ ...base, cb: { channels: [19], names: { "19": "Trucks" } } }, "cb");
    expect(sc.channels[0]?.alphaTag).toBe("CB 19 · Trucks");
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

describe("CB over SpyServer", () => {
  const spy = { host: "airspy.local", port: 5555, audioBufferMs: 500 };
  const base = () => ({ ...defaultConfig(), weatherChannel: { id: "wx", freq: WX_FREQ, alphaTag: "NWR", mode: "nfm" as const, enabled: true } });

  it("toScanConfig cb carries spyserver and a window inside the HF+'s 660 kHz", () => {
    const s = toScanConfig({ ...base(), spyserver: spy }, "cb");
    expect(s.spyserver).toEqual(spy);
    expect(s.windowBandwidthHz).toBe(600_000);
    expect(s.flatBandwidthHz).toBe(600_000);
  });

  it("toScanConfig scan and weather never carry spyserver", () => {
    expect(toScanConfig({ ...base(), spyserver: spy }, "scan").spyserver).toBeUndefined();
    expect(toScanConfig({ ...base(), spyserver: spy }, "weather").spyserver).toBeUndefined();
  });

  it("toScanConfig cb without spyserver is unchanged", () => {
    const c = base();
    c.scan.windowBandwidthHz = 2_000_000;
    const s = toScanConfig(c, "cb");
    expect("spyserver" in s).toBe(false);
    expect(s.windowBandwidthHz).toBe(2_000_000);
  });

  it("config.spyserver validates, with port defaulting to 5555", () => {
    const parsed = configSchema.parse({ ...defaultConfig(), spyserver: { host: "airspy.local" } });
    expect(parsed.spyserver?.port).toBe(5555);
    expect(parsed.spyserver?.audioBufferMs).toBeGreaterThan(0);
    expect(configSchema.safeParse({ ...defaultConfig(), spyserver: { host: "" } }).success).toBe(false);
    for (const host of ["-x", "--sink", "a:1", "a b", "a/b"]) {
      expect(configSchema.safeParse({ ...defaultConfig(), spyserver: { host } }).success).toBe(false);
    }
    expect(configSchema.safeParse({ ...defaultConfig(), spyserver: { host: "192.168.1.30" } }).success).toBe(true);
    expect(configSchema.safeParse({ ...defaultConfig(), spyserver: { host: "a", digitalGain: 33 } }).success).toBe(false);
    expect(configSchema.safeParse({ ...defaultConfig(), spyserver: { host: "a", audioBufferMs: 3001 } }).success).toBe(false);
  });

  it("a PUT changing config.spyserver in CB mode respawns the engine", async () => {
    const { server, engine } = makeApp();
    await request(server).post("/api/mode").send({ mode: "cb" });
    const current = (await request(server).get("/api/config")).body;
    const start = vi.spyOn(engine, "start");
    const res = await request(server).put("/api/config").send({ ...current, spyserver: { host: "airspy.local" } });
    expect(res.status).toBe(200);
    expect(start).toHaveBeenCalledTimes(1);
    expect(start.mock.calls[0]![0].spyserver?.host).toBe("airspy.local");
  });

  it("a break-in from CB drops spyserver, then restores it, holding breakIn in between", async () => {
    const { server, engine } = makeApp();
    await request(server).post("/api/channels").send({ freq: SCAN_FREQ, alphaTag: "SCAN", mode: "nfm", enabled: true });
    await request(server).put("/api/weather-channel").send({ freq: WX_FREQ, alphaTag: "NWR", mode: "nfm", enabled: true });
    const current = (await request(server).get("/api/config")).body;
    await request(server).put("/api/config").send({ ...current, spyserver: { host: "airspy.local" } });
    await request(server).post("/api/scan/start");
    await request(server).post("/api/mode").send({ mode: "cb" });
    expect(engine.retunes.at(-1)?.spyserver?.host).toBe("airspy.local");
    vi.useFakeTimers();
    engine.emitSame(TOR);
    expect(engine.retunes.at(-1)?.spyserver).toBeUndefined();
    expect(freqs(engine.retunes.at(-1))).toEqual([WX_FREQ]);
    vi.useRealTimers();
    expect((await request(server).get("/api/status")).body.breakIn).toBe(true);
    vi.useFakeTimers();
    engine.emitSame(EOM);
    vi.advanceTimersByTime(9_000);
    expect(engine.retunes.at(-1)?.spyserver?.host).toBe("airspy.local");
    vi.useRealTimers();
    expect((await request(server).get("/api/status")).body.breakIn).toBe(false);
  });
});

describe("direct tune below 30 MHz", () => {
  const spy = { host: "airspy.local", port: 5555, audioBufferMs: 500 };
  const mon = (freq: number) => ({ id: "mon_direct", freq, alphaTag: "x", mode: "am" as const, enabled: true });

  it("goes through SpyServer when it's configured", () => {
    const s = toScanConfig({ ...defaultConfig(), spyserver: spy }, "monitor", mon(5_000_000));
    expect(s.spyserver).toEqual(spy);
    expect(s.windowBandwidthHz).toBe(600_000);
    expect(s.monitor).toBe(true);
    expect(freqs(s)).toEqual([5_000_000]);
  });

  it("stays on the RTL radio at 30 MHz and up, or with no SpyServer", () => {
    expect(toScanConfig({ ...defaultConfig(), spyserver: spy }, "monitor", mon(30_000_000)).spyserver).toBeUndefined();
    expect(toScanConfig({ ...defaultConfig(), spyserver: spy }, "monitor", mon(162_550_000)).spyserver).toBeUndefined();
    expect(toScanConfig(defaultConfig(), "monitor", mon(5_000_000)).spyserver).toBeUndefined();
  });

  it("POST /api/monitor reaches the engine with SpyServer and AM", async () => {
    const { server, engine } = makeApp();
    const current = (await request(server).get("/api/config")).body;
    await request(server).put("/api/config").send({ ...current, spyserver: { host: "airspy.local" } });
    await request(server).post("/api/scan/start");
    const res = await request(server).post("/api/monitor").send({ freq: 9_650_000, mode: "am" });
    expect(res.status).toBe(200);
    expect(engine.retunes.at(-1)?.spyserver?.host).toBe("airspy.local");
    expect(engine.retunes.at(-1)?.channels[0]?.mode).toBe("am");
  });
});

describe("thermal shedding", () => {
  it("has nothing to shed in CB, which already runs with no Close Call or sweep", () => {
    const c = defaultConfig();
    c.scan.closeCall = true;
    c.scan.sweepRanges = [{ loHz: 1, hiHz: 2 }];
    expect(nothingToShed(c, "cb")).toBe(true);
    expect(nothingToShed(c, "scan")).toBe(false);
    c.scan.closeCall = false;
    c.scan.sweepRanges = [];
    expect(nothingToShed(c, "scan")).toBe(true);
  });
});

describe("SAME decoder placement", () => {
  it("the scanner never decodes when a dedicated weather radio does, even on a break-in", () => {
    const wx = { id: "wx", freq: WX_FREQ, alphaTag: "NWR", mode: "nfm" as const, enabled: true };
    const dedicated = { ...defaultConfig(), weatherChannel: wx, radios: [{ serial: "KIOSK03", role: "weather" as const }] };
    expect(toScanConfig(dedicated, "weather").sameEnable).toBe(false);
    expect(toScanConfig({ ...defaultConfig(), weatherChannel: wx }, "weather").sameEnable).toBe(true);
  });
});
