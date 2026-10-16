import { describe, it, expect } from "vitest";
import { cbView, cbHtml, fmtDur, CB_VIEW_DEFAULTS, type CbViewInput } from "../src/frontend/dashboard/cbView.js";
import { CB_EMPTY, cbReduce } from "../src/frontend/dashboard/cbDial.js";
import { CB_FREQ_HZ, CB_NAMES_DEFAULT } from "../src/backend/config/cb.js";
import { configSchema, defaultConfig } from "../src/backend/config/schema.js";
import type { EngineEvent } from "../src/backend/engine/ScannerEngine.js";

const F = (n: number) => CB_FREQ_HZ[n]!;
const active = (n: number, ts: number) => ({ type: "active", ts, freq: F(n), channel: { id: `cb_${n}`, freq: F(n), alphaTag: `CB ${n}`, mode: "am", enabled: true, tags: ["cb"] } }) as EngineEvent;
const release = (n: number, ts: number) => ({ type: "release", channelId: `cb_${n}`, ts }) as EngineEvent;
const MIN = 60_000;
const NOW = 1000 * MIN;
const base: CbViewInput = {
  cb: CB_EMPTY, now: NOW, liveFreq: null, error: null, muted: false,
  monitored: Array.from({ length: 32 }, (_, k) => k + 1), names: CB_NAMES_DEFAULT,
  fadeStepsMin: [2, 10, 20, 30], logRows: 5, fmtTime: (ts) => `T${ts / MIN}`,
};

describe("CB_VIEW_DEFAULTS", () => {
  it("match the schema's display.cb defaults (no drift)", () => {
    // defaultConfig() has no display block; give it the two required fields.
    const parsed = configSchema.parse({ ...defaultConfig(), display: { weatherLat: 39.1, weatherLon: -94.58 } });
    expect(parsed.display?.cb).toEqual(CB_VIEW_DEFAULTS);
  });
});

describe("cbView readout", () => {
  it("never heard: listening, no number", () => {
    expect(cbView(base).readout).toEqual({ state: "never", meta: "CB only · Listening on 32 channels", metaRight: "", num: "", name: "", freq: "" });
  });

  it("live: number, name, frequency, needle at the channel", () => {
    const cb = cbReduce(CB_EMPTY, active(19, NOW));
    const v = cbView({ ...base, cb, liveFreq: F(19) });
    expect(v.readout).toMatchObject({ state: "live", meta: "CB · AM · Live", metaRight: "", num: "19", name: "Highway", freq: "27.1850" });
    expect(v.needleX).not.toBeNull();
    expect(cbView({ ...base, cb, liveFreq: F(19), muted: true }).readout.metaRight).toBe("Muted");
  });

  it("idle: the last-heard channel stays up with its time; no needle", () => {
    const cb = cbReduce(cbReduce(CB_EMPTY, active(9, NOW - 5 * MIN)), release(9, NOW - 4 * MIN));
    const v = cbView({ ...base, cb });
    expect(v.readout).toEqual({ state: "idle", meta: "CB only · Listening on 32 channels", metaRight: "Last heard T996", num: "9", name: "Emergency", freq: "27.0650" });
    expect(v.needleX).toBeNull();
  });

  it("error wins over everything", () => {
    const v = cbView({ ...base, liveFreq: F(19), error: "NO_DEVICE" });
    expect(v.readout.state).toBe("error");
    expect(v.readout.meta).toBe("Radio error");
  });

  it("off the air: calm readout with the return time; error and offline win", () => {
    const v = cbView({ ...base, offAir: true, offAirUntil: 1200 * MIN });
    expect(v.readout).toEqual({ state: "never", meta: "CB receiver off the air", metaRight: "", num: "", name: "Back at T1200", freq: "" });
    expect(cbView({ ...base, offAir: true, offAirUntil: null }).readout.name).toBe("Back at sunrise");
    expect(cbView({ ...base, offAir: true, offline: "x" }).readout.state).toBe("error");
    expect(cbView({ ...base, offAir: true, error: "NO_DEVICE" }).readout.meta).toBe("Radio error");
  });

  it("a live freq that isn't a CB channel counts as not live", () => {
    expect(cbView({ ...base, liveFreq: 146_790_000 }).readout.state).toBe("never");
  });
});

