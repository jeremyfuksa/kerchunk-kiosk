# Kerchunk Wall Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a second artistic-kiosk skin at `/wall` — a frequency-column wall where every key-up stacks a service-colored mark in its channel's column — and extract a shared idle-suspend loop that the Wall uses and `art.ts` is retrofitted onto (closing the logged unconditional-rAF watch-item).

**Architecture:** A pure `WallField` accumulator (counts + bloom per frequency, daily-reset aware, headless-tested, mirroring `art/sediment.ts`'s `SedimentField`) feeds a canvas renderer (`wall/wall.ts`) that draws frequency-ordered columns of marks with the busiest labeled. A new `lib/idleLoop.ts` factors out `map.ts`'s proven wake/suspend/dual-schedule loop; both `wall.ts` and `art.ts` consume it. `startOfLocalDay` moves to `lib/localDay.ts` so both skins share it. Zero backend/schema/API change beyond one `/wall` route clause.

**Tech Stack:** TypeScript (ESM `.js` imports, `strict` + `noUncheckedIndexedAccess`), vitest; vanilla framework-free frontend + Canvas 2D. All commands from `kiosk/`.

---

## CRITICAL: off-server vs. kiosk

- **Off-server (Tasks 1–6 code + unit tests):** the pure `WallField`, the `idleLoop` scheduling logic (injected fake scheduler), the `localDay` extraction, the routing, and the canvas modules all **build and type-check** here, and the pure pieces are fully unit-tested. Ship-buildable.
- **Kiosk (Task 7):** the canvas **look** — column legibility, mark pitch, bloom feel, label placement, screen-blend over the real HDMI panel, and that the loop genuinely suspends on a quiet band — is a visual property judged on the appliance. View `/wall` on the kiosk, tune the constants, prove `art.ts` still renders and now idles, THEN open the PR.

Spec: [`docs/superpowers/specs/2026-06-09-kerchunk-wall-design.md`](../specs/2026-06-09-kerchunk-wall-design.md).

## Background the engineer needs

- **Read [`CLAUDE.md`](../../../CLAUDE.md).** ESM `.js` import extensions even in `.ts`; `strict` + `noUncheckedIndexedAccess` (indexed access is `T | undefined`); `npm run build` (vite + tsc); all commands from `kiosk/`.
- **You are on branch `feat/kerchunk-wall`** (the spec is already committed here). Commit each task here. Do NOT touch `main` or push until Task 7.
- **Mirror the existing art skin.** `src/frontend/art/art.ts` is the template for `wall.ts` (boot → `getConfig` → history backfill → `ReconnectingWs` → canvas paint). `src/frontend/art/sediment.ts` is the template for `WallField` (pure class, `deposit`/query/`clear`, headless-tested in `test/sediment.test.ts`).
- **Reuse, don't reinvent:** `colorFor(freq, "active")` from `src/frontend/lib/serviceColor.ts`; `ReconnectingWs(url, onEvent, opts)` + `.connect()` from `src/frontend/lib/wsClient.ts`; `api.getConfig()` from `src/frontend/lib/api.ts`; history via `fetch('/api/history?since=<ms>&kind=active&limit=5000')` → `HistoryRow[]` (fields used: `freq`, `ts`).
- **The idle pattern to factor out** lives at `src/frontend/map/map.ts:537-552`: a `ticking` guard, stop scheduling entirely when nothing animates, and a dual-schedule fallback (`requestAnimationFrame(() => setTimeout(go, 40)); setTimeout(go, 250)`) so a dropped rAF can't strand the loop.
- **The watch-item to fix:** `src/frontend/art/art.ts:74-91` runs an unconditional `requestAnimationFrame(frame)`. Task 6 retrofits it onto `lib/idleLoop.ts`.
- **`active` event shape** (`src/frontend/.../ScannerEngine.ts`): `{ type: "active", channel, freq, ts }`. **Config channel shape:** `{ freq, alphaTag, enabled, ... }`.

## File structure

- **Create** `src/frontend/lib/localDay.ts` — `startOfLocalDay(ts)`, moved from `sediment.ts`.
- **Modify** `src/frontend/art/sediment.ts` — drop the local `startOfLocalDay`, re-export it from `lib/localDay.ts` (so existing importers, incl. `test/sediment.test.ts` and `art.ts`, are untouched).
- **Create** `src/frontend/lib/idleLoop.ts` — `createIdleLoop({ tick, schedule? })`. One responsibility: schedule frames while animating, suspend when static, resume on `wake()`.
- **Create** `test/idleLoop.test.ts` — unit tests with an injected synchronous scheduler.
- **Create** `src/frontend/wall/wallField.ts` — pure accumulator (counts + bloom per freq).
- **Create** `test/wallField.test.ts` — unit tests.
- **Create** `src/frontend/wall/wall.ts` — `render(root)` renderer.
- **Create** `src/frontend/wall/wall.css` — full-screen near-black canvas.
- **Modify** `src/frontend/art/art.ts` — retrofit onto `idleLoop`.
- **Modify** `src/frontend/main.ts` — `/wall` route branch.
- **Modify** `src/backend/server.ts:935` — `/wall` in the static fallback.

---

## PHASE A — off-server (pure + wiring, fully unit-tested)

## Task 1: Extract `startOfLocalDay` to `lib/localDay.ts`

**Files:**
- Create: `kiosk/src/frontend/lib/localDay.ts`
- Modify: `kiosk/src/frontend/art/sediment.ts`

Pure refactor — the existing `test/sediment.test.ts` `startOfLocalDay` tests must stay green unchanged (they import it from `sediment.js`, which will re-export).

- [ ] **Step 1: Create the shared module**

```ts
// kiosk/src/frontend/lib/localDay.ts
/** Local midnight (ms) for the day containing `ts`. The daily portrait's lower
 *  bound; shared by the art skins (The Day's Map, the Kerchunk Wall). */
export function startOfLocalDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
```

- [ ] **Step 2: Re-export from `sediment.ts`**

In `kiosk/src/frontend/art/sediment.ts`, DELETE the local `startOfLocalDay` definition (the `/** Local midnight … */ export function startOfLocalDay(ts) { … }` block at the bottom) and add this re-export at the top (below the file header comment):

```ts
export { startOfLocalDay } from "../lib/localDay.js";
```

- [ ] **Step 3: Verify nothing broke**

Run: `cd kiosk && npx vitest run test/sediment.test.ts`
Expected: PASS — the `startOfLocalDay` describe block still passes via the re-export; `SedimentField` tests untouched.

- [ ] **Step 4: Build**

Run: `cd kiosk && npm run build`
Expected: succeeds (art.ts still imports `startOfLocalDay` from `./sediment.js`, now re-exported).

- [ ] **Step 5: Commit**

```bash
cd kiosk
git add src/frontend/lib/localDay.ts src/frontend/art/sediment.ts
git commit -m "refactor(frontend): extract startOfLocalDay to lib/localDay"
```

---

## Task 2: Shared `lib/idleLoop.ts` + tests

**Files:**
- Create: `kiosk/src/frontend/lib/idleLoop.ts`
- Test: `kiosk/test/idleLoop.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// kiosk/test/idleLoop.test.ts
import { describe, it, expect } from "vitest";
import { createIdleLoop } from "../src/frontend/lib/idleLoop.js";

// A controllable scheduler: frames queue up and run only when flushed.
function fakeScheduler() {
  let q: Array<() => void> = [];
  return {
    schedule: (cb: () => void) => { q.push(cb); },
    flush: () => { const s = q; q = []; s.forEach((fn) => fn()); },
    pending: () => q.length,
  };
}

describe("createIdleLoop", () => {
  it("wake() starts the loop and tick runs on the next frame", () => {
    const s = fakeScheduler();
    let ticks = 0;
    const loop = createIdleLoop({ tick: () => { ticks++; return false; }, schedule: s.schedule });
    expect(loop.running).toBe(false);
    loop.wake();
    expect(loop.running).toBe(true);
    expect(ticks).toBe(0);     // not yet — scheduled, not run
    s.flush();
    expect(ticks).toBe(1);
  });

  it("keeps scheduling while tick returns true, suspends when it returns false", () => {
    const s = fakeScheduler();
    let ticks = 0;
    const loop = createIdleLoop({ tick: () => { ticks++; return ticks < 3; }, schedule: s.schedule });
    loop.wake();
    s.flush(); // tick 1 -> true -> reschedules
    expect(loop.running).toBe(true);
    expect(s.pending()).toBe(1);
    s.flush(); // tick 2 -> true -> reschedules
    s.flush(); // tick 3 -> false -> suspends
    expect(ticks).toBe(3);
    expect(loop.running).toBe(false);
    expect(s.pending()).toBe(0);
  });

  it("wake() while running is a no-op (no double scheduling)", () => {
    const s = fakeScheduler();
    const loop = createIdleLoop({ tick: () => true, schedule: s.schedule });
    loop.wake();
    expect(s.pending()).toBe(1);
    loop.wake();
    expect(s.pending()).toBe(1); // still one
  });

  it("wake() after suspension resumes the loop", () => {
    const s = fakeScheduler();
    let cont = false;
    const loop = createIdleLoop({ tick: () => cont, schedule: s.schedule });
    loop.wake(); s.flush();          // tick -> false -> suspended
    expect(loop.running).toBe(false);
    cont = true;
    loop.wake();                     // resume
    expect(loop.running).toBe(true);
    expect(s.pending()).toBe(1);
  });

  it("stop() suspends and prevents further wake()", () => {
    const s = fakeScheduler();
    const loop = createIdleLoop({ tick: () => true, schedule: s.schedule });
    loop.wake();
    loop.stop();
    expect(loop.running).toBe(false);
    loop.wake();
    expect(loop.running).toBe(false);
    expect(s.pending()).toBe(0); // stop() drained: the queued frame is inert after stop
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd kiosk && npx vitest run test/idleLoop.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

```ts
// kiosk/src/frontend/lib/idleLoop.ts
// Shared idle-suspend animation loop, factored from map.ts's proven pattern.
// A continuous requestAnimationFrame is a thermal regression on the 24/7 2014
// appliance: this loop STOPS scheduling entirely when nothing animates (tick
// returns false) and resumes only on wake(). The default scheduler dual-arms
// (rAF for smoothness + a wall-clock fallback) so a dropped/deferred rAF can
// never strand the loop. The scheduler is injectable for headless tests.

export interface IdleLoopOptions {
  /** Paint one frame. Return true if more frames are needed (something is still
   *  animating), false if the view is now static and the loop may suspend. */
  tick: () => boolean;
  /** Schedule the next frame. Defaults to rAF + 250ms wall-clock fallback. */
  schedule?: (cb: () => void) => void;
}

export interface IdleLoop {
  /** Start (or resume) the loop if it isn't already running and wasn't stopped. */
  wake(): void;
  /** True while the loop is scheduling frames. */
  readonly running: boolean;
  /** Permanently stop the loop (teardown on unmount). */
  stop(): void;
}

function defaultSchedule(cb: () => void): void {
  // rAF gives smooth motion, but is NEVER the sole re-arm: if the compositor
  // defers/drops it (deep idle), the wall-clock fallback still fires. `ran`
  // guards against the two paths double-firing.
  let ran = false;
  const go = (): void => { if (ran) return; ran = true; cb(); };
  requestAnimationFrame(() => setTimeout(go, 40));
  setTimeout(go, 250);
}

export function createIdleLoop(opts: IdleLoopOptions): IdleLoop {
  const schedule = opts.schedule ?? defaultSchedule;
  let running = false;
  let stopped = false;

  function frame(): void {
    if (stopped) { running = false; return; }
    const cont = opts.tick();
    if (cont && !stopped) schedule(frame);
    else running = false;
  }

  return {
    wake(): void {
      if (running || stopped) return;
      running = true;
      schedule(frame);
    },
    get running(): boolean { return running; },
    stop(): void { stopped = true; running = false; },
  };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd kiosk && npx vitest run test/idleLoop.test.ts`
Expected: PASS (5 tests). Note the `stop()` test: after `stop()`, the queued `frame` runs inert (sees `stopped`, sets `running=false`, schedules nothing) — `pending()` is 0 because nothing re-queued.

- [ ] **Step 5: Commit**

```bash
cd kiosk
git add src/frontend/lib/idleLoop.ts test/idleLoop.test.ts
git commit -m "feat(frontend): shared idle-suspend loop (lib/idleLoop)"
```

---

## Task 3: Pure `wall/wallField.ts` + tests

**Files:**
- Create: `kiosk/src/frontend/wall/wallField.ts`
- Test: `kiosk/test/wallField.test.ts`

The accumulator tracks per-frequency hit counts and a decaying bloom. The renderer owns the channel list/colors and queries this field per frequency.

- [ ] **Step 1: Write the failing test**

```ts
// kiosk/test/wallField.test.ts
import { describe, it, expect } from "vitest";
import { WallField } from "../src/frontend/wall/wallField.js";

describe("WallField", () => {
  it("counts deposits per frequency", () => {
    const f = new WallField({ breathMs: 6000 });
    f.deposit({ freq: 154_000_000, ts: 0 });
    f.deposit({ freq: 154_000_000, ts: 10 });
    f.deposit({ freq: 460_000_000, ts: 20 });
    expect(f.countFor(154_000_000)).toBe(2);
    expect(f.countFor(460_000_000)).toBe(1);
    expect(f.countFor(999)).toBe(0);
  });

  it("maxCount is the busiest column (>=1 floor for empty)", () => {
    const f = new WallField({ breathMs: 6000 });
    expect(f.maxCount()).toBe(1); // never 0 — keeps the renderer's divide safe
    f.deposit({ freq: 154_000_000, ts: 0 });
    f.deposit({ freq: 154_000_000, ts: 0 });
    f.deposit({ freq: 460_000_000, ts: 0 });
    expect(f.maxCount()).toBe(2);
  });

  it("bloomFor is 1 at the latest hit, linear to 0 at breathMs, never negative", () => {
    const f = new WallField({ breathMs: 4000 });
    f.deposit({ freq: 154_000_000, ts: 0 });
    expect(f.bloomFor(154_000_000, 0)).toBeCloseTo(1, 5);
    expect(f.bloomFor(154_000_000, 2000)).toBeCloseTo(0.5, 5);
    expect(f.bloomFor(154_000_000, 4000)).toBeCloseTo(0, 5);
    expect(f.bloomFor(154_000_000, 9999)).toBe(0);
    expect(f.bloomFor(999, 0)).toBe(0); // unknown freq
  });

  it("anyBloom is true while a column is within breathMs, false after", () => {
    const f = new WallField({ breathMs: 4000 });
    expect(f.anyBloom(0)).toBe(false);
    f.deposit({ freq: 154_000_000, ts: 0 });
    expect(f.anyBloom(1000)).toBe(true);
    expect(f.anyBloom(5000)).toBe(false);
  });

  it("clear() empties the field for the daily reset", () => {
    const f = new WallField({ breathMs: 4000 });
    f.deposit({ freq: 154_000_000, ts: 0 });
    f.clear();
    expect(f.countFor(154_000_000)).toBe(0);
    expect(f.maxCount()).toBe(1);
    expect(f.anyBloom(0)).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd kiosk && npx vitest run test/wallField.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

```ts
// kiosk/src/frontend/wall/wallField.ts
// Pure accumulator for the Kerchunk Wall (spec 2026-06-09). One column per
// configured channel; every key-up deposits a mark keyed by frequency. Tracks
// per-frequency hit counts (column height, relative to the busiest) and a
// decaying "breath" (the fresh-hit bloom). No DOM, no canvas, no wall-clock —
// the caller passes `now`. Mirrors art/sediment.ts's SedimentField.

export interface MarkInput {
  freq: number;
  ts: number;
}

export interface WallFieldOptions {
  breathMs: number;
}

interface Column {
  count: number;
  lastTs: number;
}

export class WallField {
  private cols = new Map<number, Column>();
  private readonly breathMs: number;

  constructor(opts: WallFieldOptions) {
    this.breathMs = opts.breathMs;
  }

  deposit(m: MarkInput): void {
    const col = this.cols.get(m.freq) ?? { count: 0, lastTs: m.ts };
    col.count += 1;
    col.lastTs = Math.max(col.lastTs, m.ts);
    this.cols.set(m.freq, col);
  }

  countFor(freq: number): number {
    return this.cols.get(freq)?.count ?? 0;
  }

  /** Busiest column's count, floored at 1 so renderers can divide safely. */
  maxCount(): number {
    let max = 1;
    for (const col of this.cols.values()) max = Math.max(max, col.count);
    return max;
  }

  /** 1 at the latest hit on this column, linear to 0 at breathMs. */
  bloomFor(freq: number, now: number): number {
    const col = this.cols.get(freq);
    if (!col) return 0;
    const age = now - col.lastTs;
    return age >= this.breathMs ? 0 : Math.max(0, 1 - age / this.breathMs);
  }

  /** True if any column is still blooming — the loop's "keep animating" signal. */
  anyBloom(now: number): boolean {
    for (const col of this.cols.values()) {
      if (now - col.lastTs < this.breathMs) return true;
    }
    return false;
  }

  clear(): void {
    this.cols.clear();
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd kiosk && npx vitest run test/wallField.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
cd kiosk
git add src/frontend/wall/wallField.ts test/wallField.test.ts
git commit -m "feat(wall): pure WallField accumulator (per-freq counts + bloom)"
```

---

## Task 4: Routing — `/wall` view + static fallback

**Files:**
- Modify: `kiosk/src/frontend/main.ts`
- Modify: `kiosk/src/backend/server.ts`

Wiring only (no unit test; verified by build). `renderWall` is created in Task 5 — to keep this task self-contained and buildable, Task 5 lands the module; do Task 4's `main.ts` import edit **together with Task 5** if your tooling fails on a missing import. Per the order here, do Task 5 first if you prefer a green build at every commit; this plan lists routing first for narrative clarity but the two may be committed together.

- [ ] **Step 1: Add the backend static-fallback clause**

In `kiosk/src/backend/server.ts`, the `serveStatic` line (~`935`):

```ts
    let filePath = join(staticDir, safe === "/" || safe === "/map" || safe === "/art" || safe === "/wall" ? "index.html" : safe);
```

- [ ] **Step 2: Add the frontend route branch**

In `kiosk/src/frontend/main.ts`, add the import alongside the others and a branch:

```ts
import { renderWall } from "./wall/wall.js";
```
```ts
} else if (location.pathname.startsWith("/wall")) {
  renderWall(root);
} else if (location.pathname.startsWith("/art")) {
  renderArt(root);
```

- [ ] **Step 3: Build**

Run: `cd kiosk && npm run build`
Expected: succeeds once Task 5's `wall.ts` exists. (If doing strictly in order, commit Tasks 4+5 together.)

- [ ] **Step 4: Commit** (with Task 5, or here if `wall.ts` already exists)

```bash
cd kiosk
git add src/backend/server.ts src/frontend/main.ts
git commit -m "feat(wall): route /wall to the Kerchunk Wall view"
```

---

## PHASE B — canvas (build off-server; prove the look on the kiosk)

## Task 5: `wall/wall.ts` renderer + `wall.css`

**Files:**
- Create: `kiosk/src/frontend/wall/wall.ts`
- Create: `kiosk/src/frontend/wall/wall.css`

No unit test (canvas DOM render — the pure logic is already covered by Tasks 2–3; the look is a kiosk gate). Verify by build + Task 7's kiosk view.

- [ ] **Step 1: Create the stylesheet**

```css
/* kiosk/src/frontend/wall/wall.css */
html, body { margin: 0; height: 100%; background: #05070a; overflow: hidden; }
#wall-canvas { position: fixed; inset: 0; width: 100vw; height: 100vh; display: block; background: #05070a; }
```

- [ ] **Step 2: Create the renderer**

```ts
// kiosk/src/frontend/wall/wall.ts
// The Kerchunk Wall (ROADMAP Idea 3, 2nd art skin): one frequency-ordered
// column per configured channel; every key-up stacks a service-colored mark.
// Relative scale (busiest column fills the panel); a fresh hit blooms ~6s then
// settles; the busiest columns are labeled; one day = one wall, rebuilt from
// history at local midnight. Idle-suspends via lib/idleLoop. See
// docs/superpowers/specs/2026-06-09-kerchunk-wall-design.md.
import { ReconnectingWs } from "../lib/wsClient.js";
import { api } from "../lib/api.js";
import { colorFor } from "../lib/serviceColor.js";
import { startOfLocalDay } from "../lib/localDay.js";
import { createIdleLoop } from "../lib/idleLoop.js";
import { WallField } from "./wallField.js";
import type { EngineEvent } from "../../backend/engine/ScannerEngine.js";
import type { HistoryRow } from "../../backend/history.js";
import "./wall.css";

const BREATH_MS = 6000;     // fresh-hit bloom lifetime, matches The Day's Map
const MIN_PITCH = 7;        // DEVICE-px between stacked marks (floor). Tune on the panel.
const PAD_X = 28;           // side padding (device px)
const PAD_BOTTOM = 34;      // room for the frequency axis
const PAD_TOP = 26;         // room for floating labels
const MARK_W = 6;           // mark diameter (device px)
const LABEL_COUNT = 3;      // how many busiest columns get a name

interface Col { freq: number; tag: string; color: string; }

export function renderWall(root: HTMLElement): void {
  root.innerHTML = `<canvas id="wall-canvas"></canvas>`;
  const canvas = root.querySelector<HTMLCanvasElement>("#wall-canvas")!;
  void boot(canvas);
}

async function boot(canvas: HTMLCanvasElement): Promise<void> {
  const cfg = await api.getConfig();
  // Columns = enabled channels, ascending by frequency. Stable layout.
  const cols: Col[] = cfg.channels
    .filter((c) => c.enabled)
    .slice()
    .sort((a, b) => a.freq - b.freq)
    .map((c) => ({ freq: c.freq, tag: c.alphaTag || `${(c.freq / 1e6).toFixed(4)}`, color: colorFor(c.freq, "active") }));
  const known = new Set(cols.map((c) => c.freq));

  const field = new WallField({ breathMs: BREATH_MS });
  let dayStart = startOfLocalDay(Date.now());

  // Seed today's wall from history (recovers it across a reload/reboot).
  try {
    const rows: HistoryRow[] = await fetch(
      `/api/history?since=${dayStart}&kind=active&limit=5000`,
    ).then((r) => (r.ok ? r.json() : []));
    for (const row of rows) {
      if (known.has(row.freq)) field.deposit({ freq: row.freq, ts: row.ts });
    }
  } catch { /* offline / no history — start empty */ }

  const ctx = canvas.getContext("2d")!;
  function resize(): void {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(canvas.clientWidth * dpr);
    canvas.height = Math.round(canvas.clientHeight * dpr);
  }
  resize();

  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function paint(): void {
    const now = Date.now();
    const today = startOfLocalDay(now);
    if (today !== dayStart) { field.clear(); dayStart = today; }

    const w = canvas.width, h = canvas.height;
    const plotH = h - PAD_TOP - PAD_BOTTOM;
    const baseY = h - PAD_BOTTOM;
    const max = field.maxCount();
    const slot = (w - PAD_X * 2) / Math.max(1, cols.length);

    ctx.clearRect(0, 0, w, h);
    ctx.globalCompositeOperation = "screen";

    // Rank for labels: indices of the LABEL_COUNT busiest columns.
    const ranked = cols
      .map((c, i) => ({ i, n: field.countFor(c.freq) }))
      .filter((x) => x.n > 0)
      .sort((a, b) => b.n - a.n)
      .slice(0, LABEL_COUNT);
    const labelled = new Set(ranked.map((x) => x.i));

    const dpr = window.devicePixelRatio || 1;
    cols.forEach((c, i) => {
      const x = PAD_X + slot * (i + 0.5);
      const n = field.countFor(c.freq);
      // Faint baseline tick — a silent channel still reads as "ready".
      paintDot(ctx, x, baseY, MARK_W * 0.5, c.color, 0.18);
      if (n === 0) return;
      // Relative scale: the busiest column fills the plot; pitch floored at
      // MIN_PITCH so marks merge into a solid glowing bar when a channel maxes.
      const colH = (n / max) * plotH;
      const pitch = Math.max(MIN_PITCH, colH / n);
      const marks = Math.min(n, Math.max(1, Math.floor(colH / pitch)));
      for (let k = 0; k < marks; k++) {
        paintDot(ctx, x, baseY - k * pitch, MARK_W * 0.5, c.color, 0.55);
      }
      const topY = baseY - (marks - 1) * pitch;
      const bloom = field.bloomFor(c.freq, now);
      if (bloom > 0) paintDot(ctx, x, topY, MARK_W * (0.6 + bloom), c.color, 0.85 * bloom);
      if (labelled.has(i)) {
        ctx.globalCompositeOperation = "source-over";
        ctx.fillStyle = "rgba(232,237,244,0.92)";
        ctx.font = `${Math.round(11 * dpr)}px system-ui, sans-serif`;
        ctx.textAlign = "center";
        ctx.fillText(c.tag, x, Math.max(PAD_TOP * 0.7, topY - 8));
        ctx.globalCompositeOperation = "screen";
      }
    });

    // Faint frequency axis (guarded — an empty channel set has no endpoints).
    if (cols.length > 0) {
      ctx.globalCompositeOperation = "source-over";
      ctx.fillStyle = "rgba(107,115,130,0.7)";
      ctx.font = `${Math.round(9 * dpr)}px system-ui, sans-serif`;
      ctx.textAlign = "left";
      ctx.fillText(`${(cols[0]!.freq / 1e6).toFixed(1)} MHz`, PAD_X, h - 12);
      ctx.textAlign = "right";
      ctx.fillText(`${(cols[cols.length - 1]!.freq / 1e6).toFixed(1)} MHz`, w - PAD_X, h - 12);
    }
    ctx.globalCompositeOperation = "source-over";
  }

  function paintDot(c: CanvasRenderingContext2D, x: number, y: number, r: number, color: string, alpha: number): void {
    c.globalAlpha = alpha;
    c.fillStyle = color;
    c.beginPath();
    c.arc(x, y, Math.max(1, r), 0, Math.PI * 2);
    c.fill();
    c.globalAlpha = 1;
  }

  const loop = createIdleLoop({ tick: () => { paint(); return !reduceMotion && field.anyBloom(Date.now()); } });
  window.addEventListener("resize", () => { resize(); if (reduceMotion) paint(); else loop.wake(); });

  function onEvent(ev: EngineEvent): void {
    if (ev.type === "active" && known.has(ev.freq)) {
      field.deposit({ freq: ev.freq, ts: ev.ts });
      if (reduceMotion) paint(); else loop.wake();
    }
  }
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new ReconnectingWs(`${proto}://${location.host}/ws`, onEvent, {});
  ws.connect();

  // Initial paint + (when not reduced-motion) kick the loop so the backfilled
  // wall shows immediately and any startup blooms animate.
  if (reduceMotion) paint(); else loop.wake();

  // Daily reset even while idle: wake once at the next local midnight so the
  // wall clears on time without a continuous poll. Re-arms each midnight.
  function scheduleMidnight(): void {
    const next = startOfLocalDay(Date.now()) + 24 * 60 * 60 * 1000;
    setTimeout(() => { if (reduceMotion) paint(); else loop.wake(); scheduleMidnight(); },
      Math.max(1000, next - Date.now()));
  }
  scheduleMidnight();
}
```

- [ ] **Step 3: Build**

Run: `cd kiosk && npm run build`
Expected: succeeds (vite bundles the new view; tsc is clean). Commit together with Task 4's routing if not already committed.

- [ ] **Step 4: Commit**

```bash
cd kiosk
git add src/frontend/wall/wall.ts src/frontend/wall/wall.css src/frontend/main.ts src/backend/server.ts
git commit -m "feat(wall): Kerchunk Wall canvas renderer + /wall route"
```

---

## Task 6: Retrofit `art.ts` onto `lib/idleLoop` (close the watch-item)

**Files:**
- Modify: `kiosk/src/frontend/art/art.ts`

Replace the unconditional `requestAnimationFrame(frame)` (lines ~74–91) with the shared loop so The Day's Map suspends on a quiet band.

- [ ] **Step 1: Import the loop**

Add to `art.ts`'s imports:

```ts
import { createIdleLoop } from "../lib/idleLoop.js";
```

- [ ] **Step 2: Convert `frame()` to a tick + drive it with the loop**

Replace the `function frame(): void { … } requestAnimationFrame(frame);` block (the body that does the daily-reset check, projection, `clearRect`, the deposits loop, and `requestAnimationFrame(frame)`) with a `paint()` that returns whether to keep animating, plus the loop:

```ts
  function paint(): boolean {
    const now = Date.now();
    const today = startOfLocalDay(now);
    if (today !== dayStart) { field.clear(); dayStart = today; }

    const w = canvas.width, h = canvas.height;
    const project = makeProjection(home, SPAN_M, w, h);
    ctx.clearRect(0, 0, w, h);
    ctx.globalCompositeOperation = "screen";

    const deps = field.deposits(now);
    for (const dep of deps) {
      drawDeposit(ctx, project(dep.lat, dep.lon), dep);
    }
    ctx.globalCompositeOperation = "source-over";
    // Keep animating only while a deposit is still blooming.
    return deps.some((d) => d.breath > 0);
  }

  const loop = createIdleLoop({ tick: paint });
```

- [ ] **Step 3: Wake the loop on a deposit and at boot**

In `onEvent`, after `field.deposit({...})`, add `loop.wake();`. After the WS wiring (where `requestAnimationFrame(frame)` used to be), add an initial `loop.wake();` so the seeded portrait paints once.

Also schedule a daily-reset wake so the portrait clears on time while idle (mirror the Wall):

```ts
  function scheduleMidnight(): void {
    const next = startOfLocalDay(Date.now()) + 24 * 60 * 60 * 1000;
    setTimeout(() => { loop.wake(); scheduleMidnight(); }, Math.max(1000, next - Date.now()));
  }
  scheduleMidnight();
```

(Remove the now-dead `requestAnimationFrame(frame)` line and the old `frame` name. Keep `drawDeposit`/`paintGlow` unchanged.)

- [ ] **Step 4: Build**

Run: `cd kiosk && npm run build`
Expected: succeeds.

- [ ] **Step 5: Commit**

```bash
cd kiosk
git add src/frontend/art/art.ts
git commit -m "fix(art): idle-suspend The Day's Map via lib/idleLoop (closes watch-item)"
```

---

## Task 7: Kiosk view, tune, and PR

**Files:** none (tuning happens in `wall.ts` constants if needed).

- [ ] **Step 1: Full suite + build**

Run: `cd kiosk && npm test && npm run build`
Expected: all green (incl. the new `idleLoop` + `wallField` suites); build clean.

- [ ] **Step 2: Deploy to the kiosk and view `/wall`**

```sh
cd kiosk && npm run build && sudo systemctl restart kerchunk-kiosk
```
Open `http://localhost:8080/wall` on the appliance display (or a LAN browser). Verify:
  - Columns are frequency-ordered; service colors block into bands; the day's history seeded the wall (not empty if there's been traffic).
  - A live key-up adds a mark to the right column and blooms briefly, then settles. The few busiest columns are labeled.
  - A quiet wall reads as calm baselines, not broken.
  - **Idle-suspend:** on a quiet band the rAF loop stops (confirm via DevTools Performance/Frame chart, or that CPU drops to idle); a new hit wakes it.
  - Tune `MIN_PITCH`, `MARK_W`, padding, label count if the look needs it (these are the kiosk-only knobs).

- [ ] **Step 3: Confirm The Day's Map still works and now idles**

Open `http://localhost:8080/art`. Verify the sediment portrait still renders identically, and that the loop now suspends on a quiet band (no continuous repaint) and wakes on a hit. This is the watch-item fix proven.

- [ ] **Step 4: Push + open the PR**

```bash
cd /home/kiosk/kerchunk-kiosk
git push -u origin feat/kerchunk-wall
gh pr create --base main --title "feat: Kerchunk Wall art skin (/wall) + shared idle-suspend loop" --body "Second artistic-kiosk skin: a frequency-column wall where every key-up stacks a service-colored mark; busiest columns labeled; daily reset rebuilt from history; calm bloom on fresh hits. Extracts lib/idleLoop and retrofits The Day's Map onto it (closes the unconditional-rAF watch-item). Pure WallField + idleLoop unit-tested; the look proven on the kiosk. Spec/plan: docs/superpowers/{specs,plans}/2026-06-09-kerchunk-wall*."
```

---

## Out of scope
- Close Call discovery columns; making `/wall` the default kiosk screen; a skin registry/rotation; refactoring `map.ts` onto `idleLoop`; any backend/schema/API change.

## Success criteria (from the spec)
- `/wall` renders a frequency-ordered, service-colored column wall seeded from the day's history, adding marks live on `active` events; busiest columns labeled; a quiet wall reads as calm baselines.
- Relative scaling proportions the wall on quiet and busy days; a fresh hit blooms ~6 s then settles; no other motion.
- The Wall's loop suspends on a quiet band and wakes on the next event (kiosk-verified); `art.ts` now does the same (watch-item closed).
- `prefers-reduced-motion` disables the bloom/loop and paints statically.
- `WallField` + `idleLoop` covered by off-server unit tests; the look proven on the kiosk before the PR; zero backend changes; the live map and The Day's Map unaffected.
