import { describe, it, expect } from "vitest";
import { reduce, initialState, esc } from "../src/frontend/dashboard/dashboard.js";

describe("dashboard reduce", () => {
  it("active sets nowPlaying and prepends to log", () => {
    const ch = { id: "c1", freq: 145130000, alphaTag: "KC0KW", mode: "nfm" as const, enabled: true };
    const s = reduce(initialState(), { type: "active", channel: ch, freq: ch.freq, ts: 10 });
    expect(s.nowPlaying?.freq).toBe(145130000);
    expect(s.log[0]?.freq).toBe(145130000);
  });

  it("idle clears nowPlaying but keeps the log", () => {
    const ch = { id: "c1", freq: 1, alphaTag: "x", mode: "fm" as const, enabled: true };
    let s = reduce(initialState(), { type: "active", channel: ch, freq: 1, ts: 1 });
    s = reduce(s, { type: "idle", ts: 2 });
    expect(s.nowPlaying).toBeNull();
    expect(s.log.length).toBe(1);
  });

  it("error sets an error message", () => {
    const s = reduce(initialState(), { type: "error", code: "NO_DONGLE", message: "No RTL-SDR", ts: 1 });
    expect(s.error).toBe("No RTL-SDR");
  });

  it("active clears a stale error (engine demonstrably working again)", () => {
    // A dashboard that missed the status:running event (WS was reconnecting
    // during a backend restart) must not show the old error forever once
    // traffic proves the engine recovered.
    const ch = { id: "c1", freq: 1, alphaTag: "x", mode: "fm" as const, enabled: true };
    let s = reduce(initialState(), { type: "error", code: "X", message: "boom", ts: 1 });
    s = reduce(s, { type: "active", channel: ch, freq: 1, ts: 2 });
    expect(s.error).toBeNull();
  });

  it("idle clears a stale error too", () => {
    let s = reduce(initialState(), { type: "error", code: "X", message: "boom", ts: 1 });
    s = reduce(s, { type: "idle", ts: 2 });
    expect(s.error).toBeNull();
  });

  it("status running clears any error", () => {
    let s = reduce(initialState(), { type: "error", code: "X", message: "boom", ts: 1 });
    s = reduce(s, { type: "status", state: "running", ts: 2 });
    expect(s.error).toBeNull();
  });
});

describe("esc (XSS guard for innerHTML interpolation)", () => {
  it("escapes HTML-significant characters", () => {
    expect(esc(`<img src=x onerror="alert(1)">`)).toBe(
      "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;",
    );
    expect(esc("Tom & Jerry's")).toBe("Tom &amp; Jerry&#39;s");
  });

  it("leaves plain text unchanged", () => {
    expect(esc("KC0KW Gibbs Rd")).toBe("KC0KW Gibbs Rd");
  });
});

describe("status resets nowPlaying", () => {
  it("an engine restart (status event) clears now-playing — nothing is audible during/after a restart until a new active arrives", () => {
    // Deleting the active channel restarts the engine with no idle event
    // (the helper is killed, not squelch-closed), so now-playing must not
    // survive a status transition.
    const ch = { id: "c1", freq: 162550000, alphaTag: "WXTEST", mode: "nfm" as const, enabled: true };
    let s = reduce(initialState(), { type: "active", channel: ch, freq: ch.freq, ts: 1 });
    s = reduce(s, { type: "status", state: "stopped", ts: 2 });
    expect(s.nowPlaying).toBeNull();
    s = reduce(s, { type: "active", channel: ch, freq: ch.freq, ts: 3 });
    s = reduce(s, { type: "status", state: "running", ts: 4 });
    expect(s.nowPlaying).toBeNull();
  });
});

