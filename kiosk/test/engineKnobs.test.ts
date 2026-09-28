import { describe, it, expect } from "vitest";
import type { Config } from "../src/backend/config/schema.js";
import {
  KNOB_FIELDS, KNOB_BY_ID, readKnob, parseKnob, knobUi, windowError, applyKnobs,
  dirtyBands, saveCost, BAND_COST,
} from "../src/frontend/admin/engineKnobs.js";

const baseCfg = (): Config => ({
  channels: [], banks: [],
  scan: { dwellMs: 2000, gain: "auto", sampleRate: 2400000, squelchLevel: 0 },
  audio: { sink: "default", volume: 40, muted: false },
} as unknown as Config);

describe("engine knob field table", () => {
  it("covers every knob the spec lists, once", () => {
    const paths = KNOB_FIELDS.map((f) => f.path.join("."));
    expect(new Set(paths).size).toBe(paths.length);
    expect(paths).toEqual(expect.arrayContaining([
      "audio.agcTargetDb", "audio.agcMaxGainDb", "scan.fmAudioLpfHz", "scan.fmAudioHpfHz", "scan.nativeAmGainDb",
      "audio.agcAttackMs", "audio.agcReleaseMs", "audio.agcHoldBelowDb", "audio.agcMinGainDb",
      "audio.limiterCeiling", "audio.limiterReleaseMs",
      "scan.lanesPerGroup", "scan.sampleRateHz", "scan.windowBandwidthHz", "scan.flatBandwidthHz",
      "scan.autoDwell.enabled", "scan.autoDwell.halfLifeMin", "scan.autoDwell.minFactor", "scan.autoDwell.maxFactor",
      "scan.priorityRevisit.enabled", "scan.priorityRevisit.everyMs", "scan.priorityRevisit.lookMs",
      "scan.helperReadyTimeoutMs", "scan.helperSilenceTimeoutMs",
    ]));
    expect(KNOB_FIELDS).toHaveLength(24);
    expect(KNOB_FIELDS.filter((f) => f.band === "sound").map((f) => f.id))
      .toEqual(["kAgcTarget", "kAgcMax", "kLpf", "kHpf", "kAmGain"]);
  });

  it("maps bands to costs", () => {
    expect(BAND_COST).toEqual({ sound: "scan", loudness: "scan", shape: "scan", schedule: "live", watchdog: "backend" });
  });
});

describe("readKnob", () => {
  it("blank for an unset number, scaled to UI units when set", () => {
    const cfg = baseCfg();
    expect(readKnob(cfg, KNOB_BY_ID.kRate!)).toBe("");
    cfg.scan.sampleRateHz = 2_500_000;
    expect(readKnob(cfg, KNOB_BY_ID.kRate!)).toBe("2.5");
    cfg.scan.priorityRevisit = { everyMs: 8000 } as Config["scan"]["priorityRevisit"];
    expect(readKnob(cfg, KNOB_BY_ID.kRevisitEvery!)).toBe("8");
  });

  it("switches fall back to their default", () => {
    const cfg = baseCfg();
    expect(readKnob(cfg, KNOB_BY_ID.kAutoDwell!)).toBe(true);
    cfg.scan.autoDwell = { enabled: false };
    expect(readKnob(cfg, KNOB_BY_ID.kAutoDwell!)).toBe(false);
  });
});

describe("parseKnob", () => {
  it("blank = undefined (the default)", () => {
    expect(parseKnob(KNOB_BY_ID.kAgcTarget!, "  ")).toBeUndefined();
  });
  it("rejects out-of-range and non-numbers with the label and range", () => {
    expect(() => parseKnob(KNOB_BY_ID.kAgcTarget!, "-2")).toThrow("Target loudness: −40…−3 dBFS");
    expect(() => parseKnob(KNOB_BY_ID.kAgcTarget!, "loud")).toThrow("Target loudness");
  });
  it("hum filter accepts 0 (off) but not 1…49", () => {
    expect(parseKnob(KNOB_BY_ID.kHpf!, "0")).toBe(0);
    expect(() => parseKnob(KNOB_BY_ID.kHpf!, "20")).toThrow("0 (off) or 50…1000 Hz");
    expect(parseKnob(KNOB_BY_ID.kHpf!, "250")).toBe(250);
  });
  it("converts to config units and rounds integer fields", () => {
    expect(parseKnob(KNOB_BY_ID.kRate!, "2.55")).toBe(2_550_000);
    expect(parseKnob(KNOB_BY_ID.kRevisitLook!, "0.7")).toBe(700);
    expect(parseKnob(KNOB_BY_ID.kLanes!, "31.6")).toBe(32);
    expect(parseKnob(KNOB_BY_ID.kLimCeil!, "0.65")).toBe(0.65);
  });
  it("sample rate must be a multiple of 50 kHz", () => {
    expect(() => parseKnob(KNOB_BY_ID.kRate!, "2.52")).toThrow("multiple of 0.05");
  });
});

