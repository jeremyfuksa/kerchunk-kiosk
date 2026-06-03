import { describe, it, expect } from "vitest";
import { reduce, initialState } from "../src/frontend/dashboard/dashboard.js";

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

  it("status running clears any error", () => {
    let s = reduce(initialState(), { type: "error", code: "X", message: "boom", ts: 1 });
    s = reduce(s, { type: "status", state: "running", ts: 2 });
    expect(s.error).toBeNull();
  });
});
