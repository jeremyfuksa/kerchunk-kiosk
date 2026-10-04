import { describe, it, expect } from "vitest";
import { cornerView, windowLabel, serviceLabel, sentenceCase, meterFill, METER_SEGMENTS, type CornerInput } from "../src/frontend/dashboard/cornerView.js";

const base: CornerInput = {
  warmed: true, warmupPhase: null, warmupStep: 0, warmupOf: 4, error: null, engineState: "running",
  nowPlaying: null, tunedHz: 160_900_000, scanCount: 41, muted: false, mode: "scan", breakIn: false,
};
const live = { freq: 154_430_000, alphaTag: "KC Fire Dispatch", tags: ["public-safety"] };

describe("cornerView — pill states", () => {
  it("scanning: pill with the window label and the sweep", () => {
    const v = cornerView(base);
    expect(v).toMatchObject({ show: "pill", word: "Scanning", detail: "VHF high 160.9", tone: "plain", sweep: true, muted: false, warmLit: null });
  });
  it("scanning while muted carries the muted flag", () => {
    expect(cornerView({ ...base, muted: true })).toMatchObject({ show: "pill", muted: true });
  });
  it("an unanswered status poll (scanCount −1) reads as scanning, not standby", () => {
    expect(cornerView({ ...base, scanCount: -1 })).toMatchObject({ word: "Scanning" });
  });
  it("retuning while the engine starts", () => {
    expect(cornerView({ ...base, engineState: "starting" })).toMatchObject({ word: "Retuning", detail: "changing windows", sweep: true });
  });
  it("standby is a hay pill with no sweep", () => {
    expect(cornerView({ ...base, scanCount: 0 })).toMatchObject({ word: "Standby", tone: "hay", sweep: false, detail: "no channels are on — turn a bank on in the admin" });
  });
  it("weather-only and monitor modes name themselves", () => {
    expect(cornerView({ ...base, mode: "weather" })).toMatchObject({ word: "Weather only" });
    expect(cornerView({ ...base, mode: "monitor" })).toMatchObject({ word: "Listening to one channel" });
  });
  it("warming up fills the pill's segments by step", () => {
    const v = cornerView({ ...base, warmed: false, warmupPhase: "spawning", warmupStep: 2, warmupOf: 4 });
    expect(v).toMatchObject({ show: "pill", word: "Warming up", detail: "step 2 of 4 · building signal processing", sweep: false, warmLit: 6 });
  });
  it("warm-up with of=0 or an unknown phase never yields NaN", () => {
    const v = cornerView({ ...base, warmed: false, warmupPhase: "mystery", warmupStep: 1, warmupOf: 0 });
    expect(v).toMatchObject({ warmLit: 0, detail: "step 1 of 0 · mystery" });
  });
  it("no tuned window yet → empty detail", () => {
    expect(cornerView({ ...base, tunedHz: null })).toMatchObject({ detail: "" });
  });
});

describe("cornerView — glass states", () => {
  it("live: service head, sentence-case meta, tag-first name, four-decimal freq", () => {
    const v = cornerView({ ...base, nowPlaying: live });
    expect(v.show).toBe("glass");
    if (v.show !== "glass") return;
    expect(v.lcd).toEqual({ state: "live", meta: "Live · Public safety", name: "KC Fire Dispatch", freq: "154.4300", silent: null });
    expect(v.head?.color).toBe("#e54059");
    expect(v.meter).toBe(true);
    expect(v.hint).toBeNull();
  });
  it("muted live glass shows Muted in the silent slot", () => {
    const v = cornerView({ ...base, nowPlaying: live, muted: true });
    expect(v.show === "glass" && v.lcd.silent).toBe("Muted");
  });
  it("an untagged unknown frequency still renders (grey head, bare Live meta)", () => {
    const v = cornerView({ ...base, nowPlaying: { freq: 30_000_000, alphaTag: "" } });
    if (v.show !== "glass") throw new Error("expected glass");
    expect(v.lcd.meta).toBe("Live");
    expect(v.lcd.name).toBe("30.0000");
    expect(v.lcd.freq).toBe("");
    expect(v.head?.color).toBe("#747B8A");
  });
  it("weather break-in: breakin state, hay meta prefix", () => {
    const v = cornerView({ ...base, mode: "weather", breakIn: true, nowPlaying: { freq: 162_550_000, alphaTag: "NWS Kansas City" } });
    if (v.show !== "glass") throw new Error("expected glass");
    expect(v.lcd.state).toBe("breakin");
    expect(v.lcd.meta).toBe("Weather break-in · NOAA");
  });
  it("error takes the glass with the recovery hint, no head, no meter", () => {
    const v = cornerView({ ...base, error: "SDR KIOSK01 not found", nowPlaying: live });
    expect(v).toMatchObject({ show: "glass", head: null, meter: false, lcd: { state: "error", meta: "Radio error", name: "SDR KIOSK01 not found", freq: "" } });
    expect(v.show === "glass" && v.hint).toMatch(/restart the radio from System/);
  });
  it("keys change with what's drawn, not with signal level", () => {
    const a = cornerView({ ...base, nowPlaying: live });
    expect(cornerView({ ...base, nowPlaying: live }).key).toBe(a.key);
    expect(cornerView({ ...base, nowPlaying: live, muted: true }).key).not.toBe(a.key);
    expect(cornerView({ ...base, nowPlaying: { ...live, freq: 154_445_000 } }).key).not.toBe(a.key);
  });
});

