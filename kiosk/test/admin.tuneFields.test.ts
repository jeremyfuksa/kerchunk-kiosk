import { describe, it, expect } from "vitest";
import type { Config } from "../src/backend/config/schema.js";
import { KNOB_FIELDS } from "../src/frontend/admin/engineKnobs.js";
import {
  TUNE_FIELDS, FIELD_BY_ID, readTune, applyTune, disabledIds, snapValue, isDefault, isNoChange, isNoOp, parseSweep,
} from "../src/frontend/admin/tuneFields.js";

const base = (): Config => ({
  version: 1,
  scan: { dwellMs: 2000 },
  audio: { sink: "plughw:CARD=PCH,DEV=0", volume: 50, muted: false, remoteListening: false },
  channels: [],
} as unknown as Config);

const set = (cfg: Config, id: string, v: string | boolean) => applyTune(cfg, [id], { [id]: v });

describe("tune field table", () => {
  it("carries every engine knob exactly once, plus the Settings fields", () => {
    for (const k of KNOB_FIELDS) expect(TUNE_FIELDS.filter((f) => f.id === k.id)).toHaveLength(1);
    for (const id of ["tOpenDb", "tQuietDb", "tGroupDwell", "tHang", "tSweep", "tCloseCall", "tCloseCallDb", "tCcRecord", "tCcSampleSec", "tCcSampleMb", "tAlertCool", "tAlertHold", "tAlertNtfy", "tSameFips", "tSameTests"]) {
      expect(FIELD_BY_ID[id], id).toBeDefined();
    }
  });
  it("sound knobs are sliders with named ends", () => {
    for (const f of TUNE_FIELDS.filter((x) => x.group === "sound")) {
      expect(f.control.kind, f.id).toBe("slider");
      if (f.control.kind === "slider") expect(f.control.ends[0].length).toBeGreaterThan(0);
    }
  });
  it("costs follow the server's restart diff", () => {
    const cost = (id: string) => FIELD_BY_ID[id]!.cost;
    expect(cost("tOpenDb")).toBe("scan");
    expect(cost("kAgcTarget")).toBe("scan");
    expect(cost("tCcRecord")).toBe("heavy");
    expect(cost("kLanes")).toBe("heavy");
    expect(cost("kAutoDwell")).toBe("live");
    expect(cost("tCcSampleSec")).toBe("live");
    expect(cost("tAlertCool")).toBe("live");
    expect(cost("kReadyTo")).toBe("backend");
  });
});

describe("read / write", () => {
  it("reads unset numbers as blank and switches as their defaults", () => {
    const v = readTune(base());
    expect(v.tOpenDb).toBe("");
    expect(v.tHang).toBe("2000");
    expect(v.tCloseCall).toBe(true);   // engine default: ON
    expect(v.tCcRecord).toBe(false);
    expect(v.tSweep).toBe("");
    expect(v.kAgcTarget).toBe("");
  });
  it("writes numbers and resets blanks to default", () => {
    const cfg = set(base(), "tOpenDb", "12");
    expect(cfg.scan.openAboveFloorDb).toBe(12);
    set(cfg, "tOpenDb", "");
    expect("openAboveFloorDb" in cfg.scan).toBe(false);
    expect(set(base(), "tHang", "").scan.dwellMs).toBe(2000);
    expect(set(base(), "kAgcTarget", "-20").audio.agcTargetDb).toBe(-20);
  });
  it("rejects out-of-range numbers with the field's name", () => {
    expect(() => set(base(), "tOpenDb", "0")).toThrow(/Squelch open/);
    expect(() => set(base(), "tCcSampleSec", "500")).toThrow(/Sample length/);
  });
  it("parses sweep ranges", () => {
    expect(parseSweep("450-470, 150-162")).toEqual([{ loHz: 450_000_000, hiHz: 470_000_000 }, { loHz: 150_000_000, hiHz: 162_000_000 }]);
    const cfg = set(base(), "tSweep", "450-470");
    expect(cfg.scan.sweepRanges).toHaveLength(1);
    set(cfg, "tSweep", "");
    expect(cfg.scan.sweepRanges).toBeUndefined();
    expect(() => parseSweep("bad")).toThrow(/Sweep ranges/);
    expect(() => parseSweep("470-450")).toThrow(/Sweep ranges/);
  });
  it("alerts: per-field writes, empty block removed", () => {
    const cfg = set(base(), "tAlertCool", "20");
    expect(cfg.alerts).toEqual({ cooldownMinutes: 20 });
    set(cfg, "tSameTests", true);
    expect(cfg.alerts).toEqual({ cooldownMinutes: 20, sameTests: true });
    set(cfg, "tAlertCool", ""); set(cfg, "tSameTests", false);
    expect(cfg.alerts).toBeUndefined();
    expect(() => set(base(), "tAlertNtfy", "not a url")).toThrow(/Push notification URL/);
    expect(set(base(), "tAlertNtfy", "https://ntfy.sh/kc").alerts?.ntfyUrl).toBe("https://ntfy.sh/kc");
    expect(set(base(), "tSameFips", "029047, 29095").alerts?.sameFips).toEqual(["029047", "29095"]);
    expect(() => set(base(), "tSameFips", "12ab")).toThrow(/SAME county codes/);
  });
});

