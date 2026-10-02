# Fixed Stage + Event Pacing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut the kiosk wall's CPU cost. The map camera never moves on its own, and the Weather Glass layer redraws only when its scene visibly changes. Transmissions move from Google `Circle`s to glass fronts and afterglows.

**Architecture:**
- **PR A, fixed stage:**
  - removes the kiosk camera push/pull-back, behind a `display.camera.follow` escape hatch;
  - adds a directional edge bloom for off-frame speakers, positioned by the pure helpers in `stage.ts`;
  - adds the `/api/test/tx` preview driver.
- **PR B, glass transmissions with event pacing:**
  - a pure `GlassState` produces each frame plus a pacing hint (`continuous`, `nextChangeAt`);
  - a pure `paceDelay()` turns that hint into a timer delay;
  - `GlassLayer` redraws only on those timers or on explicit pokes;
  - both `Circle` systems are deleted.

**Tech Stack:** TypeScript (ESM, `.js` import extensions, `strict` + `noUncheckedIndexedAccess`), vanilla-TS frontend (Vite), Google Maps JS `WebGLOverlayView`, GLSL ES 3.00, zod config, vitest.

**Spec:** `docs/superpowers/specs/2026-10-02-fixed-stage-event-pacing-design.md`. It amends `docs/superpowers/specs/2026-10-01-weather-glass-design.md`. This plan **replaces** PR 3 (Tasks 11–14) and PR 4 (Tasks 15–17) of `docs/superpowers/plans/2026-10-01-weather-glass.md`. Some code here is adapted from those tasks; do not execute them.

## Global Constraints

- All commands run from `kiosk/` (`cd /home/kiosk/kerchunk-kiosk/kiosk`).
- Relative imports carry `.js` even from `.ts`. Indexed access is `T | undefined`, so handle it.
- No frontend framework, and no hand-rolled SVG icons (lucide-static only). This plan adds no icons.
- No `backdrop-filter`, and no full-screen overlays above the animating map. The bloom is a 480 px element with opacity-only animation.
- **Every PR ships through a pull request**, branched off `main`, proven on the appliance before the PR, and merged with `gh pr merge <n> --merge --delete-branch`. Then run `git checkout main && git pull --ff-only && git fetch --prune` and `git branch -d <branch>`.
- **Definition of done**, per PR:
  - `npm test`, `npm run test:native`, `npm run typecheck` and `npm run build` all pass;
  - proven on the wall;
  - knobs live in config, and their location is stated in the PR body.
- `npm run typecheck` is mandatory: Vite does not typecheck the frontend.
- Backend restarts interrupt live audio. Restart only when a task says the change is backend (schema or route).
- Hand-editing `config.json` needs `kerchunk-kiosk` stopped first. Use `PUT /api/config` instead.
- Screenshots: `XDG_RUNTIME_DIR=/run/user/1000 WAYLAND_DISPLAY=wayland-0 grim /tmp/claude-1000/<name>.png`, then Read the PNG. Motion bugs need bursts, not single stills.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. PR bodies end with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
- New knob defaults:
  - `display.camera.follow` = `false`;
  - `display.glass.holdFps` = 4 (1–30);
  - `display.glass.signalSteps` = 8 (2–32);
  - `display.glass.fadeSteps` = 24 (4–120).

## Review Focus

1. **A resize or `fitBounds` while a transmission is live.** The frame must not jump under an active speaker. The re-fit is deferred until `idle`. *Pinned in Task 3 by the `liveCount()` gate; proven on the wall in Task 4 Step 4.*
2. **A speaker whose pin is on screen but hidden under the clock or the corner LCD.** It must get a bloom, because "off-frame" is measured against the padded rect. *Pinned in Task 1:* `outside()` treats a point inside the viewport but outside the padding as outside.
3. **Float rounding at an exact fade-step boundary**, making `nextChangeAt <= now` and spinning zero-delay timers. *Pinned in Task 5* (boundary test) *and Task 6* (`paceDelay` floors at `MIN_STEP_MS`).
4. **A `requestRedraw` that Google drops** (the page is hidden, or a context loss) during a grow, freezing a half-grown front until the next event. *Pinned in Task 6:* every armed timer re-arms a 1 s fallback, and a test asserts it.
5. **A storm of `signal` events** (2.5/s per the WS, faster on some paths) defeating the pacing. *Pinned in Task 5:* `holdFps` rate-limits brightness steps, and a repeat of the same level is not a change.

---

## PR A: Fixed stage

Start: `git checkout main && git pull --ff-only && git checkout -b feat/fixed-stage`

### Task 1: `stage.ts`, the pure geometry for the off-frame bloom

**Files:**
- Create: `kiosk/src/frontend/map/stage.ts`
- Test: `kiosk/test/stage.test.ts`

**Interfaces:**
- Produces:
```ts
export interface Pt { x: number; y: number }
export interface Rect { left: number; top: number; right: number; bottom: number }
export interface LatLngBox { n: number; s: number; e: number; w: number }
export function padRect(width: number, height: number, pad: { top: number; right: number; bottom: number; left: number }): Rect;
export function outside(p: Pt, r: Rect): boolean;
export function edgeExit(center: Pt, target: Pt, r: Rect): Pt;
export function lngLatToViewPx(lat: number, lng: number, box: LatLngBox, width: number, height: number): Pt;
export const BLOOM_PX = 480;
```

- [ ] **Step 1: Write the failing tests**

`kiosk/test/stage.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { padRect, outside, edgeExit, lngLatToViewPx } from "../src/frontend/map/stage.js";

const VIEW = { left: 0, top: 0, right: 1920, bottom: 1080 };

describe("stage geometry", () => {
  it("padRect insets the viewport by an asymmetric pad", () => {
    expect(padRect(1920, 1080, { top: 250, right: 80, bottom: 120, left: 80 }))
      .toEqual({ left: 80, top: 250, right: 1840, bottom: 960 });
  });

  it("outside: a point under the padding counts as outside the padded rect", () => {
    const inner = padRect(1920, 1080, { top: 250, right: 80, bottom: 120, left: 80 });
    expect(outside({ x: 960, y: 600 }, inner)).toBe(false);
    expect(outside({ x: 1800, y: 100 }, inner)).toBe(true);   // on screen, under the clock
    expect(outside({ x: 40, y: 1000 }, inner)).toBe(true);    // on screen, under the corner LCD
    expect(outside({ x: -50, y: 500 }, inner)).toBe(true);
  });

  it("edgeExit lands on the edge the ray leaves through", () => {
    const c = { x: 960, y: 540 };
    expect(edgeExit(c, { x: 960, y: -5000 }, VIEW)).toEqual({ x: 960, y: 0 });      // north
    expect(edgeExit(c, { x: 960, y: 9000 }, VIEW)).toEqual({ x: 960, y: 1080 });    // south
    expect(edgeExit(c, { x: -3000, y: 540 }, VIEW)).toEqual({ x: 0, y: 540 });      // west
    expect(edgeExit(c, { x: 5000, y: 540 }, VIEW)).toEqual({ x: 1920, y: 540 });    // east
  });

  it("edgeExit extends a ray through an on-screen target out to the edge", () => {
    // A pin hidden under the clock (on screen) still anchors on the border.
    const p = edgeExit({ x: 960, y: 605 }, { x: 1800, y: 100 }, VIEW);
    expect(p.y).toBe(0);
    expect(p.x).toBeCloseTo(960 + (840 / 505) * 605, 6);
  });

  it("edgeExit hits a corner exactly on the diagonal", () => {
    const p = edgeExit({ x: 960, y: 540 }, { x: 960 + 1920, y: 540 - 1080 }, VIEW);
    expect(p.x).toBeCloseTo(1920, 6);
    expect(p.y).toBeCloseTo(0, 6);
  });

  it("edgeExit with target == center returns the center (no direction)", () => {
    expect(edgeExit({ x: 10, y: 10 }, { x: 10, y: 10 }, VIEW)).toEqual({ x: 10, y: 10 });
  });

  it("lngLatToViewPx maps the bounds' corners to the viewport corners (Mercator y)", () => {
    const box = { n: 40, s: 38, e: -93, w: -96 };
    expect(lngLatToViewPx(40, -96, box, 1920, 1080)).toEqual({ x: 0, y: 0 });
    const se = lngLatToViewPx(38, -93, box, 1920, 1080);
    expect(se.x).toBeCloseTo(1920, 6);
    expect(se.y).toBeCloseTo(1080, 6);
    // Mercator: the latitude midpoint sits slightly SOUTH of the pixel midpoint
    // (north latitudes are stretched).
    expect(lngLatToViewPx(39, -94.5, box, 1920, 1080).y).toBeGreaterThan(540);
    // A site north of the view projects above the top edge.
    expect(lngLatToViewPx(40.5, -94.5, box, 1920, 1080).y).toBeLessThan(0);
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run test/stage.test.ts`
Expected: FAIL, because the module can't be resolved.

- [ ] **Step 3: Implement**