describe("knobUi", () => {
  it("returns the typed UI value, or the default when blank/invalid", () => {
    expect(knobUi({ kAgcTarget: "-20" }, "kAgcTarget")).toBe(-20);
    expect(knobUi({ kAgcTarget: "" }, "kAgcTarget")).toBe(-18);
    expect(knobUi({ kAgcTarget: "x" }, "kAgcTarget")).toBe(-18);
    expect(knobUi({}, "kWindow")).toBe(2.4);
  });
});

describe("windowError / applyKnobs", () => {
  it("window must fit inside rate − 50 kHz", () => {
    expect(windowError(2_400_000, 2_500_000)).toBeNull();
    expect(windowError(2_500_000, 2_500_000)).toBe("Window 2.5 MHz is wider than rate − 0.05 (2.45). Raise the rate or narrow the window.");
  });

  it("writes set fields, deletes blank ones, keeps unrelated config", () => {
    const cfg = baseCfg();
    cfg.audio.agcReleaseMs = 900;
    cfg.scan.priorityRevisit = { everyMs: 9000, lookMs: 800 };
    const out = applyKnobs(cfg, KNOB_FIELDS, {
      kAgcTarget: "-20", kAgcRelease: "", kRevisitEvery: "", kRevisitLook: "1.2", kRevisit: false, kAutoDwell: true,
    });
    expect(out.audio.agcTargetDb).toBe(-20);
    expect("agcReleaseMs" in out.audio).toBe(false);
    expect(out.scan.priorityRevisit).toEqual({ lookMs: 1200, enabled: false });
    expect(out.scan.autoDwell).toEqual({ enabled: true });
    expect(out.audio.volume).toBe(40);
  });

  it("drops an emptied nested object entirely", () => {
    const cfg = baseCfg();
    cfg.scan.autoDwell = { halfLifeMin: 10 };
    applyKnobs(cfg, [KNOB_BY_ID.kHalfLife!], { kHalfLife: "" });
    expect(cfg.scan.autoDwell).toBeUndefined();
  });

  it("rejects a window wider than the (new or existing) rate allows", () => {
    const cfg = baseCfg();
    cfg.scan.sampleRateHz = 2_500_000;
    expect(() => applyKnobs(cfg, KNOB_FIELDS, { kWindow: "2.5" })).toThrow("wider than rate");
    expect(() => applyKnobs(baseCfg(), KNOB_FIELDS, { kWindow: "2.5", kRate: "2.6" })).not.toThrow();
  });
});

describe("dirtyBands / saveCost", () => {
  it("collects the bands whose values changed", () => {
    const loaded = { kAgcTarget: "", kHalfLife: "30", kReadyTo: "" };
    expect(dirtyBands(KNOB_FIELDS, loaded, { ...loaded })).toEqual(new Set());
    expect(dirtyBands(KNOB_FIELDS, loaded, { ...loaded, kHalfLife: "20", kReadyTo: "12" }))
      .toEqual(new Set(["schedule", "watchdog"]));
  });

  it("sound card names the restart once dirty", () => {
    expect(saveCost("sound", new Set())).toEqual({
      label: "Save sound", note: "Volume and mute stay on the Now panel and apply instantly.", warn: false,
    });
    expect(saveCost("sound", new Set(["sound"]))).toEqual({
      label: "Save and restart scanning", note: "Audio cuts for a moment and the wall replays its warm-up.", warn: true,
    });
  });

  it("advanced card joins the costs of dirty bands", () => {
    expect(saveCost("advanced", new Set())).toEqual({ label: "Save engine settings", note: "Nothing changed.", warn: false });
    expect(saveCost("advanced", new Set(["schedule"]))).toEqual({
      label: "Save engine settings", note: "Scheduling applies at once.", warn: false,
    });
    expect(saveCost("advanced", new Set(["shape", "schedule", "watchdog"]))).toEqual({
      label: "Save and restart scanning",
      note: "Audio cuts for a moment; scheduling applies at once; watchdogs apply after a backend restart (System → Restart radio backend).",
      warn: true,
    });
  });
});
