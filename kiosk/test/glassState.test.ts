import { describe, it, expect } from "vitest";
import {
  GlassState, rampStrength, signalLevel, fadeLevel,
  RELEASE_MS, DEFAULT_BRIGHT, MIN_BRIGHT,
} from "../src/frontend/map/glassState.js";
import { MAX_FRONTS, MAX_GLOWS } from "../src/frontend/map/glassMath.js";

const T = { growMs: 900, releaseMs: RELEASE_MS, glowLifetimeMs: 60_000, ttlMs: 60_000, holdFps: 4, signalSteps: 8, fadeSteps: 24 };
const STEP = 60_000 / 24; // 2500 ms per fade step
const site = (key = "a", color: readonly [number, number, number] = [1, 0, 0]) => ({ key, lat: 39, lng: -94, color });

describe("quantisers", () => {
  it("signalLevel: clamped window, `steps` levels, floor MIN_BRIGHT", () => {
    expect(signalLevel(-10, 8)).toBe(1);
    expect(signalLevel(0, 8)).toBe(1);
    expect(signalLevel(-27.5, 8)).toBeCloseTo(4 / 7, 9);   // k=0.5 → round(3.5)=4 of 7
    expect(signalLevel(-90, 8)).toBe(MIN_BRIGHT);
  });
  it("fadeLevel: starts at 1, drops one step at each boundary, 0 at the end", () => {
    expect(fadeLevel(0, 60_000, 24)).toBe(1);
    expect(fadeLevel(STEP - 1, 60_000, 24)).toBe(1);
    expect(fadeLevel(STEP, 60_000, 24)).toBeCloseTo(23 / 24, 9);
    expect(fadeLevel(30_000, 60_000, 24)).toBeCloseTo(0.5, 9);
    expect(fadeLevel(60_000, 60_000, 24)).toBe(0);
  });
});

describe("GlassState lifecycle", () => {
  it("key-up grows (eased) then holds; growing/continuous only during the grow", () => {
    const s = new GlassState(T);
    s.keyUp("ch1", site(), 5000, 0);
    const f0 = s.frame(450);
    expect(f0.growing).toBe(true);
    expect(f0.continuous).toBe(true);
    expect(f0.fronts[0]!.grow).toBeCloseTo(0.875, 3);   // easeOutCubic(0.5)
    expect(f0.fronts[0]!.bright).toBe(DEFAULT_BRIGHT);
    const f1 = s.frame(2000);
    expect(f1.growing).toBe(false);
    expect(f1.continuous).toBe(false);
    expect(f1.fronts[0]).toMatchObject({ grow: 1, releasing: 0, radiusM: 5000, ageMs: 2000 });
    expect(f1.glows).toEqual([]);
    expect(f1.nextChangeAt).toBe(60_000);                 // only the ttl can change a still hold
    expect(s.liveCount()).toBe(1);
  });

  it("a re-key of a live id re-arms: born and radius stay latched", () => {
    const s = new GlassState(T);
    s.keyUp("ch1", site(), 5000, 0);
    s.keyUp("ch1", site(), 9000, 50_000);
    const f = s.frame(70_000);
    expect(f.fronts).toHaveLength(1);
    expect(f.fronts[0]).toMatchObject({ radiusM: 5000, ageMs: 70_000 });
    expect(s.hits("a")).toBe(1);
  });

  it("release dissolves continuously over RELEASE_MS; the afterglow then steps", () => {
    const s = new GlassState(T);
    s.keyUp("ch1", site(), 5000, 0);
    s.release("ch1", 10_000);
    expect(s.liveCount()).toBe(0);
    const mid = s.frame(10_750);
    expect(mid.continuous).toBe(true);
    expect(mid.fronts[0]!.releasing).toBeCloseTo(0.5, 6);
    expect(mid.glows[0]!.strength).toBeCloseTo(rampStrength(1), 9);   // first fade step: full
    const after = s.frame(10_000 + RELEASE_MS);
    expect(after.fronts).toEqual([]);
    expect(after.continuous).toBe(false);
    expect(after.nextChangeAt).toBe(10_000 + STEP);                    // next fade boundary
  });

  it("the afterglow fades in fadeSteps steps and ends; hits reset", () => {
    const s = new GlassState(T);
    s.keyUp("ch1", site(), 5000, 0);
    s.release("ch1", 1000);
    expect(s.frame(1000 + STEP).glows[0]!.strength).toBeCloseTo(rampStrength(1) * 23 / 24, 9);
    expect(s.frame(60_999).glows).toHaveLength(1);
    const end = s.frame(61_000);
    expect(end.glows).toEqual([]);
    expect(end.nextChangeAt).toBeNull();
    expect(s.hits("a")).toBe(0);
  });

  it("nextChangeAt never lands at or before now on an exact boundary", () => {
    const s = new GlassState(T);
    s.seedGlow(site(), 4000, 0, 0);
    for (const now of [STEP, 2 * STEP, 7 * STEP, 23 * STEP]) {
      const f = s.frame(now);
      expect(f.nextChangeAt! > now).toBe(true);
    }
  });

  it("hits ramp the afterglow strength, capped at 6", () => {
    expect(rampStrength(1)).toBeCloseTo(0.5 + 0.5 / 6, 9);
    expect(rampStrength(6)).toBe(1);
    expect(rampStrength(40)).toBe(1);
    const s = new GlassState(T);
    for (let i = 0; i < 3; i++) { s.keyUp(`k${i}`, site(), 5000, i * 100); s.release(`k${i}`, i * 100 + 50); }
    expect(s.hits("a")).toBe(3);
    expect(s.frame(400).glows[0]!.strength).toBeCloseTo(rampStrength(3), 9);
  });

  it("a missed release: the ttl ends the front into an afterglow", () => {
    const s = new GlassState(T);
    s.keyUp("ch1", site(), 5000, 0);
    const f = s.frame(60_000 + 100);
    expect(f.fronts[0]!.releasing).toBeCloseTo(100 / RELEASE_MS, 6);
    expect(f.continuous).toBe(true);
    expect(f.glows).toHaveLength(1);
  });

  it("rearm extends the ttl; releaseAll (idle) releases every front", () => {
    const s = new GlassState(T);
    s.keyUp("a1", site("a"), 5000, 0);
    s.keyUp("b1", site("b"), 5000, 0);
    s.rearm("a1", 50_000);
    expect(s.frame(70_000).fronts.find((f) => f.id === "a1")!.releasing).toBe(0);
    s.releaseAll(80_000);
    const f = s.frame(80_000 + RELEASE_MS);
    expect(f.fronts).toEqual([]);
    expect(f.glows.map((g) => g.key).sort()).toEqual(["a", "b"]);
  });

  it("seedGlow backfills a pre-faded afterglow; an expired row seeds nothing", () => {
    const s = new GlassState(T);
    s.seedGlow(site("a"), 4000, 100_000 - 30_000, 100_000);
    s.seedGlow(site("b"), 4000, 100_000 - 61_000, 100_000);
    const f = s.frame(100_000);
    expect(f.glows.map((g) => g.key)).toEqual(["a"]);
    expect(f.glows[0]!.strength).toBeCloseTo(rampStrength(1) * 0.5, 9);
    expect(f.fronts).toEqual([]);
  });

  it("caps: oldest fronts dropped past MAX_FRONTS; strongest MAX_GLOWS glows kept", () => {
    const s = new GlassState(T);
    for (let i = 0; i < MAX_FRONTS + 3; i++) s.keyUp(`f${i}`, site(`s${i}`), 5000, i);
    const ids = s.frame(MAX_FRONTS + 3).fronts.map((f) => f.id);
    expect(ids).toHaveLength(MAX_FRONTS);
    expect(ids).not.toContain("f0");
    expect(ids).toContain(`f${MAX_FRONTS + 2}`);
    const g = new GlassState(T);
    for (let i = 0; i < MAX_GLOWS + 5; i++) g.seedGlow(site(`g${i}`), 4000, i * 1000, MAX_GLOWS * 1000 + 5000);
    const glows = g.frame(MAX_GLOWS * 1000 + 5000).glows;
    expect(glows).toHaveLength(MAX_GLOWS);
    expect(glows.map((x) => x.key)).not.toContain("g0");
  });

  it("an empty scene never asks for a redraw", () => {
    const f = new GlassState(T).frame(123);
    expect(f).toMatchObject({ continuous: false, growing: false, nextChangeAt: null });
  });
});