`kiosk/src/frontend/map/stage.ts`:
```ts
// Fixed-stage geometry (spec 2026-10-02): the kiosk camera never moves, so an
// audible site outside the padded frame is shown by a soft bloom on the screen
// edge where the line toward it leaves the screen. Pure: no DOM, no Google.

export interface Pt { x: number; y: number }
export interface Rect { left: number; top: number; right: number; bottom: number }
export interface LatLngBox { n: number; s: number; e: number; w: number }

/** Bloom diameter in px (map.css .edgeBloom uses the same size). */
export const BLOOM_PX = 480;

export function padRect(width: number, height: number, pad: { top: number; right: number; bottom: number; left: number }): Rect {
  return { left: pad.left, top: pad.top, right: width - pad.right, bottom: height - pad.bottom };
}

export function outside(p: Pt, r: Rect): boolean {
  return p.x < r.left || p.x > r.right || p.y < r.top || p.y > r.bottom;
}

/** Where the ray from `center` (inside `r`) through `target` crosses `r`'s
 *  border. The target may be inside or outside `r`; only its direction counts. */
export function edgeExit(center: Pt, target: Pt, r: Rect): Pt {
  const dx = target.x - center.x, dy = target.y - center.y;
  if (dx === 0 && dy === 0) return { x: center.x, y: center.y };
  let t = Infinity;
  if (dx > 0) t = Math.min(t, (r.right - center.x) / dx);
  if (dx < 0) t = Math.min(t, (r.left - center.x) / dx);
  if (dy > 0) t = Math.min(t, (r.bottom - center.y) / dy);
  if (dy < 0) t = Math.min(t, (r.top - center.y) / dy);
  return { x: center.x + dx * t, y: center.y + dy * t };
}

const mercY = (lat: number): number => {
  const r = (lat * Math.PI) / 180;
  return Math.log(Math.tan(Math.PI / 4 + r / 2));
};

/** Project a site into viewport pixels from the map's visible bounds. Valid
 *  for the kiosk's north-up, untilted camera; works off-screen too. */
export function lngLatToViewPx(lat: number, lng: number, box: LatLngBox, width: number, height: number): Pt {
  const x = ((lng - box.w) / (box.e - box.w)) * width;
  const y = ((mercY(box.n) - mercY(lat)) / (mercY(box.n) - mercY(box.s))) * height;
  return { x, y };
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx vitest run test/stage.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/frontend/map/stage.ts test/stage.test.ts
git commit -m "feat(stage): pure geometry for the off-frame edge bloom

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 2: `display.camera.follow` and the `/api/test/tx` preview driver

**Files:**
- Modify: `kiosk/src/backend/config/schema.ts` (in the `display` object, directly after the `glass: z.object({...}).default({}),` block)
- Modify: `kiosk/src/backend/server.ts` (directly after the `/api/test/alert` route block)
- Modify: `docs/API.md` (the row after `/api/test/alert`)
- Test: `kiosk/test/schema.test.ts`, `kiosk/test/testTxRoute.test.ts`

**Interfaces:**
- Produces:
  - config `display.camera.follow: boolean` (default `false`);
  - `POST /api/test/tx { channelId?: string; holdMs?: number; lat?: number; lon?: number }`, returning `200 { ok: true, channelId, holdMs }`, or `404` if there is no located channel.
- Route behaviour:
  - broadcasts `active` and `audible{channel}` immediately;
  - broadcasts `signal` every 400 ms;
  - broadcasts `release` and `audible{null}` after `holdMs` (default 6000, clamped to 1000–60000);
  - a numeric `lat`+`lon` overrides the broadcast channel's location, so a test can place a site off-frame;
  - with no `channelId`, it picks a random enabled located channel.

- [ ] **Step 1: Write the failing tests**

Append to `kiosk/test/schema.test.ts`:
```ts
describe("display.camera", () => {
  const base = () => ({ ...defaultConfig(), display: { weatherLat: 39.1, weatherLon: -94.58 } });
  it("defaults to a fixed stage (follow off)", () => {
    expect(configSchema.parse(base()).display!.camera).toEqual({ follow: false });
  });
  it("accepts follow: true", () => {
    expect(configSchema.parse({ ...base(), display: { ...base().display, camera: { follow: true } } }).display!.camera.follow).toBe(true);
  });
});
```
If `defaultConfig` or `configSchema` aren't already imported at the top of that file, add them to the existing import from `../src/backend/config/schema.js`.

Create `kiosk/test/testTxRoute.test.ts`:
```ts
import { describe, it, expect, afterEach } from "vitest";
import request from "supertest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../src/backend/server.js";
import { ConfigStore } from "../src/backend/config/ConfigStore.js";
import { ActivityLog } from "../src/backend/activityLog.js";
import { WsHub } from "../src/backend/ws.js";
import { FakeEngine } from "../src/backend/engine/FakeEngine.js";
import { defaultConfig } from "../src/backend/config/schema.js";
import type { EngineEvent } from "../src/backend/engine/ScannerEngine.js";

