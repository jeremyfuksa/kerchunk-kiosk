// kiosk/test/schema.test.ts
import { describe, it, expect } from "vitest";
import { configSchema, defaultConfig } from "../src/backend/config/schema.js";
import { CTCSS_TONES } from "../src/backend/config/ctcss.js";
import { DCS_CODES, dcsAlias, dcsWord, isDcsCode } from "../src/backend/config/dcs.js";

describe("configSchema", () => {
  it("accepts a valid config", () => {
    const cfg = {
      version: 1,
      scan: { sampleRate: 12000, squelchLevel: 150, gain: "auto", dwellMs: 2000 },
      audio: { sink: "hdmi:CARD=vc4hdmi0", volume: 70, muted: false, remoteListening: false },
      channels: [
        { id: "ch_001", freq: 145130000, alphaTag: "KC0KW", mode: "nfm", enabled: true },
      ],
    };
    expect(configSchema.parse(cfg)).toEqual(cfg);
  });

  it("rejects a negative frequency", () => {
    const bad = { ...defaultConfig(), channels: [
      { id: "x", freq: -1, alphaTag: "", mode: "fm", enabled: true },
    ] };
    expect(() => configSchema.parse(bad)).toThrow();
  });

  it("rejects an unknown mode", () => {
    const bad = { ...defaultConfig(), channels: [
      { id: "x", freq: 1, alphaTag: "", mode: "p25", enabled: true },
    ] };
    expect(() => configSchema.parse(bad)).toThrow();
  });

  it("clamps volume range via schema (0-100)", () => {
    const bad = { ...defaultConfig(), audio: { ...defaultConfig().audio, volume: 250 } };
    expect(() => configSchema.parse(bad)).toThrow();
  });

  it("ctcssHz must be one of the 50 standard tones; heardCtcssHz is free telemetry", () => {
    const withTone = (extra: object) => ({ ...defaultConfig(), channels: [
      { id: "x", freq: 146520000, alphaTag: "", mode: "fm", enabled: true, ...extra },
    ] });
    expect(configSchema.safeParse(withTone({ ctcssHz: 100.0 })).success).toBe(true);
    expect(configSchema.safeParse(withTone({ ctcssHz: 67.0 })).success).toBe(true);
    expect(configSchema.safeParse(withTone({ ctcssHz: 254.1 })).success).toBe(true);
    expect(configSchema.safeParse(withTone({ ctcssHz: 100.1 })).success).toBe(false);
    expect(configSchema.safeParse(withTone({ ctcssHz: 150.0 })).success).toBe(false);   // not in the 50-tone set
    expect(configSchema.safeParse(withTone({ ctcssHz: "100.0" })).success).toBe(false);
    expect(configSchema.safeParse(withTone({ heardCtcssHz: 123.0 })).success).toBe(true);
    expect(configSchema.safeParse(withTone({})).success).toBe(true);   // untoned: unchanged
  });

  it("the shared CTCSS table is the 50 EIA tones", () => {
    expect(CTCSS_TONES).toHaveLength(50);
    expect(CTCSS_TONES[0]).toBe(67.0);
    expect(CTCSS_TONES[49]).toBe(254.1);
  });

  it("dcsCode must be a standard code + N|I, exclusive with ctcssHz; heardDcs is free telemetry", () => {
    const withCode = (extra: object) => ({ ...defaultConfig(), channels: [
      { id: "x", freq: 146520000, alphaTag: "", mode: "fm", enabled: true, ...extra },
    ] });
    expect(configSchema.safeParse(withCode({ dcsCode: "023N" })).success).toBe(true);
    expect(configSchema.safeParse(withCode({ dcsCode: "754I" })).success).toBe(true);
    for (const bad of ["024N", "023", "23N", "023n", "023X", "0023N", 23]) {
      expect(configSchema.safeParse(withCode({ dcsCode: bad })).success).toBe(false);
    }
    expect(configSchema.safeParse(withCode({ dcsCode: "023N", ctcssHz: 100.0 })).success).toBe(false);
    expect(configSchema.safeParse(withCode({ heardDcs: "047N", heardCtcssHz: 88.5 })).success).toBe(true);
  });

  it("the shared DCS table is the 104 standard codes; words and inversion twins match published values", () => {
    expect(DCS_CODES).toHaveLength(104);
    expect(new Set(DCS_CODES).size).toBe(104);
    expect(DCS_CODES[0]).toBe("023");
    expect(DCS_CODES[103]).toBe("754");
    expect(isDcsCode("023N") && isDcsCode("023I") && !isDcsCode("024N")).toBe(true);
    expect(dcsWord("023N")).toBe(0x763813);   // UV-K5 firmware / native test_dcs.cpp
    expect(dcsAlias("023I")).toBe("047N");     // standard inversion pairs
    expect(dcsAlias("047N")).toBe("023I");
    expect(dcsAlias("754N")).toBe("116I");
    expect(dcsAlias("bogus")).toBeUndefined();
    for (const c of DCS_CODES) expect(dcsAlias(`${c}N`)).toMatch(/^\d{3}I$/);
  });

  it("defaultConfig() is itself valid", () => {
    expect(() => configSchema.parse(defaultConfig())).not.toThrow();
  });

  it("accepts helper watchdog timeouts in [1000, 120000] ms and rejects outside it", () => {
    const base = defaultConfig();
    const scan = (x: object) => configSchema.parse({ ...base, scan: { ...base.scan, ...x } }).scan;
    expect(scan({ helperReadyTimeoutMs: 20000, helperSilenceTimeoutMs: 8000 })).toMatchObject({ helperReadyTimeoutMs: 20000, helperSilenceTimeoutMs: 8000 });
    expect(() => scan({ helperReadyTimeoutMs: 999 })).toThrow();
    expect(() => scan({ helperSilenceTimeoutMs: 120001 })).toThrow();
    expect(() => scan({ helperSilenceTimeoutMs: 1500.5 })).toThrow();
  });

  it("accepts scan.fmAudioHpfHz of 0 (off) or [50, 1000] and rejects the rest", () => {
    const base = defaultConfig();
    const hpf = (v: number) => configSchema.parse({ ...base, scan: { ...base.scan, fmAudioHpfHz: v } }).scan.fmAudioHpfHz;
    expect(hpf(0)).toBe(0);
    expect(hpf(300)).toBe(300);
    expect(() => hpf(20)).toThrow();
    expect(() => hpf(1001)).toThrow();
  });

  it("accepts scan.fmAudioLpfHz in [1000, 24000] and rejects outside it", () => {
    const base = defaultConfig();
    expect(configSchema.parse({ ...base, scan: { ...base.scan, fmAudioLpfHz: 3500 } }).scan.fmAudioLpfHz).toBe(3500);
    expect(() => configSchema.parse({ ...base, scan: { ...base.scan, fmAudioLpfHz: 999 } })).toThrow();
    expect(() => configSchema.parse({ ...base, scan: { ...base.scan, fmAudioLpfHz: 24001 } })).toThrow();
  });

  it("accepts scan.nativeAmGainDb in [-30, 20] and rejects outside it", () => {
    const base = defaultConfig();
    expect(configSchema.parse({ ...base, scan: { ...base.scan, nativeAmGainDb: -6 } }).scan.nativeAmGainDb).toBe(-6);
    expect(() => configSchema.parse({ ...base, scan: { ...base.scan, nativeAmGainDb: 25 } })).toThrow();
    expect(() => configSchema.parse({ ...base, scan: { ...base.scan, nativeAmGainDb: -31 } })).toThrow();
  });

  it("accepts scan.nativeQuietDb (native engine's own dB scale, keeps the value)", () => {
    const cfg = configSchema.parse({ ...defaultConfig(), scan: { ...defaultConfig().scan, nativeQuietDb: -6 } });
    expect(cfg.scan.nativeQuietDb).toBe(-6);
  });

  it("accepts a positive scan.nativeQuietDb (native scale may be positive)", () => {
    const cfg = configSchema.parse({ ...defaultConfig(), scan: { ...defaultConfig().scan, nativeQuietDb: 3.5 } });
    expect(cfg.scan.nativeQuietDb).toBe(3.5);
  });

  it("rejects a non-number scan.nativeQuietDb", () => {
    const bad = { ...defaultConfig(), scan: { ...defaultConfig().scan, nativeQuietDb: "x" } };
    expect(() => configSchema.parse(bad)).toThrow();
  });

  it("accepts radios addressed by serial, by port, or both", () => {
    const withRadios = (radios: unknown[]) => ({ ...defaultConfig(), radios });
    expect(() => configSchema.parse(withRadios([{ serial: "KIOSK01", role: "scan" }]))).not.toThrow();
    expect(() => configSchema.parse(withRadios([{ port: "1-1.2", role: "adsb" }]))).not.toThrow();
    expect(() => configSchema.parse(withRadios([{ serial: "K", port: "1-1.2", role: "weather" }]))).not.toThrow();
  });

  it("rejects a radio with neither serial nor port", () => {
    const bad = { ...defaultConfig(), radios: [{ role: "scan" }] };
    expect(() => configSchema.parse(bad)).toThrow();
  });

  it("defaults squelchLevel above the measured noise floor", () => {
    // Bench measurement: RMS noise floor ~150, noise spikes ~1436, real signal
    // ~2900. A default of 150 sits on the noise floor and causes constant false
    // squelch-opens. The default must clear the noise spikes with margin while
    // staying below the signal level, so >= 1500 documents that rationale.
    expect(defaultConfig().scan.squelchLevel).toBeGreaterThanOrEqual(1500);
  });

  it("defaults the aircraft block fields when given an empty object", () => {
    const cfg = configSchema.parse({ ...defaultConfig(), aircraft: {} });
    expect(cfg.aircraft).toEqual({
      enabled: false,
      radiusKm: 75,
      pollIntervalMs: 5000,
      maxTargets: 60,
      url: "https://api.airplanes.live/v2/point",
      trails: false,
    });
  });

  // The endpoint 301s http -> https, so a cleartext base cost every poll an
  // extra request/connection against a 1 req/s-limited feed. The old default
  // is persisted in deployed configs, where it shadows the new one — migrate
  // that exact value on load.
  it("migrates the legacy cleartext aircraft url to https", () => {
    const cfg = configSchema.parse({
      ...defaultConfig(),
      aircraft: { url: "http://api.airplanes.live/v2/point" },
    });
    expect(cfg.aircraft?.url).toBe("https://api.airplanes.live/v2/point");
  });

  // A self-hosted receiver (the reserved dump1090 sidecar) is plain http on
  // the LAN and must not be forced to https — only the known-bad default moves.
  it("leaves a custom http aircraft url alone", () => {
    const cfg = configSchema.parse({
      ...defaultConfig(),
      aircraft: { url: "http://192.168.1.50:8080/data" },
    });
    expect(cfg.aircraft?.url).toBe("http://192.168.1.50:8080/data");
  });

  it("accepts an enabled aircraft block with overrides", () => {
    const cfg = configSchema.parse({
      ...defaultConfig(),
      aircraft: { enabled: true, radiusKm: 40, maxTargets: 30 },
    });
    expect(cfg.aircraft?.enabled).toBe(true);
    expect(cfg.aircraft?.radiusKm).toBe(40);
    expect(cfg.aircraft?.maxTargets).toBe(30);
    expect(cfg.aircraft?.pollIntervalMs).toBe(5000); // still defaulted
  });

  it("rejects a non-URL aircraft url", () => {
    expect(() => configSchema.parse({
      ...defaultConfig(),
      aircraft: { url: "not-a-url" },
    })).toThrow();
  });

  it("omits aircraft entirely when not provided", () => {
    const cfg = configSchema.parse(defaultConfig());
    expect(cfg.aircraft).toBeUndefined();
  });
});

