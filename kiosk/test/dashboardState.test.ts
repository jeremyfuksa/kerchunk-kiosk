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