describe("audible events own now-playing (wideband)", () => {
  const wof = { id: "wof", freq: 464275000, alphaTag: "WoF Maint", mode: "nfm" as const, enabled: true };
  const gmrs = { id: "g22", freq: 462725000, alphaTag: "GMRS 22", mode: "nfm" as const, enabled: true };

  it("audible sets nowPlaying; a later active on ANOTHER channel moves the log but not nowPlaying", () => {
    // Operator-observed: audio held WoF Maintenance (first-active-wins) but
    // the banner hopped to whichever channel opened next in the same group.
    let s = reduce(initialState(), { type: "active", channel: wof, freq: wof.freq, ts: 1 });
    s = reduce(s, { type: "audible", channel: wof, ts: 1 });
    s = reduce(s, { type: "active", channel: gmrs, freq: gmrs.freq, ts: 2 });
    expect(s.nowPlaying?.alphaTag).toBe("WoF Maint");
    expect(s.log[0]?.alphaTag).toBe("GMRS 22"); // recent list still records it
  });

  it("audible null clears nowPlaying", () => {
    let s = reduce(initialState(), { type: "audible", channel: wof, ts: 1 });
    s = reduce(s, { type: "audible", channel: null, ts: 2 });
    expect(s.nowPlaying).toBeNull();
  });

  it("audible handoff moves nowPlaying to the new speaker owner", () => {
    let s = reduce(initialState(), { type: "audible", channel: wof, ts: 1 });
    s = reduce(s, { type: "audible", channel: gmrs, ts: 2 });
    expect(s.nowPlaying?.alphaTag).toBe("GMRS 22");
  });

  it("without any audible events, active still drives nowPlaying (rtlfm engine)", () => {
    const s = reduce(initialState(), { type: "active", channel: wof, freq: wof.freq, ts: 1 });
    expect(s.nowPlaying?.alphaTag).toBe("WoF Maint");
  });

  it("idle does not clear an audible-driven nowPlaying (another channel may close while the speaker plays on)", () => {
    let s = reduce(initialState(), { type: "audible", channel: wof, ts: 1 });
    s = reduce(s, { type: "idle", ts: 2 });
    expect(s.nowPlaying?.alphaTag).toBe("WoF Maint");
  });

  it("status reset returns control to active events", () => {
    let s = reduce(initialState(), { type: "audible", channel: wof, ts: 1 });
    s = reduce(s, { type: "status", state: "running", ts: 2 });
    expect(s.nowPlaying).toBeNull();
    s = reduce(s, { type: "active", channel: gmrs, freq: gmrs.freq, ts: 3 });
    expect(s.nowPlaying?.alphaTag).toBe("GMRS 22");
  });
});

describe("signal meter", () => {
  const ch = { id: "c1", freq: 464275000, alphaTag: "WoF", mode: "nfm" as const, enabled: true };

  it("signal events set signalDb while something plays", () => {
    let s = reduce(initialState(), { type: "audible", channel: ch, ts: 1 });
    s = reduce(s, { type: "signal", dbfs: -7.5, ts: 2 });
    expect(s.signalDb).toBe(-7.5);
  });

  it("signalDb clears when the speaker goes silent or the engine restarts", () => {
    let s = reduce(initialState(), { type: "audible", channel: ch, ts: 1 });
    s = reduce(s, { type: "signal", dbfs: -7.5, ts: 2 });
    s = reduce(s, { type: "audible", channel: null, ts: 3 });
    expect(s.signalDb).toBeNull();
    s = reduce(s, { type: "signal", dbfs: -3, ts: 4 });
    s = reduce(s, { type: "status", state: "running", ts: 5 });
    expect(s.signalDb).toBeNull();
  });
});

describe("engine state in dash state", () => {
  it("status events track engineState (starting renders as retuning)", () => {
    let s = reduce(initialState(), { type: "status", state: "starting", ts: 1 });
    expect(s.engineState).toBe("starting");
    s = reduce(s, { type: "status", state: "running", ts: 2 });
    expect(s.engineState).toBe("running");
  });
});

describe("alert banner (ROADMAP Idea 6)", () => {
  const ch = { id: "c1", freq: 154130000, alphaTag: "Skywarn", mode: "nfm" as const, enabled: true };
  it("alert event sets the banner with a hold deadline", () => {
    const s = reduce(initialState(), { type: "alert", channel: ch, freq: ch.freq, holdSeconds: 30, ts: 1000 });
    expect(s.alert).toEqual({ freq: ch.freq, alphaTag: "Skywarn", until: 31000 });
  });
  it("a later alert replaces the banner", () => {
    let s = reduce(initialState(), { type: "alert", channel: ch, freq: ch.freq, holdSeconds: 30, ts: 1000 });
    s = reduce(s, { type: "alert", channel: { ...ch, alphaTag: "Tac 2" }, freq: 460000000, holdSeconds: 30, ts: 2000 });
    expect(s.alert?.alphaTag).toBe("Tac 2");
  });
  it("status transitions clear the banner (engine restarted under it)", () => {
    let s = reduce(initialState(), { type: "alert", channel: ch, freq: ch.freq, holdSeconds: 30, ts: 1000 });
    s = reduce(s, { type: "status", state: "starting", ts: 2000 });
    expect(s.alert).toBeNull();
  });
  it("alert does not disturb now-playing", () => {
    let s = reduce(initialState(), { type: "audible", channel: ch, ts: 1 });
    s = reduce(s, { type: "alert", channel: { ...ch, id: "c2" }, freq: 1, holdSeconds: 5, ts: 2 });
    expect(s.nowPlaying?.alphaTag).toBe("Skywarn");
  });
});

describe("bank rail (tuned window)", () => {
  it("tuned event replaces the tuned id set", () => {
    let s = reduce(initialState(), { type: "tuned", freqHz: 155_000_000, channelIds: ["a", "b"], ts: 1 });
    expect(s.tunedIds).toEqual(["a", "b"]);
    s = reduce(s, { type: "tuned", freqHz: 460_000_000, channelIds: ["c"], ts: 2 });
    expect(s.tunedIds).toEqual(["c"]);
  });
});
