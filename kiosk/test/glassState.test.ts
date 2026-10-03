import { describe, it, expect } from "vitest";
import {
  GlassState, rampStrength, signalLevel, puffShape, puffSeed, windDir,
  RELEASE_MS, DEFAULT_BRIGHT, MIN_BRIGHT,
} from "../src/frontend/map/glassState.js";
import { MAX_FRONTS, MAX_PUFFS } from "../src/frontend/map/glassMath.js";

const T = {
  growMs: 900, releaseMs: RELEASE_MS, ttlMs: 60_000, holdFps: 4, signalSteps: 8,
  smokeLifeMs: 600_000, smokeStepMs: 6000, smokePxPerMph: 60, puffMergeMs: 60_000,
};
const TICK = 6000;
const NE7 = { towardDeg: 225, mph: 7 };   // "NE 7 mph": blows toward the SW
const site = (key = "a", color: readonly [number, number, number] = [1, 0, 0]) => ({ key, lat: 39, lng: -94, color });
const fire = (s: GlassState, id: string, key: string, on: number, off: number) => {
  s.keyUp(id, site(key), 5000, on); s.release(id, off);
};

describe("quantisers and shape", () => {
  it("signalLevel: clamped window, `steps` levels, floor MIN_BRIGHT", () => {
    expect(signalLevel(-10, 8)).toBe(1);
    expect(signalLevel(0, 8)).toBe(1);
    expect(signalLevel(-27.5, 8)).toBeCloseTo(4 / 7, 9);
    expect(signalLevel(-90, 8)).toBe(MIN_BRIGHT);
  });
  it("puffShape: windy stretches along more than across; calm spreads evenly; dims to 0", () => {
    expect(puffShape(0, true)).toEqual({ along: 1, cross: 1, dim: 1 });
    const h = puffShape(0.5, true);
    expect(h.along).toBeCloseTo(1.8, 9);
    expect(h.cross).toBeCloseTo(1 + 0.8 * Math.SQRT1_2, 9);
    expect(h.dim).toBeCloseTo(0.25, 9);
    const c = puffShape(0.25, false);
    expect(c.along).toBeCloseTo(1.6, 9);
    expect(c.cross).toBe(c.along);
    expect(puffShape(1, true).dim).toBe(0);
    expect(puffShape(2, true).dim).toBe(0);              // clamped
  });
  it("puffSeed is stable and in [0, 1); windDir is [east, north]", () => {
    expect(puffSeed("a", 1000)).toBe(puffSeed("a", 1000));
    expect(puffSeed("a", 1000)).not.toBe(puffSeed("a", 1001));
    for (let i = 0; i < 50; i++) { const v = puffSeed(`k${i}`, i * 77); expect(v >= 0 && v < 1).toBe(true); }
    const sw = windDir(225);
    expect(sw[0]).toBeCloseTo(-Math.SQRT1_2, 9);
    expect(sw[1]).toBeCloseTo(-Math.SQRT1_2, 9);
    expect(windDir(90)[0]).toBeCloseTo(1, 9);
  });
});