describe("cbView ticks", () => {
  it("40 ticks; core always labelled; unmonitored hollow; heard ones stepped; live at 4", () => {
    let cb = cbReduce(CB_EMPTY, active(14, NOW - 12 * MIN));
    cb = cbReduce(cb, release(14, NOW - 12 * MIN));
    cb = cbReduce(cb, active(19, NOW));
    const v = cbView({ ...base, cb, liveFreq: F(19) });
    expect(v.ticks).toHaveLength(40);
    const t = (n: number) => v.ticks.find((k) => k.n === n)!;
    expect(t(6)).toMatchObject({ core: true, label: true, step: 0, monitored: true });
    expect(t(19)).toMatchObject({ core: true, step: 4, label: true });
    expect(t(14)).toMatchObject({ core: false, step: 2, label: false });   // 12 min ago
    expect(t(15).label).toBe(true);                                        // multiple of 5
    expect(t(1).label).toBe(true);
    expect(t(2).label).toBe(false);
    expect(t(36)).toMatchObject({ monitored: false });
  });
});

describe("cbView log", () => {
  it("names, durations, the live row says now, capped at logRows", () => {
    let cb = cbReduce(CB_EMPTY, active(9, NOW - 3 * MIN));
    cb = cbReduce(cb, release(9, NOW - 3 * MIN + 41_000));
    cb = cbReduce(cb, active(19, NOW));
    const v = cbView({ ...base, cb, liveFreq: F(19), logRows: 1 });
    expect(v.log).toEqual([{ label: "CB 19 · Highway", when: "now", live: true }]);
    const all = cbView({ ...base, cb, liveFreq: F(19) }).log;
    expect(all[1]).toEqual({ label: "CB 9 · Emergency", when: "T997 · 0:41", live: false });
  });

  it("fmtDur", () => {
    expect(fmtDur(8_000)).toBe("0:08");
    expect(fmtDur(41_400)).toBe("0:41");
    expect(fmtDur(125_000)).toBe("2:05");
  });
});

describe("cbView key", () => {
  it("is stable across signal changes and moves when a tick steps", () => {
    const cb = cbReduce(cbReduce(CB_EMPTY, active(9, NOW)), release(9, NOW));
    const a = cbView({ ...base, cb });
    expect(cbView({ ...base, cb }).key).toBe(a.key);
    expect(cbView({ ...base, cb, now: NOW + 3 * MIN }).key).not.toBe(a.key);
  });
});

describe("cbHtml", () => {
  it("live: dB readout, lit meter, needle, data-state", () => {
    const cb = cbReduce(CB_EMPTY, active(19, NOW));
    const h = cbHtml(cbView({ ...base, cb, liveFreq: F(19) }), -41);
    expect(h).toContain('data-state="live"');
    expect(h).toContain('<span class="kc-cb__db">−41 dB</span>');
    expect(h).toContain('class="kc-cb__needle"');
    expect(h).toContain('<div class="kc-cb__num">19</div>');
    expect(h).toContain("27.1850 MHz");
  });

  it("never: no number, no needle", () => {
    const h = cbHtml(cbView(base), null);
    expect(h).not.toContain("kc-cb__num");
    expect(h).not.toContain("kc-cb__needle");
  });

  it("escapes operator names", () => {
    const cb = cbReduce(CB_EMPTY, active(19, NOW));
    const h = cbHtml(cbView({ ...base, cb, liveFreq: F(19), names: { "19": "<b>x</b>" } }), null);
    expect(h).not.toContain("<b>x</b>");
    expect(h).toContain("&lt;b&gt;x&lt;/b&gt;");
  });
  it("receiver offline shows in the readout (engine errors still win)", () => {
    const v = cbView({ ...base, offline: "connect ECONNREFUSED 192.168.1.30:8073" });
    expect(v.readout).toMatchObject({ state: "error", meta: "Receiver offline" });
    expect(cbView({ ...base, offline: "x", error: "kerchunk-dsp: boom" }).readout.meta).toBe("Radio error");
  });
  it("offline readout says retrying only while the client still is", () => {
    expect(cbView({ ...base, offline: "x" }).readout.name).toBe("Retrying the CB receiver");
    expect(cbView({ ...base, offline: "x", retrying: true }).readout.name).toBe("Retrying the CB receiver");
    expect(cbView({ ...base, offline: "x", retrying: false }).readout.name).toBe("CB receiver stopped — re-enter CB mode");
  });
  it("the live meta names the channel's mode", () => {
    const v = cbView({ ...base, liveFreq: 27_385_000, liveMode: "lsb" });
    expect(v.readout.meta).toBe("CB · LSB · Live");
    expect(cbView({ ...base, liveFreq: 27_185_000 }).readout.meta).toBe("CB · AM · Live");
  });
});
