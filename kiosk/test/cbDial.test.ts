import { describe, it, expect } from "vitest";
import { CB_EMPTY, cbNumberForId, dialX, tickStep, cbReduce, cbSeed, type CbState } from "../src/frontend/dashboard/cbDial.js";
import { CB_FREQ_HZ, CB_ALL } from "../src/backend/config/cb.js";
import type { EngineEvent } from "../src/backend/engine/ScannerEngine.js";

const F = (n: number) => CB_FREQ_HZ[n]!;
const active = (n: number, ts: number) => ({
  type: "active", ts, freq: F(n),
  channel: { id: `cb_${n}`, freq: F(n), alphaTag: `CB ${n}`, mode: "am", enabled: true, tags: ["cb"] },
}) as EngineEvent;
const release = (n: number, ts: number) => ({ type: "release", channelId: `cb_${n}`, ts }) as EngineEvent;
const STEPS = [2, 10, 20, 30];
const MIN = 60_000;

describe("dialX", () => {
  it("spans the band inside 0–1 and follows frequency, so 23 sits between 25 and 26", () => {
    expect(dialX(F(1))).toBeGreaterThan(0);
    expect(dialX(F(1))).toBeLessThan(0.05);
    expect(dialX(F(40))).toBeGreaterThan(0.95);
    expect(dialX(F(40))).toBeLessThan(1);
    const xs = [...CB_ALL].sort((a, b) => F(a) - F(b)).map((n) => dialX(F(n)));
    for (let k = 1; k < xs.length; k++) expect(xs[k]!).toBeGreaterThan(xs[k - 1]!);
    expect(dialX(F(23))).toBeGreaterThan(dialX(F(25)));
    expect(dialX(F(23))).toBeLessThan(dialX(F(26)));
    expect(dialX(1)).toBe(0);
    expect(dialX(1e12)).toBe(1);
  });
});

describe("tickStep", () => {
  it("steps down at each fade mark", () => {
    const now = 100 * MIN;
    expect(tickStep(undefined, now, STEPS)).toBe(0);
    expect(tickStep(now + MIN, now, STEPS)).toBe(4);           // clock skew: future = fresh
    expect(tickStep(now, now, STEPS)).toBe(4);
    expect(tickStep(now - 1.99 * MIN, now, STEPS)).toBe(4);
    expect(tickStep(now - 2 * MIN, now, STEPS)).toBe(3);
    expect(tickStep(now - 9.99 * MIN, now, STEPS)).toBe(3);
    expect(tickStep(now - 10 * MIN, now, STEPS)).toBe(2);
    expect(tickStep(now - 20 * MIN, now, STEPS)).toBe(1);
    expect(tickStep(now - 29.99 * MIN, now, STEPS)).toBe(1);
    expect(tickStep(now - 30 * MIN, now, STEPS)).toBe(0);
  });
});

describe("cbNumberForId", () => {
  it("only cb_1 … cb_40", () => {
    expect(cbNumberForId("cb_19")).toBe(19);
    expect(cbNumberForId("cb_0")).toBeNull();
    expect(cbNumberForId("cb_41")).toBeNull();
    expect(cbNumberForId("ch_19")).toBeNull();
  });
});

describe("cbReduce", () => {
  it("an open logs a row, marks the channel heard, and tracks it as open", () => {
    const s = cbReduce(CB_EMPTY, active(19, 1000));
    expect(s.lastHeard[19]).toBe(1000);
    expect(s.log).toEqual([{ n: 19, ts: 1000, durationMs: null }]);
    expect(s.open["cb_19"]).toEqual({ n: 19, ts: 1000 });
  });

  it("a release fills the duration, closes it, and stamps last-heard at the close", () => {
    const s = cbReduce(cbReduce(CB_EMPTY, active(19, 1000)), release(19, 13_000));
    expect(s.log[0]).toEqual({ n: 19, ts: 1000, durationMs: 12_000 });
    expect(s.open).toEqual({});
    expect(s.lastHeard[19]).toBe(13_000);
  });

  it("ignores non-CB channels and unknown releases (same state object)", () => {
    const other = { type: "active", ts: 5, freq: 146_790_000, channel: { id: "ch_1", freq: 146_790_000, alphaTag: "W0TE", mode: "nfm", enabled: true } } as EngineEvent;
    expect(cbReduce(CB_EMPTY, other)).toBe(CB_EMPTY);
    expect(cbReduce(CB_EMPTY, release(9, 5))).toBe(CB_EMPTY);
  });

  it("a status event (restart/retune) closes every open transmission — no stuck 'now' row", () => {
    const s = cbReduce(cbReduce(CB_EMPTY, active(19, 1000)), { type: "status", state: "running", ts: 2000 } as EngineEvent);
    expect(s.open).toEqual({});
    expect(s.log[0]).toEqual({ n: 19, ts: 1000, durationMs: null });
  });

  it("caps the log at 50 rows, newest first", () => {
    let s: CbState = CB_EMPTY;
    for (let k = 0; k < 60; k++) s = cbReduce(s, active(9, k));
    expect(s.log).toHaveLength(50);
    expect(s.log[0]!.ts).toBe(59);
  });
});

describe("cbSeed", () => {
  it("maps history rows to channels, skipping non-CB freqs and non-active kinds", () => {
    const s = cbSeed(CB_EMPTY, [
      { ts: 3000, freq: F(9), kind: "active", durationMs: 41_000 },
      { ts: 2000, freq: 146_790_000, kind: "active", durationMs: 1000 },
      { ts: 1000, freq: F(6), kind: "alert", durationMs: null },
      { ts: 500, freq: F(6), kind: "active", durationMs: null },
    ]);
    expect(s.log).toEqual([{ n: 9, ts: 3000, durationMs: 41_000 }, { n: 6, ts: 500, durationMs: null }]);
    expect(s.lastHeard[9]).toBe(44_000);   // heard until its close
    expect(s.lastHeard[6]).toBe(500);
  });

  it("dedupes against live rows and keeps newest first; empty rows = same state", () => {
    const live = cbReduce(CB_EMPTY, active(19, 9000));
    const s = cbSeed(live, [{ ts: 9000, freq: F(19), kind: "active" }, { ts: 4000, freq: F(9), kind: "active" }]);
    expect(s.log.map((r) => r.ts)).toEqual([9000, 4000]);
    expect(cbSeed(live, [])).toBe(live);
  });
});
