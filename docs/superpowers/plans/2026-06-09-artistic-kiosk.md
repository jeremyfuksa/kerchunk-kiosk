# The Day's Map — Artistic Kiosk Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a calm, accumulating "Day's Map" artistic view at `/art` that renders each day's radio traffic as luminous geographic sediment, becoming the kiosk's primary screen.

**Architecture:** A new framework-free frontend view (`src/frontend/art/`) mirroring the existing `map/` view's structure. A *pure, headless-testable* accumulator (`SedimentField`, modeled on the existing `BlipField`) folds today's history rows + live WS events into per-site deposits; a thin canvas renderer draws them with `globalCompositeOperation = "screen"` over a dark ground, positioning sites by a geographic projection anchored on the home QTH (no map tiles — offline-safe). Service color reuses the live map's classifier, which is extracted into a shared module so both views import one source.

**Tech Stack:** TypeScript (ESM, `.js` import extensions), Vite (multi-path SPA via `main.ts` routing), vanilla Canvas 2D, vitest. Backend: existing `/api/history`, `/api/config`, `/ws` — no backend changes except a one-line static-fallback route.

---

## Background the engineer needs

- **This repo's conventions bite. Read [`CLAUDE.md`](../../../CLAUDE.md) first.** ESM with mandatory `.js` import extensions even from `.ts`; `strict` + `noUncheckedIndexedAccess` (indexed access is `T | undefined`); all commands run from `kiosk/`.
- **Framework-free frontend.** No React. A "view" is a function `renderX(root: HTMLElement)` that builds DOM and wires a `ReconnectingWs`. `main.ts` routes by `location.pathname`. See [`src/frontend/map/map.ts`](../../../kiosk/src/frontend/map/map.ts) as the closest analog.
- **The pure-reducer pattern.** [`src/frontend/map/blips.ts`](../../../kiosk/src/frontend/map/blips.ts) (`BlipField`) is pure data — `add()` / `alive(now)` — and is tested headlessly in [`test/blips.test.ts`](../../../kiosk/test/blips.test.ts) with no DOM. **Copy this pattern exactly** for `SedimentField`. The render layer consumes the reducer each animation tick.
- **The data is already there.** `GET /api/history?since=<ms>&kind=active&limit=5000` returns `HistoryRow[]` (`{ id, ts, kind, freq, alphaTag, mode, band, tags, lat, lon, durationMs, rfDb }`). Live events arrive on `/ws` as `EngineEvent`; the relevant ones are `{ type:"active"; channel; freq; ts }` and `{ type:"closecall"; freqHz; ts }`. `channel.location?.lat/lon` carries the site.
- **Color classifier lives in [`map.ts:53-73`](../../../kiosk/src/frontend/map/map.ts#L53)** as `PIN_COLORS` + `colorFor(freqHz, kind)`, using `serviceFor()` from [`banks.ts`](../../../kiosk/src/backend/config/banks.ts). Task 1 extracts it so the art view does not duplicate it.
- **Spec:** [`docs/superpowers/specs/2026-06-09-artistic-kiosk-design.md`](../specs/2026-06-09-artistic-kiosk-design.md). The locked visual language (sediment, band-coded, `screen` blend, no false connections, daily reset, calm) is non-negotiable; tuning values are free.

## File structure

- **Create** `src/frontend/lib/serviceColor.ts` — shared `PIN_COLORS`, `colorFor(freqHz, kind)`. One responsibility: frequency → service color.
- **Modify** `src/frontend/map/map.ts` — delete its local `PIN_COLORS`/`colorFor`, import from `serviceColor.ts` (DRY; no behavior change).
- **Create** `src/frontend/art/sediment.ts` — pure `SedimentField` accumulator (deposits per site, strata per service, breath state). No DOM.
- **Create** `src/frontend/art/project.ts` — pure geographic projection (lat/lon ↔ canvas x/y, anchored on home). No DOM.
- **Create** `src/frontend/art/art.ts` — `renderArt(root)`: fetch config+history, build field, wire WS, run the canvas animation loop.
- **Create** `src/frontend/art/art.css` — full-bleed dark canvas styling.
- **Create** `test/sediment.test.ts`, `test/project.test.ts` — headless vitest for the two pure modules.
- **Modify** `src/frontend/main.ts` — route `/art` → `renderArt`.
- **Modify** `src/backend/server.ts:~840` (`serveStatic`) — add `/art` to the `index.html` fallback so a hard refresh on `/art` serves the SPA.

---

## Task 1: Extract the shared service-color module

**Files:**
- Create: `kiosk/src/frontend/lib/serviceColor.ts`
- Modify: `kiosk/src/frontend/map/map.ts:53-73`
- Test: `kiosk/test/serviceColor.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// kiosk/test/serviceColor.test.ts
import { describe, it, expect } from "vitest";
import { PIN_COLORS, colorFor } from "../src/frontend/lib/serviceColor.js";

describe("colorFor", () => {
  it("maps a ham frequency to the ham pin color", () => {
    expect(colorFor(146_520_000, "active")).toBe(PIN_COLORS.ham);
  });
  it("maps a NOAA weather frequency to the weather color", () => {
    expect(colorFor(162_550_000, "active")).toBe(PIN_COLORS.weather);
  });
  it("returns the unknown color for an unclassified frequency", () => {
    expect(colorFor(500_000_000, "active")).toBe(PIN_COLORS.unknown);
  });
  it("uses the nofix color when geography is synthetic", () => {
    expect(colorFor(146_520_000, "nofix")).toBe("#4a7c7e");
  });
  it("falls back to a warm orange when frequency is unknown", () => {
    expect(colorFor(undefined, "active")).toBe("#ff6b35");
    expect(colorFor(undefined, "closecall")).toBe("#dc3a38");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd kiosk && npx vitest run test/serviceColor.test.ts`
Expected: FAIL — cannot resolve `../src/frontend/lib/serviceColor.js`.

- [ ] **Step 3: Create the module** (move the logic verbatim from `map.ts:53-73`)

```ts
// kiosk/src/frontend/lib/serviceColor.ts
import { serviceFor } from "../../backend/config/banks.js";

// The pin heads' palette, shared by the live map's transient layer and the
// artistic kiosk's sediment. One color language across the appliance.
export const PIN_COLORS: Record<string, string> = {
  air: "#3478F5", rail: "#F5821F", ham: "#EC4E89", gmrs: "#1FA84C",
  biz: "#7C4FE0", marine: "#0FAEC0", weather: "#F4B315", unknown: "#747B8A",
};
const UNKNOWN_POSITION_COLOR = "#4a7c7e";

export function colorFor(freqHz: number | undefined, kind: "active" | "closecall" | "nofix"): string {
  if (kind === "nofix") return UNKNOWN_POSITION_COLOR;
  if (freqHz === undefined) return kind === "closecall" ? "#dc3a38" : "#ff6b35";
  const svc = serviceFor(freqHz);
  if (svc === "air") return PIN_COLORS.air!;
  if (svc === "rail") return PIN_COLORS.rail!;
  if (svc?.startsWith("ham")) return PIN_COLORS.ham!;
  if (svc === "GMRS/FRS") return PIN_COLORS.gmrs!;
  if (svc === "marine") return PIN_COLORS.marine!;
  if (svc === "NOAA wx") return PIN_COLORS.weather!;
  if (svc && (svc.includes("biz") || svc.includes("PS") || svc.includes("trunked") || svc === "T-band")) return PIN_COLORS.biz!;
  return PIN_COLORS.unknown!;
}
```

- [ ] **Step 4: Point `map.ts` at the shared module**

In `kiosk/src/frontend/map/map.ts`: delete the local `PIN_COLORS`, `UNKNOWN_POSITION_COLOR`, and `colorFor` definitions (lines ~53-73), and add to the imports near the top:

```ts
import { PIN_COLORS, colorFor } from "../lib/serviceColor.js";
```

(Leave every *call site* of `colorFor`/`PIN_COLORS` in `map.ts` unchanged — only the definitions move.)

- [ ] **Step 5: Run tests + typecheck to verify nothing broke**

Run: `cd kiosk && npx vitest run test/serviceColor.test.ts && npm run build`
Expected: serviceColor tests PASS; build succeeds (proves `map.ts` still resolves `colorFor`/`PIN_COLORS`).

- [ ] **Step 6: Commit**

```bash
cd kiosk
git add src/frontend/lib/serviceColor.ts src/frontend/map/map.ts test/serviceColor.test.ts
git commit -m "refactor(frontend): extract shared serviceColor module from map"
```

---

## Task 2: Geographic projection (pure)

**Files:**
- Create: `kiosk/src/frontend/art/project.ts`
- Test: `kiosk/test/project.test.ts`

Rationale: the art is geographically literal but uses **no map tiles** (offline-safe, and tiles would fight the sediment). `project()` converts lat/lon to canvas pixels using a local equirectangular approximation centered on home — accurate at metro scale.

- [ ] **Step 1: Write the failing test**

```ts
// kiosk/test/project.test.ts
import { describe, it, expect } from "vitest";
import { makeProjection } from "../src/frontend/art/project.js";

const HOME = { lat: 39.2915, lon: -94.4953 };

describe("makeProjection", () => {
  it("places home at the canvas center", () => {
    const p = makeProjection(HOME, 18_000, 1000, 800);
    const c = p(HOME.lat, HOME.lon);
    expect(c.x).toBeCloseTo(500, 0);
    expect(c.y).toBeCloseTo(400, 0);
  });
  it("maps a point due north to a smaller y (up on screen)", () => {
    const p = makeProjection(HOME, 18_000, 1000, 800);
    const north = p(HOME.lat + 0.05, HOME.lon);
    expect(north.y).toBeLessThan(400);
    expect(north.x).toBeCloseTo(500, 0);
  });
  it("maps a point due east to a larger x", () => {
    const p = makeProjection(HOME, 18_000, 1000, 800);
    const east = p(HOME.lat, HOME.lon + 0.05);
    expect(east.x).toBeGreaterThan(500);
  });
  it("scales so spanM maps to the smaller canvas half-dimension", () => {
    // A point spanM north of home should land at the top edge (y≈0).
    const p = makeProjection(HOME, 18_000, 1000, 800);
    const dLat = 18_000 / 111_320;
    const edge = p(HOME.lat + dLat, HOME.lon);
    expect(edge.y).toBeCloseTo(0, 0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd kiosk && npx vitest run test/project.test.ts`
Expected: FAIL — cannot resolve `project.js`.

- [ ] **Step 3: Implement the projection**

```ts
// kiosk/src/frontend/art/project.ts
// Pure geographic projection for the artistic kiosk: lat/lon -> canvas px,
// anchored on the home QTH. Local equirectangular approximation — accurate at
// metro scale, no tiles, no network. spanM is the radius (meters) that maps
// from center to the nearer canvas edge.
export interface Home { lat: number; lon: number; }
export interface Px { x: number; y: number; }

export function makeProjection(home: Home, spanM: number, width: number, height: number): (lat: number, lon: number) => Px {
  const cosLat = Math.cos((home.lat * Math.PI) / 180);
  const half = Math.min(width, height) / 2;
  const pxPerM = half / spanM;
  return (lat: number, lon: number): Px => {
    const dyM = (lat - home.lat) * 111_320;            // north positive
    const dxM = (lon - home.lon) * 111_320 * cosLat;   // east positive
    return { x: width / 2 + dxM * pxPerM, y: height / 2 - dyM * pxPerM };
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd kiosk && npx vitest run test/project.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
cd kiosk
git add src/frontend/art/project.ts test/project.test.ts
git commit -m "feat(art): geographic projection for the artistic kiosk canvas"
```

---

## Task 3: SedimentField accumulator (pure)

**Files:**
- Create: `kiosk/src/frontend/art/sediment.ts`
- Test: `kiosk/test/sediment.test.ts`

The reducer: each hit deposits at a site (keyed by rounded lat/lon, matching `BlipField` and the backend `sites()` rounding). Per-site it tracks **per-service hit counts** (the strata) and a **breath** timestamp (the live bloom). `deposits(now)` returns render-ready per-site data: position, per-service counts, total hits, and a breath intensity decaying to 0.

- [ ] **Step 1: Write the failing test**

```ts
// kiosk/test/sediment.test.ts
import { describe, it, expect } from "vitest";
import { SedimentField } from "../src/frontend/art/sediment.js";

describe("SedimentField", () => {
  it("accumulates hits at a site and counts them per service color", () => {
    const f = new SedimentField({ breathMs: 4000 });
    f.deposit({ lat: 39.30, lon: -94.50, color: "#EC4E89", ts: 0 });
    f.deposit({ lat: 39.30, lon: -94.50, color: "#EC4E89", ts: 1000 });
    const d = f.deposits(1000);
    expect(d).toHaveLength(1);
    expect(d[0]!.totalHits).toBe(2);
    expect(d[0]!.strata).toEqual([{ color: "#EC4E89", hits: 2 }]);
  });

  it("keeps distinct services at one site as separate strata, busiest first", () => {
    const f = new SedimentField({ breathMs: 4000 });
    f.deposit({ lat: 39.30, lon: -94.50, color: "#EC4E89", ts: 0 }); // ham
    f.deposit({ lat: 39.30, lon: -94.50, color: "#EC4E89", ts: 10 });
    f.deposit({ lat: 39.30, lon: -94.50, color: "#7C4FE0", ts: 20 }); // biz
    const strata = f.deposits(20)[0]!.strata;
    expect(strata).toEqual([
      { color: "#EC4E89", hits: 2 },
      { color: "#7C4FE0", hits: 1 },
    ]);
  });

  it("treats sites >~1m apart as distinct deposits", () => {
    const f = new SedimentField({ breathMs: 4000 });
    f.deposit({ lat: 39.30, lon: -94.50, color: "#F5821F", ts: 0 });
    f.deposit({ lat: 39.31, lon: -94.70, color: "#F4B315", ts: 0 });
    expect(f.deposits(0)).toHaveLength(2);
  });

  it("a fresh deposit sets breath=1, decaying linearly to 0 over breathMs", () => {
    const f = new SedimentField({ breathMs: 4000 });
    f.deposit({ lat: 39.30, lon: -94.50, color: "#EC4E89", ts: 0 });
    expect(f.deposits(0)[0]!.breath).toBeCloseTo(1, 5);
    expect(f.deposits(2000)[0]!.breath).toBeCloseTo(0.5, 5);
    expect(f.deposits(4000)[0]!.breath).toBeCloseTo(0, 5);
    expect(f.deposits(9999)[0]!.breath).toBe(0); // never negative
  });

  it("clear() empties the field for the daily reset", () => {
    const f = new SedimentField({ breathMs: 4000 });
    f.deposit({ lat: 39.30, lon: -94.50, color: "#EC4E89", ts: 0 });
    f.clear();
    expect(f.deposits(0)).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd kiosk && npx vitest run test/sediment.test.ts`
Expected: FAIL — cannot resolve `sediment.js`.

- [ ] **Step 3: Implement SedimentField**

```ts
// kiosk/src/frontend/art/sediment.ts
// Pure accumulator for the artistic kiosk. Each transmission is an INDEPENDENT
// site key-up — deposits never link to other sites. A site accrues per-service
// strata (sub-layers within its own footprint) and a decaying "breath" from
// the most recent hit. Modeled on BlipField; rendered by art.ts each tick.

export interface DepositInput {
  lat: number;
  lon: number;
  color: string; // service color from serviceColor.colorFor()
  ts: number;
}

export interface Stratum { color: string; hits: number; }

export interface Deposit {
  lat: number;
  lon: number;
  totalHits: number;
  /** Per-service sub-layers, busiest first. */
  strata: Stratum[];
  /** 1 at the most recent hit, linear to 0 at breathMs. */
  breath: number;
}

interface Site {
  lat: number;
  lon: number;
  byColor: Map<string, number>;
  lastTs: number;
}

export interface SedimentOptions { breathMs: number; }

export class SedimentField {
  private sites = new Map<string, Site>();
  private readonly breathMs: number;

  constructor(opts: SedimentOptions) {
    this.breathMs = opts.breathMs;
  }

  deposit(d: DepositInput): void {
    const key = `${d.lat.toFixed(5)},${d.lon.toFixed(5)}`;
    const site = this.sites.get(key) ?? { lat: d.lat, lon: d.lon, byColor: new Map(), lastTs: d.ts };
    site.byColor.set(d.color, (site.byColor.get(d.color) ?? 0) + 1);
    site.lastTs = Math.max(site.lastTs, d.ts);
    this.sites.set(key, site);
  }

  deposits(now: number): Deposit[] {
    const out: Deposit[] = [];
    for (const site of this.sites.values()) {
      const strata: Stratum[] = [...site.byColor.entries()]
        .map(([color, hits]) => ({ color, hits }))
        .sort((a, b) => b.hits - a.hits);
      const totalHits = strata.reduce((s, x) => s + x.hits, 0);
      const age = now - site.lastTs;
      const breath = age >= this.breathMs ? 0 : Math.max(0, 1 - age / this.breathMs);
      out.push({ lat: site.lat, lon: site.lon, totalHits, strata, breath });
    }
    return out;
  }

  clear(): void {
    this.sites.clear();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd kiosk && npx vitest run test/sediment.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
cd kiosk
git add src/frontend/art/sediment.ts test/sediment.test.ts
git commit -m "feat(art): SedimentField accumulator with per-service strata and breath"
```

---

## Task 4: Local-midnight reset helper (pure)

**Files:**
- Modify: `kiosk/src/frontend/art/sediment.ts` (append a pure helper)
- Test: `kiosk/test/sediment.test.ts` (append a describe block)

The daily portrait spans local midnight → now. The view needs "start-of-local-day for a given timestamp" both to query history and to detect when to `clear()`.

- [ ] **Step 1: Append the failing test**

```ts
// append to kiosk/test/sediment.test.ts
import { startOfLocalDay } from "../src/frontend/art/sediment.js";

describe("startOfLocalDay", () => {
  it("returns local midnight for a timestamp", () => {
    const noon = new Date(2026, 5, 9, 12, 0, 0, 0).getTime();
    const midnight = new Date(2026, 5, 9, 0, 0, 0, 0).getTime();
    expect(startOfLocalDay(noon)).toBe(midnight);
  });
  it("is idempotent on a midnight input", () => {
    const midnight = new Date(2026, 5, 9, 0, 0, 0, 0).getTime();
    expect(startOfLocalDay(midnight)).toBe(midnight);
  });
  it("two timestamps on the same local day share a start", () => {
    const a = new Date(2026, 5, 9, 6, 30).getTime();
    const b = new Date(2026, 5, 9, 23, 59).getTime();
    expect(startOfLocalDay(a)).toBe(startOfLocalDay(b));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd kiosk && npx vitest run test/sediment.test.ts`
Expected: FAIL — `startOfLocalDay` is not exported.

- [ ] **Step 3: Implement the helper** (append to `sediment.ts`)

```ts
// append to kiosk/src/frontend/art/sediment.ts
/** Local midnight (ms) for the day containing `ts`. The portrait's lower bound. */
export function startOfLocalDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd kiosk && npx vitest run test/sediment.test.ts`
Expected: PASS (8 tests total).

- [ ] **Step 5: Commit**

```bash
cd kiosk
git add src/frontend/art/sediment.ts test/sediment.test.ts
git commit -m "feat(art): startOfLocalDay helper for the daily-reset boundary"
```

---

## Task 5: The art view — fetch, wire, render

**Files:**
- Create: `kiosk/src/frontend/art/art.ts`
- Create: `kiosk/src/frontend/art/art.css`

No unit test for this task — it is the DOM/canvas glue layer (the testable logic lives in Tasks 1-4). It is verified by build + manual run in Task 7.

- [ ] **Step 1: Write the CSS**

```css
/* kiosk/src/frontend/art/art.css */
html, body { margin: 0; height: 100%; background: #04060a; overflow: hidden; }
#art-canvas {
  display: block;
  width: 100vw;
  height: 100vh;
  /* The calm dark ground; the canvas paints luminance on top via screen blend. */
  background: radial-gradient(ellipse at 50% 55%, #0b0f16 0%, #070a10 68%, #04060a 100%);
}
```

- [ ] **Step 2: Write the view**

```ts
// kiosk/src/frontend/art/art.ts
// The Day's Map (ROADMAP Idea 3): a calm, accumulating artistic kiosk. Today's
// history seeds the sediment; live WS hits add deposits and a soft breath. All
// marks composite with "screen" so density reads as luminance. Daily reset at
// local midnight. See docs/superpowers/specs/2026-06-09-artistic-kiosk-design.md.
import { ReconnectingWs } from "../lib/wsClient.js";
import { api } from "../lib/api.js";
import { colorFor } from "../lib/serviceColor.js";
import { SedimentField, startOfLocalDay, type Deposit } from "./sediment.js";
import { makeProjection, type Home } from "./project.js";
import type { EngineEvent } from "../../backend/engine/ScannerEngine.js";
import type { HistoryRow } from "../../backend/history.js";
import "./art.css";

const BREATH_MS = 6000;       // live bloom lifetime
const SPAN_M = 40_000;        // metro radius mapped to the nearer canvas edge
const MAX_STRATUM_R = 90;     // px radius of the busiest stratum's glow

export function renderArt(root: HTMLElement): void {
  root.innerHTML = `<canvas id="art-canvas"></canvas>`;
  const canvas = root.querySelector<HTMLCanvasElement>("#art-canvas")!;
  void boot(canvas);
}

async function boot(canvas: HTMLCanvasElement): Promise<void> {
  const cfg = await api.getConfig();
  const home: Home = {
    lat: cfg.display?.mapLat ?? 39.0997,
    lon: cfg.display?.mapLon ?? -94.5786,
  };

  const field = new SedimentField({ breathMs: BREATH_MS });
  let dayStart = startOfLocalDay(Date.now());

  // Seed today's portrait from history (also recovers it across a reload).
  try {
    const rows: HistoryRow[] = await fetch(
      `/api/history?since=${dayStart}&kind=active&limit=5000`,
    ).then((r) => (r.ok ? r.json() : []));
    for (const row of rows) {
      if (row.lat == null || row.lon == null) continue;
      field.deposit({ lat: row.lat, lon: row.lon, color: colorFor(row.freq, "active"), ts: row.ts });
    }
  } catch { /* offline / no history store — start from an empty canvas */ }

  // Live breath: each opening/discovery with a location adds a deposit.
  const ws = new ReconnectingWs(
    `ws://${location.host}/ws`,
    (ev: EngineEvent) => onEvent(ev),
    {},
  );
  ws.connect();

  function onEvent(ev: EngineEvent): void {
    if (ev.type === "active" && ev.channel.location?.lat != null && ev.channel.location.lon != null) {
      field.deposit({
        lat: ev.channel.location.lat,
        lon: ev.channel.location.lon,
        color: colorFor(ev.freq, "active"),
        ts: ev.ts,
      });
    }
    // closecall has no location on the event itself (server files it as a
    // channel; its later "active" carries the location) — nothing to plot here.
  }

  // Resolution-correct canvas sizing for the kiosk's HDMI panel.
  function resize(): void {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(canvas.clientWidth * dpr);
    canvas.height = Math.round(canvas.clientHeight * dpr);
  }
  resize();
  window.addEventListener("resize", resize);

  const ctx = canvas.getContext("2d")!;

  function frame(): void {
    const now = Date.now();

    // Daily reset: when the wall clock crosses local midnight, clear.
    const today = startOfLocalDay(now);
    if (today !== dayStart) { field.clear(); dayStart = today; }

    const w = canvas.width, h = canvas.height;
    const project = makeProjection(home, SPAN_M, w, h);

    // Repaint the dark ground (CSS gradient shows through; clear keeps it crisp).
    ctx.clearRect(0, 0, w, h);

    // Screen blend: luminance ADDS where marks overlap — the whole point.
    ctx.globalCompositeOperation = "screen";

    for (const dep of field.deposits(now)) {
      drawDeposit(ctx, project(dep.lat, dep.lon), dep);
    }

    ctx.globalCompositeOperation = "source-over";
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  function drawDeposit(c: CanvasRenderingContext2D, p: { x: number; y: number }, dep: Deposit): void {
    // Strata: largest (busiest) first so smaller services layer on top. Radius
    // grows with log(hits) so a busy site is bigger but never runaway.
    const maxHits = dep.strata[0]?.hits ?? 1;
    for (const s of dep.strata) {
      const r = MAX_STRATUM_R * (Math.log1p(s.hits) / Math.log1p(maxHits || 1));
      paintGlow(c, p.x, p.y, Math.max(8, r), s.color, 0.42);
    }
    // Breath: a brief, brighter bloom on top of the most recent hit.
    if (dep.breath > 0) {
      const top = dep.strata[0]?.color ?? "#ffffff";
      paintGlow(c, p.x, p.y, MAX_STRATUM_R * 0.7, top, 0.5 * dep.breath);
    }
  }

  function paintGlow(c: CanvasRenderingContext2D, x: number, y: number, r: number, color: string, alpha: number): void {
    const g = c.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, hexA(color, alpha));
    g.addColorStop(0.5, hexA(color, alpha * 0.4));
    g.addColorStop(1, hexA(color, 0));
    c.fillStyle = g;
    c.beginPath();
    c.arc(x, y, r, 0, Math.PI * 2);
    c.fill();
  }

  // "#RRGGBB" + alpha -> "rgba(...)". The palette is all 6-digit hex.
  function hexA(hex: string, a: number): string {
    const n = parseInt(hex.slice(1), 16);
    const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    return `rgba(${r},${g},${b},${a})`;
  }
}
```

- [ ] **Step 3: Build to typecheck the glue**

Run: `cd kiosk && npm run build`
Expected: build succeeds. If TS complains about an unused `closecall` branch or an import, fix per the compiler (do not silence with `any`).

- [ ] **Step 4: Commit**

```bash
cd kiosk
git add src/frontend/art/art.ts src/frontend/art/art.css
git commit -m "feat(art): The Day's Map view — sediment canvas with screen blend"
```

---

## Task 6: Route `/art` (frontend + static fallback)

**Files:**
- Modify: `kiosk/src/frontend/main.ts`
- Modify: `kiosk/src/backend/server.ts` (the `serveStatic` fallback)

- [ ] **Step 1: Add the frontend route**

In `kiosk/src/frontend/main.ts`, add the import and a branch:

```ts
import { renderArt } from "./art/art.js";
```

```ts
// in the path dispatch, before the dashboard fallback:
} else if (location.pathname.startsWith("/art")) {
  renderArt(root);
}
```

So the chain reads `admin` → `map` → `art` → dashboard (else).

- [ ] **Step 2: Add `/art` to the static fallback**

In `kiosk/src/backend/server.ts`, find in `serveStatic`:

```ts
let filePath = join(staticDir, safe === "/" || safe === "/map" ? "index.html" : safe);
```

Change it to include `/art` so a hard refresh on `/art` serves the SPA shell:

```ts
let filePath = join(staticDir, safe === "/" || safe === "/map" || safe === "/art" ? "index.html" : safe);
```

- [ ] **Step 3: Build + run the full test suite**

Run: `cd kiosk && npm run build && npm test`
Expected: build succeeds; all tests PASS (existing suite + serviceColor + project + sediment).

- [ ] **Step 4: Commit**

```bash
cd kiosk
git add src/frontend/main.ts src/backend/server.ts
git commit -m "feat(art): route /art to The Day's Map (frontend + static fallback)"
```

---

## Task 7: Manual verification on the kiosk (hardware proof)

**Files:** none (verification only).

Per [`CLAUDE.md`](../../../CLAUDE.md), changes are proven on the kiosk before the PR. Run this on the appliance (or any machine with the real backend + a populated history DB).

- [ ] **Step 1: Build and start the backend with real data**

Run (on the kiosk): `cd kiosk && npm run build && sudo systemctl restart kerchunk-kiosk`
Or locally against a fake engine but real-ish history:
`USE_FAKE_ENGINE=1 KERCHUNK_CONFIG=/tmp/kc.json npm run dev:backend` (terminal 1) and `npm run dev:frontend` (terminal 2).

- [ ] **Step 2: Open `/art` and verify the locked behaviors against the spec**

Open `http://<host>:8080/art` (prod) or the Vite URL + `/art` (dev). Confirm:
  - The screen shows the day's accumulated sediment immediately (non-empty if there is any history today), positioned geographically with home centered.
  - Busier sites glow brighter/larger; the dominant-site triangle is legible.
  - A live key-up produces a soft breath at the right location, then settles into the sediment (does not vanish).
  - Overlapping services at one site screen into a luminous blended tone (if your data has a co-located case).
  - The register is calm — no hot statics, nothing twitchy. If it reads "busy," lower the alpha constants in `art.ts` (`paintGlow` alphas, `MAX_STRATUM_R`).
  - A page refresh reconstructs the same portrait from history (no lost state).