describe("cornerView helpers", () => {
  it("windowLabel sentence-cases the spectrum names", () => {
    expect(windowLabel(120_000_000)).toBe("Airband 120.0");
    expect(windowLabel(146_000_000)).toBe("2 m 146.0");
    expect(windowLabel(462_000_000)).toBe("UHF-T 462.0");
  });
  it("serviceLabel", () => {
    expect(serviceLabel("publicsafety")).toBe("Public safety");
    expect(serviceLabel("biz")).toBe("Business");
    expect(serviceLabel("unknown")).toBe("");
  });
  it("sentenceCase rewrites ALL-CAPS only", () => {
    expect(sentenceCase("TORNADO WARNING")).toBe("Tornado warning");
    expect(sentenceCase("KC Fire Dispatch")).toBe("KC Fire Dispatch");
    expect(sentenceCase("")).toBe("");
  });
  it("meterFill maps the kiosk dB range onto 0..1", () => {
    expect(meterFill(null)).toBe(0);
    expect(meterFill(-35)).toBe(0);
    expect(meterFill(5)).toBe(1);
    expect(meterFill(-15)).toBe(0.5);
    expect(METER_SEGMENTS).toBe(12);
  });
});

describe("cornerView — review fixes", () => {
  it("a window hop does not change the pill's key (the sweep must not restart every hop)", () => {
    const a = cornerView({ ...base, tunedHz: 160_900_000 });
    const b = cornerView({ ...base, tunedHz: 462_800_000 });
    expect(a.show === "pill" && b.show === "pill" && a.detail !== b.detail).toBe(true);
    expect(b.key).toBe(a.key);
  });
  it("a stale breakIn flag never labels a non-weather hit as a break-in", () => {
    const v = cornerView({ ...base, breakIn: true, nowPlaying: live });
    if (v.show !== "glass") throw new Error("expected glass");
    expect(v.lcd.state).toBe("live");
    expect(v.lcd.meta).toBe("Live · Public safety");
  });
});

import { friendlyError } from "../src/frontend/dashboard/cornerView.js";

describe("friendlyError — the error glass is read from across the room", () => {
  it("a missing radio says which one, in words", () => {
    expect(friendlyError("wideband helper exited (code 1): kerchunk-dsp: failed to open RTL-SDR (serial KIOSK99): not found; restarting"))
      .toBe("Scanner radio KIOSK99 not found");
  });
  it("other helper exits lose the plumbing prefix and the retry tail", () => {
    expect(friendlyError("wideband helper exited (code 2): kerchunk-dsp: ALSA device busy; restarting")).toBe("ALSA device busy");
  });
  it("a plain message passes through, first letter up", () => {
    expect(friendlyError("spawn failed")).toBe("Spawn failed");
  });
  it("the error glass uses it", () => {
    const v = cornerView({ ...base, error: "wideband helper exited (code 1): kerchunk-dsp: failed to open RTL-SDR (serial KIOSK99): not found; restarting" });
    expect(v.show === "glass" && v.lcd.name).toBe("Scanner radio KIOSK99 not found");
  });
});

describe("warm-up with an unknown step", () => {
  it("a page that only knows 'not warmed' (status poll, no warmup event yet) doesn't say step 0", () => {
    const v = cornerView({ ...base, warmed: false, warmupPhase: null, warmupStep: 0, warmupOf: 4 });
    expect(v).toMatchObject({ show: "pill", word: "Warming up", detail: "starting the radio", warmLit: 0 });
  });
});