describe("weatherChannel", () => {
  it("is optional — a config without it still parses", () => {
    expect(configSchema.safeParse(defaultConfig()).success).toBe(true);
  });

  it("accepts a valid weather channel", () => {
    const cfg = { ...defaultConfig(), weatherChannel: { id: "wx_1", freq: 162550000, alphaTag: "NOAA", mode: "nfm", enabled: true } };
    expect(configSchema.safeParse(cfg).success).toBe(true);
  });

  it("rejects a weather channel with a bad mode", () => {
    const cfg = { ...defaultConfig(), weatherChannel: { id: "wx_1", freq: 162550000, alphaTag: "NOAA", mode: "ssb", enabled: true } };
    expect(configSchema.safeParse(cfg).success).toBe(false);
  });
});

describe("wideband scan fields", () => {
  it("are optional — existing configs still parse", () => {
    expect(configSchema.safeParse(defaultConfig()).success).toBe(true);
  });

  it("accepts explicit wideband tuning and preserves the values", () => {
    const cfg = structuredClone(defaultConfig()) as Record<string, unknown> & { scan: Record<string, unknown> };
    cfg.scan.windowBandwidthHz = 2_000_000;
    cfg.scan.groupDwellMs = 3000;
    cfg.scan.openAboveFloorDb = 9;
    const parsed = configSchema.safeParse(cfg);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.scan.windowBandwidthHz).toBe(2_000_000);
      expect(parsed.data.scan.groupDwellMs).toBe(3000);
      expect(parsed.data.scan.openAboveFloorDb).toBe(9);
    }
  });

  it("rejects a non-positive windowBandwidthHz", () => {
    const cfg = structuredClone(defaultConfig()) as Record<string, unknown> & { scan: Record<string, unknown> };
    cfg.scan.windowBandwidthHz = 0;
    expect(configSchema.safeParse(cfg).success).toBe(false);
  });
});