- [ ] **Step 3: Tune constants if needed, then re-verify**

If brightness/size/breath feel wrong, adjust `BREATH_MS`, `SPAN_M`, `MAX_STRATUM_R`, and the `paintGlow` alphas in `art.ts`. Rebuild and re-check. Commit any tuning:

```bash
cd kiosk && git add src/frontend/art/art.ts && git commit -m "tune(art): calm-register constants after hardware proof"
```

- [ ] **Step 4: Open the PR**

```bash
git push -u origin feat/artistic-kiosk
gh pr create --title "feat(art): The Day's Map artistic kiosk" --base main
```

(Do **not** make `/art` the default kiosk screen in this PR — that is a deliberate follow-up once the art is proven. See Out of scope.)

---

## Out of scope (this plan)

- **Making `/art` the kiosk's default screen.** The spec's intent is that the art *becomes* the primary face, but flipping the kiosk session's URL from `/map` (or `/`) to `/art` is a one-line appliance-config change best done *after* the art is proven on hardware — its own tiny follow-up, not bundled here. This plan ships `/art` as a reachable route.
- **Channel-list de-duplication / GMRS-exempt uniqueness rules** — separate project (needs the on-kiosk config).
- **Close Call breath.** `closecall` events carry no location; the server files them as channels whose later `active` events do carry a location and are already handled. No special path needed.
- **Layered-strata refinement beyond busiest-on-bottom** — the simple log-scaled concentric model is the v1; richer strata textures are a visual-polish follow-up if the hardware proof calls for it.

## Success criteria (from the spec)

- At any hour, including dead-quiet, `/art` shows a non-empty composed image and is pleasant on the wall.
- The dominant-site triangle is legible in the sediment.
- A live key-up produces a soft breath without disturbing the calm.
- The canvas clears at local midnight and a fresh portrait begins.
- The portrait reconstructs from history after reload (no separate persisted state).
- No regressions: `npm test` green; the live map and admin still work (Task 1's refactor is behavior-preserving).