let dir: string;
function makeApp() {
  dir = mkdtempSync(join(tmpdir(), "ktx-"));
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify({
    ...defaultConfig(),
    channels: [
      { id: "loc", freq: 462_550_000, alphaTag: "Located", mode: "nfm", enabled: true, location: { lat: 39.1, lon: -94.5, source: "manual" } },
      { id: "noloc", freq: 462_575_000, alphaTag: "Nowhere", mode: "nfm", enabled: true },
    ],
  }));
  const wsHub = new WsHub();
  const sent: EngineEvent[] = [];
  const real = wsHub.broadcast.bind(wsHub);
  wsHub.broadcast = (e: EngineEvent) => { sent.push(e); real(e); };
  const { server } = createServer({ configStore: new ConfigStore(path), engine: new FakeEngine(), activityLog: new ActivityLog(100), wsHub, staticDir: dir });
  return { server, sent };
}
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("POST /api/test/tx", () => {
  it("plays active → audible → signal… → release → audible(null) for a located channel", async () => {
    // Real timers (fake ones stall supertest's sockets); holdMs clamps to >= 1000.
    const { server, sent } = makeApp();
    const res = await request(server).post("/api/test/tx").send({ channelId: "loc", holdMs: 1000 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, channelId: "loc", holdMs: 1000 });
    expect(sent.slice(0, 2).map((e) => e.type)).toEqual(["active", "audible"]);
    await new Promise((r) => setTimeout(r, 1150));
    const types = sent.map((e) => e.type);
    expect(types.filter((t) => t === "signal").length).toBeGreaterThanOrEqual(2);
    expect(types.slice(-2)).toEqual(["release", "audible"]);
    const last = sent.at(-1) as Extract<EngineEvent, { type: "audible" }>;
    expect(last.channel).toBeNull();
  });

  it("lat/lon override the broadcast location (off-frame previews)", async () => {
    const { server, sent } = makeApp();
    await request(server).post("/api/test/tx").send({ channelId: "loc", holdMs: 1000, lat: 39.9, lon: -94.4 }).expect(200);
    const active = sent[0] as Extract<EngineEvent, { type: "active" }>;
    expect(active.channel.location).toMatchObject({ lat: 39.9, lon: -94.4 });
    const audible = sent[1] as Extract<EngineEvent, { type: "audible" }>;
    expect(audible.channel?.location).toMatchObject({ lat: 39.9, lon: -94.4 });
  });

  it("404 for an unknown or unlocated channel", async () => {
    const { server } = makeApp();
    expect((await request(server).post("/api/test/tx").send({ channelId: "noloc" })).status).toBe(404);
    expect((await request(server).post("/api/test/tx").send({ channelId: "zzz" })).status).toBe(404);
  });

  it("no channelId picks a located channel; holdMs is clamped", async () => {
    const { server } = makeApp();
    const res = await request(server).post("/api/test/tx").send({ holdMs: 999_999 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, channelId: "loc", holdMs: 60_000 });
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run test/schema.test.ts test/testTxRoute.test.ts`
Expected: FAIL. `display.camera` is undefined, and the route falls through.

If `testTxRoute` fails on construction instead (because `createServer` requires deps this fixture doesn't pass), copy the minimal deps object from `test/api.test.ts`'s own server factory. The assertions stay as written.

- [ ] **Step 3: Implement the schema**

In `kiosk/src/backend/config/schema.ts`, directly after the `glass: z.object({ ... }).default({}),` block inside `display`, add:
```ts
    // Kiosk camera (spec 2026-10-02 "fixed stage"): the wall frames once and
    // never moves on its own — camera moves made Google re-lay-out the vector
    // map on CPU at every hit. follow: true restores the old push toward the
    // audible site + pull-back (escape hatch). Applies on kiosk/reload.
    camera: z.object({
      follow: z.boolean().default(false),
    }).default({}),
```
Also change the radar `spanDeg` comment line `// cover the home framing plus the camera push.` to `// cover the home framing (plus the push, if display.camera.follow is on).`

- [ ] **Step 4: Implement the route**

In `kiosk/src/backend/server.ts`, directly after the `/api/test/alert` route block, add:
```ts
    // Wall preview driver: play a synthetic transmission on a located channel
    // through the WS only — no engine, no audio, no history — so the operator
    // can watch the passive wall (CLAUDE.md "Previewing wall states"). lat/lon
    // override the broadcast location so a test can place a site off-frame.
    if (method === "POST" && path === "/api/test/tx") {
      const body = await readBody(req).catch(() => undefined);
      const located = config.channels.filter((c) => c.enabled && c.location?.lat != null && c.location.lon != null);
      const found = typeof body?.channelId === "string"
        ? located.find((c) => c.id === body.channelId)
        : located[Math.floor(Math.random() * located.length)];
      if (!found) return json(res, 404, { error: "no such located channel" });
      const lat = Number(body?.lat), lon = Number(body?.lon);
      const ch = Number.isFinite(lat) && Number.isFinite(lon)
        ? { ...found, location: { ...found.location!, lat, lon } }
        : found;
      const holdRaw = Number(body?.holdMs);
      const holdMs = Math.min(60_000, Math.max(1_000, Number.isFinite(holdRaw) ? holdRaw : 6_000));
      const t0 = Date.now();
      deps.wsHub.broadcast({ type: "active", channel: ch, freq: ch.freq, ts: t0 });
      deps.wsHub.broadcast({ type: "audible", channel: ch, ts: t0 });
      let n = 0;
      const sig = setInterval(() => {
        deps.wsHub.broadcast({ type: "signal", dbfs: -30 + 15 * Math.sin(n++ / 2), ts: Date.now() });
      }, 400);
      sig.unref?.();
      const end = setTimeout(() => {
        clearInterval(sig);
        deps.wsHub.broadcast({ type: "release", channelId: ch.id, ts: Date.now() });
        deps.wsHub.broadcast({ type: "audible", channel: null, ts: Date.now() });
      }, holdMs);
      end.unref?.();
      return json(res, 200, { ok: true, channelId: ch.id, holdMs });
    }
```
If `config` isn't the in-scope name for the current config at that spot, use the same accessor the `/api/test/alert` block uses. If the `EngineEvent` shapes for `active`, `audible`, `signal` or `release` differ from these literals, match `src/backend/engine/ScannerEngine.ts`: `npm run typecheck` will name the mismatch.

In `docs/API.md`, add a row after `/api/test/alert`:
```markdown
| POST | `/api/test/tx` | Wall preview: play a synthetic transmission (`active` → `audible` → `signal`… → `release` → `audible(null)`) on a located channel over the WS only — no engine/audio/history. `{ channelId?, holdMs?, lat?, lon? }` (random located channel; hold 6000 ms, clamped 1000–60000; `lat`/`lon` override the broadcast location) → `{ ok, channelId, holdMs }`; `404` if none. |
```

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `npx vitest run test/schema.test.ts test/testTxRoute.test.ts && npm run typecheck`
Expected: PASS, and typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add src/backend/config/schema.ts src/backend/server.ts test/schema.test.ts test/testTxRoute.test.ts ../docs/API.md
git commit -m "feat(stage): display.camera.follow knob + POST /api/test/tx preview driver

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 3: Fixed stage in `map.ts`, with the bloom and CSS

**Files:**
- Modify: `kiosk/src/frontend/map/map.ts`
- Modify: `kiosk/src/frontend/map/map.css`

**Interfaces:**
- Consumes: `padRect`, `outside`, `edgeExit`, `lngLatToViewPx` and `BLOOM_PX` (Task 1); `display.camera.follow` (Task 2).
- Produces, inside `start()`, for PR B to reuse:
  - `liveCount(): number` (open transmissions);
  - `onQuiet(): void` (called from the WS `idle` handler);
  - `bloomToward(lat, lng, color): boolean`.

There's no new unit test here: `map.ts` is DOM and Google glue. Its pure parts were tested in Task 1. Proof is on the wall (Task 4).

- [ ] **Step 1: Import the helpers**

Add to `map.ts`'s imports:
```ts
import { padRect, outside, edgeExit, lngLatToViewPx, BLOOM_PX } from "./stage.js";
```

- [ ] **Step 2: Add the bloom element and `bloomToward`**

Directly after the `glowEdges` function (the block that creates `.edgeGlow`), add:
```ts
    // Off-frame speaker (spec 2026-10-02): a soft bloom on the screen edge
    // where the line from the frame's centre toward the site leaves the screen.
    // Opacity-only animation (compositor), 480 px — not a full-screen overlay.
    const bloom = document.createElement("div");
    bloom.className = "edgeBloom";
    root.appendChild(bloom);
    function bloomToward(lat: number, lng: number, color: string): boolean {
      const b = map.getBounds();
      if (!b) return false;
      const ne = b.getNorthEast(), sw = b.getSouthWest();
      const W = root.clientWidth, H = root.clientHeight;
      const p = lngLatToViewPx(lat, lng, { n: ne.lat(), s: sw.lat(), e: ne.lng(), w: sw.lng() }, W, H);
      const inner = padRect(W, H, KIOSK_FIT_PAD);
      if (!outside(p, inner)) return false;
      const c = { x: (inner.left + inner.right) / 2, y: (inner.top + inner.bottom) / 2 };
      const at = edgeExit(c, p, { left: 0, top: 0, right: W, bottom: H });
      bloom.style.setProperty("--glow-color", color);
      bloom.style.transform = `translate(${Math.round(at.x - BLOOM_PX / 2)}px, ${Math.round(at.y - BLOOM_PX / 2)}px)`;
      bloom.classList.remove("pulse");
      void bloom.offsetWidth; // restart the animation every hit
      bloom.classList.add("pulse");
      return true;
    }
```

- [ ] **Step 3: Add `liveCount` and gate the camera**

1. Directly after `const liveTx = new Map<...>();`, add:
```ts
    const liveCount = (): number => liveTx.size; // open transmissions (re-fit deferral)
```
2. Replace the whole activity-camera block, from the comment `// ── Activity camera (kiosk only)` through the end of the `if (!interactive) { setInterval(...) }` block, with:
```ts
    // ── Camera (spec 2026-10-02 "fixed stage"): the kiosk frames once and
    // never moves on its own — each push made Google re-lay-out the vector map
    // on the CPU. Who/where is carried by the pin, the transmission, the LCD
    // and (off-frame) the edge bloom. display.camera.follow restores the old
    // push toward the audible site + pull-back. /map never moves itself.
    const follow = !interactive && display.camera.follow;
    const PUNCH_HOLD_MS = 12_000;   // follow mode: quiet time before pulling back out
    const PUNCH_ZOOM_IN = 2;        // follow mode: levels closer than the home framing
    let homeZoom: number | null = null;
    let punchedUntil = 0;
    function punch(lat: number, lng: number): void {
      if (!follow) return;
      punchedUntil = Date.now() + PUNCH_HOLD_MS;
      map.panTo({ lat, lng });
      map.setZoom(Math.min((homeZoom ?? map.getZoom()) + PUNCH_ZOOM_IN, 13));
    }
    if (follow) {
      setInterval(() => {
        if (punchedUntil && Date.now() >= punchedUntil) {
          punchedUntil = 0;
          map.fitBounds(framedBounds(), fitPad);
        }
      }, 1500);
    }
    // Fixed stage: re-fit only when the screen resizes (sites and channels load
    // once per page; a newly located site joins the frame on the next
    // kiosk/reload). Never mid-transmission: deferred to the next idle.
    let refitDue = false;
    function refit(): void {
      if (liveCount() > 0) { refitDue = true; return; }
      refitDue = false;
      map.fitBounds(framedBounds(), fitPad);
    }
    function onQuiet(): void { if (refitDue) refit(); }
    if (!interactive && !follow) {
      let t: ReturnType<typeof setTimeout> | undefined;
      window.addEventListener("resize", () => { clearTimeout(t); t = setTimeout(refit, 500); });
    }
```
The existing initial fit (`void Promise.allSettled([...]).then(() => { map.fitBounds(...); ... homeZoom ... })`) stays exactly as it is: it runs before this block, and `homeZoom` is declared here with `let`. **If the existing initial-fit code sits above this block and references `homeZoom`, move the `let homeZoom` declaration up beside `fitPad`** so it's declared before use. `npm run typecheck` flags a use-before-declare.

- [ ] **Step 4: Rewire the WS `idle` and `audible` handlers**

In the WS handler:
- `idle` branch: after the existing loop that ends the rings, add `onQuiet();`.
- `audible` branch: replace its body with:
```ts
        // Camera follows AUDIO only in follow mode. On the fixed stage an
        // audible site outside the padded frame blooms the edge toward it.
        const ch = ev.channel;
        audibleId = ch?.id ?? null; // drives the signal-driven ring re-arm above
        if (ch?.location?.lat != null && ch.location.lon != null) {
          if (follow) punch(ch.location.lat, ch.location.lon);
          else if (!interactive) bloomToward(ch.location.lat, ch.location.lon, colorFor(ch.freq, "active", tagsFor(ch.freq)));
        }
```
If `ch.freq` isn't a field on the `audible` channel type, use the same frequency expression the `active` branch uses for `colorFor`.

- [ ] **Step 5: CSS**

In `kiosk/src/frontend/map/map.css`, directly after the `@keyframes edgeGlowPulse { ... }` block, add:
```css
/* Off-frame speaker bloom (spec 2026-10-02): 480 px (= BLOOM_PX in stage.ts),
   positioned by transform at the edge exit point, half off-screen. Reuses the
   edge-glow pulse: opacity only, so the compositor does all the work. */
:is(html[data-page="map"], html[data-page="dashboard"]) .edgeBloom {
  position: fixed; left: 0; top: 0; width: 480px; height: 480px;
  pointer-events: none; z-index: 2; opacity: 0; border-radius: 50%;
  background: radial-gradient(closest-side, var(--glow-color), transparent);
}
:is(html[data-page="map"], html[data-page="dashboard"]) .edgeBloom.pulse { animation: edgeGlowPulse 7s ease-out; }
```

- [ ] **Step 6: Test and typecheck**

Run: `npm test && npm run typecheck`
Expected: all pass, clean.

- [ ] **Step 7: Commit**

```bash
git add src/frontend/map/map.ts src/frontend/map/map.css
git commit -m "feat(stage): kiosk camera holds still; off-frame speakers bloom the edge toward them

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 4: Ship PR A (prove it on the wall)

- [ ] **Step 1: Thermal baseline before deploying** (the camera still pushes)

Run with `run_in_background: true`:
```bash
for i in $(seq 20); do curl -s localhost:8080/api/system | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const n=JSON.parse(s).now;console.log(n.tempC,n.cpuPct)})'; sleep 30; done | awk '{t+=$1;c+=$2;n++} END{printf "BEFORE tempC=%.1f cpuPct=%.1f n=%d\n",t/n,c/n,n}' > /tmp/claude-1000/stage-before.txt; for i in 1 2 3 4 5 6; do top -b -d 10 -n 2 | awk '/^top/{n++} n==2 && /chrome/{s+=$9} END{printf "%s ", s}'; done >> /tmp/claude-1000/stage-before.txt
```
Wait for it to finish before building: a build is a CPU spike.

- [ ] **Step 2: Definition-of-done checks**

Run: `npm test && npm run test:native && npm run typecheck && npm run build`
Expected: all pass.

- [ ] **Step 3: Deploy** (the schema and route are backend)

```bash
sudo systemctl restart kerchunk-kiosk
until curl -sf localhost:8080/api/status >/dev/null; do sleep 1; done
curl -X POST localhost:8080/api/kiosk/reload
```
Then check `curl -s localhost:8080/api/config | grep -o '"camera":{[^}]*}'`.
Expected: `"camera":{"follow":false}`.

Also check `"hazeIntensity":0`. If haze reads anything else, set it to 0 via `PUT /api/config` before going on: haze above 0 is a known 90 °C path.

- [ ] **Step 4: Prove the stage holds and the bloom points the right way**

Get home with `curl -s localhost:8080/api/config | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const d=JSON.parse(s).display;console.log(d.weatherLat,d.weatherLon)})'`, then:
- **(a) Off-frame north.** Home is the top edge of the frame, so a site 0.5° north is always off-frame:
```bash
curl -s -X POST localhost:8080/api/test/tx -H 'content-type: application/json' -d "{\"holdMs\":8000,\"lat\":$(echo "$HLAT + 0.5" | bc),\"lon\":$HLON}"
```
  Capture 0.4 s, 1 s and 3 s after it, using `grim` with distinct file names. Expected: a bloom centred near the top edge, roughly above home's x, fading over 7 s. The camera does not move.