describe("scan lanesPerGroup + sampleRateHz", () => {
  const base = defaultConfig();
  const scan = (x: object) => configSchema.parse({ ...base, scan: { ...base.scan, ...x } }).scan;

  it("are optional (today's 12 lanes / 2.4 Msps / 2 MHz apply)", () => {
    const s = scan({});
    expect(s.lanesPerGroup).toBeUndefined();
    expect(s.sampleRateHz).toBeUndefined();
  });

  it("lanesPerGroup: integer in [1, 64]", () => {
    expect(scan({ lanesPerGroup: 1 }).lanesPerGroup).toBe(1);
    expect(scan({ lanesPerGroup: 64 }).lanesPerGroup).toBe(64);
    expect(() => scan({ lanesPerGroup: 0 })).toThrow();
    expect(() => scan({ lanesPerGroup: 65 })).toThrow();
    expect(() => scan({ lanesPerGroup: 12.5 })).toThrow();
  });

  it("sampleRateHz: multiple of 50 kHz in [950k, 3.2M]", () => {
    expect(scan({ sampleRateHz: 2_400_000, windowBandwidthHz: 2_000_000 }).sampleRateHz).toBe(2_400_000);
    expect(scan({ sampleRateHz: 3_200_000, windowBandwidthHz: 3_150_000 }).sampleRateHz).toBe(3_200_000);
    expect(scan({ sampleRateHz: 950_000, windowBandwidthHz: 900_000 }).sampleRateHz).toBe(950_000);
    expect(() => scan({ sampleRateHz: 900_000, windowBandwidthHz: 850_000 })).toThrow();   // librtlsdr rejects exactly 900 000
    expect(() => scan({ sampleRateHz: 2_048_000 })).toThrow();          // not a lane multiple
    expect(() => scan({ sampleRateHz: 850_000, windowBandwidthHz: 500_000 })).toThrow();
    expect(() => scan({ sampleRateHz: 3_250_000 })).toThrow();
  });

  it("rejects a window wider than (sampleRateHz - 50 kHz), using defaults for omitted fields", () => {
    expect(scan({ sampleRateHz: 2_450_000 }).sampleRateHz).toBe(2_450_000);   // exactly fits the 2.4 MHz default
    expect(() => scan({ sampleRateHz: 2_400_000 })).toThrow();                 // default 2.4 MHz window too wide
    expect(() => scan({ windowBandwidthHz: 2_500_000 })).toThrow();            // default 2.5 Msps rate
    expect(scan({ windowBandwidthHz: 2_450_000 }).windowBandwidthHz).toBe(2_450_000);
    const r = configSchema.safeParse({ ...base, scan: { ...base.scan, sampleRateHz: 1_000_000 } });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]?.path).toEqual(["scan", "windowBandwidthHz"]);
  });
});

