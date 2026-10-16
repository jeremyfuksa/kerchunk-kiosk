import { describe, it, expect } from "vitest";
import { initialLive, reduceEvent, withStatus, withAudio, lcdView } from "../src/frontend/admin/live.js";
import { fmtFreq } from "../src/frontend/lib/format.js";
import type { Channel } from "../src/backend/config/schema.js";

const ch = (freq: number, alphaTag: string, mode: Channel["mode"] = "am"): Channel =>
  ({ id: "c1", freq, alphaTag, mode, enabled: true }) as Channel;

describe("live reducer", () => {
  it("audible drives nowPlaying and then wins over active/idle", () => {
    let s = reduceEvent(initialLive, { type: "audible", channel: ch(118_400_000, "KC Approach"), ts: 1 }).state;
    expect(s.nowPlaying).toEqual({ freq: 118_400_000, alphaTag: "KC Approach", mode: "am" });
    s = reduceEvent(s, { type: "idle", ts: 2 }).state;
    expect(s.nowPlaying?.alphaTag).toBe("KC Approach");
    s = reduceEvent(s, { type: "audible", channel: null, ts: 3 }).state;
    expect(s.nowPlaying).toBeNull();
  });
  it("active/idle drive nowPlaying until audible is seen", () => {
    let s = reduceEvent(initialLive, { type: "active", channel: ch(121_800_000, "MCI Ground"), freq: 121_800_000, ts: 1 }).state;
    expect(s.nowPlaying?.alphaTag).toBe("MCI Ground");
    s = reduceEvent(s, { type: "idle", ts: 2 }).state;
    expect(s.nowPlaying).toBeNull();
  });
  it("status resets and asks for a resync", () => {
    const a = reduceEvent(initialLive, { type: "audible", channel: ch(1, "x"), ts: 1 }).state;
    const r = reduceEvent(a, { type: "status", state: "running" as never, ts: 2 });
    expect(r.resync).toBe(true);
    expect(r.state.nowPlaying).toBeNull();
    expect(r.state.audibleDriven).toBe(false);
  });
  it("signal updates dbfs; alert flags the feed", () => {
    expect(reduceEvent(initialLive, { type: "signal", dbfs: -41, ts: 1 }).state.dbfs).toBe(-41);
    expect(reduceEvent(initialLive, { type: "alert", channel: ch(1, "x"), freq: 1, holdSeconds: 30, ts: 1 }).alert).toBe(true);
  });
  it("unrelated events leave state untouched", () => {
    const r = reduceEvent(initialLive, { type: "reload", ts: 1 });
    expect(r.state).toBe(initialLive);
    expect(r.resync).toBe(false);
  });
});

describe("lcdView", () => {
  it("cb mode: CB only, idle and live, never lockable", () => {
    const idle = withStatus(initialLive, { mode: "cb", monitor: null });
    expect(lcdView(idle)).toMatchObject({ state: "scanning", meta: "CB only", name: "Listening to CB…", canLock: false });
    const cb19: Channel = { id: "cb_19", freq: 27_185_000, alphaTag: "CB 19", mode: "am", enabled: true, tags: ["cb"] };
    const s = reduceEvent(idle, { type: "audible", channel: cb19, ts: 1 }).state;
    expect(lcdView(s)).toMatchObject({ state: "live", meta: "CB only · AM", name: "CB 19", canLock: false });
  });
  it("a CB receiver that is still connecting is not offline", () => {
    const base = { mode: "cb" as const, monitor: null };
    expect(withStatus(initialLive, { ...base, cb: { connected: false, error: null, retrying: true } }).cbOffline).toBeNull();
    expect(withStatus(initialLive, { ...base, cb: { connected: false, error: "x", retrying: true } }).cbOffline).toBe("x");
    expect(withStatus(initialLive, { ...base, cb: { connected: false, error: null, retrying: false } }).cbOffline).toBe("offline");
  });

  it("CB mode with the receiver offline says so", () => {
    const s = initialLive;
    expect(lcdView({ ...s, mode: "cb", nowPlaying: null, cbOffline: "connect ECONNREFUSED" })).toMatchObject({ meta: "CB only", name: "Receiver offline" });
  });
  it("scanning when nothing is open", () => {
    const v = lcdView(initialLive);
    expect(v.state).toBe("scanning");
    expect(v.name).toBe("Scanning…");
    expect(v.freq).toBe("");
    expect(v.canLock).toBe(false);
  });
  it("live channel", () => {
    const s = reduceEvent(initialLive, { type: "audible", channel: ch(118_400_000, "KC Approach"), ts: 1 }).state;
    const v = lcdView(s);
    expect(v).toMatchObject({ state: "live", name: "KC Approach", freq: fmtFreq(118_400_000), canLock: true });
    expect(v.meta).toBe("Live · AM");
  });
  it("monitor, weather and break-in", () => {
    const mon = withStatus(initialLive, { mode: "monitor", monitor: ch(462_562_500, "GMRS 1", "nfm") });
    expect(lcdView(mon)).toMatchObject({ state: "monitor", name: "GMRS 1", canLock: false });
    const wx = { ...withStatus(initialLive, { mode: "weather", monitor: null }), weatherChannel: { freq: 162_550_000, alphaTag: "NOAA KC" } };
    expect(lcdView(wx)).toMatchObject({ state: "weather", name: "NOAA KC", freq: fmtFreq(162_550_000) });
    const bi = withStatus(wx, { mode: "weather", monitor: null, breakIn: true });
    expect(lcdView(bi).state).toBe("breakin");
    expect(lcdView(bi).meta).toBe("Weather alert");
  });
  it("names alphaTag-less channels by frequency", () => {
    const s = reduceEvent(initialLive, { type: "audible", channel: ch(151_820_000, ""), ts: 1 }).state;
    expect(lcdView(s).name).toBe(fmtFreq(151_820_000));
  });
  it("reports speaker silence", () => {
    expect(lcdView(withAudio(initialLive, { volume: 40, muted: true })).silent).toBe("Muted");
    expect(lcdView(withAudio(initialLive, { volume: 0, muted: false })).silent).toBe("Volume 0");
    expect(lcdView(withAudio(initialLive, { volume: 40, muted: false })).silent).toBeNull();
  });
});

describe("startedAt", () => {
  it("is null until a status carries it, then kept when a status omits it", () => {
    expect(initialLive.startedAt).toBeNull();
    const a = withStatus(initialLive, { mode: "scan", monitor: null, startedAt: 111 });
    expect(a.startedAt).toBe(111);
    expect(withStatus(a, { mode: "scan", monitor: null }).startedAt).toBe(111);
    expect(withStatus(a, { mode: "scan", monitor: null, startedAt: 222 }).startedAt).toBe(222);
  });
});