- **(b) Off-frame east:** the same with `lat=$HLAT-0.3`, `lon=$HLON+1.5`. Expected: a bloom on the right edge.
- **(c) On-frame:** `{"holdMs":8000}` with no lat/lon (a random real site). Expected: the ring at the pin, no bloom, no camera move.
- **(d) Deferred re-fit:** during a hold, run `sudo systemctl restart kerchunk-display`. That's a full reload, not a resize, so this only checks that the page comes back framed identically. True resize events don't happen on the kiosk; the deferral is covered by code review of `refit()`.
- **(e) Ten minutes of the live band:** take a screenshot at the start and at the end, and compare the framing. Expected: identical framing.

Read each PNG. If the bloom lands on the wrong edge, check the `lngLatToViewPx` y sign against `map.getBounds()`.

- [ ] **Step 5: Thermal after**

Same loop as Step 1, into `/tmp/claude-1000/stage-after.txt`, while traffic is normal. Report both files' numbers in the PR. Expected: chromium's busy-band samples drop below the "before" spread. If they don't, say so plainly.

- [ ] **Step 6: Push, open the PR, merge, clean up**

```bash
git push -u origin feat/fixed-stage
gh pr create --title "feat(stage): fixed camera on the kiosk — edge bloom for off-frame speakers" --body "$(cat <<'EOF'
Spec: docs/superpowers/specs/2026-10-02-fixed-stage-event-pacing-design.md (PR A).

- The kiosk camera frames once and never moves on its own (every push made Google re-lay-out the vector map on CPU at each hit). Re-fit only on resize, deferred while a transmission is live.
- An audible site outside the padded frame blooms the screen edge toward it (480 px, opacity-only). Unlocated speakers keep the whole-edge glow.
- POST /api/test/tx: WS-only synthetic transmission; lat/lon override for off-frame previews.

Knob: `display.camera.follow` (default false) in src/backend/config/schema.ts restores the old push/pull-back. Apply via PUT /api/config + POST /api/kiosk/reload.

Proof: <bloom screenshots per direction, 10-min framing check, thermal before/after with chromium samples>

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
gh pr checks <n> --watch
gh pr merge <n> --merge --delete-branch && git checkout main && git pull --ff-only && git fetch --prune && git branch -d feat/fixed-stage
```
On this appliance's flaky Wi-Fi, `gh` calls can time out. Re-run them, and confirm with `gh pr view <n> --json state`.

---

## PR B: Glass transmissions with event pacing

Start: `git checkout main && git pull --ff-only && git checkout -b feat/glass-transmissions`

### Task 5: `glassState`, the lifecycle plus the pacing hint

**Files:**
- Modify: `kiosk/src/frontend/map/glassMath.ts` (`GlassFrame`, `EMPTY_FRAME`)
- Create: `kiosk/src/frontend/map/glassState.ts`
- Test: `kiosk/test/glassState.test.ts`

**Interfaces:**
- Consumes: `Rgb`, `Front`, `Glow`, `MAX_FRONTS`, `MAX_GLOWS`, `easeOutCubic` and `fadeProgress` from `glassMath.ts`.
- Produces:
```ts
// glassMath.ts
export interface GlassFrame {
  fronts: Front[]; glows: Glow[];
  growing: boolean;              // a front is in its grow → txFps
  continuous: boolean;           // growing or dissolving → redraw every frame
  nextChangeAt: number | null;   // Date.now()-ms of the next visible change; null = never on its own
}
// glassState.ts
export interface GlassSite { key: string; lat: number; lng: number; color: Rgb }
export interface GlassTimings {
  growMs: number; releaseMs: number; glowLifetimeMs: number; ttlMs: number;
  holdFps: number; signalSteps: number; fadeSteps: number;
}
export const RELEASE_MS = 1500;
export const SIGNAL_FLOOR_DBFS = -45;
export const SIGNAL_CEIL_DBFS = -10;
export const MIN_BRIGHT = 0.15;
export const DEFAULT_BRIGHT = 0.6;
export function rampStrength(hits: number): number;          // 0.5 + 0.5*min(hits,6)/6
export function signalLevel(dbfs: number, steps: number): number;
export function fadeLevel(ageMs: number, lifeMs: number, steps: number): number;
export class GlassState {
  constructor(t: GlassTimings);
  keyUp(id: string, site: GlassSite, radiusM: number, now: number): void;
  rearm(id: string, now: number): void;
  signal(id: string, dbfs: number, now: number): boolean;     // true = brightness changed now → redraw
  release(id: string, now: number): void;
  releaseAll(now: number): void;
  seedGlow(site: GlassSite, radiusM: number, ts: number, now: number): void;
  hits(key: string): number;
  liveCount(): number;
  frame(now: number): GlassFrame;
}
```

- [ ] **Step 1: Extend `GlassFrame`**

In `kiosk/src/frontend/map/glassMath.ts`, replace the `GlassFrame` interface and `EMPTY_FRAME` with:
```ts
export interface GlassFrame {
  fronts: Front[]; glows: Glow[];
  /** A front is in its grow phase: pace at txFps. */
  growing: boolean;
  /** Something moves every frame (a grow or a release dissolve). */
  continuous: boolean;
  /** Date.now() ms of the next VISIBLE change if no event arrives (a fade
   *  step, a rate-limited signal step, a ttl expiry); null = never. */
  nextChangeAt: number | null;
}

export const EMPTY_FRAME: GlassFrame = Object.freeze({ fronts: [], glows: [], growing: false, continuous: false, nextChangeAt: null }) as GlassFrame;
```

- [ ] **Step 2: Write the failing tests**

`kiosk/test/glassState.test.ts`:
```ts
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
```

- [ ] **Step 3: Run the tests and confirm they fail**