describe("GlassState signal pacing", () => {
  it("a level change applies at once when outside the holdFps window", () => {
    const s = new GlassState(T);
    s.keyUp("ch1", site(), 5000, 0);
    expect(s.signal("ch1", -10, 1000)).toBe(true);
    expect(s.frame(1000).fronts[0]!.bright).toBe(1);
  });

  it("the same level again is not a change", () => {
    const s = new GlassState(T);
    s.keyUp("ch1", site(), 5000, 0);
    s.signal("ch1", -10, 1000);
    expect(s.signal("ch1", -11, 2000)).toBe(false);          // still level 1
  });

  it("a change inside the holdFps window waits for the window's end", () => {
    const s = new GlassState(T);
    s.keyUp("ch1", site(), 5000, 0);
    s.signal("ch1", -10, 1000);
    expect(s.signal("ch1", -27.5, 1100)).toBe(false);        // 100 ms < 250 ms
    const held = s.frame(1100);
    expect(held.fronts[0]!.bright).toBe(1);
    expect(held.nextChangeAt).toBe(1250);
    expect(s.frame(1250).fronts[0]!.bright).toBeCloseTo(4 / 7, 9);
  });

  it("a storm of signals costs at most holdFps changes per second", () => {
    const s = new GlassState(T);
    s.keyUp("ch1", site(), 5000, 0);
    let changes = 0, last = s.frame(0).fronts[0]!.bright;
    for (let t = 1000; t < 2000; t += 20) {                   // 50 events in 1 s, wild swings
      s.signal("ch1", t % 40 === 0 ? -10 : -40, t);
      const b = s.frame(t).fronts[0]!.bright;
      if (b !== last) { changes++; last = b; }
    }
    expect(changes).toBeLessThanOrEqual(4);
  });

  it("signal on a released or unknown id is ignored", () => {
    const s = new GlassState(T);
    s.keyUp("ch1", site(), 5000, 0);
    s.release("ch1", 10);
    expect(s.signal("ch1", -10, 1000)).toBe(false);
    expect(s.signal("nope", -20, 1000)).toBe(false);
    expect(() => s.release("nope", 1)).not.toThrow();
    expect(() => s.rearm("nope", 1)).not.toThrow();
  });
});