describe("mixerCard by name", () => {
  it("accepts an ALSA card NAME (stable across boots, unlike indices)", () => {
    const cfg = structuredClone(defaultConfig()) as Record<string, unknown> & { audio: Record<string, unknown> };
    cfg.audio.mixerCard = "PCH";
    const parsed = configSchema.safeParse(cfg);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.audio.mixerCard).toBe("PCH");
  });

  it("still accepts a numeric index", () => {
    const cfg = structuredClone(defaultConfig()) as Record<string, unknown> & { audio: Record<string, unknown> };
    cfg.audio.mixerCard = 1;
    expect(configSchema.safeParse(cfg).success).toBe(true);
  });
});

describe("retired GNU Radio keys (legacy configs)", () => {
  it("a config still holding noiseQuietDb (scan + bank) and detectVia parses; the keys are stripped", () => {
    const cfg = structuredClone(defaultConfig()) as Record<string, unknown> & {
      scan: Record<string, unknown>; banks?: Array<Record<string, unknown>>;
    };
    cfg.scan.noiseQuietDb = -86;
    cfg.scan.detectVia = "fft";
    cfg.banks = [{ id: "b1", name: "Ham", enabled: true, noiseQuietDb: -90, hangMs: 1500 }];
    const parsed = configSchema.safeParse(cfg);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.scan).not.toHaveProperty("noiseQuietDb");
    expect(parsed.data.scan).not.toHaveProperty("detectVia");
    expect(parsed.data.banks?.[0]).not.toHaveProperty("noiseQuietDb");
    expect(parsed.data.banks?.[0]?.hangMs).toBe(1500);    // live profile keys survive
  });
});