Run: `npx vitest run test/glassState.test.ts`
Expected: FAIL, because the module can't be resolved.

- [ ] **Step 4: Implement**

`kiosk/src/frontend/map/glassState.ts`:
```ts
// Pure transmission/afterglow lifecycle for Weather Glass, event-paced
// (spec 2026-10-02). key-up → eased grow → STILL hold (brightness follows the
// audible channel's signal, quantised + rate-limited) → release dissolves the
// rim over RELEASE_MS while the site's afterglow fades in fadeSteps steps.
// Every frame also says how it will change (continuous / nextChangeAt) so the
// layer redraws only when something visibly moves. Replaces BlipField + txRing.
import {
  MAX_FRONTS, MAX_GLOWS, easeOutCubic, fadeProgress,
  type Rgb, type Front, type Glow, type GlassFrame,
} from "./glassMath.js";

export interface GlassSite { key: string; lat: number; lng: number; color: Rgb }
export interface GlassTimings {
  growMs: number; releaseMs: number; glowLifetimeMs: number; ttlMs: number;
  /** Max held-rim brightness steps per second (display.glass.holdFps). */
  holdFps: number;
  /** Brightness levels for a held rim (display.glass.signalSteps). */
  signalSteps: number;
  /** Visible steps across an afterglow's life (display.glass.fadeSteps). */
  fadeSteps: number;
}

export const RELEASE_MS = 1500;
// Rim brightness window for the audible channel's `signal` telemetry.
export const SIGNAL_FLOOR_DBFS = -45;
export const SIGNAL_CEIL_DBFS = -10;
export const MIN_BRIGHT = 0.15;
export const DEFAULT_BRIGHT = 0.6;   // open channels without signal telemetry

/** Afterglow weight by hits in the window — the old blip ramp's 1..6 cap. */
export function rampStrength(hits: number): number {
  return 0.5 + (0.5 * Math.min(Math.max(hits, 0), 6)) / 6;
}

/** dBFS → one of `steps` brightness levels over the window, floored at MIN_BRIGHT. */
export function signalLevel(dbfs: number, steps: number): number {
  const k = Math.min(1, Math.max(0, (dbfs - SIGNAL_FLOOR_DBFS) / (SIGNAL_CEIL_DBFS - SIGNAL_FLOOR_DBFS)));
  const n = Math.max(1, steps - 1);
  return Math.max(MIN_BRIGHT, Math.round(k * n) / n);
}

/** Remaining afterglow, quantised: 1 until the first boundary, then one step
 *  down at each ageMs = life*j/steps, 0 at the end. */
export function fadeLevel(ageMs: number, lifeMs: number, steps: number): number {
  if (ageMs >= lifeMs) return 0;
  return Math.ceil((1 - Math.max(0, ageMs) / lifeMs) * steps - 1e-9) / steps;
}

/** The first fade boundary strictly after `now` for a glow started at `start`. */
function nextFadeBoundary(start: number, now: number, lifeMs: number, steps: number): number {
  const stepMs = lifeMs / steps;
  let j = Math.floor((now - start) / stepMs) + 1;
  let t = start + j * stepMs;
  while (t <= now) t = start + ++j * stepMs;   // float guard: never at/before now
  return t;
}

interface LiveFront {
  id: string; site: GlassSite; radiusM: number; born: number; until: number;
  bright: number; brightAt: number; pending: number | null; releasedAt: number | null;
}
interface SiteState { site: GlassSite; radiusM: number; hits: number; glowStart: number | null }

export class GlassState {
  private readonly fronts = new Map<string, LiveFront>();
  private readonly sites = new Map<string, SiteState>();
  private readonly gapMs: number;

  constructor(private readonly t: GlassTimings) {
    this.gapMs = 1000 / Math.max(1, t.holdFps);
  }

  keyUp(id: string, site: GlassSite, radiusM: number, now: number): void {
    const existing = this.fronts.get(id);
    if (existing && existing.releasedAt === null) { existing.until = now + this.t.ttlMs; return; }
    this.fronts.set(id, {
      id, site, radiusM, born: now, until: now + this.t.ttlMs,
      bright: DEFAULT_BRIGHT, brightAt: -Infinity, pending: null, releasedAt: null,
    });
    const s = this.sites.get(site.key);
    if (s) { s.hits++; s.radiusM = radiusM; s.site = site; }
    else this.sites.set(site.key, { site, radiusM, hits: 1, glowStart: null });
    if (this.fronts.size > MAX_FRONTS) {
      const oldest = [...this.fronts.values()].sort((a, b) => a.born - b.born)[0];
      if (oldest) this.fronts.delete(oldest.id);
    }
  }

  rearm(id: string, now: number): void {
    const f = this.fronts.get(id);
    if (f && f.releasedAt === null) f.until = now + this.t.ttlMs;
  }

  /** Returns true when the visible brightness changed NOW (caller redraws).
   *  A change inside the holdFps window is parked; frame() applies it at the
   *  window's end and reports that moment as nextChangeAt. */
  signal(id: string, dbfs: number, now: number): boolean {
    const f = this.fronts.get(id);
    if (!f || f.releasedAt !== null) return false;
    const lvl = signalLevel(dbfs, this.t.signalSteps);
    if (lvl === f.bright) { f.pending = null; return false; }
    if (now - f.brightAt >= this.gapMs) {
      f.bright = lvl; f.brightAt = now; f.pending = null;
      return true;
    }
    f.pending = lvl;
    return false;
  }

  release(id: string, now: number): void {
    const f = this.fronts.get(id);
    if (!f || f.releasedAt !== null) return;
    f.releasedAt = now;
    f.pending = null;
    const s = this.sites.get(f.site.key);
    if (s) s.glowStart = now;
  }

  releaseAll(now: number): void {
    for (const id of this.fronts.keys()) this.release(id, now);
  }

  seedGlow(site: GlassSite, radiusM: number, ts: number, now: number): void {
    if (now - ts >= this.t.glowLifetimeMs) return;
    const s = this.sites.get(site.key);
    if (s) { s.hits++; s.glowStart = Math.max(s.glowStart ?? ts, ts); s.radiusM = radiusM; }
    else this.sites.set(site.key, { site, radiusM, hits: 1, glowStart: ts });
  }

  hits(key: string): number {
    return this.sites.get(key)?.hits ?? 0;
  }

  /** Open (unreleased) transmissions. */
  liveCount(): number {
    let n = 0;
    for (const f of this.fronts.values()) if (f.releasedAt === null) n++;
    return n;
  }

  frame(now: number): GlassFrame {
    const fronts: Front[] = [];
    let growing = false, continuous = false;
    let next = Infinity;
    for (const f of [...this.fronts.values()]) {
      if (f.releasedAt === null && now >= f.until) this.release(f.id, f.until);   // a missed release
      if (f.pending !== null && now >= f.brightAt + this.gapMs) {
        f.bright = f.pending; f.brightAt = now; f.pending = null;
      }
      const releasing = f.releasedAt === null ? 0 : fadeProgress(f.releasedAt, now, this.t.releaseMs);
      if (releasing >= 1) { this.fronts.delete(f.id); continue; }
      const p = fadeProgress(f.born, now, this.t.growMs);
      if (p < 1) { growing = true; continuous = true; }
      if (f.releasedAt !== null) continuous = true;                       // dissolving
      if (f.releasedAt === null) {
        next = Math.min(next, f.until);
        if (f.pending !== null) next = Math.min(next, f.brightAt + this.gapMs);
      }
      fronts.push({
        id: f.id, key: f.site.key, lat: f.site.lat, lng: f.site.lng, radiusM: f.radiusM, color: f.site.color,
        ageMs: now - f.born, grow: easeOutCubic(p), bright: f.bright, releasing,
      });
    }
    const liveKeys = new Set([...this.fronts.values()].map((f) => f.site.key));
    const glows: Glow[] = [];
    const life = this.t.glowLifetimeMs;
    for (const [key, s] of this.sites) {
      if (s.glowStart !== null && now - s.glowStart >= life) s.glowStart = null;
      if (s.glowStart === null) {
        if (!liveKeys.has(key)) this.sites.delete(key);   // window over: hits reset
        continue;
      }
      glows.push({
        key, lat: s.site.lat, lng: s.site.lng, radiusM: s.radiusM, color: s.site.color,
        strength: rampStrength(s.hits) * fadeLevel(now - s.glowStart, life, this.t.fadeSteps),
      });
      next = Math.min(next, nextFadeBoundary(s.glowStart, now, life, this.t.fadeSteps));
    }
    glows.sort((a, b) => b.strength - a.strength);
    return {
      fronts, glows: glows.slice(0, MAX_GLOWS), growing, continuous,
      nextChangeAt: Number.isFinite(next) ? next : null,
    };
  }
}
```

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `npx vitest run test/glassState.test.ts && npm run typecheck`
Expected: PASS (18 tests), and typecheck clean. `EMPTY_FRAME` users still compile, because the new fields are in the literal.

If "release dissolves continuously" fails on `after.nextChangeAt`: the glow started at the release (10 000), so its first boundary is 10 000 + 2500. Check that `release()` sets `glowStart = now`.

