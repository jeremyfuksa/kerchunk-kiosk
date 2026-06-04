// kiosk/test/schema.test.ts
import { describe, it, expect } from "vitest";
import { configSchema, defaultConfig } from "../src/backend/config/schema.js";

describe("configSchema", () => {
  it("accepts a valid config", () => {
    const cfg = {
      version: 1,
      scan: { sampleRate: 12000, squelchLevel: 150, gain: "auto", dwellMs: 2000 },
      audio: { sink: "hdmi:CARD=vc4hdmi0", volume: 70, muted: false },
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

  it("defaultConfig() is itself valid", () => {
    expect(() => configSchema.parse(defaultConfig())).not.toThrow();
  });

  it("defaults squelchLevel above the measured noise floor", () => {
    // Bench measurement: RMS noise floor ~150, noise spikes ~1436, real signal
    // ~2900. A default of 150 sits on the noise floor and causes constant false
    // squelch-opens. The default must clear the noise spikes with margin while
    // staying below the signal level, so >= 1500 documents that rationale.
    expect(defaultConfig().scan.squelchLevel).toBeGreaterThanOrEqual(1500);
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

describe("noiseQuietDb", () => {
  it("accepts a negative dB quieting threshold and preserves it", () => {
    const cfg = structuredClone(defaultConfig()) as Record<string, unknown> & { scan: Record<string, unknown> };
    cfg.scan.noiseQuietDb = -86;
    const parsed = configSchema.safeParse(cfg);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.scan.noiseQuietDb).toBe(-86);
  });

  it("rejects a positive value (it is a below-threshold in dB)", () => {
    const cfg = structuredClone(defaultConfig()) as Record<string, unknown> & { scan: Record<string, unknown> };
    cfg.scan.noiseQuietDb = 10;
    expect(configSchema.safeParse(cfg).success).toBe(false);
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
