# Glass Smoke Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Weather Glass 60 s afterglow with wind-carried "smoke & sparks" puffs that live ~10 min and change only on a shared step tick, so the wall is something you can stare at without heating the box.

**Architecture:**
- **State:** pure `glassState` holds a list of puffs. One is born per release; a release within `puffMergeMs` of the site's newest puff's birth re-feeds that puff instead. Each puff latches the wind at its birth. `frame()` samples every puff at one absolute `smokeStepMs` grid tick, and the result says when the next tick is (`nextChangeAt`).
- **Layer:** `glassLayer` projects each puff once per redraw (site px + downwind drift) into uniform arrays.
- **Shader:** the FX shader draws a stretched, noise-edged body plus a hashed spark grain.
- **Wind:** a tiny `lib/wind.ts` store carries the dashboard's existing `/api/weather` wind to the map, with no new poll.

**Tech Stack:** TypeScript (ESM, `.js` import extensions, `strict` + `noUncheckedIndexedAccess`), WebGL2 GLSL ES 3.00 inside Google's `WebGLOverlayView`, zod config schema, vitest.

**Spec:** `docs/superpowers/specs/2026-10-02-glass-smoke-design.md`

**Prerequisite:** `feat/glass-transmissions` (PR B: fronts, still hold, event pacing) is merged to `main`. This branch (`feat/glass-smoke`) was cut from it. Rebase onto `main` once PR B lands (`git rebase --onto main feat/glass-transmissions feat/glass-smoke`), before Task 4's PR. Don't open a PR stacked on PR B.

All commands run from `kiosk/` unless stated otherwise.

## Global Constraints

- Puff life `smokeLifeMs` default **600 000** (range 60 000–3 600 000).
- Shared tick `smokeStepMs` default **6 000** (range 1 000–60 000). Every puff changes only on `gridTick(now, smokeStepMs)`.
- Drift `smokePxPerMph` default **60** (range 0–200): px of drift over a full life per mph, at a 1080-px-tall viewport.
- Body `smokeBody` default **0.55** (0–1); `sparkDensity` default **1** (0–3); `puffMergeMs` default **60 000** (0–600 000).
- `MAX_PUFFS` = **48**, a code constant in `glassMath.ts` that sizes the shader arrays.
- `fadeSteps` is removed from the schema. zod strips the key from old configs, which must still load.
- No standing animation: smoke never sets `continuous`. A quiet band (no fronts, no puffs, haze 0, no radar fade) reports `nextChangeAt === null`.
- NWS wind strings give the direction the wind blows **from**; smoke heads the opposite way.
- **No new `/api/weather` poll.** The appliance deadlocks on concurrent requests; reuse the dashboard's.
- Icons are `lucide-static` only; no frontend framework.

## Review Focus

1. **Wind string variants from NWS:** `"5 to 10 mph"`, `"Calm"`, `"0 mph"`, `"VRB 3 mph"` or `"Variable 3 mph"`, and `""` must never throw. Calm or unparseable wind gives no drift (pinned in Task 1).
2. **A busy site hit every 30 s for 10 minutes** must leave a trail of several puffs, not one puff pinned at the source (pinned in Task 2, "a hot site leaves a trail").
3. **A page reload mid-band** seeds part-aged puffs from history using real timestamps; rows older than the life seed nothing (pinned in Task 2, seedPuff test; wired in Task 3).
4. **Shader float precision:** `Date.now() / smokeStepMs` is about 3e8, far past float32 precision. The step index must be wrapped (`STEP_WRAP`) before it becomes a uniform, or the sparks freeze or alias (pinned in Task 2, the `step` wrap test).
5. **An old config.json carrying `display.glass.fadeSteps`** still loads, and the new defaults fill in (pinned in Task 3, schema test).

---

### Task 1: Wind parsing and the shared wind store

**Files:**
- Create: `src/frontend/lib/wind.ts`
- Create: `test/wind.test.ts`
- Modify: `src/frontend/dashboard/dashboard.ts` (the `COMPASS` table and `windBlock`, about lines 384–396; `paintWeather`, about lines 399–410)

**Interfaces:**
- Produces:
  - `interface Wind { towardDeg: number; mph: number }`
  - `fromDeg(raw: string): number | undefined`
  - `parseWind(raw: string): Wind | null`
  - `setWind(raw: string | null | undefined): void`
  - `onWind(cb: (w: Wind | null) => void): () => void`

- [ ] **Step 1: Write the failing test** at `test/wind.test.ts`

```ts
import { describe, it, expect, vi } from "vitest";
import { parseWind, fromDeg, setWind, onWind } from "../src/frontend/lib/wind.js";

describe("parseWind (NWS gives where wind comes FROM; smoke goes the other way)", () => {
  it("inverts all 16 compass points", () => {
    const pts = ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"];
    pts.forEach((p, i) => {
      const from = [0, 22, 45, 67, 90, 112, 135, 157, 180, 202, 225, 247, 270, 292, 315, 337][i]!;
      expect(parseWind(`${p} 7 mph`)).toEqual({ towardDeg: (from + 180) % 360, mph: 7 });
    });
  });
  it("a range uses the upper bound", () => {
    expect(parseWind("SW 5 to 10 mph")).toEqual({ towardDeg: 45, mph: 10 });
  });
  it("calm, variable, zero, missing number and empty give null; never throws", () => {
    for (const s of ["Calm", "", "VRB 3 mph", "Variable 3 mph", "NE 0 mph", "NE", "7 mph"]) {
      expect(parseWind(s)).toBeNull();
    }
  });
  it("fromDeg reads the from-bearing (the dashboard arrow uses it)", () => {
    expect(fromDeg("NE 7 mph")).toBe(45);
    expect(fromDeg("Calm")).toBeUndefined();
  });
});

describe("wind store", () => {
  it("replays the current wind to a new subscriber and notifies on change", () => {
    setWind("NE 7 mph");
    const cb = vi.fn();
    const off = onWind(cb);
    expect(cb).toHaveBeenLastCalledWith({ towardDeg: 225, mph: 7 });
    setWind("Calm");
    expect(cb).toHaveBeenLastCalledWith(null);
    off();
    setWind("S 4 mph");
    expect(cb).toHaveBeenCalledTimes(2);
    setWind(undefined);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/wind.test.ts`