- [ ] **Step 6: Commit**

```bash
git add src/frontend/map/glassMath.ts src/frontend/map/glassState.ts test/glassState.test.ts
git commit -m "feat(glass): glassState — fronts, still hold, stepped afterglows, and a pacing hint

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 6: Event-paced `GlassLayer`, the still-rim shader and the pacing knobs

**Files:**
- Modify: `kiosk/src/frontend/map/glassMath.ts` (add `paceDelay`, `MIN_STEP_MS`)
- Modify: `kiosk/src/frontend/map/glassLayer.ts` (`GlassKnobs`, the scheduler, `poke()`, the redraw counter)
- Modify: `kiosk/src/frontend/map/glassShaders.ts` (remove the breathing)
- Modify: `kiosk/src/backend/config/schema.ts` (`display.glass.holdFps`, `signalSteps`, `fadeSteps`)
- Test: `kiosk/test/glassMath.test.ts` (or the existing glassMath test file; `ls test | grep -i glass`), `kiosk/test/glassLayer.test.ts`, `kiosk/test/schema.test.ts`

**Interfaces:**
- Consumes: `GlassFrame` with `continuous` and `nextChangeAt` (Task 5).
- Produces:
```ts
// glassMath.ts
export const MIN_STEP_MS = 16;
export function paceDelay(f: GlassFrame, now: number, o: { haze: boolean; radarFading: boolean; maxFps: number; txFps: number }): number | null;
// glassLayer.ts
export interface GlassKnobs { maxFps; txFps; hazeIntensity; radarOpacity; radarMinDbz; radarFadeMs; txGrowMs; holdFps; signalSteps; fadeSteps }  // all number
class GlassLayer { poke(): void; takeRedraws(): number; /* existing API unchanged */ }
```

- [ ] **Step 1: Write the failing tests**

Find the glassMath test file: `ls test | grep -i glassmath`. If it doesn't exist, create `kiosk/test/glassPace.test.ts`. Add:
```ts
import { describe, it, expect } from "vitest";
import { paceDelay, MIN_STEP_MS, EMPTY_FRAME, type GlassFrame } from "../src/frontend/map/glassMath.js";

const O = { haze: false, radarFading: false, maxFps: 30, txFps: 60 };
const fr = (p: Partial<GlassFrame>): GlassFrame => ({ ...EMPTY_FRAME, ...p });

describe("paceDelay", () => {
  it("idle scene: no timer at all", () => {
    expect(paceDelay(EMPTY_FRAME, 0, O)).toBeNull();
  });
  it("continuous: maxFps; growing: txFps", () => {
    expect(paceDelay(fr({ continuous: true }), 0, O)).toBeCloseTo(1000 / 30, 9);
    expect(paceDelay(fr({ continuous: true, growing: true }), 0, O)).toBeCloseTo(1000 / 60, 9);
  });
  it("haze or a radar fade forces the steady rate", () => {
    expect(paceDelay(EMPTY_FRAME, 0, { ...O, haze: true })).toBeCloseTo(1000 / 30, 9);
    expect(paceDelay(EMPTY_FRAME, 0, { ...O, radarFading: true })).toBeCloseTo(1000 / 30, 9);
  });
  it("a scheduled change: one timer to that moment, floored at MIN_STEP_MS", () => {
    expect(paceDelay(fr({ nextChangeAt: 2500 }), 1000, O)).toBe(1500);
    expect(paceDelay(fr({ nextChangeAt: 1000 }), 1000, O)).toBe(MIN_STEP_MS);
    expect(paceDelay(fr({ nextChangeAt: 900 }), 1000, O)).toBe(MIN_STEP_MS);
  });
});
```
In `kiosk/test/glassLayer.test.ts`, change the `knobs` literal in the existing test to:
```ts
    const knobs = { maxFps: 30, txFps: 60, hazeIntensity: 0.35, radarOpacity: 0.6, radarMinDbz: 15, radarFadeMs: 20_000, txGrowMs: 900, holdFps: 4, signalSteps: 8, fadeSteps: 24 };
```
Then append a new `describe`:
```ts
describe("GlassLayer pacing", () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("a dropped redraw is retried by the 1 s fallback; poke() requests a redraw", () => {
    vi.useFakeTimers();
    const requestRedraw = vi.fn();
    vi.stubGlobal("google", { maps: { WebGLOverlayView: class { requestRedraw = requestRedraw; setMap = vi.fn(); } } });
    const knobs = { maxFps: 30, txFps: 60, hazeIntensity: 0, radarOpacity: 0.6, radarMinDbz: 15, radarFadeMs: 20_000, txGrowMs: 900, holdFps: 4, signalSteps: 8, fadeSteps: 24 };
    const layer = new GlassLayer({ map: {}, home: { lat: 39, lng: -94 }, knobs, getFrame: () => EMPTY_FRAME });
    requestRedraw.mockClear();
    vi.advanceTimersByTime(1000);                 // no draw ever came back: the kick retries
    expect(requestRedraw).toHaveBeenCalled();
    requestRedraw.mockClear();
    layer.poke();
    expect(requestRedraw).toHaveBeenCalledTimes(1);
    expect(layer.takeRedraws()).toBe(0);           // nothing drew (no GL in node)
  });
});
```
In `kiosk/test/schema.test.ts`, change the expected object in "fills the glass defaults" to:
```ts
    expect(configSchema.parse(base()).display!.glass).toEqual({
      maxFps: 30, txFps: 60, hazeIntensity: 0, radarOpacity: 0.6,
      radarMinDbz: 15, radarFadeMs: 20_000, txGrowMs: 900,
      holdFps: 4, signalSteps: 8, fadeSteps: 24,
    });
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run test/glassPace.test.ts test/glassLayer.test.ts test/schema.test.ts`
(Use the existing glassMath test filename if you added the tests there.)
Expected: FAIL: `paceDelay` is missing, `poke` and `takeRedraws` are missing, and the glass defaults differ.

- [ ] **Step 3: Implement `paceDelay`**

Append to `kiosk/src/frontend/map/glassMath.ts`:
```ts
/** Floor for any scheduled redraw delay: a boundary at/before now (float
 *  rounding) must never spin zero-delay timers. */
export const MIN_STEP_MS = 16;

/** How long until the glass layer must redraw, from the frame it just drew.
 *  null = nothing will change on its own (no timer; events poke the layer). */