describe("GlassState fronts", () => {
  it("key-up grows (eased) then holds; growing/continuous only during the grow", () => {
    const s = new GlassState(T);
    s.keyUp("ch1", site(), 5000, 0);
    const f0 = s.frame(450);
    expect(f0.growing).toBe(true);
    expect(f0.continuous).toBe(true);
    expect(f0.fronts[0]!.grow).toBeCloseTo(0.875, 3);
    expect(f0.fronts[0]!.bright).toBe(DEFAULT_BRIGHT);
    const f1 = s.frame(2000);
    expect(f1.growing).toBe(false);
    expect(f1.continuous).toBe(false);
    expect(f1.fronts[0]).toMatchObject({ grow: 1, releasing: 0, radiusM: 5000, ageMs: 2000 });
    expect(f1.puffs).toEqual([]);
    expect(f1.nextChangeAt).toBe(60_000);
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

  it("a missed release: the ttl ends the front into a puff", () => {
    const s = new GlassState(T);
    s.keyUp("ch1", site(), 5000, 0);
    const f = s.frame(60_000 + 100);
    expect(f.fronts[0]!.releasing).toBeCloseTo(100 / RELEASE_MS, 6);
    expect(f.continuous).toBe(true);
    expect(f.puffs).toHaveLength(1);
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
    expect(f.puffs.map((p) => p.key).sort()).toEqual(["a", "b"]);
  });

  it("caps: oldest fronts dropped past MAX_FRONTS", () => {
    const s = new GlassState(T);
    for (let i = 0; i < MAX_FRONTS + 3; i++) s.keyUp(`f${i}`, site(`s${i}`), 5000, i);
    const ids = s.frame(MAX_FRONTS + 3).fronts.map((f) => f.id);
    expect(ids).toHaveLength(MAX_FRONTS);
    expect(ids).not.toContain("f0");
    expect(ids).toContain(`f${MAX_FRONTS + 2}`);
  });

  it("an empty scene never asks for a redraw", () => {
    const f = new GlassState(T).frame(123);
    expect(f).toMatchObject({ continuous: false, growing: false, nextChangeAt: null, puffs: [] });
  });
});

describe("GlassState puffs (smoke)", () => {
  it("a release births a puff at the site with the current wind", () => {
    const s = new GlassState(T);
    s.setWind(NE7);
    fire(s, "ch1", "a", 0, 10_000);
    const mid = s.frame(10_750);
    expect(mid.continuous).toBe(true);                           // the rim is still dissolving
    expect(mid.fronts[0]!.releasing).toBeCloseTo(0.5, 6);
    const p = mid.puffs[0]!;
    expect(p).toMatchObject({ key: "a", radiusM: 5000, driftPx: 0, along: 1, cross: 1 });
    expect(p.strength).toBeCloseTo(rampStrength(1), 9);
    expect(p.dir[0]).toBeCloseTo(-Math.SQRT1_2, 9);
    expect(p.dir[1]).toBeCloseTo(-Math.SQRT1_2, 9);
    const after = s.frame(10_000 + RELEASE_MS);
    expect(after.continuous).toBe(false);                        // smoke is never continuous
    expect(after.nextChangeAt).toBe(12_000);                     // the next shared tick
  });

  it("a release within puffMergeMs re-feeds the newest puff and KEEPS its birth", () => {
    const s = new GlassState(T);
    fire(s, "k0", "a", 0, 1000);
    fire(s, "k1", "a", 30_000, 31_000);
    const f = s.frame(31_000);
    expect(f.puffs).toHaveLength(1);
    expect(f.puffs[0]!.strength).toBeCloseTo(rampStrength(2) * puffShape(30_000 / 600_000 - 1000 / 600_000, false).dim, 9);
    expect(s.frame(600_500).puffs).toHaveLength(1);              // tick 600 000: age 599 000 < life
    expect(s.frame(606_000).puffs).toHaveLength(0);              // tick 606 000: age 605 000 ≥ life
  });

  it("a hot site leaves a trail: one puff per merge window, older ones further downwind", () => {
    const s = new GlassState(T);
    s.setWind(NE7);
    for (let i = 0; i < 20; i++) fire(s, `k${i}`, "a", i * 30_000, i * 30_000 + 2000);   // every 30 s for 10 min
    const f = s.frame(20 * 30_000);
    expect(f.puffs.length).toBeGreaterThanOrEqual(9);
    expect(f.puffs.length).toBeLessThanOrEqual(11);
    const drifts = f.puffs.map((p) => p.driftPx).sort((a, b) => a - b);
    expect(drifts[drifts.length - 1]!).toBeGreaterThan(drifts[0]! + 200);
  });

  it("drift = k × pxPerMph × mph at the sampled tick", () => {
    const s = new GlassState(T);
    s.setWind(NE7);
    fire(s, "k0", "a", 0, 1000);
    const p = s.frame(72_000).puffs[0]!;
    expect(p.driftPx).toBeCloseTo(((72_000 - 1000) / 600_000) * 60 * 7, 6);
    expect(p.along).toBeCloseTo(puffShape(71_000 / 600_000, true).along, 9);
  });

  it("a puff only changes across a smokeStepMs boundary", () => {
    const s = new GlassState(T);
    s.setWind(NE7);
    fire(s, "k0", "a", 0, 0);
    const a = s.frame(2 * TICK).puffs, b = s.frame(3 * TICK - 1).puffs, c = s.frame(3 * TICK).puffs;
    expect(b).toEqual(a);
    expect(c[0]!.driftPx).toBeGreaterThan(a[0]!.driftPx);
  });

  it("nextChangeAt is the next shared tick while smoke lives, never ≤ now; null once gone", () => {
    const s = new GlassState(T);
    fire(s, "k0", "a", 0, 1000);
    expect(s.frame(3000).nextChangeAt).toBe(6000);
    for (const now of [TICK, 2 * TICK, 50 * TICK]) expect(s.frame(now).nextChangeAt! > now).toBe(true);
    const end = s.frame(606_000);
    expect(end.puffs).toEqual([]);
    expect(end.nextChangeAt).toBeNull();
    expect(s.hits("a")).toBe(0);                                 // window over: hits reset
  });

  it("many puffs share ONE tick: 10 minutes of smoke costs about life/step redraws", () => {
    const s = new GlassState(T);
    for (let i = 0; i < 30; i++) s.seedPuff(site(`s${i}`), 4000, i * 777, 30 * 777);
    const changes = new Set<number>();
    let now = 30 * 777;
    for (let k = 0; k < 500; k++) {
      const n = s.frame(now).nextChangeAt;
      if (n === null) break;
      changes.add(n); now = n;
    }
    expect(changes.size).toBeLessThanOrEqual(600_000 / TICK + 2);
  });

  it("step is the tick index", () => {
    const s = new GlassState(T);
    expect(s.frame(5 * TICK + 10).step).toBe(5);
  });

  it("caps at MAX_PUFFS by dropping the weakest (oldest) puff", () => {
    const s = new GlassState(T);
    const now = (MAX_PUFFS + 5) * 1000;
    for (let i = 0; i < MAX_PUFFS + 5; i++) s.seedPuff(site(`g${i}`), 4000, i * 1000, now);
    const keys = s.frame(now).puffs.map((p) => p.key);
    expect(keys).toHaveLength(MAX_PUFFS);
    expect(keys).not.toContain("g0");
    expect(keys).toContain(`g${MAX_PUFFS + 4}`);
  });

  it("seedPuff pre-ages from the real ts; rows older than the life seed nothing", () => {
    const s = new GlassState(T);
    const now = 1_000_000;
    s.seedPuff(site("a"), 4000, now - 300_000, now);
    s.seedPuff(site("b"), 4000, now - 600_001, now);
    const f = s.frame(now);
    expect(f.puffs.map((p) => p.key)).toEqual(["a"]);
    const k = (996_000 - 700_000) / 600_000;                    // sampled at tick 996 000
    expect(f.puffs[0]!.strength).toBeCloseTo(rampStrength(1) * (1 - k) * (1 - k), 9);
  });

  it("a wind change only affects puffs born after it", () => {
    const s = new GlassState(T);
    s.setWind(NE7);
    fire(s, "k0", "a", 0, 0);
    s.setWind({ towardDeg: 90, mph: 10 });
    fire(s, "k1", "b", 0, 100);
    const f = s.frame(200);
    const a = f.puffs.find((p) => p.key === "a")!, b = f.puffs.find((p) => p.key === "b")!;
    expect(a.dir[0]).toBeCloseTo(-Math.SQRT1_2, 9);
    expect(b.dir[0]).toBeCloseTo(1, 9);
  });

  it("calm (null or 0 mph): no drift, even spread", () => {
    for (const w of [null, { towardDeg: 90, mph: 0 }]) {
      const s = new GlassState(T);
      s.setWind(w);
      fire(s, "k0", "a", 0, 0);
      const p = s.frame(300_000).puffs[0]!;
      expect(p.driftPx).toBe(0);
      expect(p.dir).toEqual([0, 0]);
      expect(p.along).toBe(p.cross);
      expect(p.along).toBeGreaterThan(1);
    }
  });

  it("hits ramp the puff strength, capped at 6", () => {
    expect(rampStrength(1)).toBeCloseTo(0.5 + 0.5 / 6, 9);
    expect(rampStrength(6)).toBe(1);
    expect(rampStrength(40)).toBe(1);
    const s = new GlassState(T);
    for (let i = 0; i < 3; i++) fire(s, `k${i}`, "a", i * 100, i * 100 + 50);
    expect(s.hits("a")).toBe(3);
    expect(s.frame(400).puffs[0]!.strength).toBeCloseTo(rampStrength(3), 9);
  });
});

describe("GlassState signal pacing", () => {
  it("signal returns WHEN to redraw: now, the window's end when parked, null for no change (review I2)", () => {
    const s = new GlassState(T);
    s.keyUp("ch1", site(), 5000, 0);
    expect(s.signal("ch1", -10, 1000)).toBe(1000);           // changed now
    expect(s.signal("ch1", -27.5, 1100)).toBe(1250);         // parked to the holdFps window's end
    expect(s.signal("ch1", -11, 1200)).toBeNull();           // back to the shown level: nothing to do
    expect(s.signal("nope", -20, 1300)).toBeNull();
  });

  it("a level change applies at once when outside the holdFps window", () => {
    const s = new GlassState(T);
    s.keyUp("ch1", site(), 5000, 0);
    expect(s.signal("ch1", -10, 1000)).toBe(1000);
    expect(s.frame(1000).fronts[0]!.bright).toBe(1);
  });

  it("the same level again is not a change", () => {
    const s = new GlassState(T);
    s.keyUp("ch1", site(), 5000, 0);
    s.signal("ch1", -10, 1000);
    expect(s.signal("ch1", -11, 2000)).toBeNull();           // still level 1
  });

  it("a change inside the holdFps window waits for the window's end", () => {
    const s = new GlassState(T);
    s.keyUp("ch1", site(), 5000, 0);
    s.signal("ch1", -10, 1000);
    expect(s.signal("ch1", -27.5, 1100)).toBe(1250);         // 100 ms < 250 ms: parked
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
    expect(s.signal("ch1", -10, 1000)).toBeNull();
    expect(s.signal("nope", -20, 1000)).toBeNull();
    expect(() => s.release("nope", 1)).not.toThrow();
    expect(() => s.rearm("nope", 1)).not.toThrow();
  });
});