Expected: FAIL, "Failed to resolve import ../src/frontend/lib/wind.js"

- [ ] **Step 3: Write the implementation** at `src/frontend/lib/wind.ts`

```ts
// Surface wind for the glass smoke (spec 2026-10-02 glass smoke). The
// dashboard's existing /api/weather poll feeds setWind(); the map subscribes
// with onWind(). No second poll: the appliance deadlocks on concurrent requests.

/** Where the wind blows TOWARD (compass degrees, 0 = N, 90 = E) and its speed. */
export interface Wind { towardDeg: number; mph: number }

// NWS gives the direction the wind comes FROM ("SW 3 mph").
const COMPASS: Record<string, number> = {
  N: 0, NNE: 22, NE: 45, ENE: 67, E: 90, ESE: 112, SE: 135, SSE: 157,
  S: 180, SSW: 202, SW: 225, WSW: 247, W: 270, WNW: 292, NW: 315, NNW: 337,
};

/** The from-bearing of an NWS wind string, or undefined. */
export function fromDeg(raw: string): number | undefined {
  return COMPASS[(/\b([NSEW]{1,3})\b/.exec(raw) ?? [])[1] ?? ""];
}

/** "NE 7 mph" → { towardDeg: 225, mph: 7 }. Ranges use the upper bound.
 *  Calm, variable, zero or unparseable → null (smoke pools, no drift). */
export function parseWind(raw: string): Wind | null {
  const from = fromDeg(raw);
  const nums = [...raw.matchAll(/\d+/g)].map((m) => Number(m[0]));
  const mph = nums.length ? Math.max(...nums) : 0;
  if (from === undefined || !(mph > 0)) return null;
  return { towardDeg: (from + 180) % 360, mph };
}

let current: Wind | null = null;
const subs = new Set<(w: Wind | null) => void>();

export function setWind(raw: string | null | undefined): void {
  current = raw ? parseWind(raw) : null;
  for (const cb of subs) cb(current);
}

/** Subscribe; the callback gets the current wind at once. Returns unsubscribe. */
export function onWind(cb: (w: Wind | null) => void): () => void {
  subs.add(cb);
  cb(current);
  return () => { subs.delete(cb); };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/wind.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Wire the dashboard.** In `src/frontend/dashboard/dashboard.ts`:
  - add `import { fromDeg, setWind } from "../lib/wind.js";` to the imports;
  - delete the local `COMPASS` table;
  - change `windBlock` to use `fromDeg`;
  - in `paintWeather`, call `setWind`.

Replace:

```ts
  const COMPASS: Record<string, number> = {
    N: 0, NNE: 22, NE: 45, ENE: 67, E: 90, ESE: 112, SE: 135, SSE: 157,
    S: 180, SSW: 202, SW: 225, WSW: 247, W: 270, WNW: 292, NW: 315, NNW: 337,
  };
  function windBlock(wind: string): string {
    const speed = /(\d+)/.exec(wind)?.[1];
    if (!speed) return "";
    const fromDeg = COMPASS[(/\b([NSEW]{1,3})\b/.exec(wind) ?? [])[1] ?? ""];
    const arrow = fromDeg === undefined ? ""
      : `<span class="kc-wx__arrow" aria-hidden="true" style="transform:rotate(${(fromDeg + 180) % 360}deg)">${icoArrow}</span>`;
```

with:

```ts
  function windBlock(wind: string): string {
    const speed = /(\d+)/.exec(wind)?.[1];
    if (!speed) return "";
    const from = fromDeg(wind);
    const arrow = from === undefined ? ""
      : `<span class="kc-wx__arrow" aria-hidden="true" style="transform:rotate(${(from + 180) % 360}deg)">${icoArrow}</span>`;
```

And in `paintWeather`'s `.then((wx: …) => {` body, add this as the first line:

```ts
        setWind(wx?.wind);   // feeds the glass smoke's drift (lib/wind.ts)
```

- [ ] **Step 6: Typecheck and run the full suite**

Run: `npm run typecheck && npx vitest run`
Expected: typecheck clean; all tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/frontend/lib/wind.ts test/wind.test.ts src/frontend/dashboard/dashboard.ts
git commit -m "feat(glass): lib/wind — parse NWS wind, share the dashboard's poll with the map

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Puffs in glassState (pure lifecycle + pacing)

**Files:**
- Modify: `src/frontend/map/glassMath.ts`:
  - replace `Glow` with `Puff`;
  - `GlassFrame` gains `puffs` and `step`;
  - `MAX_GLOWS` → `MAX_PUFFS`;
  - add `STEP_WRAP`.
- Modify: `src/frontend/map/glassState.ts`:
  - the afterglow becomes puffs;
  - `GlassTimings` swaps `glowLifetimeMs` and `fadeSteps` for the smoke timings.
- Modify: `test/glassState.test.ts` (everything before `describe("GlassState signal pacing"`)
- Modify: `test/glassMath.test.ts:2,44-45`

**Interfaces:**
- Consumes: `Wind` from `src/frontend/lib/wind.ts` (Task 1).
- Produces (later tasks rely on these exact names):
  - From `glassMath.ts`:
    - `interface Puff { key; lat; lng; radiusM; color: Rgb; strength: number; dir: readonly [number, number]; driftPx: number; along: number; cross: number; seed: number }`
    - `GlassFrame` = `{ fronts: Front[]; puffs: Puff[]; step: number; growing; continuous; nextChangeAt }`
    - `MAX_PUFFS = 48`
    - `STEP_WRAP = 7000`
  - From `glassState.ts`:
    - `GlassTimings` = `{ growMs, releaseMs, ttlMs, holdFps, signalSteps, smokeLifeMs, smokeStepMs, smokePxPerMph, puffMergeMs }`
    - `GlassState` methods `setWind(w: Wind | null)` and `seedPuff(site, radiusM, ts, now)`; `seedGlow` is removed.
    - Exported pure helpers `puffShape(k, windy)`, `puffSeed(key, born)` and `windDir(towardDeg)`; `fadeAt` is removed.

**Note:** after this task, `glassLayer.ts` and `map.ts` no longer typecheck (they still use `glows`). Task 3 fixes them. Run only the vitest files named here until then.

- [ ] **Step 1: Update `glassMath.ts` types.** Replace the `Glow` interface and `GlassFrame`/`EMPTY_FRAME`/caps with:

```ts
/** A released transmission's smoke (spec 2026-10-02 glass smoke), sampled at
 *  the shared smoke tick. Screen terms: dir is [east, north]. */
export interface Puff {
  key: string; lat: number; lng: number; radiusM: number; color: Rgb;
  /** Hit-ramp strength × the life dim. */
  strength: number;
  /** Downwind unit vector [east, north]; [0, 0] = calm (no drift). */
  dir: readonly [number, number];
  /** Drift so far along `dir`, px at a 1080-px-tall viewport. */
  driftPx: number;
  /** Radius multipliers along / across the wind. */
  along: number; cross: number;
  /** Stable 0..1 per puff: outline noise + spark hash. */
  seed: number;
}

export interface GlassFrame {
  fronts: Front[]; puffs: Puff[];
  /** The shared smoke tick index (gridTick / smokeStepMs). Wrap with
   *  STEP_WRAP before it becomes a shader uniform. */
  step: number;
  /** A front is in its grow phase: pace at txFps. */
  growing: boolean;
  /** Something moves every frame (a grow or a release dissolve). */
  continuous: boolean;
  /** Date.now() ms of the next VISIBLE change if no event arrives (a smoke
   *  tick, a rate-limited signal step, a ttl expiry); null = never. */
  nextChangeAt: number | null;
}

export const EMPTY_FRAME: GlassFrame = Object.freeze({ fronts: [], puffs: [], step: 0, growing: false, continuous: false, nextChangeAt: null }) as GlassFrame;

// Uniform-array sizes compiled into glassShaders.ts — keep in sync.
export const MAX_FRONTS = 8;
export const MAX_PUFFS = 48;
/** The step index wraps here before the shader sees it: Date.now()/step is
 *  ~3e8, far past float32 precision. A multiple of 7 keeps the 7-tick spark
 *  reshuffle continuous across the wrap. */
export const STEP_WRAP = 7000;
```

- [ ] **Step 2: Update `test/glassMath.test.ts`.**
  - In the line-2 import, replace `MAX_GLOWS` with `MAX_PUFFS, STEP_WRAP`.
  - Replace the "exports the empty frame and the shader caps" test body with:

```ts
    expect(EMPTY_FRAME).toEqual({ fronts: [], puffs: [], step: 0, growing: false, continuous: false, nextChangeAt: null });
    expect([MAX_FRONTS, MAX_PUFFS]).toEqual([8, 48]);
    expect(STEP_WRAP % 7).toBe(0);
    expect(Math.fround(STEP_WRAP - 1)).toBe(STEP_WRAP - 1);   // exact in float32
```

- [ ] **Step 3: Write the failing state tests.** In `test/glassState.test.ts`, replace everything **before** `describe("GlassState signal pacing", () => {` with the code below. Keep the signal-pacing describe block unchanged; it uses `T`, `site` and `GlassState`, which are all still defined.

```ts
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

```

- [ ] **Step 4: Run tests to verify they fail**

Run: `npx vitest run test/glassState.test.ts test/glassMath.test.ts`
Expected: FAIL, because `puffShape`, `puffSeed`, `windDir`, `setWind` and `seedPuff` don't exist.

- [ ] **Step 5: Implement.** In `src/frontend/map/glassState.ts`:
  - Replace the header comment and the import block with:

```ts
// Pure transmission + smoke lifecycle for Weather Glass, event-paced
// (specs 2026-10-02 event pacing + glass smoke). key-up → eased grow → STILL
// hold (brightness follows the audible channel's signal, quantised and
// rate-limited) → release dissolves the rim over RELEASE_MS and births a
// smoke PUFF. A puff drifts downwind with the wind at its birth, stretches,
// and dims over smokeLifeMs, sampled on ONE shared smokeStepMs tick so any
// number of puffs costs one redraw per tick. A release within puffMergeMs of
// the site's newest puff re-feeds it (birth kept), so a hot site streams a
// trail. Every frame says how it will change (continuous / nextChangeAt).
import {
  MAX_FRONTS, MAX_PUFFS, easeOutCubic, fadeProgress,
  type Rgb, type Front, type Puff, type GlassFrame,
} from "./glassMath.js";
import type { Wind } from "../lib/wind.js";
```

  - Replace `GlassTimings` with:

```ts
export interface GlassTimings {
  growMs: number; releaseMs: number; ttlMs: number;
  /** Max held-rim brightness steps per second (display.glass.holdFps). */
  holdFps: number;
  /** Brightness levels for a held rim (display.glass.signalSteps). */
  signalSteps: number;
  /** A puff's life (display.glass.smokeLifeMs). */
  smokeLifeMs: number;
  /** The shared smoke tick (display.glass.smokeStepMs). */
  smokeStepMs: number;
  /** Drift over a full life per mph, px at 1080 tall (display.glass.smokePxPerMph). */
  smokePxPerMph: number;
  /** A release within this of the site's newest puff's birth re-feeds it. */
  puffMergeMs: number;
}
```

  - Replace `fadeAt` (keep `gridTick` and `nextTick`) with:

```ts
/** A puff's shape at life fraction k: radius multipliers and dim. Calm air
 *  spreads evenly; wind stretches along more than across. */
export function puffShape(k: number, windy: boolean): { along: number; cross: number; dim: number } {
  const c = Math.min(1, Math.max(0, k));
  const dim = (1 - c) * (1 - c);
  if (!windy) { const r = 1 + 1.2 * Math.sqrt(c); return { along: r, cross: r, dim }; }
  return { along: 1 + 1.6 * c, cross: 1 + 0.8 * Math.sqrt(c), dim };
}

/** Stable 0..1 seed per puff (FNV-1a of key@born). */
export function puffSeed(key: string, born: number): number {
  const s = `${key}@${born}`;
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) / 4294967296;
}

/** Downwind unit vector [east, north] for a compass "toward" bearing. */
export function windDir(towardDeg: number): [number, number] {
  const r = (towardDeg * Math.PI) / 180;
  return [Math.sin(r), Math.cos(r)];
}
```

  - Replace `interface SiteState` with:

```ts
interface LivePuff { site: GlassSite; radiusM: number; born: number; strength0: number; wind: Wind | null; seed: number }
interface SiteState { hits: number }
```

  - In the class, replace the `sites` field and add the puff fields:

```ts
  private readonly fronts = new Map<string, LiveFront>();
  private readonly sites = new Map<string, SiteState>();
  private readonly puffs: LivePuff[] = [];
  private wind: Wind | null = null;
  private readonly gapMs: number;
```

  - In `keyUp`, replace the two site lines (`const s = this.sites.get(site.key); if (s) …; else …`) with:

```ts
    const s = this.sites.get(site.key);
    if (s) s.hits++;
    else this.sites.set(site.key, { hits: 1 });
```

  - In `release`, replace the last two lines (`const s = this.sites.get(…); if (s) s.glowStart = now;`) with:

```ts
    this.birth(f.site, f.radiusM, now);
```

  - Replace `seedGlow` with `setWind`, `seedPuff` and the private `birth` and `dropWeakest`:

```ts
  /** The wind new puffs latch (lib/wind.ts). 0 mph counts as calm. */
  setWind(w: Wind | null): void {
    this.wind = w && w.mph > 0 ? w : null;
  }

  /** History backfill: a puff born at the row's real ts, already part-aged. */
  seedPuff(site: GlassSite, radiusM: number, ts: number, now: number): void {
    if (now - ts >= this.t.smokeLifeMs) return;
    const s = this.sites.get(site.key);
    if (s) s.hits++;
    else this.sites.set(site.key, { hits: 1 });
    this.birth(site, radiusM, ts);
  }

  private birth(site: GlassSite, radiusM: number, at: number): void {
    const strength0 = rampStrength(this.sites.get(site.key)?.hits ?? 1);
    let newest: LivePuff | undefined;
    for (const p of this.puffs) if (p.site.key === site.key && (!newest || p.born > newest.born)) newest = p;
    if (newest && Math.abs(at - newest.born) < this.t.puffMergeMs) {
      // Re-feed: thicker, birth KEPT — restarting the age would pin a hot
      // site's smoke at the source forever (no trail).
      newest.strength0 = strength0; newest.radiusM = radiusM; newest.site = site;
      return;
    }
    this.puffs.push({ site, radiusM, born: at, strength0, wind: this.wind, seed: puffSeed(site.key, at) });
    if (this.puffs.length > MAX_PUFFS) this.dropWeakest(at);
  }

  private dropWeakest(at: number): void {
    let wi = 0, ws = Infinity;
    this.puffs.forEach((p, i) => {
      const v = p.strength0 * puffShape((at - p.born) / this.t.smokeLifeMs, p.wind !== null).dim;
      if (v < ws) { ws = v; wi = i; }
    });
    this.puffs.splice(wi, 1);
  }
```

  - In `frame()`, replace everything from `const liveKeys = …` to the end of the method with:

```ts
    const life = this.t.smokeLifeMs, stepMs = this.t.smokeStepMs;
    const tick = gridTick(now, stepMs);
    const puffs: Puff[] = [];
    for (let i = this.puffs.length - 1; i >= 0; i--) {
      const p = this.puffs[i]!;
      const k = Math.max(0, tick - p.born) / life;
      if (k >= 1) { this.puffs.splice(i, 1); continue; }
      const w = p.wind;
      const sh = puffShape(k, w !== null);
      puffs.push({
        key: p.site.key, lat: p.site.lat, lng: p.site.lng, radiusM: p.radiusM, color: p.site.color,
        strength: p.strength0 * sh.dim,
        dir: w ? windDir(w.towardDeg) : [0, 0],
        driftPx: w ? k * this.t.smokePxPerMph * w.mph : 0,
        along: sh.along, cross: sh.cross, seed: p.seed,
      });
    }
    const alive = new Set<string>([...this.fronts.values()].map((f) => f.site.key));
    for (const p of this.puffs) alive.add(p.site.key);
    for (const key of [...this.sites.keys()]) if (!alive.has(key)) this.sites.delete(key);   // window over: hits reset
    if (this.puffs.length) next = Math.min(next, nextTick(now, stepMs));
    puffs.sort((a, b) => b.strength - a.strength);
    return {
      fronts, puffs, step: Math.round(tick / stepMs), growing, continuous,
      nextChangeAt: Number.isFinite(next) ? next : null,
    };
```

  - Change `nextTick`'s signature to `function nextTick(now: number, stepMs: number): number`. Its body becomes:

```ts
  let t = gridTick(now, stepMs) + stepMs;
  while (t <= now) t += stepMs;
  return t;
```

  - Change `gridTick` to take the step directly. Update its doc comment to say "Puffs step on ONE absolute grid":

```ts
export function gridTick(now: number, stepMs: number): number {
  return Math.floor(now / stepMs) * stepMs;
}
```

  - Delete the now-unused `GlassFrame`/`Glow` references, and any `Glow` import, if `tsc` flags them.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run test/glassState.test.ts test/glassMath.test.ts test/glassPace.test.ts`
Expected: PASS (all, including the unchanged signal-pacing block)

- [ ] **Step 7: Commit**

```bash
git add src/frontend/map/glassMath.ts src/frontend/map/glassState.ts test/glassState.test.ts test/glassMath.test.ts
git commit -m "feat(glass): smoke puffs — per-release puffs with birth wind, shared step tick, trail re-feed

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Shader, layer, schema knobs and map wiring

**Files:**
- Modify: `src/frontend/map/glassShaders.ts` (`FX_FS` uniforms and the afterglow loop, about lines 69–110; header comment line 10)
- Modify: `src/frontend/map/glassLayer.ts`:
  - `GlassKnobs`;
  - the `glows` buffers become `puffs` buffers;
  - the `link()` uniform list (about line 162);
  - the draw section (about lines 309–335).
- Modify: `src/backend/config/schema.ts` (the `glass` object, about lines 362–378)
- Modify: `src/frontend/map/map.ts`:
  - constants, about lines 60–69;
  - the `GlassState` construction, about lines 228–232;
  - wind subscription;
  - `push()`, about line 496;
  - the backfill, about lines 501–512.
- Modify: `test/schema.test.ts:518-532`, `test/glassLayer.test.ts:83,102,122`

**Interfaces:**
- Consumes:
  - from Task 2: `Puff`, `GlassFrame.puffs`, `GlassFrame.step`, `MAX_PUFFS`, `STEP_WRAP`, `GlassState.setWind`, `GlassState.seedPuff`, the new `GlassTimings`;
  - from Task 1: `onWind`.
- Produces: the `display.glass.smokeLifeMs`, `smokeStepMs`, `smokePxPerMph`, `smokeBody`, `sparkDensity` and `puffMergeMs` config keys.

- [ ] **Step 1: Write the failing schema test.** In `test/schema.test.ts`, replace the "fills the glass defaults" expectation and add two tests in the same describe:

```ts
  it("fills the glass defaults", () => {
    expect(configSchema.parse(base()).display!.glass).toEqual({
      maxFps: 30, txFps: 60, hazeIntensity: 0, radarOpacity: 0.6,
      radarMinDbz: 15, radarFadeMs: 20_000, txGrowMs: 900,
      holdFps: 4, signalSteps: 8,
      smokeLifeMs: 600_000, smokeStepMs: 6000, smokePxPerMph: 60,
      smokeBody: 0.55, sparkDensity: 1, puffMergeMs: 60_000,
    });
  });
  it("an old config carrying glass.fadeSteps still loads; the key is stripped", () => {
    const cfg = configSchema.parse({ ...base(), display: { ...base().display, glass: { fadeSteps: 24, holdFps: 6 } } });
    expect("fadeSteps" in cfg.display!.glass).toBe(false);
    expect(cfg.display!.glass.holdFps).toBe(6);
    expect(cfg.display!.glass.smokeStepMs).toBe(6000);
  });
  it("rejects out-of-range smoke knobs", () => {
    const g = (glass: object) => ({ ...base(), display: { ...base().display, glass } });
    expect(() => configSchema.parse(g({ smokeStepMs: 500 }))).toThrow();
    expect(() => configSchema.parse(g({ smokeLifeMs: 10_000 }))).toThrow();
    expect(() => configSchema.parse(g({ smokePxPerMph: 201 }))).toThrow();
    expect(() => configSchema.parse(g({ smokeBody: 1.5 }))).toThrow();
    expect(() => configSchema.parse(g({ sparkDensity: -1 }))).toThrow();
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/schema.test.ts`
Expected: FAIL in "fills the glass defaults" (`fadeSteps` present, smoke keys missing).

- [ ] **Step 3: Schema.** In `src/backend/config/schema.ts`, replace the event-pacing comment block and the three lines `holdFps`, `signalSteps`, `fadeSteps` with:

```ts
      // Event pacing (spec 2026-10-02): the layer redraws only when its scene
      // visibly changes. A held rim's brightness moves in signalSteps levels at
      // most holdFps times a second.
      holdFps: z.number().int().min(1).max(30).default(4),
      signalSteps: z.number().int().min(2).max(32).default(8),
      // Glass smoke (spec 2026-10-02 glass smoke): each release births a puff
      // that drifts downwind (dashboard /api/weather wind) for smokeLifeMs,
      // changing only on a shared smokeStepMs tick — redraws/min ≈ 60000 /
      // smokeStepMs while smoke is on screen, 0 on a quiet band.
      smokeLifeMs: z.number().int().min(60_000).max(3_600_000).default(600_000),
      smokeStepMs: z.number().int().min(1_000).max(60_000).default(6_000),
      smokePxPerMph: z.number().min(0).max(200).default(60),   // drift over a life per mph, px @1080 tall
      smokeBody: z.number().min(0).max(1).default(0.55),       // body brightness vs the old afterglow
      sparkDensity: z.number().min(0).max(3).default(1),       // 0 = no sparks
      puffMergeMs: z.number().int().min(0).max(600_000).default(60_000), // re-feed window per site
```

- [ ] **Step 4: Run the schema test**

Run: `npx vitest run test/schema.test.ts`
Expected: PASS

- [ ] **Step 5: Shader.** In `src/frontend/map/glassShaders.ts`:
  - Change header line 10 to read `afterglow smoke (puffs + sparks), live transmission fronts. Array sizes = MAX_PUFFS /`.
  - In `FX_FS`, replace the three `uGlow*`/`uNGlows` uniform lines with:

```glsl
uniform vec4 uPuffA[48];   // centre px (xy, drift applied), base radius px, strength
uniform vec4 uPuffB[48];   // downwind unit (xy; gl px, +y north; 0,0 = calm), along, cross
uniform vec4 uPuffC[48];   // rgb, seed
uniform int uNPuffs;
uniform float uStep;       // shared smoke tick, wrapped (STEP_WRAP): outline + spark generations
uniform float uSmokeBody;
uniform float uSparkDensity;
```

  - Replace the afterglow loop (`for (int i = 0; i < 32; i++) { if (i >= uNGlows) break; … }`) with:

```glsl
  // Smoke & sparks (spec 2026-10-02 glass smoke). Static between ticks: only
  // uStep and the puff uniforms change, and only on the shared smoke tick.
  vec3 acc = vec3(0.0);
  float dens = 0.0;
  for (int i = 0; i < 48; i++) {
    if (i >= uNPuffs) break;
    vec4 a = uPuffA[i];
    vec4 b = uPuffB[i];
    vec4 c = uPuffC[i];
    float R = max(a.z, 1.0);
    vec2 d = px - a.xy;
    vec2 ax = dot(b.xy, b.xy) > 0.5 ? b.xy : vec2(1.0, 0.0);
    float u = dot(d, ax) / (R * b.z);
    float v = dot(d, vec2(-ax.y, ax.x)) / (R * b.w);
    float r2 = u * u + v * v;
    if (r2 > 4.0) continue;
    float n = vnoise(d / R * 1.6 + vec2(c.w * 97.0, c.w * 41.0) + uStep * 0.15) - 0.5;   // ragged edge, shifts per tick
    float f = a.w * exp(-r2 * 2.2 * (1.0 + n * 1.4));
    acc += c.rgb * f;
    dens += f;
  }
  float m = max(max(acc.r, acc.g), acc.b);
  if (m > 0.002) {
    vec3 hue = acc / m;                                    // keep service hues; compress brightness only
    col += hue * (1.0 - exp(-m * 1.6)) * uSmokeBody * 0.44; // smokeBody 1 ≈ the old afterglow peak
    vec2 cell = floor(px / 2.0);
    float gen = floor((uStep + h21(cell) * 7.0) / 7.0);  // each grain reshuffles every 7 ticks, staggered
    float g = h21(cell + gen * vec2(17.31, 5.13));
    if (g < dens * uSparkDensity * 0.12) col += hue * min(1.0, 0.45 + dens);
  }
```

- [ ] **Step 6: Layer.** In `src/frontend/map/glassLayer.ts`:
  - Import: replace `MAX_GLOWS` with `MAX_PUFFS, STEP_WRAP`.
  - `GlassKnobs`: replace `holdFps: number; signalSteps: number; fadeSteps: number;` with:

```ts
  holdFps: number; signalSteps: number;
  smokeLifeMs: number; smokeStepMs: number; smokePxPerMph: number;
  smokeBody: number; sparkDensity: number; puffMergeMs: number;
```

  - Fields: replace the `glows` and `glowsC` arrays with:

```ts
  private readonly puffsA = new Float32Array(MAX_PUFFS * 4);
  private readonly puffsB = new Float32Array(MAX_PUFFS * 4);
  private readonly puffsC = new Float32Array(MAX_PUFFS * 4);
```

  - In `init`, in the `link(gl, FX_VS, FX_FS, [...])` list, replace `"uGlowA", "uGlowC", "uNGlows"` with `"uPuffA", "uPuffB", "uPuffC", "uNPuffs", "uStep", "uSmokeBody", "uSparkDensity"`.
  - In `draw`, change the comment `// (2) haze + afterglows + fronts` to `// (2) haze + smoke + fronts`. Then replace the `let ng = 0; for (const g of frame.glows) {…}` block with:

```ts
    let np = 0;
    const px1080 = H / 1080;   // drift is authored at 1080 tall
    for (const p of frame.puffs) {
      if (np >= MAX_PUFFS) break;
      const m = transformer.fromLatLngAltitude({ lat: p.lat, lng: p.lng, altitude: 0 });
      const c = clipToPx(m, 0, 0, 0, W, H), e = clipToPx(m, p.radiusM, 0, 0, W, H);
      if (!c || !e) continue;
      const drift = p.driftPx * px1080;   // gl px: origin bottom-left, so +y = north
      this.puffsA.set([c[0] + p.dir[0] * drift, c[1] + p.dir[1] * drift, Math.hypot(e[0] - c[0], e[1] - c[1]), p.strength], np * 4);
      this.puffsB.set([p.dir[0], p.dir[1], p.along, p.cross], np * 4);
      this.puffsC.set([p.color[0], p.color[1], p.color[2], p.seed], np * 4);
      np++;
    }
```

  - Change `if (k.hazeIntensity > 0 || nf > 0 || ng > 0) {` to `if (k.hazeIntensity > 0 || nf > 0 || np > 0) {`.
  - Replace the three `uGlow*`/`uNGlows` uniform calls with:

```ts
      gl.uniform4fv(u.uPuffA!, this.puffsA);
      gl.uniform4fv(u.uPuffB!, this.puffsB);
      gl.uniform4fv(u.uPuffC!, this.puffsC);
      gl.uniform1i(u.uNPuffs!, np);
      gl.uniform1f(u.uStep!, frame.step % STEP_WRAP);
      gl.uniform1f(u.uSmokeBody!, k.smokeBody);
      gl.uniform1f(u.uSparkDensity!, k.sparkDensity);
```

- [ ] **Step 7: Layer test fixtures.** In `test/glassLayer.test.ts` lines 83, 102 and 122, replace `holdFps: 4, signalSteps: 8, fadeSteps: 24 }` with:

```ts
holdFps: 4, signalSteps: 8, smokeLifeMs: 600_000, smokeStepMs: 6000, smokePxPerMph: 60, smokeBody: 0.55, sparkDensity: 1, puffMergeMs: 60_000 }
```

- [ ] **Step 8: Map wiring.** In `src/frontend/map/map.ts`:
  - Add `import { onWind } from "../lib/wind.js";` next to the other `../lib` imports.
  - Delete `const BLIP_LIFETIME_MS = 60_000;` and `const HISTORY_BACKFILL_MS = 3_600_000;`. Run `grep -n "BLIP_LIFETIME_MS\|HISTORY_BACKFILL_MS" src/frontend/map/map.ts` afterwards; it should only hit the lines changed below. Update the file-head comment ("decays over a minute. Backfills the last hour") to say the smoke lives `display.glass.smokeLifeMs` and the backfill covers that window.
  - Replace the `GlassState` construction with:

```ts
    const glassState = new GlassState({
      growMs: display.glass.txGrowMs, releaseMs: RELEASE_MS, ttlMs: TX_TTL_MS,
      holdFps: display.glass.holdFps, signalSteps: display.glass.signalSteps,
      smokeLifeMs: display.glass.smokeLifeMs, smokeStepMs: display.glass.smokeStepMs,
      smokePxPerMph: display.glass.smokePxPerMph, puffMergeMs: display.glass.puffMergeMs,
    });
    // Smoke drifts with the dashboard's /api/weather wind (lib/wind.ts): no
    // poll of our own. A new wind only steers puffs born after it.
    onWind((w) => glassState.setWind(w));
```

  - In `push()`, replace `glassState.seedGlow(` with `glassState.seedPuff(`.
  - Replace the backfill block with:

```ts
    // Backfill: the smoke window, at real timestamps (puffs arrive part-aged).
    const backfillMs = display.glass.smokeLifeMs;
    void fetch(`/api/history?since=${Date.now() - backfillMs}&limit=500`)
      .then((r) => (r.ok ? r.json() : []))
      .then((rows: Array<{ lat: number | null; lon: number | null; alphaTag: string; kind: string; ts: number; freq: number }>) => {
        for (const r of rows) {
          if (r.lat == null || r.lon == null) continue;
          push(r.lat, r.lon, r.alphaTag, r.kind === "closecall" ? "closecall" : "active", r.ts, r.freq);
        }
      })
      .catch(() => {});
```

- [ ] **Step 9: Full verification**

Run: `npm run typecheck && npm test && npm run build`
Expected: typecheck clean (both tsconfigs); every vitest file passes; the build completes (vite + tsc + native).

Run: `grep -rn "fadeSteps\|seedGlow\|MAX_GLOWS\|uGlow\|frame.glows" src test`
Expected: no output.

- [ ] **Step 10: Commit**

```bash
git add src/frontend/map/glassShaders.ts src/frontend/map/glassLayer.ts src/backend/config/schema.ts src/frontend/map/map.ts test/schema.test.ts test/glassLayer.test.ts
git commit -m "feat(glass): smoke & sparks shader + layer, smoke knobs, wind-fed map, real-ts backfill

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Docs, on-wall proof, stare test, PR

**Files:**
- Modify: `CLAUDE.md` (repo root; the "Weather Glass layer" architecture bullet)
- Modify: `docs/ROADMAP.md` (the "Shipped 2026-10 — Weather Glass + fixed stage" line, about line 274)
- Modify: `docs/superpowers/specs/2026-10-02-glass-smoke-design.md` (Status line, plus the default `smokeStepMs` if the stare test changes it)

- [ ] **Step 1: Docs.** In `CLAUDE.md`, append to the "Weather Glass layer" bullet:

```markdown
  Released transmissions become **smoke** (`glassState` puffs): each drifts
  downwind with the dashboard's `/api/weather` wind (`lib/wind.ts`, no second
  poll) for `display.glass.smokeLifeMs`, changing only on one shared
  `smokeStepMs` tick — the knob that trades stare-ability against heat.
```

In `docs/ROADMAP.md`, change `transmissions are glass fronts → still rim → stepped afterglow;` to `transmissions are glass fronts → still rim → wind-carried smoke & sparks (10 min, shared step tick);`. Add the spec path `…/2026-10-02-glass-smoke-design.md` to that line's spec list.

- [ ] **Step 2: Deploy to the wall** (backend restart needed for the schema, from the repo root):

```bash
(cd kiosk && npm run build) && sudo systemctl restart kerchunk-kiosk && sleep 8 && curl -s -X POST localhost:8080/api/kiosk/reload
```

Expected: the reload returns OK. If the wall page is stale after ~15 s, run `sudo systemctl restart kerchunk-display`.

- [ ] **Step 3: Driven proof.** `/api/test/tx` takes `{ channelId?, lat?, lon?, holdMs? }`. With no `channelId` it picks a located enabled channel; `holdMs` is clamped to 1–60 s, default 6 s. Pick two channel ids of different services from `curl -s localhost:8080/api/config | jq -r '.channels[] | select(.location.lat) | "\(.id) \(.freq) \(.tags)"' | head`. Fire a trail on the first and an overlapping hit on the second, then capture bursts (`A` and `B` are those ids):

```bash
A=<first id>; B=<second id>
for i in 1 2 3 4 5 6; do curl -s -X POST localhost:8080/api/test/tx -H 'content-type: application/json' -d "{\"channelId\":\"$A\",\"holdMs\":4000}" >/dev/null; sleep 20; done &
sleep 45; curl -s -X POST localhost:8080/api/test/tx -H 'content-type: application/json' -d "{\"channelId\":\"$B\",\"holdMs\":4000}" >/dev/null &
for t in 5 30 90 240 480; do sleep $t; XDG_RUNTIME_DIR=/run/user/1000 WAYLAND_DISPLAY=wayland-0 grim /tmp/claude-1000/smoke-$t.png; done
```

Read each PNG. Expected:
- a puff at the source at 5 s;
- a downwind trail by 90 s, heading opposite the clock's wind letters (the arrow points the way it blows);
- sparks visible inside the body;
- dimmer, stretched smoke at 480 s;
- different services keep distinct hues where they overlap.

- [ ] **Step 4: Pacing.** Run `journalctl -u kerchunk-display --since "-15 min" | grep -i "glass" | tail`. Expected: the pacing diag shows `glassRedraws/min` ≈ 10 (60 000 / 6000) while smoke is on screen, and 0 after 10 quiet minutes. Report the actual numbers.

- [ ] **Step 5: Stare test + thermal.** For each `smokeStepMs` in 6000, 3000 and 1500:
  - set it with `curl -s -X PUT localhost:8080/api/config` (merge `display.glass.smokeStepMs` into the current config: GET it first);
  - `curl -X POST localhost:8080/api/kiosk/reload`;
  - leave 10 minutes of live band;
  - record package temperature and chromium CPU (`sensors`; `top -b -n 3 -d 10 | grep -i chrom`).

Report a table to the operator with temperature, chromium % and redraws/min per step. Budget: +2 °C and +10 % chromium versus the PR B baseline. The operator picks the default by eye. If it isn't 6000, change the schema default, the schema test and the spec, then re-run `npm test`.

- [ ] **Step 6: Commit docs**

```bash
git add ../CLAUDE.md ../docs/ROADMAP.md ../docs/superpowers/specs/2026-10-02-glass-smoke-design.md src/backend/config/schema.ts test/schema.test.ts
git commit -m "docs(glass): smoke shipped — CLAUDE.md glass note, roadmap, stare-test default

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 7: PR** (only after PR B is merged and this branch is rebased onto `main`). First write `/tmp/claude-1000/smoke-pr.md`: a summary, the stare-test table from Step 5, the pacing numbers from Step 4, and the test/typecheck/build results.

```bash
git fetch origin && git rebase --onto origin/main feat/glass-transmissions feat/glass-smoke
(cd kiosk && npm run typecheck && npm test)
git push -u origin feat/glass-smoke
gh pr create --base main --title "feat(glass): smoke & sparks — afterglows become 10-min wind-carried smoke" --body "$(cat /tmp/claude-1000/smoke-pr.md)

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

After merge: `gh pr merge <n> --merge --delete-branch && git checkout main && git pull --ff-only && git fetch --prune && git branch -d feat/glass-smoke`.