describe("channel priority", () => {
  it("accepts priority: true and preserves it", () => {
    const cfg = { ...defaultConfig(), channels: [
      { id: "p1", freq: 464275000, alphaTag: "WOF", mode: "nfm", enabled: true, priority: true },
    ] };
    const parsed = configSchema.safeParse(cfg);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.channels[0]!.priority).toBe(true);
  });

  it("channels without priority still parse (optional)", () => {
    expect(configSchema.safeParse(defaultConfig()).success).toBe(true);
  });
});

describe("close call config", () => {
  it("accepts closeCall toggle and closeCallDb threshold", () => {
    const cfg = structuredClone(defaultConfig()) as Record<string, unknown> & { scan: Record<string, unknown> };
    cfg.scan.closeCall = false;
    cfg.scan.closeCallDb = 20;
    const parsed = configSchema.safeParse(cfg);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.scan.closeCall).toBe(false);
      expect(parsed.data.scan.closeCallDb).toBe(20);
    }
  });
});

describe("close call sample recording", () => {
  it("accepts close call sample recording knobs", () => {
    const cfg = structuredClone(defaultConfig()) as Record<string, unknown> & { scan: Record<string, unknown> };
    cfg.scan.recordCloseCalls = true;
    cfg.scan.closeCallSampleSeconds = 20;
    cfg.scan.closeCallSampleMaxMb = 50;
    const parsed = configSchema.safeParse(cfg);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.scan.recordCloseCalls).toBe(true);
      expect(parsed.data.scan.closeCallSampleSeconds).toBe(20);
      expect(parsed.data.scan.closeCallSampleMaxMb).toBe(50);
    }
  });

  it("rejects a non-positive close call sample length", () => {
    const cfg = structuredClone(defaultConfig()) as Record<string, unknown> & { scan: Record<string, unknown> };
    cfg.scan.closeCallSampleSeconds = 0;
    const parsed = configSchema.safeParse(cfg);
    expect(parsed.success).toBe(false);
  });
});

describe("close call lockouts", () => {
  it("accepts a lockout frequency list", () => {
    const cfg = structuredClone(defaultConfig()) as Record<string, unknown> & { scan: Record<string, unknown> };
    cfg.scan.lockoutHz = [462887500, 463100000];
    const parsed = configSchema.safeParse(cfg);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.scan.lockoutHz).toEqual([462887500, 463100000]);
  });
});

describe("lookup config (RepeaterBook)", () => {
  it("accepts userAgent + states", () => {
    const cfg = structuredClone(defaultConfig()) as Record<string, unknown>;
    cfg.lookup = { userAgent: "Kerchunk/1.0 (JeremyFuksa, hello@jeremyfuksa.com)", states: ["Missouri", "Kansas"] };
    const parsed = configSchema.safeParse(cfg);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.lookup?.states).toEqual(["Missouri", "Kansas"]);
  });

  it("is optional", () => {
    expect(configSchema.safeParse(defaultConfig()).success).toBe(true);
  });
});