export function paceDelay(
  f: GlassFrame, now: number,
  o: { haze: boolean; radarFading: boolean; maxFps: number; txFps: number },
): number | null {
  if (o.haze || o.radarFading || f.continuous) {
    return 1000 / Math.max(1, f.growing ? o.txFps : o.maxFps);
  }
  if (f.nextChangeAt === null) return null;
  return Math.max(MIN_STEP_MS, f.nextChangeAt - now);
}
```

- [ ] **Step 4: Implement the schema knobs**

In `kiosk/src/backend/config/schema.ts`, inside `glass: z.object({`, after `txGrowMs`, add:
```ts
      // Event pacing (spec 2026-10-02): the layer redraws only when its scene
      // visibly changes. A held rim's brightness moves in signalSteps levels at
      // most holdFps times a second; an afterglow fades in fadeSteps steps.
      holdFps: z.number().int().min(1).max(30).default(4),
      signalSteps: z.number().int().min(2).max(32).default(8),
      fadeSteps: z.number().int().min(4).max(120).default(24),
```

- [ ] **Step 5: Implement the layer scheduler**

In `kiosk/src/frontend/map/glassLayer.ts`:
1. Import `paceDelay` from `./glassMath.js`, alongside the existing imports.
2. Replace `GlassKnobs` with:
```ts
export interface GlassKnobs {
  maxFps: number; txFps: number; hazeIntensity: number; radarOpacity: number;
  radarMinDbz: number; radarFadeMs: number; txGrowMs: number;
  holdFps: number; signalSteps: number; fadeSteps: number;
}
```
3. Add the fields `private redraws = 0;` and the constant `const KICK_MS = 1000;` (module scope, with the comment `// Fallback: if Google drops a requested redraw, retry after this long.`).
4. Replace the whole `schedule()` method, and its comment block, with:
```ts
  // ── pacing (spec 2026-10-02): after every draw, the frame says when it will
  // next visibly change. Continuous (grow/dissolve/haze/radar fade) → fps
  // timer; a scheduled change → one timer to that moment; nothing → no timer.
  // Every armed timer re-arms a KICK_MS fallback, so a redraw Google drops
  // can't freeze a half-grown front.
  private arm(delayMs: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.off) return;
      this.ov.requestRedraw();
      this.arm(KICK_MS);
    }, delayMs);
  }

  private reschedule(): void {
    if (this.off) return;
    const f = this.lastFrame;
    if (!f) { this.arm(KICK_MS); return; }
    const delay = paceDelay(f, Date.now(), {
      haze: this.o.knobs.hazeIntensity > 0,
      radarFading: this.fade.fading(performance.now()),
      maxFps: this.o.knobs.maxFps, txFps: this.o.knobs.txFps,
    });
    if (delay === null) {
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
    } else this.arm(delay);
  }

  /** An event changed the scene (key-up, release, signal step, seed): draw now. */
  poke(): void {
    if (this.off) return;
    this.ov.requestRedraw();
    this.arm(KICK_MS);
  }

  /** Redraws since the last call (diag: glass redraws per minute). */
  takeRedraws(): number {
    const n = this.redraws;
    this.redraws = 0;
    return n;
  }
```
5. In the constructor, replace `this.schedule();` with `this.arm(KICK_MS);`.
6. `setRadar` and `setRadarStale` already call `this.ov.requestRedraw()`. Change both to call `this.poke()` instead.
7. In `draw()`: increment `this.redraws++;` right after the early-return guard. At the very end of `draw()`, after `restoreGl(gl, saved);`, add `this.reschedule();`.
8. Search for any remaining `schedule(` calls: `rg -n "schedule\(" src/frontend/map/glassLayer.ts` must show only `reschedule(`.

- [ ] **Step 6: Remove the breathing from the shader**

In `kiosk/src/frontend/map/glassShaders.ts`, in `FX_FS`:
- delete the line `float breathe = 0.8 + 0.2 * sin(uTime * 2.094 + a.w);          // ~3 s period`;
- change `float rim = exp(-pow((d - r) / w, 2.0)) * mix(1.4, breathe, b.x) * level;` to:
```glsl
    float rim = exp(-pow((d - r) / w, 2.0)) * mix(1.4, 0.9, b.x) * level;   // still hold (spec 2026-10-02)
```
Update the file's header comment wherever it mentions breathing: the hold is now still. `uTime` remains for the haze.

- [ ] **Step 7: Run the tests and confirm they pass**

Run: `npm test && npm run typecheck`
Expected: all pass, clean.

- [ ] **Step 8: Commit**

```bash
git add src/frontend/map/glassMath.ts src/frontend/map/glassLayer.ts src/frontend/map/glassShaders.ts src/backend/config/schema.ts test/
git commit -m "feat(glass): event-paced redraws (continuous / next change / none), still hold rim, pacing knobs

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 7: Replace both `Circle` systems with glass fronts, plus the redraw diag

**Files:**
- Modify: `kiosk/src/frontend/map/map.ts`
- Modify: `kiosk/src/frontend/map/blips.ts` (delete `BlipInput`, `Blip` and `BlipField`; keep `GeoPoint`, `syntheticPoint` and `coverageRadiusM`)
- Delete: `kiosk/src/frontend/map/txRing.ts`, `kiosk/test/txRing.test.ts`
- Modify: `kiosk/test/blips.test.ts` (delete the `BlipField` describe block and its import)
- Modify: `kiosk/src/backend/server.ts` (the `/api/kiosk/diag` pacing report)
- Test: `kiosk/test/api.test.ts` (the diag pacing report)

**Interfaces:**
- Consumes: `GlassState`, `GlassSite` and `RELEASE_MS` (Task 5); `GlassLayer.poke()` and `takeRedraws()` (Task 6); `hexToGlowRgb` (`glassMath.ts`); `liveCount`, `onQuiet` and `bloomToward` (Task 3).
- Produces: `POST /api/kiosk/diag { kind: "pacing", glassRedrawsPerMin: number }`, which logs `[kiosk] glass redraws=<n>/min`.

- [ ] **Step 1: Write the failing diag test**

In `kiosk/test/api.test.ts`, next to the existing `POST /api/kiosk/diag accepts a well-formed report and rejects junk` test, add:
```ts
  it("POST /api/kiosk/diag accepts a pacing report", async () => {
    const { server } = makeServer();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await request(server).post("/api/kiosk/diag").send({ kind: "pacing", glassRedrawsPerMin: 37.5 }).expect(200);
    expect(err.mock.calls.some(([m]) => String(m).includes("glass redraws=37.5/min"))).toBe(true);
    await request(server).post("/api/kiosk/diag").send({ kind: "pacing", glassRedrawsPerMin: "lots" }).expect(400);
    err.mockRestore();
  });
```
Use whatever server factory the neighbouring diag test uses in place of `makeServer()`, and add `vi` to the vitest import if it's missing.

Run: `npx vitest run test/api.test.ts -t "pacing report"`
Expected: FAIL with a 400, because the handler requires `renderingType`.

- [ ] **Step 2: Implement the diag pacing report**

In `kiosk/src/backend/server.ts`, at the top of the `/api/kiosk/diag` handler, right after `const num = ...`, add:
```ts
      if (b?.kind === "pacing") {
        // Event-paced glass (spec 2026-10-02): how often the wall really redraws.
        if (!num(b.glassRedrawsPerMin)) return json(res, 400, { error: "expected { kind: 'pacing', glassRedrawsPerMin }" });
        console.error(`[kiosk] glass redraws=${Math.round(b.glassRedrawsPerMin * 10) / 10}/min`);
        return json(res, 200, { ok: true });
      }
```
Run: `npx vitest run test/api.test.ts -t "kiosk/diag"`
Expected: PASS, both diag tests.

- [ ] **Step 3: Delete the dead modules**

```bash
git rm src/frontend/map/txRing.ts test/txRing.test.ts
```
In `src/frontend/map/blips.ts`, delete the `BlipInput` interface, the `Blip` interface and the `BlipField` class. Then replace the file's header comment with:
`// Geometry helpers for the activity map: synthetic placement for unlocated traffic and the FCC coverage-radius estimate.`
In `test/blips.test.ts`, remove `BlipField` from the import and delete its `describe` block.

- [ ] **Step 4: Rewire `map.ts`**

1. Imports:
   - remove `BlipField` from the `./blips.js` import (keep `coverageRadiusM`);
   - remove `import { heldTxRadius } from "./txRing.js";`;
   - remove `import { EMPTY_FRAME } from "./glassMath.js";`;
   - add:
```ts
import { GlassState, RELEASE_MS, type GlassSite } from "./glassState.js";
import { hexToGlowRgb } from "./glassMath.js";
```
2. Move `const TX_TTL_MS = 60_000;` and its two-line comment out of `start()` up to module scope, beside `BLIP_LIFETIME_MS`.
3. In the Weather Glass block, replace the `const glass = mapId ? new GlassLayer({ ..., getFrame: () => EMPTY_FRAME }) : null;` statement with:
```ts
    const glassState = new GlassState({
      growMs: display.glass.txGrowMs, releaseMs: RELEASE_MS,
      glowLifetimeMs: BLIP_LIFETIME_MS, ttlMs: TX_TTL_MS,
      holdFps: display.glass.holdFps, signalSteps: display.glass.signalSteps, fadeSteps: display.glass.fadeSteps,
    });
    const glass = mapId
      ? new GlassLayer({ map, home, knobs: display.glass, getFrame: (now) => glassState.frame(now) })
      : null;
    const poke = (): void => { if (glass && !glass.off) glass.poke(); };
    // How often the wall really redraws (spec 2026-10-02 proof): one journal
    // line every PACING_REPORT_MS on the kiosk.
    const PACING_REPORT_MS = 5 * 60_000;
    if (!interactive && glass) {
      setInterval(() => {
        if (glass.off) return;
        const perMin = glass.takeRedraws() / (PACING_REPORT_MS / 60_000);
        void fetch("/api/kiosk/diag", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "pacing", glassRedrawsPerMin: perMin }) })
          .catch(() => { /* best-effort */ });
      }, PACING_REPORT_MS);
    }
```
4. Delete all of the following:
   - `const field = new BlipField(...)`;
   - the `circles` map and its comment;
   - `TX_GROW_MS`, `GROW_FRAME_DELAY_MS` and their comments;
   - `liveTx`, `txRings`;
   - `ticking`, `wake()`, `tick()` (the entire render loop, through its closing brace);
   - every `wake();` call.
5. Change `liveCount` (Task 3) to:
```ts
    const liveCount = (): number => glassState.liveCount(); // open transmissions (re-fit deferral)
```
6. Below `tagsFor`, add:
```ts
    // Rendered footprint: power-rated sites use ESTIMATED COVERAGE (true
    // geography); the rest use the old blip hit ramp (kiosk-scaled).
    const siteRadius = (key: string, hits: number): number =>
      coverage.get(key) ?? (3750 + 625 * Math.min(Math.max(hits, 1), 6)) * geo;
    const glassSite = (lat: number, lng: number, freq: number | undefined, kind: "active" | "closecall"): GlassSite => ({
      key: `${lat.toFixed(5)},${lng.toFixed(5)}`, lat, lng,
      color: hexToGlowRgb(colorFor(freq, kind, tagsFor(freq))),
    });
```
7. Replace `startTx` and `endTx` with:
```ts
    function startTx(id: string, lat: number, lng: number, freq: number | undefined, kind: "active" | "closecall"): void {
      const s = glassSite(lat, lng, freq, kind);
      glassState.keyUp(id, s, siteRadius(s.key, glassState.hits(s.key) + 1), Date.now());
      poke();
    }
    function endTx(id: string): void {
      glassState.release(id, Date.now());
      poke();
    }
```
8. Replace `push()` with:
```ts
    function push(lat: number, lon: number, alphaTag: string, kind: "active" | "closecall", ts: number, freq?: number, live = false): void {
      // Live hits plant/refresh the persistent antenna; the front itself is
      // started by the WS handler (startTx). Backfilled rows seed afterglows.
      // An explicit flag, not the old "ts < 2 s ago" test: the newest backfill
      // rows are scaled to within 2 s of now and must still seed a glow.
      if (live) antenna(lat, lon, [alphaTag], 1, ts, true, freq);
      else {
        const s = glassSite(lat, lon, freq, kind);
        glassState.seedGlow(s, siteRadius(s.key, glassState.hits(s.key) + 1), ts, Date.now());
        poke();
      }
    }
```
9. In the WS handler:
   - `active`: pass `true` as a new last argument to the `push(...)` call (`push(ch.location.lat, ch.location.lon, ch.alphaTag || fmtFreq(ev.freq), "active", Date.now(), ev.freq, true);`). The history backfill call keeps the default `false`.
   - `release`: keep `endTx(ev.channelId);`.
   - `idle`: replace the ring-ending loop with `glassState.releaseAll(Date.now()); poke();`. Keep `audibleId = null;` and `onQuiet();`.
   - `signal`: replace the body with:
```ts
        // The audible channel's telemetry: re-arm its ttl (a continuous carrier
        // never expires mid-transmission) and step its rim brightness — at most
        // holdFps times a second, only when the quantised level moves.
        if (audibleId) {
          const now = Date.now();
          glassState.rearm(audibleId, now);
          if (glassState.signal(audibleId, ev.dbfs, now)) poke();
        }
```
   - Any `closecall` branch that called `startTx` keeps calling it (the signature is unchanged except the dropped `ttlMs` parameter). Remove a passed `ttlMs` argument if there is one.
10. `rg -n "circles|liveTx|txRings|field\.|Circle\(|wake\(|heldTxRadius" src/frontend/map/map.ts` must print nothing.

- [ ] **Step 5: Test and typecheck**

Run: `npm test && npm run typecheck`
Expected: all pass, clean.

- [ ] **Step 6: Commit**

```bash
git add -A src/frontend/map src/backend/server.ts test/
git commit -m "feat(glass): transmissions as event-paced glass fronts + afterglows; drop Circle rings, BlipField, txRing; redraw diag

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 8: Docs, and ship PR B (prove it on the wall)

**Files:**
- Modify: `docs/ROADMAP.md` (Idea 3)
- Modify: `CLAUDE.md` (Architecture notes, Do-not-undo invariants)
- Modify: `docs/superpowers/plans/2026-10-01-weather-glass.md` (the PR 3 and PR 4 headings)

- [ ] **Step 1: Docs**

1. In `docs/ROADMAP.md`, at the end of Idea 3's section, add:
```markdown
> **Shipped 2026-10 — Weather Glass + fixed stage.** Real QC'd radar (MRMS) on a GPU layer (#282–#285); transmissions are glass fronts → still rim → stepped afterglow; the kiosk camera never moves (off-frame speakers bloom the edge toward them); the layer redraws only when its scene changes. Specs: `docs/superpowers/specs/2026-10-01-weather-glass-design.md`, `…/2026-10-02-fixed-stage-event-pacing-design.md`.
```
2. In `CLAUDE.md`, under "Architecture notes", add a bullet:
```markdown
- **Weather Glass layer** (`src/frontend/map/glass*.ts`): one `WebGLOverlayView`
  inside Google's GL context draws radar (backend `/api/radar`, QC'd MRMS by
  default) and transmissions. It is **event-paced**: every glass frame
  re-composites the whole map, so `glassState.frame()` reports `continuous` /
  `nextChangeAt` and the layer redraws only then (`display.glass.*`). The
  kiosk camera is a **fixed stage** (`display.camera.follow` false).
```
   And under "Do-not-undo invariants", add:
```markdown
- **The kiosk camera stays still and the glass layer stays event-paced.**
  Camera moves made Google re-lay-out the vector map on the CPU at every hit,
  and continuous glass redraws (haze 0.35) drove the box to its 90 °C trip on
  2026-10-01. Don't add standing animation (breathing, drifting haze, smooth
  long fades) without a thermal A/B.
