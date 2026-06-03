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