describe("lookup.radioReference config", () => {
  it("accepts appKey/credentials/countyIds", () => {
    const cfg = structuredClone(defaultConfig()) as Record<string, unknown>;
    cfg.lookup = {
      userAgent: "Kerchunk/1.0 (test)",
      states: ["Missouri"],
      radioReference: { appKey: "k", username: "u", password: "p", countyIds: [1310] },
    };
    expect(configSchema.safeParse(cfg).success).toBe(true);
  });
});

describe("retired channel levelTrimDb", () => {
  it("a live config still carrying it parses, and the key is stripped", () => {
    const cfg = { ...defaultConfig(), channels: [
      { id: "c1", freq: 464275000, alphaTag: "WOF", mode: "nfm", enabled: true, levelTrimDb: -8.5 },
    ] };
    const parsed = configSchema.safeParse(cfg);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect("levelTrimDb" in parsed.data.channels[0]!).toBe(false);
  });
});

describe("audio speaker AGC knobs", () => {
  const withAudio = (extra: Record<string, unknown>) => {
    const d = defaultConfig();
    return configSchema.safeParse({ ...d, audio: { ...d.audio, ...extra } });
  };
  it("are optional and accept in-range values", () => {
    expect(withAudio({}).success).toBe(true);
    expect(withAudio({
      agcTargetDb: -18, agcMaxGainDb: 15, agcMinGainDb: -20, agcAttackMs: 10,
      agcReleaseMs: 400, agcHoldBelowDb: -50, limiterCeiling: 0.7, limiterReleaseMs: 50,
    }).success).toBe(true);
  });
  it("reject values outside the helper's CLI ranges", () => {
    for (const bad of [
      { agcTargetDb: -2 }, { agcTargetDb: -41 }, { agcMaxGainDb: 31 }, { agcMaxGainDb: -1 },
      { agcMinGainDb: 1 }, { agcMinGainDb: -41 }, { agcAttackMs: 0.5 }, { agcAttackMs: 201 },
      { agcReleaseMs: 19 }, { agcReleaseMs: 5001 }, { agcHoldBelowDb: -19 }, { agcHoldBelowDb: -91 },
      { limiterCeiling: 0 }, { limiterCeiling: 0.81 }, { limiterReleaseMs: 4 }, { limiterReleaseMs: 1001 },
    ]) expect(withAudio(bad).success, JSON.stringify(bad)).toBe(false);
  });
});

describe("channel/discovery location", () => {
  it("accepts a location object on channels and discoveries", () => {
    const cfg = { ...defaultConfig(),
      channels: [{ id: "c1", freq: 145130000, alphaTag: "W0ABC", mode: "nfm", enabled: true,
        location: { lat: 38.88, lon: -94.82, city: "Olathe", state: "KS", source: "repeaterbook" },
        lookedUpAt: 1780600000000 }],
      discoveries: [{ id: "d1", freq: 462887500, alphaTag: "CC", ts: 1,
        location: { city: "Kansas City", state: "MO", source: "repeaterbook" },
        hitCount: 8, lastSeenAt: 9, suppressedAt: 10, suppressionReason: "Repeated unidentified carrier" }],
    };
    const parsed = configSchema.safeParse(cfg);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.channels[0]!.location?.city).toBe("Olathe");
      expect(parsed.data.discoveries![0]!.location?.state).toBe("MO");
      expect(parsed.data.discoveries![0]!.suppressedAt).toBe(10);
    }
  });
});

describe("close call sample knobs", () => {
  const withScan = (scan: Record<string, unknown>) => {
    const base = defaultConfig();
    return configSchema.safeParse({ ...base, scan: { ...base.scan, ...scan } });
  };

  it("accepts a clip length inside the band", () => {
    const parsed = withScan({ closeCallSampleSeconds: 20, closeCallSampleMaxMb: 50 });
    expect(parsed.success).toBe(true);
  });

  it("rejects a clip length below the pre-roll floor", () => {
    // Under 3 s the "clip" would be pre-roll only — audio recorded before the
    // Close Call lane ever took the speaker.
    expect(withScan({ closeCallSampleSeconds: 2 }).success).toBe(false);
  });

  it("rejects a clip length above the memory ceiling", () => {
    // The in-flight clip lives in RAM at ~96 kB/s inside the audio callback:
    // 3600 would mean a 345 MB Buffer.concat on the path that must not stall.
    expect(withScan({ closeCallSampleSeconds: 3600 }).success).toBe(false);
    expect(withScan({ closeCallSampleSeconds: 120 }).success).toBe(true);
  });

  it("bounds the directory budget at both ends", () => {
    expect(withScan({ closeCallSampleMaxMb: 0 }).success).toBe(false);
    expect(withScan({ closeCallSampleMaxMb: 10_000 }).success).toBe(false);
  });
});