describe("helpers", () => {
  it("disables Close Call dependents", () => {
    const v = readTune(base());
    expect([...disabledIds({ ...v, tCloseCall: false })].sort()).toEqual(["tCcRecord", "tCcSampleMb", "tCcSampleSec", "tCloseCallDb"]);
    expect([...disabledIds({ ...v, tCloseCall: true, tCcRecord: false })].sort()).toEqual(["tCcSampleMb", "tCcSampleSec"]);
    expect(disabledIds({ ...v, tCloseCall: true, tCcRecord: true }).size).toBe(0);
  });
  it("snaps the hum filter's dead zone to off or its minimum", () => {
    const hum = FIELD_BY_ID.kHpf!;
    expect(snapValue(hum, 20)).toBe(0);
    expect(snapValue(hum, 30)).toBe(50);
    expect(snapValue(hum, 300)).toBe(300);
    expect(snapValue(FIELD_BY_ID.kAgcTarget!, -20)).toBe(-20);
  });
  it("isDefault", () => {
    expect(isDefault(FIELD_BY_ID.tOpenDb!, "")).toBe(true);
    expect(isDefault(FIELD_BY_ID.tCloseCall!, true)).toBe(true);
    expect(isDefault(FIELD_BY_ID.tCloseCall!, false)).toBe(false);
    expect(isDefault(FIELD_BY_ID.tGroupDwell!, "3000")).toBe(true);
  });
  it("isDefault compares text fields as strings, not numbers", () => {
    // "0" and "" are numerically equal (Number("0") === Number("")) but must
    // not both read as default for a free-text field.
    expect(isDefault(FIELD_BY_ID.tSameFips!, "0")).toBe(false);
    expect(isDefault(FIELD_BY_ID.tSweep!, "")).toBe(true);
  });
  it("applyTune falls back to the field's default when a value is omitted, not OFF", () => {
    // A missing value must not fall through to "" and read as OFF for a switch.
    const cfg = set(base(), "tCloseCall", false);
    expect(cfg.scan.closeCall).toBe(false);
    applyTune(cfg, ["tCloseCall"], {});
    expect(cfg.scan.closeCall).toBe(true); // tCloseCall's engine default is ON
  });
  describe("isNoChange", () => {
    const open = FIELD_BY_ID.tOpenDb!; // default 9
    it("the loaded value is no change", () => {
      expect(isNoChange(open, "12", "12")).toBe(true);
      expect(isNoChange(open, "", "")).toBe(true);
    });
    it("an unset field landing on its displayed default is no change", () => {
      expect(isNoChange(open, "9", "")).toBe(true);
      expect(isNoChange(open, "9.0", "")).toBe(true);
      expect(isNoChange(open, "10", "")).toBe(false);
    });
    it("resetting a set field to the default IS a change (it unsets it)", () => {
      expect(isNoChange(open, "", "12")).toBe(false);
      expect(isNoChange(open, "9", "12")).toBe(false);
    });
    it("numbers compare numerically, text as text", () => {
      expect(isNoChange(open, "12.0", "12")).toBe(true);
      expect(isNoChange(FIELD_BY_ID.tSameFips!, "0", "")).toBe(false);
      expect(isNoChange(FIELD_BY_ID.tSweep!, " 450-470 ", "450-470")).toBe(true);
    });
    it("switches compare as booleans", () => {
      expect(isNoChange(FIELD_BY_ID.tCloseCall!, true, true)).toBe(true);
      expect(isNoChange(FIELD_BY_ID.tCloseCall!, false, true)).toBe(false);
    });
  });
  describe("isNoOp — against what the radio will have", () => {
    const open = FIELD_BY_ID.tOpenDb!; // default 9
    it("with nothing in flight it is isNoChange against loaded", () => {
      expect(isNoOp(open, "12", "12")).toBe(true);
      expect(isNoOp(open, "9", "")).toBe(true);
      expect(isNoOp(open, "15", "12")).toBe(false);
    });
    it("moving back to the old loaded value while a save of another is in flight is a change", () => {
      // loaded 12, 15 in flight: 12 must be queued, or the radio ends on 15.
      expect(isNoOp(open, "12", "12", "15")).toBe(false);
    });
    it("matching the in-flight value is no change", () => {
      expect(isNoOp(open, "15", "12", "15")).toBe(true);
      expect(isNoOp(open, "9", "12", "")).toBe(true); // "" in flight = unset = default 9
    });
  });
});