```
3. In `docs/superpowers/plans/2026-10-01-weather-glass.md`, directly under the `## PR 3 — Glass transmissions` heading and under the `## PR 4 — Gentle camera + docs` heading, add the line:
`> **Superseded** by docs/superpowers/plans/2026-10-02-fixed-stage-event-pacing.md (PR B / dropped). Do not execute.`
4. Commit:
```bash
git add ../docs/ROADMAP.md ../CLAUDE.md ../docs/superpowers/plans/2026-10-01-weather-glass.md
git commit -m "docs: Weather Glass shipped as a fixed stage with event-paced redraws

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 2: Definition-of-done checks**

Run: `npm test && npm run test:native && npm run typecheck && npm run build`
Expected: all pass.

- [ ] **Step 3: Deploy** (the schema and diag are backend)

```bash
sudo systemctl restart kerchunk-kiosk
until curl -sf localhost:8080/api/status >/dev/null; do sleep 1; done
curl -X POST localhost:8080/api/kiosk/reload
```
Confirm `"hazeIntensity":0`, and that `holdFps`, `signalSteps` and `fadeSteps` appear in `curl -s localhost:8080/api/config`.

- [ ] **Step 4: Burst-prove the lifecycle**

Run a transmission and a burst capture together, as one script with `run_in_background: true` (a foreground `sleep` loop is blocked in this harness):
```bash
cat > /tmp/claude-1000/burst.sh <<'EOF'
#!/bin/bash
curl -s -X POST localhost:8080/api/test/tx -H 'content-type: application/json' -d '{"holdMs":6000}' > /tmp/claude-1000/burst-tx.json
t0=$(date +%s.%N)
for at in 0.15 0.4 0.9 3 6.4 6.9 7.6 20 40; do
  while (( $(echo "$(date +%s.%N) - $t0 < $at" | bc) )); do sleep 0.02; done
  XDG_RUNTIME_DIR=/run/user/1000 WAYLAND_DISPLAY=wayland-0 grim /tmp/claude-1000/burst-$at.png
done
EOF
chmod +x /tmp/claude-1000/burst.sh && /tmp/claude-1000/burst.sh
```
Read the PNGs, and check:
- (a) 0.15 s: the core flash at the pin;
- (b) 0.4 s and 0.9 s: the front growing outward from the pin;
- (c) 3 s: a still rim at coverage size, centred on the pin;
- (d) 6.4 s and 6.9 s: the rim dissolving into a disc;
- (e) 7.6 s, 20 s and 40 s: an afterglow disc, dimmer at each stage;
- (f) no flat Google circles anywhere.

- [ ] **Step 5: Count redraws and measure thermal**

Run the 10-minute loop from Task 4 Step 1 into `/tmp/claude-1000/glass-after.txt` while traffic is normal. Then:
```bash
journalctl -u kerchunk-kiosk --since "-15 min" --no-pager | grep "glass redraws="
```
Expected:
- the redraw lines report a low number on a quiet band (tens per minute or fewer), and roughly the grow/dissolve frames plus the steps during traffic;
- temperature within +3 °C, and chromium within +10 %, of PR A's `stage-after.txt`.

If either budget fails, report it plainly. Try `holdFps` 2 and `fadeSteps` 12 via `PUT /api/config` plus `kiosk/reload`, and report both runs.

- [ ] **Step 6: Push, open the PR, merge, clean up**

```bash
git push -u origin feat/glass-transmissions
gh pr create --title "feat(glass): transmissions as event-paced light fronts + afterglows" --body "$(cat <<'EOF'
Spec: docs/superpowers/specs/2026-10-02-fixed-stage-event-pacing-design.md (PR B). Replaces both Google Circle systems.

- Key-up flash → eased grow to coverage → STILL rim (brightness follows signal, quantised, ≤ holdFps steps/s) → release dissolves into a 60 s afterglow that fades in fadeSteps steps
- Event pacing: glassState.frame() reports continuous / nextChangeAt; GlassLayer redraws only for grows/dissolves, at scheduled steps, or on events — a quiet band draws nothing. A 1 s fallback retries a redraw Google drops.
- Deletes BlipField, txRing.ts, the custom wake/tick loop; history seeds pre-faded afterglows
- Journal: `[kiosk] glass redraws=<n>/min` every 5 min
- Docs: ROADMAP Idea 3, CLAUDE.md architecture + invariant; old PR 3/4 plan marked superseded

Knobs (`display.glass` in src/backend/config/schema.ts; PUT /api/config + POST /api/kiosk/reload): holdFps 4, signalSteps 8, fadeSteps 24, txGrowMs 900, maxFps 30, txFps 60.

Proof: <burst screenshot notes per phase, redraws/min quiet vs busy, thermal vs PR A>

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
gh pr checks <n> --watch
gh pr merge <n> --merge --delete-branch && git checkout main && git pull --ff-only && git fetch --prune && git branch -d feat/glass-transmissions
```