describe("display.radar", () => {
  const base = () => ({ ...defaultConfig(), display: { weatherLat: 39.1, weatherLon: -94.58 } });
  it("fills every default when absent", () => {
    const cfg = configSchema.parse(base());
    expect(cfg.display!.radar).toEqual({ enabled: true, source: "mrms", refreshMs: 300_000, staleMs: 1_200_000, fetchTimeoutMs: 240_000, spanDeg: { w: 4, h: 3 } });
  });
  it("keeps operator overrides and fills the rest", () => {
    const cfg = configSchema.parse({ ...base(), display: { ...base().display, radar: { enabled: false, spanDeg: { w: 6 } } } });
    expect(cfg.display!.radar).toEqual({ enabled: false, source: "mrms", refreshMs: 300_000, staleMs: 1_200_000, fetchTimeoutMs: 240_000, spanDeg: { w: 6, h: 3 } });
  });
  it("rejects a refresh faster than one minute (IEM updates every 5)", () => {
    expect(() => configSchema.parse({ ...base(), display: { ...base().display, radar: { refreshMs: 1000 } } })).toThrow();
  });
});

describe("display.glass + radarProduct retirement", () => {
  const base = () => ({ ...defaultConfig(), display: { weatherLat: 39.1, weatherLon: -94.58 } });
  it("fills the glass defaults", () => {
    expect(configSchema.parse(base()).display!.glass).toEqual({
      maxFps: 30, txFps: 60, hazeIntensity: 0, radarOpacity: 0.6,
      radarMinDbz: 15, radarFadeMs: 20_000, txGrowMs: 900,
      holdFps: 4, signalSteps: 8,
      smokeLifeMs: 600_000, smokeStepMs: 6000, smokePxPerMph: 60,
      smokeBody: 0.55, sparkDensity: 1, puffMergeMs: 60_000,
    });
  });
  it("an old config carrying glass.fadeSteps still loads; the key is stripped", () => {
    const cfg = configSchema.parse({ ...base(), display: { ...base().display, glass: { fadeSteps: 24, holdFps: 6 } } });
    expect("fadeSteps" in cfg.display!.glass).toBe(false);
    expect(cfg.display!.glass.holdFps).toBe(6);
    expect(cfg.display!.glass.smokeStepMs).toBe(6000);
  });
  it("rejects out-of-range smoke knobs", () => {
    const g = (glass: object) => ({ ...base(), display: { ...base().display, glass } });
    expect(() => configSchema.parse(g({ smokeStepMs: 500 }))).toThrow();
    expect(() => configSchema.parse(g({ smokeLifeMs: 10_000 }))).toThrow();
    expect(() => configSchema.parse(g({ smokePxPerMph: 201 }))).toThrow();
    expect(() => configSchema.parse(g({ smokeBody: 1.5 }))).toThrow();
    expect(() => configSchema.parse(g({ sparkDensity: -1 }))).toThrow();
  });
  it("an old config carrying radarProduct still loads, and the key is stripped", () => {
    const cfg = configSchema.parse({ ...base(), display: { ...base().display, radarProduct: "mrms-reflectivity" } });
    expect("radarProduct" in cfg.display!).toBe(false);
  });
  it("rejects out-of-range knobs", () => {
    expect(() => configSchema.parse({ ...base(), display: { ...base().display, glass: { maxFps: 0 } } })).toThrow();
    expect(() => configSchema.parse({ ...base(), display: { ...base().display, glass: { hazeIntensity: 2 } } })).toThrow();
  });
});
describe("display.camera", () => {
  const base = () => ({ ...defaultConfig(), display: { weatherLat: 39.1, weatherLon: -94.58 } });
  it("defaults to a fixed stage (follow off)", () => {
    expect(configSchema.parse(base()).display!.camera).toEqual({ follow: false });
  });
  it("accepts follow: true", () => {
    expect(configSchema.parse({ ...base(), display: { ...base().display, camera: { follow: true } } }).display!.camera.follow).toBe(true);
  });
});
