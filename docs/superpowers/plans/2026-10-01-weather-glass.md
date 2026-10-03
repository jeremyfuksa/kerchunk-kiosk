# Weather Glass Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the kiosk map's Google `Circle` rings and tile-by-tile `ImageMapType` radar with one GPU layer ("Weather Glass"):
- real NEXRAD reflectivity, crossfaded between scans;
- an ambient haze;
- luminous transmission fronts with afterglows;
- a gentler camera.

**Architecture:**
- The backend `RadarFeed` pulls IEM's palette-indexed national n0q composite, decodes only a crop around the QTH, and serves raw dBZ indices.
- The frontend draws inside Google's own GL context via `WebGLOverlayView`, in two passes per frame:
  - a georeferenced radar mesh (cubic B-spline reconstruction, palette by dBZ);
  - a screen-space additive pass (haze + fronts + afterglows).
- Pure state modules (`glassState`, `radarSync`, `cameraTween`, `glassMath`) carry all the timing logic and are unit-tested headless.

**Tech Stack:** TypeScript (Node ≥24, ESM, `.js` import extensions), zod 3, vitest 4 + supertest, `node:zlib`, WebGL2 / GLSL ES 3.00, Google Maps JS (vector map, `WebGLOverlayView`, `moveCamera`).

**Spec:** `docs/superpowers/specs/2026-10-01-weather-glass-design.md`. Read it first; this plan argues from it.

## Global Constraints

- All commands run from `kiosk/` unless stated otherwise.
- Relative imports carry `.js` extensions, even from `.ts`.
- `tsconfig` is `strict` + `noUncheckedIndexedAccess`: every `arr[i]` / `map[k]` is `T | undefined`, and you must handle that.
- No frontend framework. Vanilla TS. Icons are `lucide-static` only (this plan adds none).
- Radar is **real data only**: every radar pixel is a measured value or a blend of two real scans. No shimmer, no refraction, no motion interpolation.
- n0q scale: index 0 = no echo, otherwise `dBZ = −32 + 0.5·index`.
- IEM source: `https://mesonet.agron.iastate.edu/data/gis/images/4326/USCOMP/n0q_0.png` + `n0q_0.json` (`meta.valid`). The grid is 12200×5400, 0.005°/px, upper-left pixel **centre** at 126 °W, 50 °N, 8-bit palette, non-interlaced.
- The external-consumer routes `/api/status`, `/api/logs` and `/api/weather` must not change shape.
- No new npm dependencies.
- Knob defaults (verbatim from the spec):
  - `radar.enabled` true; `radar.refreshMs` 300000; `radar.staleMs` 1200000; `radar.spanDeg` `{w:4,h:3}`
  - `glass.maxFps` 30; `glass.txFps` 60; `glass.hazeIntensity` 0.35; `glass.radarOpacity` 0.6; `glass.radarMinDbz` 15; `glass.radarFadeMs` 20000; `glass.txGrowMs` 900
  - `camera.pushZoom` 1; `camera.pushMs` 2500; `camera.holdMs` 12000; `camera.returnMs` 4000
- Shader caps: `MAX_FRONTS = 8`, `MAX_GLOWS = 32`.
- Every change ships via a PR from a `feat/*` / `docs/*` branch, proven on the wall **before** the PR. After a merge, run `gh pr merge <n> --merge --delete-branch && git checkout main && git pull --ff-only && git fetch --prune && git branch -d <branch>`.
- Restart discipline:
  - `sudo systemctl restart kerchunk-kiosk` only for backend changes.
  - For frontend-only changes: `npm run build`, then `curl -X POST localhost:8080/api/kiosk/reload`.
  - A wedged wall gets `sudo systemctl restart kerchunk-display`.
- Definition of done per PR: `npm test`, `npm run test:native`, `npm run typecheck`, full `npm run build`, on-wall proof, knobs stated in the PR body.

## Review Focus

The input classes the spec implies but doesn't spell out, most likely first. Each has a test in the task named.

1. **IEM changes the image** (new dimensions, a non-palette PNG, or a truncated download). Expected: keep the last good scan, log once, never crash or serve a mis-registered crop. Tests: Task 2 (unsupported format, truncation) and Task 3 (dimension mismatch keeps the previous scan).
2. **`n0q_0.json` is unchanged, malformed, or missing `meta.valid`.** Expected: no 4.6 MB download and no crash. Tests: Task 3 (unchanged → no PNG fetch; malformed → error path keeps the scan).
3. **A missed `radar` WS event** (backend restart, WS reconnect). Expected: the page still picks up the next scan via the `refreshMs` backstop poll, and never re-downloads an unchanged frame. Tests: Task 7 (`poll()` dedupes by `scanTime`; a concurrent poll doesn't double-fetch).
4. **A transmission whose `release` never arrives, or an `idle` that ends everything at once.** Expected: TTL ends it into an afterglow; `idle` releases all; a `signal` for an unknown id is ignored; an expired backfill row seeds nothing. Tests: Task 11.
5. **A second speaker mid-push, or degenerate framing bounds** (a single site, so `n === s`). Expected: the camera retargets from where it is with no snap, and the zoom is capped instead of `Infinity`. Tests: Task 15.

---

## File map

**Backend (PR 1)**
- Create `src/backend/radar/n0q.ts`: index → dBZ.
- Create `src/backend/radar/crop.ts`: grid + QTH + span → crop window and bounds.
- Create `src/backend/radar/pngIndexed.ts`: streaming indexed-PNG crop decoder.
- Create `src/backend/radar/RadarFeed.ts`: poll loop, scan holder, `RadarSource` interface.
- Modify `src/backend/config/schema.ts`: `display.radar` block (PR 1), `display.glass` + remove `radarProduct` (PR 2), `display.camera` (PR 4).
- Modify `src/backend/engine/ScannerEngine.ts`: `radar` event in the `EngineEvent` union.
- Modify `src/backend/server.ts`: `ServerDeps.radar`, `/api/radar`, `/api/radar/frame`, the WS wiring, the diag `glass` field (PR 2), `/api/test/tx` (PR 3).
- Modify `src/backend/index.ts`: construct `RadarFeed`.
- Modify `docs/API.md` (repo root).

**Frontend (PRs 2–4)**, all in `src/frontend/map/`
- Create `glassMath.ts`: shared types, easing, fade, Mercator offset, clip→px, colour lift.
- Create `radarSync.ts`: fetch/dedupe/stale logic for radar frames.
- Create `glassShaders.ts`: GLSL source strings.
- Create `glassLayer.ts`: `WebGLOverlayView` plumbing.
- Create `glassState.ts`: transmission/afterglow lifecycle (PR 3).
- Create `cameraTween.ts`: eased camera tween + `fitCamera` (PR 4).
- Modify `map.ts`.
- Delete `txRing.ts` and the `BlipField` class in `blips.ts` (PR 3).

**Tests** (`test/`): `radarN0q.test.ts`, `radarCrop.test.ts`, `pngIndexed.test.ts`, `radarFeed.test.ts`, `radarRoutes.test.ts`, `glassMath.test.ts`, `radarSync.test.ts`, `glassState.test.ts`, `testTxRoute.test.ts`, `cameraTween.test.ts`, plus additions to `schema.test.ts`. Delete `txRing.test.ts` and the `BlipField` cases in `blips.test.ts` (PR 3).

---

## PR 0 — spec + plan (docs)

The spec and this plan sit on branch `docs/weather-glass-spec`. Push it, then open and merge the PR before Task 1:

```bash
cd /home/kiosk/kerchunk-kiosk
git push -u origin docs/weather-glass-spec
gh pr create --title "docs: Weather Glass spec + implementation plan" --body "Design + plan for the GPU art layer and real-radar pipeline.

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
gh pr merge <n> --merge --delete-branch && git checkout main && git pull --ff-only && git fetch --prune && git branch -d docs/weather-glass-spec
```

---

## PR 1 — Radar backend

Start: `git checkout main && git pull --ff-only && git checkout -b feat/radar-feed`

### Task 1: n0q scale and crop window

**Files:**
- Create: `kiosk/src/backend/radar/n0q.ts`
- Create: `kiosk/src/backend/radar/crop.ts`
- Test: `kiosk/test/radarN0q.test.ts`, `kiosk/test/radarCrop.test.ts`

**Interfaces:**
- Produces:
  - `n0qIndexToDbz(index: number): number | null`
  - `N0Q_NO_ECHO = 0`
  - `interface WorldGrid { ulLon: number; ulLat: number; deg: number; width: number; height: number }`
  - `IEM_USCOMP: WorldGrid`
  - `interface Bounds { n: number; s: number; e: number; w: number }`
  - `interface CropWindow { x0: number; y0: number; width: number; height: number; bounds: Bounds }`
  - `cropWindow(grid: WorldGrid, center: { lat: number; lon: number }, span: { w: number; h: number }): CropWindow | null`

- [ ] **Step 1: Write the failing tests**

`kiosk/test/radarN0q.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { n0qIndexToDbz, N0Q_NO_ECHO } from "../src/backend/radar/n0q.js";

// Anchors read from the live n0q_0.png PLTE on 2026-10-01: index 0 is black
// (no echo), index 64 is the 0 dBZ grey-blue, and the NWS 20 dBZ green band
// starts exactly at index 104 (75,214,144).
describe("n0qIndexToDbz", () => {
  it("index 0 is no echo", () => {
    expect(N0Q_NO_ECHO).toBe(0);
    expect(n0qIndexToDbz(0)).toBeNull();
  });
  it("matches the palette anchors", () => {
    expect(n0qIndexToDbz(64)).toBe(0);
    expect(n0qIndexToDbz(104)).toBe(20);
  });
  it("spans -31.5 .. 95.5 in 0.5 dBZ steps", () => {
    expect(n0qIndexToDbz(1)).toBe(-31.5);
    expect(n0qIndexToDbz(255)).toBe(95.5);
    expect(n0qIndexToDbz(105)! - n0qIndexToDbz(104)!).toBe(0.5);
  });
});
```

`kiosk/test/radarCrop.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { cropWindow, IEM_USCOMP } from "../src/backend/radar/crop.js";

describe("cropWindow (IEM USCOMP grid)", () => {
  it("crops a 4x3 degree box around Kansas City", () => {
    const c = cropWindow(IEM_USCOMP, { lat: 39.1, lon: -94.58 }, { w: 4, h: 3 })!;
    expect(c).toMatchObject({ x0: 5884, y0: 1880, width: 801, height: 601 });
    expect(c.bounds.w).toBeCloseTo(-96.5825, 6);
    expect(c.bounds.e).toBeCloseTo(-92.5775, 6);
    expect(c.bounds.n).toBeCloseTo(40.6025, 6);
    expect(c.bounds.s).toBeCloseTo(37.5975, 6);
  });
  it("bounds are pixel EDGES (world file gives the upper-left pixel centre)", () => {
    const c = cropWindow(IEM_USCOMP, { lat: 39, lon: -94 }, { w: 0.01, h: 0.01 })!;
    expect(c).toMatchObject({ x0: 6399, y0: 2199, width: 3, height: 3 });
    expect(c.bounds.e - c.bounds.w).toBeCloseTo(3 * 0.005, 9);
  });
  it("clamps to the image at the grid corner", () => {
    const c = cropWindow(IEM_USCOMP, { lat: 49.5, lon: -125.5 }, { w: 4, h: 3 })!;
    expect(c).toMatchObject({ x0: 0, y0: 0, width: 501, height: 401 });
    expect(c.bounds.w).toBeCloseTo(-126.0025, 6);
    expect(c.bounds.n).toBeCloseTo(50.0025, 6);
  });
  it("returns null when the box misses the grid entirely", () => {
    expect(cropWindow(IEM_USCOMP, { lat: 0, lon: 0 }, { w: 4, h: 3 })).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run test/radarN0q.test.ts test/radarCrop.test.ts`
Expected: FAIL, because the modules can't be resolved.

- [ ] **Step 3: Implement**

`kiosk/src/backend/radar/n0q.ts`:
```ts
// IEM's n0q national composite stores reflectivity as a palette INDEX, not a
// colour: 0 = no echo / missing, otherwise 0.5 dBZ steps from -32 dBZ.
// Verified against the PNG's own PLTE (test/radarN0q.test.ts). The glass
// fragment shader (frontend/map/glassShaders.ts) applies the same formula.
export const N0Q_NO_ECHO = 0;

export function n0qIndexToDbz(index: number): number | null {
  if (index === N0Q_NO_ECHO) return null;
  return -32 + 0.5 * index;
}
```

`kiosk/src/backend/radar/crop.ts`:
```ts
// Crop math for an equirectangular world-file grid. A world file gives the
// CENTRE of the upper-left pixel, so pixel edges sit half a pixel outward;
// the returned bounds are edges, which is what the frontend mesh needs.

export interface WorldGrid { ulLon: number; ulLat: number; deg: number; width: number; height: number }
export interface Bounds { n: number; s: number; e: number; w: number }
export interface CropWindow { x0: number; y0: number; width: number; height: number; bounds: Bounds }

/** IEM USCOMP n0q composite: n0q_0.wld = 0.005, 0, 0, -0.005, -126.0, 50.0. */
export const IEM_USCOMP: WorldGrid = { ulLon: -126, ulLat: 50, deg: 0.005, width: 12200, height: 5400 };

export function cropWindow(
  grid: WorldGrid,
  center: { lat: number; lon: number },
  span: { w: number; h: number },
): CropWindow | null {
  const westEdge = grid.ulLon - grid.deg / 2;
  const northEdge = grid.ulLat + grid.deg / 2;
  const x0 = Math.max(0, Math.floor((center.lon - span.w / 2 - westEdge) / grid.deg));
  const x1 = Math.min(grid.width, Math.ceil((center.lon + span.w / 2 - westEdge) / grid.deg));
  const y0 = Math.max(0, Math.floor((northEdge - (center.lat + span.h / 2)) / grid.deg));
  const y1 = Math.min(grid.height, Math.ceil((northEdge - (center.lat - span.h / 2)) / grid.deg));
  if (x1 <= x0 || y1 <= y0) return null;
  return {
    x0, y0, width: x1 - x0, height: y1 - y0,
    bounds: {
      w: westEdge + x0 * grid.deg,
      e: westEdge + x1 * grid.deg,
      n: northEdge - y0 * grid.deg,
      s: northEdge - y1 * grid.deg,
    },
  };
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx vitest run test/radarN0q.test.ts test/radarCrop.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/backend/radar/n0q.ts src/backend/radar/crop.ts test/radarN0q.test.ts test/radarCrop.test.ts
git commit -m "feat(radar): n0q dBZ scale and IEM grid crop window

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 2: Streaming indexed-PNG crop decoder

**Files:**
- Create: `kiosk/src/backend/radar/pngIndexed.ts`
- Test: `kiosk/test/pngIndexed.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `class PngFormatError extends Error`
  - `interface IndexedCrop { width: number; height: number; bytes: Uint8Array; imageWidth: number; imageHeight: number }`
  - `decodeIndexedCrop(png: Uint8Array, win: { x0: number; y0: number; width: number; height: number }): Promise<IndexedCrop>`. The bytes are row-major; row 0 is the northernmost row of the crop. It rejects with `PngFormatError` for a non-PNG, an unsupported format, or data that ends before the crop. It rejects with `RangeError` if the window falls outside the image.

- [ ] **Step 1: Write the failing tests**

`kiosk/test/pngIndexed.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { deflateSync } from "node:zlib";
import { decodeIndexedCrop, PngFormatError } from "../src/backend/radar/pngIndexed.js";

// Minimal indexed-PNG encoder for fixtures. CRCs are written as 0: the decoder
// doesn't check them (zlib's adler32 already covers the image data).
function chunk(type: string, data: Uint8Array): Buffer {
  const b = Buffer.alloc(12 + data.length);
  b.writeUInt32BE(data.length, 0);
  b.write(type, 4, "ascii");
  Buffer.from(data).copy(b, 8);
  return b;
}
function paeth(a: number, b: number, c: number): number {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}
function encode(w: number, h: number, px: Uint8Array, filterFor: (row: number) => number,
                opts: { color?: number; depth?: number } = {}): Buffer {
  const raw = Buffer.alloc(h * (w + 1));
  for (let y = 0; y < h; y++) {
    const f = filterFor(y);
    raw[y * (w + 1)] = f;
    for (let x = 0; x < w; x++) {
      const cur = px[y * w + x]!;
      const a = x > 0 ? px[y * w + x - 1]! : 0;
      const b = y > 0 ? px[(y - 1) * w + x]! : 0;
      const c = x > 0 && y > 0 ? px[(y - 1) * w + x - 1]! : 0;
      const pred = f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : paeth(a, b, c);
      raw[y * (w + 1) + 1 + x] = (cur - pred) & 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = opts.depth ?? 8; ihdr[9] = opts.color ?? 3; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("PLTE", new Uint8Array(768)),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", new Uint8Array(0)),
  ]);
}
function pixels(w: number, h: number, seed = 7): Uint8Array {
  const out = new Uint8Array(w * h);
  let s = seed;
  for (let i = 0; i < out.length; i++) { s = (s * 1103515245 + 12345) >>> 0; out[i] = s >>> 24; }
  return out;
}
function expectCrop(px: Uint8Array, w: number, win: { x0: number; y0: number; width: number; height: number }): Uint8Array {
  const out = new Uint8Array(win.width * win.height);
  for (let y = 0; y < win.height; y++)
    out.set(px.subarray((win.y0 + y) * w + win.x0, (win.y0 + y) * w + win.x0 + win.width), y * win.width);
  return out;
}

describe("decodeIndexedCrop", () => {
  const W = 37, H = 23, px = pixels(37, 23);

  for (const f of [0, 1, 2, 3, 4]) {
    it(`round-trips filter type ${f}`, async () => {
      const win = { x0: 0, y0: 0, width: W, height: H };
      const out = await decodeIndexedCrop(encode(W, H, px, () => f), win);
      expect(Buffer.from(out.bytes).equals(Buffer.from(px))).toBe(true);
      expect(out).toMatchObject({ width: W, height: H, imageWidth: W, imageHeight: H });
    });
  }

  it("decodes mixed per-row filters and an interior crop", async () => {
    const win = { x0: 5, y0: 4, width: 11, height: 9 };
    const out = await decodeIndexedCrop(encode(W, H, px, (y) => y % 5), win);
    expect(Buffer.from(out.bytes).equals(Buffer.from(expectCrop(px, W, win)))).toBe(true);
  });

  it("crops at the right/bottom image edges", async () => {
    const win = { x0: W - 4, y0: H - 3, width: 4, height: 3 };
    const out = await decodeIndexedCrop(encode(W, H, px, (y) => (y * 3) % 5), win);
    expect(Buffer.from(out.bytes).equals(Buffer.from(expectCrop(px, W, win)))).toBe(true);
  });

  it("stops early: a crop in the top rows survives a truncated tail", async () => {
    const big = pixels(400, 300, 11);
    const png = encode(400, 300, big, () => 4);
    // Find the IDAT payload and cut its last 40%: rows near the top are still intact.
    const idatAt = png.indexOf(Buffer.from("IDAT")) - 4;
    const len = png.readUInt32BE(idatAt);
    const cut = Math.floor(len * 0.6);
    const truncated = Buffer.concat([png.subarray(0, idatAt), (() => {
      const head = Buffer.alloc(8); head.writeUInt32BE(cut, 0); head.write("IDAT", 4, "ascii"); return head;
    })(), png.subarray(idatAt + 8, idatAt + 8 + cut), Buffer.alloc(4), chunk("IEND", new Uint8Array(0))]);
    const top = { x0: 10, y0: 2, width: 50, height: 20 };
    const out = await decodeIndexedCrop(truncated, top);
    expect(Buffer.from(out.bytes).equals(Buffer.from(expectCrop(big, 400, top)))).toBe(true);
    await expect(decodeIndexedCrop(truncated, { x0: 0, y0: 280, width: 10, height: 10 }))
      .rejects.toBeInstanceOf(Error);
  });

  it("rejects a non-PNG", async () => {
    await expect(decodeIndexedCrop(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]), { x0: 0, y0: 0, width: 1, height: 1 }))
      .rejects.toBeInstanceOf(PngFormatError);
  });

  it("rejects a non-palette or non-8-bit PNG (IEM changed format)", async () => {
    await expect(decodeIndexedCrop(encode(4, 4, pixels(4, 4), () => 0, { color: 2 }), { x0: 0, y0: 0, width: 1, height: 1 }))
      .rejects.toThrow(/unsupported PNG/);
    await expect(decodeIndexedCrop(encode(4, 4, pixels(4, 4), () => 0, { depth: 4 }), { x0: 0, y0: 0, width: 1, height: 1 }))
      .rejects.toThrow(/unsupported PNG/);
  });

  it("rejects a window outside the image", async () => {
    await expect(decodeIndexedCrop(encode(4, 4, pixels(4, 4), () => 0), { x0: 2, y0: 0, width: 3, height: 1 }))
      .rejects.toBeInstanceOf(RangeError);
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run test/pngIndexed.test.ts`
Expected: FAIL, because the module can't be resolved.

- [ ] **Step 3: Implement**

`kiosk/src/backend/radar/pngIndexed.ts`:
```ts
// Streaming crop decoder for 8-bit palette-indexed, non-interlaced PNGs (the
// IEM n0q composite). Inflate runs on the libuv threadpool via node:zlib; row
// un-filtering happens in the 'data' callbacks, so the event loop yields
// between ~64 KB chunks. It keeps only the crop window and destroys the stream
// once past the crop's last row, so a crop near the top of a 12200x5400 image
// never inflates the rest. Indices are returned raw (n0q.ts maps them to dBZ).
import { createInflate } from "node:zlib";

export class PngFormatError extends Error {}

export interface IndexedCrop {
  width: number;
  height: number;
  /** Row-major palette indices; row 0 is the crop's top (northern) row. */
  bytes: Uint8Array;
  imageWidth: number;
  imageHeight: number;
}

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

export function decodeIndexedCrop(
  png: Uint8Array,
  win: { x0: number; y0: number; width: number; height: number },
): Promise<IndexedCrop> {
  for (let i = 0; i < 8; i++) {
    if (png[i] !== SIGNATURE[i]) return Promise.reject(new PngFormatError("not a PNG"));
  }
  const dv = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let off = 8;
  let width = 0, height = 0;
  const idat: Uint8Array[] = [];
  while (off + 8 <= png.length) {
    const len = dv.getUint32(off);
    const type = String.fromCharCode(png[off + 4]!, png[off + 5]!, png[off + 6]!, png[off + 7]!);
    if (type === "IHDR") {
      width = dv.getUint32(off + 8);
      height = dv.getUint32(off + 12);
      const depth = png[off + 16], color = png[off + 17], interlace = png[off + 20];
      if (depth !== 8 || color !== 3 || interlace !== 0) {
        return Promise.reject(new PngFormatError(
          `unsupported PNG: depth ${depth} color ${color} interlace ${interlace}`));
      }
    } else if (type === "IDAT") {
      idat.push(png.subarray(off + 8, Math.min(png.length, off + 8 + len)));
    } else if (type === "IEND") {
      break;
    }
    off += 12 + len;
  }
  if (!width || !height) return Promise.reject(new PngFormatError("missing IHDR"));
  if (win.x0 < 0 || win.y0 < 0 || win.width <= 0 || win.height <= 0
      || win.x0 + win.width > width || win.y0 + win.height > height) {
    return Promise.reject(new RangeError("crop window outside the image"));
  }

  const stride = width + 1; // filter byte + one index per pixel
  const out = new Uint8Array(win.width * win.height);
  const rowBuf = new Uint8Array(stride);
  let prev = new Uint8Array(width);
  let cur = new Uint8Array(width);
  let fill = 0;
  let row = 0;
  const endRow = win.y0 + win.height; // exclusive

  function unfilter(): void {
    const f = rowBuf[0];
    for (let x = 0; x < width; x++) {
      const raw = rowBuf[x + 1]!;
      const a = x > 0 ? cur[x - 1]! : 0;
      const b = prev[x]!;
      const c = x > 0 ? prev[x - 1]! : 0;
      let v: number;
      switch (f) {
        case 0: v = raw; break;
        case 1: v = raw + a; break;
        case 2: v = raw + b; break;
        case 3: v = raw + ((a + b) >> 1); break;
        case 4: {
          const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          v = raw + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: throw new PngFormatError(`bad filter type ${f} on row ${row}`);
      }
      cur[x] = v & 255;
    }
  }

  function consume(chunk: Uint8Array): void {
    let i = 0;
    while (i < chunk.length && row < endRow) {
      const take = Math.min(stride - fill, chunk.length - i);
      rowBuf.set(chunk.subarray(i, i + take), fill);
      fill += take;
      i += take;
      if (fill === stride) {
        unfilter();
        if (row >= win.y0) out.set(cur.subarray(win.x0, win.x0 + win.width), (row - win.y0) * win.width);
        const t = prev; prev = cur; cur = t;
        row++;
        fill = 0;
      }
    }
  }

  return new Promise((resolve, reject) => {
    const inflate = createInflate();
    let settled = false;
    const finish = (err: Error | null): void => {
      if (settled) return;
      settled = true;
      inflate.removeAllListeners("data");
      inflate.destroy();
      if (err) reject(err);
      else resolve({ width: win.width, height: win.height, bytes: out, imageWidth: width, imageHeight: height });
    };
    inflate.on("data", (chunk: Buffer) => {
      if (settled) return;
      try { consume(chunk); } catch (err) { finish(err as Error); return; }
      if (row >= endRow) finish(null);
    });
    inflate.on("error", (err) => finish(row >= endRow ? null : err));
    inflate.on("end", () => finish(row >= endRow ? null : new PngFormatError("image data ended before the crop")));
    for (const d of idat) inflate.write(d);
    inflate.end();
  });
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx vitest run test/pngIndexed.test.ts`
Expected: PASS (11 tests).

- [ ] **Step 5: Smoke test against the real composite** (no commit; proves the 12200×5400 decode end to end)

```bash
cat > /tmp/claude-1000/radar-smoke.mjs <<'EOF'
import { decodeIndexedCrop } from "/home/kiosk/kerchunk-kiosk/kiosk/dist-smoke/radar/pngIndexed.js";
import { cropWindow, IEM_USCOMP } from "/home/kiosk/kerchunk-kiosk/kiosk/dist-smoke/radar/crop.js";
const png = new Uint8Array(await (await fetch("https://mesonet.agron.iastate.edu/data/gis/images/4326/USCOMP/n0q_0.png")).arrayBuffer());
const win = cropWindow(IEM_USCOMP, { lat: 39.1, lon: -94.58 }, { w: 4, h: 3 });
const t0 = performance.now();
const out = await decodeIndexedCrop(png, win);
const hist = new Map(); for (const v of out.bytes) hist.set(v, (hist.get(v) ?? 0) + 1);
console.log({ ms: Math.round(performance.now() - t0), w: out.width, h: out.height, img: [out.imageWidth, out.imageHeight], echoPx: out.bytes.length - (hist.get(0) ?? 0), maxIndex: Math.max(...hist.keys()) });
EOF
npx tsc src/backend/radar/pngIndexed.ts src/backend/radar/crop.ts --outDir dist-smoke/radar --module nodenext --target es2022 && node /tmp/claude-1000/radar-smoke.mjs; rm -rf dist-smoke
```
Expected: `img: [12200, 5400]`, `w: 801, h: 601`, and `ms` well under 2000. `echoPx` is >0 if it's raining in the box.

- [ ] **Step 6: Commit**

```bash
git add src/backend/radar/pngIndexed.ts test/pngIndexed.test.ts
git commit -m "feat(radar): streaming indexed-PNG crop decoder (no new deps)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 3: RadarFeed

**Files:**
- Create: `kiosk/src/backend/radar/RadarFeed.ts`
- Test: `kiosk/test/radarFeed.test.ts`

**Interfaces:**
- Consumes: `cropWindow`, `IEM_USCOMP`, `Bounds` (Task 1); `decodeIndexedCrop` (Task 2).
- Produces:
```ts
export interface RadarScan { scanTime: number; fetchedAt: number; bounds: Bounds; width: number; height: number; bytes: Uint8Array; gz: Buffer }
export interface RadarSource {
  latest(): RadarScan | null;
  isStale(now?: number): boolean;
  onScan(cb: (scan: RadarScan) => void): void;
  start(): void;
  stop(): void;
}
export interface RadarFetchResponse { ok: boolean; status: number; json(): Promise<unknown>; arrayBuffer(): Promise<ArrayBuffer> }
export interface RadarFeedOpts {
  center: { lat: number; lon: number };
  span: { w: number; h: number };
  refreshMs: number;
  staleMs: number;
  baseUrl?: string;                                        // default IEM_N0Q_BASE
  fetcher?: (url: string) => Promise<RadarFetchResponse>;
  now?: () => number;
}
export const IEM_N0Q_BASE = "https://mesonet.agron.iastate.edu/data/gis/images/4326/USCOMP/n0q_0";
export class RadarFeed implements RadarSource { pollOnce(): Promise<void>; /* + RadarSource */ }
```

- [ ] **Step 1: Write the failing tests**

`kiosk/test/radarFeed.test.ts`:
```ts
import { describe, it, expect, vi } from "vitest";
import { deflateSync, gunzipSync } from "node:zlib";
import { RadarFeed, type RadarFetchResponse } from "../src/backend/radar/RadarFeed.js";

// A full-size-header fixture would be 66 MB; instead the feed is pointed at a
// small grid via the `grid` test hook so a 40x30 PNG stands in for USCOMP.
const GRID = { ulLon: -100, ulLat: 42, deg: 0.1, width: 40, height: 30 };

function png(w: number, h: number, fillIndex: number): Buffer {
  const raw = Buffer.alloc(h * (w + 1));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw[y * (w + 1) + 1 + x] = fillIndex;
  const chunk = (t: string, d: Buffer) => { const b = Buffer.alloc(12 + d.length); b.writeUInt32BE(d.length, 0); b.write(t, 4, "ascii"); d.copy(b, 8); return b; };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 3;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("PLTE", Buffer.alloc(768)), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
const meta = (valid: string): RadarFetchResponse => ({ ok: true, status: 200, json: async () => ({ meta: { valid } }), arrayBuffer: async () => new ArrayBuffer(0) });
const image = (b: Buffer): RadarFetchResponse => ({ ok: true, status: 200, json: async () => ({}), arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer });

function makeFeed(responses: Record<string, () => RadarFetchResponse | Promise<RadarFetchResponse>>, now = () => Date.parse("2026-10-01T20:00:00Z")) {
  const fetcher = vi.fn(async (url: string) => {
    const key = url.endsWith(".json") ? "json" : "png";
    const r = responses[key];
    if (!r) throw new Error(`no fixture for ${key}`);
    return r();
  });
  const feed = new RadarFeed({
    center: { lat: 40.5, lon: -98 }, span: { w: 1, h: 1 }, refreshMs: 300_000, staleMs: 1_200_000,
    fetcher, now, grid: GRID,
  });
  return { feed, fetcher };
}

describe("RadarFeed", () => {
  it("fetches meta then the image, crops, and emits one scan", async () => {
    const { feed, fetcher } = makeFeed({ json: () => meta("2026-10-01T19:55:00Z"), png: () => image(png(40, 30, 120)) });
    const seen: number[] = [];
    feed.onScan((s) => seen.push(s.scanTime));
    await feed.pollOnce();
    const s = feed.latest()!;
    expect(s.scanTime).toBe(Date.parse("2026-10-01T19:55:00Z"));
    expect(s.width * s.height).toBe(s.bytes.length);
    expect(s.bytes.every((v) => v === 120)).toBe(true);
    expect(gunzipSync(s.gz).equals(Buffer.from(s.bytes))).toBe(true);
    expect(seen).toEqual([s.scanTime]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("an unchanged meta.valid skips the image download and emits nothing", async () => {
    const { feed, fetcher } = makeFeed({ json: () => meta("2026-10-01T19:55:00Z"), png: () => image(png(40, 30, 120)) });
    const seen: number[] = [];
    feed.onScan((s) => seen.push(s.scanTime));
    await feed.pollOnce();
    await feed.pollOnce();
    expect(fetcher.mock.calls.filter(([u]) => String(u).endsWith(".png"))).toHaveLength(1);
    expect(seen).toHaveLength(1);
  });

  it("malformed meta keeps the last scan and does not download", async () => {
    let body: unknown = { meta: { valid: "2026-10-01T19:55:00Z" } };
    const { feed, fetcher } = makeFeed({
      json: () => ({ ok: true, status: 200, json: async () => body, arrayBuffer: async () => new ArrayBuffer(0) }),
      png: () => image(png(40, 30, 120)),
    });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await feed.pollOnce();
    body = { nope: true };
    await feed.pollOnce();
    expect(feed.latest()!.scanTime).toBe(Date.parse("2026-10-01T19:55:00Z"));
    expect(fetcher.mock.calls.filter(([u]) => String(u).endsWith(".png"))).toHaveLength(1);
    err.mockRestore();
  });

  it("an image whose dimensions no longer match the grid keeps the previous scan", async () => {
    let valid = "2026-10-01T19:55:00Z", img = png(40, 30, 120);
    const { feed } = makeFeed({ json: () => meta(valid), png: () => image(img) });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await feed.pollOnce();
    valid = "2026-10-01T20:00:00Z"; img = png(50, 30, 200);
    await feed.pollOnce();
    expect(feed.latest()!.scanTime).toBe(Date.parse("2026-10-01T19:55:00Z"));
    expect(feed.latest()!.bytes[0]).toBe(120);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it("HTTP errors and throws keep the last scan; logs once per failure streak", async () => {
    let fail = false;
    const { feed } = makeFeed({
      json: () => (fail ? { ok: false, status: 503, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) } : meta("2026-10-01T19:55:00Z")),
      png: () => image(png(40, 30, 120)),
    });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await feed.pollOnce();
    fail = true;
    await feed.pollOnce();
    await feed.pollOnce();
    expect(feed.latest()).not.toBeNull();
    expect(err).toHaveBeenCalledTimes(1);
    err.mockRestore();
  });

  it("isStale: true with no scan, flips true past staleMs after scanTime", async () => {
    let t = Date.parse("2026-10-01T20:00:00Z");
    const { feed } = makeFeed({ json: () => meta("2026-10-01T19:55:00Z"), png: () => image(png(40, 30, 1)) }, () => t);
    expect(feed.isStale()).toBe(true);
    await feed.pollOnce();
    expect(feed.isStale()).toBe(false);
    t = Date.parse("2026-10-01T19:55:00Z") + 1_200_001;
    expect(feed.isStale()).toBe(true);
  });

  it("a crop box that misses the grid never fetches", async () => {
    const fetcher = vi.fn();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const feed = new RadarFeed({ center: { lat: 0, lon: 0 }, span: { w: 1, h: 1 }, refreshMs: 1, staleMs: 1, fetcher, grid: GRID });
    await feed.pollOnce();
    expect(fetcher).not.toHaveBeenCalled();
    expect(feed.latest()).toBeNull();
    err.mockRestore();
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run test/radarFeed.test.ts`
Expected: FAIL, because the module can't be resolved.

- [ ] **Step 3: Implement**

`kiosk/src/backend/radar/RadarFeed.ts`:
```ts
// Live NEXRAD for the kiosk's Weather Glass layer (spec 2026-10-01). Polls
// IEM's tiny n0q_0.json for the scan time and downloads the 4.6 MB national
// composite only when it advances, decoding just the crop around the QTH. A
// failure of any kind keeps the last good scan: staleness (not an error) is
// what makes the frontend fade radar out, so old weather is never shown as
// current. Lifecycle mirrors AircraftFeed: start/stop + an injectable fetcher.
import { gzip } from "node:zlib";
import { promisify } from "node:util";
import { cropWindow, IEM_USCOMP, type Bounds, type CropWindow, type WorldGrid } from "./crop.js";
import { decodeIndexedCrop } from "./pngIndexed.js";

const gzipAsync = promisify(gzip);
const FETCH_TIMEOUT_MS = 60_000;

export const IEM_N0Q_BASE = "https://mesonet.agron.iastate.edu/data/gis/images/4326/USCOMP/n0q_0";

export interface RadarScan {
  scanTime: number;
  fetchedAt: number;
  bounds: Bounds;
  width: number;
  height: number;
  /** Raw n0q indices, row-major, north row first. */
  bytes: Uint8Array;
  /** `bytes`, gzip'd once per scan for /api/radar/frame. */
  gz: Buffer;
}

export interface RadarSource {
  latest(): RadarScan | null;
  isStale(now?: number): boolean;
  onScan(cb: (scan: RadarScan) => void): void;
  start(): void;
  stop(): void;
}

export interface RadarFetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface RadarFeedOpts {
  center: { lat: number; lon: number };
  span: { w: number; h: number };
  refreshMs: number;
  staleMs: number;
  baseUrl?: string;
  fetcher?: (url: string) => Promise<RadarFetchResponse>;
  now?: () => number;
  /** Test hook: the source grid (defaults to IEM USCOMP). */
  grid?: WorldGrid;
}

export class RadarFeed implements RadarSource {
  private readonly win: CropWindow | null;
  private readonly grid: WorldGrid;
  private readonly base: string;
  private readonly refreshMs: number;
  private readonly staleMs: number;
  private readonly fetcher: (url: string) => Promise<RadarFetchResponse>;
  private readonly now: () => number;
  private scan: RadarScan | null = null;
  private cb: ((scan: RadarScan) => void) | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;
  private failStreak = 0;

  constructor(opts: RadarFeedOpts) {
    this.grid = opts.grid ?? IEM_USCOMP;
    this.win = cropWindow(this.grid, opts.center, opts.span);
    if (!this.win) console.error("[radar] crop box is outside the radar grid; radar disabled");
    this.base = opts.baseUrl ?? IEM_N0Q_BASE;
    this.refreshMs = opts.refreshMs;
    this.staleMs = opts.staleMs;
    this.fetcher = opts.fetcher ?? ((u) => fetch(u, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }));
    this.now = opts.now ?? Date.now;
  }

  latest(): RadarScan | null { return this.scan; }

  isStale(now = this.now()): boolean {
    return !this.scan || now - this.scan.scanTime > this.staleMs;
  }

  onScan(cb: (scan: RadarScan) => void): void { this.cb = cb; }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.loop();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  }

  /** One meta check (+ download when the scan advanced). Public for tests. */
  async pollOnce(): Promise<void> {
    const win = this.win;
    if (!win) return;
    try {
      const metaRes = await this.fetcher(`${this.base}.json`);
      if (!metaRes.ok) throw new Error(`meta HTTP ${metaRes.status}`);
      const body = await metaRes.json() as { meta?: { valid?: unknown } };
      const scanTime = typeof body?.meta?.valid === "string" ? Date.parse(body.meta.valid) : NaN;
      if (!Number.isFinite(scanTime)) throw new Error("meta.valid missing or unparseable");
      if (this.scan && scanTime <= this.scan.scanTime) { this.failStreak = 0; return; }

      const imgRes = await this.fetcher(`${this.base}.png`);
      if (!imgRes.ok) throw new Error(`image HTTP ${imgRes.status}`);
      const crop = await decodeIndexedCrop(new Uint8Array(await imgRes.arrayBuffer()), win);
      if (crop.imageWidth !== this.grid.width || crop.imageHeight !== this.grid.height) {
        throw new Error(`image is ${crop.imageWidth}x${crop.imageHeight}, grid expects ${this.grid.width}x${this.grid.height}`);
      }
      const gz = await gzipAsync(crop.bytes);
      this.scan = {
        scanTime, fetchedAt: this.now(), bounds: win.bounds,
        width: crop.width, height: crop.height, bytes: crop.bytes, gz,
      };
      this.failStreak = 0;
      this.cb?.(this.scan);
    } catch (err) {
      this.failStreak++;
      if (this.failStreak === 1) {
        console.error(`[radar] feed error: ${err instanceof Error ? err.message : String(err)}`.slice(0, 200));
      }
    }
  }

  private async loop(): Promise<void> {
    if (this.stopped) return;
    await this.pollOnce();
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.loop(), this.refreshMs);
    this.timer.unref?.();
  }
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx vitest run test/radarFeed.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/backend/radar/RadarFeed.ts test/radarFeed.test.ts
git commit -m "feat(radar): RadarFeed — meta-gated n0q download, crop, stale tracking

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 4: Config, routes, WS event, boot wiring, API docs

**Files:**
- Modify: `kiosk/src/backend/config/schema.ts` (inside `display: z.object({...})`, after `radarProduct`)
- Modify: `kiosk/src/backend/engine/ScannerEngine.ts` (`EngineEvent` union, next to `aircraft`)
- Modify: `kiosk/src/backend/server.ts` (`ServerDeps`, the routes near `/api/weather`, the wiring next to the aircraft block at the end of `createServer`)
- Modify: `kiosk/src/backend/index.ts` (next to `aircraftFeed`)
- Modify: `docs/API.md`
- Test: `kiosk/test/radarRoutes.test.ts`, `kiosk/test/schema.test.ts`

**Interfaces:**
- Consumes: `RadarSource`, `RadarScan`, `RadarFeed` (Task 3).
- Produces:
  - `ServerDeps.radar?: RadarSource`
  - `GET /api/radar` → `{ scanTime, fetchedAt, bounds:{n,s,e,w}, width, height, stale }`, or 404 (disabled) / 503 (no scan yet)
  - `GET /api/radar/frame` → gzip'd raw bytes, `ETag: "<scanTime>"`, 304 on match
  - WS event `{ type: "radar"; scanTime: number; ts: number }`
  - `config.display.radar: { enabled: boolean; refreshMs: number; staleMs: number; spanDeg: { w: number; h: number } }` (always present once `display` exists)

- [ ] **Step 1: Write the failing tests**

Append to `kiosk/test/schema.test.ts` (inside the file, as a new `describe`):
```ts
describe("display.radar", () => {
  const base = () => ({ ...defaultConfig(), display: { weatherLat: 39.1, weatherLon: -94.58 } });
  it("fills every default when absent", () => {
    const cfg = configSchema.parse(base());
    expect(cfg.display!.radar).toEqual({ enabled: true, refreshMs: 300_000, staleMs: 1_200_000, spanDeg: { w: 4, h: 3 } });
  });
  it("keeps operator overrides and fills the rest", () => {
    const cfg = configSchema.parse({ ...base(), display: { ...base().display, radar: { enabled: false, spanDeg: { w: 6 } } } });
    expect(cfg.display!.radar).toEqual({ enabled: false, refreshMs: 300_000, staleMs: 1_200_000, spanDeg: { w: 6, h: 3 } });
  });
  it("rejects a refresh faster than one minute (IEM updates every 5)", () => {
    expect(() => configSchema.parse({ ...base(), display: { ...base().display, radar: { refreshMs: 1000 } } })).toThrow();
  });
});
```

`kiosk/test/radarRoutes.test.ts`:
```ts
import { describe, it, expect, afterEach } from "vitest";
import request from "supertest";
import type { Response as SuperAgentResponse } from "superagent";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { createServer } from "../src/backend/server.js";
import { ConfigStore } from "../src/backend/config/ConfigStore.js";
import { ActivityLog } from "../src/backend/activityLog.js";
import { WsHub } from "../src/backend/ws.js";
import { FakeEngine } from "../src/backend/engine/FakeEngine.js";
import type { RadarScan, RadarSource } from "../src/backend/radar/RadarFeed.js";
import type { EngineEvent } from "../src/backend/engine/ScannerEngine.js";

function binaryParser(res: SuperAgentResponse, cb: (err: Error | null, body: Buffer) => void): void {
  res.setEncoding("binary");
  let data = "";
  res.on("data", (c: string) => { data += c; });
  res.on("end", () => cb(null, Buffer.from(data, "binary")));
}
// superagent normally inflates gzip before the parser; tolerate either.
const maybeGunzip = (b: Buffer): Buffer => (b[0] === 0x1f && b[1] === 0x8b ? gunzipSync(b) : b);

class FakeRadar implements RadarSource {
  scan: RadarScan | null = null;
  stale = false;
  started = false;
  private cb: ((s: RadarScan) => void) | null = null;
  latest() { return this.scan; }
  isStale() { return this.stale; }
  onScan(cb: (s: RadarScan) => void) { this.cb = cb; }
  start() { this.started = true; }
  stop() {}
  fire(s: RadarScan) { this.scan = s; this.cb?.(s); }
}
const scanOf = (scanTime: number): RadarScan => {
  const bytes = new Uint8Array([0, 104, 120, 255, 64, 1]);
  return { scanTime, fetchedAt: scanTime + 5, bounds: { n: 40, s: 39, e: -94, w: -95 }, width: 3, height: 2, bytes, gz: gzipSync(bytes) };
};

let dir: string;
function makeApp(radar?: RadarSource) {
  dir = mkdtempSync(join(tmpdir(), "kradar-"));
  const wsHub = new WsHub();
  const sent: EngineEvent[] = [];
  const realBroadcast = wsHub.broadcast.bind(wsHub);
  wsHub.broadcast = (e: EngineEvent) => { sent.push(e); realBroadcast(e); };
  const { server } = createServer({
    configStore: new ConfigStore(join(dir, "config.json")), engine: new FakeEngine(),
    activityLog: new ActivityLog(100), wsHub, staticDir: dir, ...(radar ? { radar } : {}),
  });
  return { server, sent };
}
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("radar routes", () => {
  it("404 when radar is disabled (no source)", async () => {
    const { server } = makeApp();
    expect((await request(server).get("/api/radar")).status).toBe(404);
    expect((await request(server).get("/api/radar/frame")).status).toBe(404);
  });

  it("503 before the first scan", async () => {
    const { server } = makeApp(new FakeRadar());
    expect((await request(server).get("/api/radar")).status).toBe(503);
    expect((await request(server).get("/api/radar/frame")).status).toBe(503);
  });

  it("meta reports the scan and the stale flag", async () => {
    const radar = new FakeRadar();
    radar.scan = scanOf(1_790_000_000_000);
    radar.stale = true;
    const { server } = makeApp(radar);
    const res = await request(server).get("/api/radar");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ scanTime: 1_790_000_000_000, fetchedAt: 1_790_000_000_005, bounds: { n: 40, s: 39, e: -94, w: -95 }, width: 3, height: 2, stale: true });
  });

  it("frame serves the gzip'd bytes with an ETag, 304 on match", async () => {
    const radar = new FakeRadar();
    radar.scan = scanOf(1_790_000_000_000);
    const { server } = makeApp(radar);
    const res = await request(server).get("/api/radar/frame").buffer(true).parse(binaryParser);
    expect(res.status).toBe(200);
    expect(res.headers["content-encoding"]).toBe("gzip");
    expect(res.headers["content-type"]).toBe("application/octet-stream");
    expect(res.headers.etag).toBe('"1790000000000"');
    expect(maybeGunzip(res.body as Buffer).equals(Buffer.from([0, 104, 120, 255, 64, 1]))).toBe(true);
    const again = await request(server).get("/api/radar/frame").set("If-None-Match", '"1790000000000"');
    expect(again.status).toBe(304);
  });

  it("starts the feed and broadcasts a radar event per new scan", async () => {
    const radar = new FakeRadar();
    const { sent } = makeApp(radar);
    expect(radar.started).toBe(true);
    radar.fire(scanOf(42));
    expect(sent.filter((e) => e.type === "radar")).toEqual([expect.objectContaining({ type: "radar", scanTime: 42 })]);
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run test/radarRoutes.test.ts test/schema.test.ts`
Expected: FAIL, because `radar` isn't a `ServerDeps` key and the routes return the SPA/404, and the schema has no `display.radar`.

- [ ] **Step 3: Implement the schema**

In `kiosk/src/backend/config/schema.ts`, directly after the `radarProduct: z...optional(),` field inside `display`, add:
```ts
    // Live NEXRAD for the Weather Glass layer (backend/radar/RadarFeed.ts).
    // Read at boot like aircraft.*: changing it needs a kerchunk-kiosk restart.
    // spanDeg is the crop box around the QTH (degrees lon x lat); it must
    // cover the home framing plus the camera push.
    radar: z.object({
      enabled: z.boolean().default(true),
      refreshMs: z.number().int().min(60_000).default(300_000),
      staleMs: z.number().int().min(60_000).default(1_200_000),
      spanDeg: z.object({
        w: z.number().positive().max(20).default(4),
        h: z.number().positive().max(15).default(3),
      }).default({}),
    }).default({}),
```

- [ ] **Step 4: Implement the event type**

In `kiosk/src/backend/engine/ScannerEngine.ts`, add directly after the `aircraft` member of `EngineEvent`:
```ts
  // A new radar scan landed in RadarFeed (Weather Glass): the page fetches
  // /api/radar/frame once. Synthesized by the server, like "aircraft".
  | { type: "radar"; scanTime: number; ts: number }
```

- [ ] **Step 5: Implement the server deps, routes and wiring**

In `kiosk/src/backend/server.ts`:
- Add the import: `import type { RadarSource } from "./radar/RadarFeed.js";`
- Add to `ServerDeps`, after `aircraftFeed?`:
```ts
  /** Live NEXRAD crop for the Weather Glass layer (off when display.radar.enabled is false). */
  radar?: RadarSource;
```
- Directly before the `if (method === "GET" && path === "/api/weather")` route, add:
```ts
    if (method === "GET" && (path === "/api/radar" || path === "/api/radar/frame")) {
      if (!deps.radar) return json(res, 404, { error: "radar disabled" });
      const scan = deps.radar.latest();
      if (!scan) return json(res, 503, { error: "no radar scan yet" });
      if (path === "/api/radar") {
        return json(res, 200, {
          scanTime: scan.scanTime, fetchedAt: scan.fetchedAt, bounds: scan.bounds,
          width: scan.width, height: scan.height, stale: deps.radar.isStale(),
        });
      }
      const etag = `"${scan.scanTime}"`;
      if (req.headers["if-none-match"] === etag) { res.writeHead(304, { etag }); res.end(); return; }
      res.writeHead(200, {
        "content-type": "application/octet-stream", "content-encoding": "gzip",
        etag, "cache-control": "no-cache",
      });
      res.end(scan.gz);
      return;
    }
```
- Directly after the aircraft block at the end of `createServer` (before `return { server, getConfig ... }`), add:
```ts
  // Radar: announce each new scan so pages fetch the frame once per scan.
  if (deps.radar) {
    deps.radar.onScan((scan) => {
      deps.wsHub.broadcast({ type: "radar", scanTime: scan.scanTime, ts: Date.now() });
    });
    deps.radar.start();
    server.on("close", () => deps.radar?.stop());
  }
```

- [ ] **Step 6: Implement the boot wiring**

In `kiosk/src/backend/index.ts`:
- Add the import: `import { RadarFeed } from "./radar/RadarFeed.js";`
- After the `aircraftFeed` declaration, add:
```ts
// Live NEXRAD crop for the Weather Glass layer, centred on the QTH. On by
// default whenever a QTH is configured; display.radar.enabled=false opts out.
const radarCfg = config.display?.radar;
const radar = config.display && radarCfg?.enabled
  ? new RadarFeed({
      center: { lat: config.display.weatherLat, lon: config.display.weatherLon },
      span: radarCfg.spanDeg,
      refreshMs: radarCfg.refreshMs,
      staleMs: radarCfg.staleMs,
    })
  : undefined;
```
- In the `createServer({ ... })` call, change `lookup, weather, history, aircraftFeed,` to `lookup, weather, history, aircraftFeed, radar,`.
- In the shutdown section where `aircraftFeed?.stop();` appears, add `radar?.stop();` beside it.

- [ ] **Step 7: Run the tests and confirm they pass, then typecheck**

Run: `npx vitest run test/radarRoutes.test.ts test/schema.test.ts && npm run typecheck`
Expected: PASS, typecheck clean.

- [ ] **Step 8: Document the routes**

In `docs/API.md`, add these rows to the end of the "Telemetry, history & lookups" table:
```markdown
| GET | `/api/radar` | Latest NEXRAD crop for the Weather Glass layer: `{ scanTime, fetchedAt, bounds:{n,s,e,w}, width, height, stale }` (`404` when `display.radar.enabled` is false, `503` before the first scan). Source: IEM n0q national composite, cropped to `display.radar.spanDeg` around the QTH. |
| GET | `/api/radar/frame` | The crop's raw n0q indices (`width·height` bytes, row-major, north row first; index 0 = no echo, else dBZ = −32 + 0.5·index), gzip'd, `ETag: "<scanTime>"` (`304` on `If-None-Match`). |
```
In the "WebSocket `/ws`" section, add `radar` to the event list (after `aircraft`), and append this sentence to that paragraph: "`radar` (`{ scanTime }`) fires once per new NEXRAD scan; pages then fetch `/api/radar/frame`."

- [ ] **Step 9: Run the full suite**

Run: `npm test && npm run typecheck`
Expected: all pass.

- [ ] **Step 10: Commit**

```bash
git add src/backend/config/schema.ts src/backend/engine/ScannerEngine.ts src/backend/server.ts src/backend/index.ts test/radarRoutes.test.ts test/schema.test.ts ../docs/API.md
git commit -m "feat(radar): /api/radar + /api/radar/frame, radar WS event, display.radar knobs

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 5: Ship PR 1

- [ ] **Step 1: Definition-of-done checks**

Run: `npm test && npm run test:native && npm run typecheck && npm run build`
Expected: all pass.

- [ ] **Step 2: Deploy (backend change, so a restart is warranted)**

Run: `sudo systemctl restart kerchunk-kiosk`, then poll until the first scan lands (up to ~30 s): `curl -s localhost:8080/api/radar` until it returns 200.
Expected: JSON with `width: 801, height: 601`, bounds ≈ `{n:40.6025,s:37.5975,e:-92.5775,w:-96.5825}` (for the configured QTH), `stale: false`, and a `scanTime` within 15 min of now.

- [ ] **Step 3: Prove the data is real and registered**

Render the crop to a PNG, then compare echo positions against the current tile layer on the wall:
```bash
curl -s --compressed localhost:8080/api/radar/frame -o /tmp/claude-1000/frame.bin
node -e '
const fs=require("fs"),zlib=require("zlib");const b=fs.readFileSync("/tmp/claude-1000/frame.bin");
const W=801,H=601;if(b.length!==W*H)throw new Error("len "+b.length);
const raw=Buffer.alloc(H*(W*4+1));for(let y=0;y<H;y++){raw[y*(W*4+1)]=0;for(let x=0;x<W;x++){const v=b[y*W+x],d=v?-32+v/2:-99,o=y*(W*4+1)+1+x*4;
const c=d<15?[0,0,0,0]:d<35?[90,200,170,255]:d<50?[255,184,80,255]:[255,80,130,255];c.forEach((k,i)=>raw[o+i]=k);}}
const ch=(t,d)=>{const l=Buffer.alloc(4),c=Buffer.alloc(4);l.writeUInt32BE(d.length);c.writeUInt32BE(zlib.crc32(Buffer.concat([Buffer.from(t),d])));return Buffer.concat([l,Buffer.from(t),d,c])};
const ih=Buffer.alloc(13);ih.writeUInt32BE(W,0);ih.writeUInt32BE(H,4);ih[8]=8;ih[9]=6;
fs.writeFileSync("/home/kiosk/radar-crop.png",Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),ch("IHDR",ih),ch("IDAT",zlib.deflateSync(raw)),ch("IEND",Buffer.alloc(0))]));'
XDG_RUNTIME_DIR=/run/user/1000 WAYLAND_DISPLAY=wayland-0 grim /tmp/claude-1000/kiosk.png
```
Read both PNGs. The ≥15 dBZ cells in `radar-crop.png` (north up; the box spans the bounds above) must match the shape and position of the yellow/red cells on the live wall's tile radar. If there's no echo ≥15 dBZ anywhere in the box, say so in the PR and use the `maxIndex` / `echoPx` numbers from Task 2 Step 5 instead.

- [ ] **Step 4: Confirm the external consumer routes are unchanged**

Run: `curl -s localhost:8080/api/status | head -c 200; curl -s localhost:8080/api/weather | head -c 200`
Expected: the same shape as before. `/api/logs` is untouched by this PR.

- [ ] **Step 5: Push, open the PR, merge, clean up**

```bash
git push -u origin feat/radar-feed
gh pr create --title "feat(radar): real NEXRAD crop feed for Weather Glass (PR 1/4)" --body "$(cat <<'EOF'
Backend half of the Weather Glass radar (spec: docs/superpowers/specs/2026-10-01-weather-glass-design.md).

- RadarFeed polls IEM n0q_0.json; downloads the 4.6 MB composite only when meta.valid advances
- Streaming indexed-PNG crop decoder (node:zlib, no deps), early-stops past the crop
- GET /api/radar, GET /api/radar/frame (gzip, ETag), WS {type:"radar"}
- Nothing visible yet — the frontend layer is PR 2

Knobs: `display.radar.{enabled (true), refreshMs (300000), staleMs (1200000), spanDeg ({w:4,h:3})}` in src/backend/config/schema.ts — read at boot, restart kerchunk-kiosk after changing.

Proof: <paste curl /api/radar output + the crop-vs-wall comparison>

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
gh pr merge <n> --merge --delete-branch && git checkout main && git pull --ff-only && git fetch --prune && git branch -d feat/radar-feed
```

---

## PR 2 — Glass layer: haze + real radar

Start: `git checkout main && git pull --ff-only && git checkout -b feat/glass-radar`

### Task 6: glassMath — shared types and pure helpers

**Files:**
- Create: `kiosk/src/frontend/map/glassMath.ts`
- Test: `kiosk/test/glassMath.test.ts`

**Interfaces:**
- Produces:
```ts
export type Rgb = readonly [number, number, number];          // 0..1
export interface Front { id: string; key: string; lat: number; lng: number; radiusM: number; color: Rgb;
  ageMs: number; grow: number; bright: number; releasing: number }
export interface Glow { key: string; lat: number; lng: number; radiusM: number; color: Rgb; strength: number }
export interface GlassFrame { fronts: Front[]; glows: Glow[]; growing: boolean }
export const EMPTY_FRAME: GlassFrame;
export const MAX_FRONTS = 8;
export const MAX_GLOWS = 32;
export function fadeProgress(startMs: number, now: number, durMs: number): number;   // clamp 0..1; dur<=0 → 1
export function easeOutCubic(t: number): number;
export function mercatorOffsetM(lat: number, lng: number, anchor: { lat: number; lng: number }): [number, number]; // [east, north] m
export function clipToPx(m: ArrayLike<number>, x: number, y: number, z: number, w: number, h: number): [number, number] | null;
export function hexToGlowRgb(hex: string): Rgb;                // ×1.15, clamped to 1
```

- [ ] **Step 1: Write the failing tests**

`kiosk/test/glassMath.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { fadeProgress, easeOutCubic, mercatorOffsetM, clipToPx, hexToGlowRgb, EMPTY_FRAME, MAX_FRONTS, MAX_GLOWS } from "../src/frontend/map/glassMath.js";

describe("glassMath", () => {
  it("fadeProgress clamps and treats a zero duration as done", () => {
    expect(fadeProgress(1000, 500, 100)).toBe(0);
    expect(fadeProgress(1000, 1050, 100)).toBe(0.5);
    expect(fadeProgress(1000, 9999, 100)).toBe(1);
    expect(fadeProgress(1000, 1000, 0)).toBe(1);
  });
  it("easeOutCubic is 0 at 0, 1 at 1, fast early", () => {
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(1)).toBe(1);
    expect(easeOutCubic(0.5)).toBeCloseTo(0.875, 9);
  });
  it("mercatorOffsetM: metres east/north of the anchor in Google's local frame", () => {
    const a = { lat: 39, lng: -94 };
    const [e0, n0] = mercatorOffsetM(39, -94, a);
    expect(e0).toBeCloseTo(0, 6); expect(n0).toBeCloseTo(0, 6);
    const [e1, n1] = mercatorOffsetM(39, -93.99, a);
    expect(e1).toBeCloseTo(865.11, 1); expect(n1).toBeCloseTo(0, 6);
    const [, n2] = mercatorOffsetM(39.01, -94, a);
    expect(n2).toBeCloseTo(1113.27, 1);
    const [, n3] = mercatorOffsetM(41, -94, a);   // Mercator stretch, not a flat 222 km
    expect(n3).toBeCloseTo(225893.09, 0);
  });
  it("clipToPx projects through a column-major matrix and drops points behind the camera", () => {
    const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    expect(clipToPx(identity, 0, 0, 0, 200, 100)).toEqual([100, 50]);
    expect(clipToPx(identity, 1, 1, 0, 200, 100)).toEqual([200, 100]);
    const scaleX2 = [2, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    expect(clipToPx(scaleX2, 0.25, 0, 0, 200, 100)).toEqual([150, 50]);
    const behind = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1];
    expect(clipToPx(behind, 0, 0, 0, 200, 100)).toBeNull();
  });
  it("hexToGlowRgb lifts by 15% and clamps", () => {
    const [r, g, b] = hexToGlowRgb("#6D28D9");
    expect(r).toBeCloseTo((0x6d / 255) * 1.15, 6);
    expect(g).toBeCloseTo((0x28 / 255) * 1.15, 6);
    expect(b).toBe(1);
  });
  it("exports the empty frame and the shader caps", () => {
    expect(EMPTY_FRAME).toEqual({ fronts: [], glows: [], growing: false });
    expect([MAX_FRONTS, MAX_GLOWS]).toEqual([8, 32]);
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run test/glassMath.test.ts`
Expected: FAIL, because the module can't be resolved.

- [ ] **Step 3: Implement**

`kiosk/src/frontend/map/glassMath.ts`:
```ts
// Pure helpers + shared types for the Weather Glass layer (spec 2026-10-01).
// No DOM, no GL — everything here is unit-tested headless.

export type Rgb = readonly [number, number, number];

/** One live transmission as the shader sees it. */
export interface Front {
  id: string; key: string; lat: number; lng: number; radiusM: number; color: Rgb;
  /** ms since key-up (drives the 300 ms core flash). */
  ageMs: number;
  /** Eased 0..1 expand progress. */
  grow: number;
  /** 0..1 rim brightness (audible channel: live signal dBFS). */
  bright: number;
  /** 0 = live, 1 = fully dissolved into its afterglow. */
  releasing: number;
}

/** A released site's fading footprint. */
export interface Glow { key: string; lat: number; lng: number; radiusM: number; color: Rgb; strength: number }

export interface GlassFrame { fronts: Front[]; glows: Glow[]; growing: boolean }

export const EMPTY_FRAME: GlassFrame = Object.freeze({ fronts: [], glows: [], growing: false }) as GlassFrame;

// Uniform-array sizes compiled into glassShaders.ts — keep in sync.
export const MAX_FRONTS = 8;
export const MAX_GLOWS = 32;

export function fadeProgress(startMs: number, now: number, durMs: number): number {
  if (durMs <= 0) return 1;
  return Math.min(1, Math.max(0, (now - startMs) / durMs));
}

export function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

const EARTH_CIRCUMFERENCE_M = 40_075_016.686;
const mercX = (lng: number): number => (lng + 180) / 360;
const mercY = (lat: number): number => {
  const r = (lat * Math.PI) / 180;
  return (1 - Math.log(Math.tan(Math.PI / 4 + r / 2)) / Math.PI) / 2;
};

/** [east, north] metres of (lat,lng) from `anchor` in WebGLOverlayView's
 *  local frame: Web Mercator distance scaled to metres at the anchor latitude,
 *  so geometry stays registered with the Mercator base map. */
export function mercatorOffsetM(lat: number, lng: number, anchor: { lat: number; lng: number }): [number, number] {
  const scale = EARTH_CIRCUMFERENCE_M * Math.cos((anchor.lat * Math.PI) / 180);
  return [(mercX(lng) - mercX(anchor.lng)) * scale, -(mercY(lat) - mercY(anchor.lat)) * scale];
}

/** Project a local-frame point through a column-major MVP to drawing-buffer
 *  pixels (origin bottom-left, like gl_FragCoord). null = behind the camera. */
export function clipToPx(m: ArrayLike<number>, x: number, y: number, z: number, w: number, h: number): [number, number] | null {
  const at = (i: number): number => m[i] ?? 0;
  const cx = at(0) * x + at(4) * y + at(8) * z + at(12);
  const cy = at(1) * x + at(5) * y + at(9) * z + at(13);
  const cw = at(3) * x + at(7) * y + at(11) * z + at(15);
  if (cw <= 0) return null;
  return [((cx / cw + 1) / 2) * w, ((cy / cw + 1) / 2) * h];
}

/** Service colour (#rrggbb) → shader RGB, lifted slightly for glow on the dark map. */
export function hexToGlowRgb(hex: string): Rgb {
  const n = parseInt(hex.slice(1), 16);
  const lift = (v: number): number => Math.min(1, (v / 255) * 1.15);
  return [lift((n >> 16) & 255), lift((n >> 8) & 255), lift(n & 255)];
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx vitest run test/glassMath.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/frontend/map/glassMath.ts test/glassMath.test.ts
git commit -m "feat(glass): shared types and pure geometry/fade helpers

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 7: radarSync — fetch, dedupe, stale

**Files:**
- Create: `kiosk/src/frontend/map/radarSync.ts`
- Test: `kiosk/test/radarSync.test.ts`

**Interfaces:**
- Produces:
```ts
export interface RadarMeta { scanTime: number; fetchedAt: number; bounds: { n: number; s: number; e: number; w: number }; width: number; height: number; stale: boolean }
export interface RadarFrame { meta: RadarMeta; bytes: Uint8Array }
export interface RadarSyncDeps {
  fetchMeta: () => Promise<RadarMeta | null>;
  fetchFrame: () => Promise<Uint8Array | null>;
  onFrame: (f: RadarFrame) => void;
  onStale: (stale: boolean) => void;
  staleMs: number;
  now?: () => number;
}
export class RadarSync { constructor(d: RadarSyncDeps); poll(): Promise<void>; checkStale(): void }
export const httpRadarFetchers: Pick<RadarSyncDeps, "fetchMeta" | "fetchFrame">;
```
- `onStale` fires only on change. The initial state counts as "not stale", so the first stale result fires `onStale(true)`.

- [ ] **Step 1: Write the failing tests**

`kiosk/test/radarSync.test.ts`:
```ts
import { describe, it, expect, vi } from "vitest";
import { RadarSync, type RadarMeta } from "../src/frontend/map/radarSync.js";

const meta = (scanTime: number, over: Partial<RadarMeta> = {}): RadarMeta => ({
  scanTime, fetchedAt: scanTime, bounds: { n: 40, s: 39, e: -94, w: -95 }, width: 2, height: 2, stale: false, ...over,
});

function make(metas: Array<RadarMeta | null>, t = 1_000_000) {
  let i = 0;
  const deps = {
    fetchMeta: vi.fn(async () => metas[Math.min(i++, metas.length - 1)] ?? null),
    fetchFrame: vi.fn(async () => new Uint8Array([1, 2, 3, 4])),
    onFrame: vi.fn(),
    onStale: vi.fn(),
    staleMs: 1_200_000,
    now: () => t,
  };
  return { sync: new RadarSync(deps), deps, setNow: (n: number) => { t = n; } };
}

describe("RadarSync", () => {
  it("fetches the frame once per new scanTime (missed WS events are covered by polling)", async () => {
    const { sync, deps } = make([meta(900_000), meta(900_000), meta(950_000)]);
    await sync.poll(); await sync.poll(); await sync.poll();
    expect(deps.fetchFrame).toHaveBeenCalledTimes(2);
    expect(deps.onFrame.mock.calls.map(([f]) => f.meta.scanTime)).toEqual([900_000, 950_000]);
  });

  it("drops a frame whose length doesn't match the meta and retries next poll", async () => {
    const { sync, deps } = make([meta(900_000, { width: 3 }), meta(900_000)]);
    await sync.poll();
    expect(deps.onFrame).not.toHaveBeenCalled();
    await sync.poll();
    expect(deps.onFrame).toHaveBeenCalledTimes(1);
  });

  it("a concurrent poll does not double-fetch", async () => {
    const { sync, deps } = make([meta(900_000)]);
    await Promise.all([sync.poll(), sync.poll()]);
    expect(deps.fetchFrame).toHaveBeenCalledTimes(1);
  });

  it("404/503/network errors are quiet no-ops", async () => {
    const { sync, deps } = make([null]);
    deps.fetchMeta.mockRejectedValueOnce(new Error("offline"));
    await sync.poll();
    await sync.poll();
    expect(deps.onFrame).not.toHaveBeenCalled();
    expect(deps.onStale).not.toHaveBeenCalled();
  });

  it("reports stale from the server flag or from local age, only on change", async () => {
    const { sync, deps, setNow } = make([meta(900_000)], 1_000_000);
    await sync.poll();
    expect(deps.onStale).not.toHaveBeenCalled();
    setNow(900_000 + 1_200_001);
    sync.checkStale();
    sync.checkStale();
    expect(deps.onStale.mock.calls).toEqual([[true]]);
  });

  it("server-flagged stale fires immediately", async () => {
    const { sync, deps } = make([meta(900_000, { stale: true })]);
    await sync.poll();
    expect(deps.onStale.mock.calls).toEqual([[true]]);
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run test/radarSync.test.ts`
Expected: FAIL, because the module can't be resolved.

- [ ] **Step 3: Implement**

`kiosk/src/frontend/map/radarSync.ts`:
```ts
// Keeps the Weather Glass radar texture in step with the backend's RadarFeed.
// poll() runs on page load, on every WS "radar" event, and on a refreshMs
// timer (the backstop for a missed event across a backend restart). It only
// downloads a frame when scanTime changes. Stale = the server says so OR the
// scan is older than staleMs locally; the layer then fades radar out.

export interface RadarMeta {
  scanTime: number; fetchedAt: number;
  bounds: { n: number; s: number; e: number; w: number };
  width: number; height: number; stale: boolean;
}
export interface RadarFrame { meta: RadarMeta; bytes: Uint8Array }

export interface RadarSyncDeps {
  fetchMeta: () => Promise<RadarMeta | null>;
  fetchFrame: () => Promise<Uint8Array | null>;
  onFrame: (f: RadarFrame) => void;
  onStale: (stale: boolean) => void;
  staleMs: number;
  now?: () => number;
}

export class RadarSync {
  private lastScan: number | null = null;
  private lastMeta: RadarMeta | null = null;
  private stale = false;
  private inFlight: Promise<void> | null = null;
  private readonly now: () => number;

  constructor(private readonly d: RadarSyncDeps) {
    this.now = d.now ?? Date.now;
  }

  poll(): Promise<void> {
    this.inFlight ??= this.run().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  checkStale(): void {
    const m = this.lastMeta;
    if (!m) return;
    const stale = m.stale || this.now() - m.scanTime > this.d.staleMs;
    if (stale !== this.stale) { this.stale = stale; this.d.onStale(stale); }
  }

  private async run(): Promise<void> {
    let meta: RadarMeta | null;
    try { meta = await this.d.fetchMeta(); } catch { return; }
    if (!meta) return;
    this.lastMeta = meta;
    if (meta.scanTime !== this.lastScan) {
      let bytes: Uint8Array | null = null;
      try { bytes = await this.d.fetchFrame(); } catch { /* retry next poll */ }
      // A scan can land between the two requests; a size mismatch means the
      // frame doesn't belong to this meta, so wait for the next poll.
      if (bytes && bytes.length === meta.width * meta.height) {
        this.lastScan = meta.scanTime;
        this.d.onFrame({ meta, bytes });
      }
    }
    this.checkStale();
  }
}

export const httpRadarFetchers: Pick<RadarSyncDeps, "fetchMeta" | "fetchFrame"> = {
  fetchMeta: async () => {
    const r = await fetch("/api/radar");
    return r.ok ? (await r.json()) as RadarMeta : null;
  },
  fetchFrame: async () => {
    const r = await fetch("/api/radar/frame");
    return r.ok ? new Uint8Array(await r.arrayBuffer()) : null;
  },
};
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx vitest run test/radarSync.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/frontend/map/radarSync.ts test/radarSync.test.ts
git commit -m "feat(glass): radarSync — scan-deduped frame fetch + stale tracking

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 8: Shaders and the WebGLOverlayView layer

**Files:**
- Create: `kiosk/src/frontend/map/glassShaders.ts`
- Create: `kiosk/src/frontend/map/glassLayer.ts`

**Interfaces:**
- Consumes: everything in `glassMath.ts` (Task 6); `RadarFrame` (Task 7).
- Produces:
```ts
export interface GlassKnobs { maxFps: number; txFps: number; hazeIntensity: number; radarOpacity: number; radarMinDbz: number; radarFadeMs: number; txGrowMs: number }
export class GlassLayer {
  constructor(opts: { map: any; home: { lat: number; lng: number }; knobs: GlassKnobs; getFrame: (now: number) => GlassFrame });
  readonly status: string;              // "pending" | "on" | "off:no-webgl2" | "off:shader"
  setRadar(f: RadarFrame): void;
  setRadarStale(stale: boolean): void;
  stop(): void;
}
```

The GL code can't run under vitest (no WebGL in node), so this task has no unit tests. It's proven on the wall in Task 10, and all its logic inputs (fade, projection, frame contents) are already unit-tested.

- [ ] **Step 1: Write the shaders**

`kiosk/src/frontend/map/glassShaders.ts`:
```ts
// GLSL ES 3.00 for the Weather Glass layer. Two programs:
//  RADAR — georeferenced mesh; samples the real n0q grid (cubic B-spline from
//          4 bilinear taps: smooths BETWEEN measured samples, never moves or
//          invents echoes), crossfades prev→next scan in dBZ, palette by dBZ.
//          Index→dBZ is the n0q scale from backend/radar/n0q.ts.
//  FX    — full-viewport additive pass in drawing-buffer pixels: ambient haze,
//          afterglows, live transmission fronts. Array sizes = MAX_GLOWS /
//          MAX_FRONTS in glassMath.ts.

export const RADAR_VS = `#version 300 es
in vec2 aPos;
in vec2 aUv;
uniform mat4 uMvp;
out vec2 vUv;
void main() {
  vUv = aUv;
  gl_Position = uMvp * vec4(aPos, 0.0, 1.0);
}`;

export const RADAR_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uPrev;
uniform sampler2D uNext;
uniform vec2 uTexSize;
uniform float uMix;
uniform float uAlpha;
uniform float uMinDbz;
uniform float uOpacity;
out vec4 O;

float dbzAt(sampler2D t, vec2 uv) {
  return -32.0 + 0.5 * (texture(t, uv).r * 255.0);
}
// Cubic B-spline reconstruction with 4 bilinear fetches (Sigg & Hadwiger).
float bspline(sampler2D t, vec2 uv) {
  vec2 texel = uv * uTexSize - 0.5;
  vec2 i = floor(texel);
  vec2 f = texel - i;
  vec2 f2 = f * f, f3 = f2 * f;
  vec2 w0 = (1.0 - 3.0 * f + 3.0 * f2 - f3) / 6.0;
  vec2 w1 = (4.0 - 6.0 * f2 + 3.0 * f3) / 6.0;
  vec2 w2 = (1.0 + 3.0 * f + 3.0 * f2 - 3.0 * f3) / 6.0;
  vec2 w3 = f3 / 6.0;
  vec2 g0 = w0 + w1, g1 = w2 + w3;
  vec2 h0 = (i - 1.0 + w1 / g0 + 0.5) / uTexSize;
  vec2 h1 = (i + 1.0 + w3 / g1 + 0.5) / uTexSize;
  return g0.y * (g0.x * dbzAt(t, vec2(h0.x, h0.y)) + g1.x * dbzAt(t, vec2(h1.x, h0.y)))
       + g1.y * (g0.x * dbzAt(t, vec2(h0.x, h1.y)) + g1.x * dbzAt(t, vec2(h1.x, h1.y)));
}
void main() {
  float d = mix(bspline(uPrev, vUv), bspline(uNext, vUv), uMix);
  float vis = smoothstep(uMinDbz - 2.0, uMinDbz + 3.0, d);
  if (vis <= 0.0) discard;
  vec3 deep = vec3(0.05, 0.32, 0.34);
  vec3 seaglass = vec3(0.42, 0.86, 0.74);
  vec3 amber = vec3(1.0, 0.72, 0.32);
  vec3 rose = vec3(1.0, 0.32, 0.52);
  vec3 c = mix(deep, seaglass, smoothstep(uMinDbz, 35.0, d));
  c = mix(c, amber, smoothstep(35.0, 42.0, d));
  c = mix(c, rose, smoothstep(50.0, 55.0, d));
  float a = vis * uOpacity * uAlpha * (0.55 + 0.45 * smoothstep(uMinDbz, 50.0, d));
  O = vec4(c * a, a); // premultiplied
}`;

export const FX_VS = `#version 300 es
in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;

export const FX_FS = `#version 300 es
precision highp float;
uniform vec2 uRes;
uniform float uTime;
uniform float uHaze;
uniform vec4 uFrontA[8];   // centre px (xy), radius px, age s
uniform vec4 uFrontB[8];   // grow, bright, releasing, unused
uniform vec3 uFrontC[8];
uniform int uNFronts;
uniform vec4 uGlowA[32];   // centre px (xy), radius px, strength
uniform vec3 uGlowC[32];
uniform int uNGlows;
out vec4 O;

float h21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1, 0)), u.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) { s += a * vnoise(p); p = p * 2.03 + vec2(1.7, 9.2); a *= 0.5; }
  return s;
}

void main() {
  vec2 px = gl_FragCoord.xy;
  vec3 col = vec3(0.0);

  if (uHaze > 0.0) {
    vec2 p = px / uRes.y;
    float hz = fbm(p * 1.2 + vec2(uTime * 0.02, -uTime * 0.012) + fbm(p * 2.2 - uTime * 0.03));
    col += vec3(0.12, 0.32, 0.36) * pow(hz, 3.0) * uHaze;
  }

  for (int i = 0; i < 32; i++) {
    if (i >= uNGlows) break;
    vec4 g = uGlowA[i];
    float d = distance(px, g.xy) / max(g.z, 1.0);
    col += uGlowC[i] * exp(-d * d * 2.2) * g.w * 0.35;
  }

  for (int i = 0; i < 8; i++) {
    if (i >= uNFronts) break;
    vec4 a = uFrontA[i];
    vec4 b = uFrontB[i];
    vec3 c = uFrontC[i];
    float R = max(a.z, 1.0);
    float d = distance(px, a.xy);
    float r = R * (0.08 + 0.92 * b.x);
    float w = max(2.0, R * 0.035);
    float live = 1.0 - b.z;
    float breathe = 0.8 + 0.2 * sin(uTime * 2.094 + a.w);          // ~3 s period
    float level = 0.35 + 0.65 * b.y;
    float rim = exp(-pow((d - r) / w, 2.0)) * mix(1.4, breathe, b.x) * level;
    float trail = 0.0;
    for (int k = 1; k <= 2; k++) {
      float rk = r - float(k) * w * 3.5;
      trail += exp(-pow((d - rk) / w, 2.0)) * (0.25 / float(k)) * (1.0 - b.x * 0.6);
    }
    float flash = exp(-a.w * 7.0) * exp(-(d * d) / (R * R * 0.004));  // ~300 ms
    float core = exp(-(d * d) / (R * R * 0.0015)) * 0.6 * level;
    col += c * ((rim + trail + core) * live + flash);
  }

  O = vec4(col, 0.0); // additive: blendFunc(ONE, ONE)
}`;
```

- [ ] **Step 2: Write the layer**

`kiosk/src/frontend/map/glassLayer.ts`:
```ts
// Weather Glass: one WebGLOverlayView drawing inside Google's own GL context
// (spec 2026-10-01 §1). Per frame: (1) the real-radar mesh, premultiplied;
// (2) an additive full-viewport pass with haze, afterglows and live fronts.
// Pins, aircraft and the edge glow stay Google/DOM objects above it.
//
// GL state discipline: Google owns this context. Every draw saves what it
// touches and restores it, and all texture uploads happen inside onDraw
// (never from a fetch callback), so we never fight the map renderer.
import { RADAR_VS, RADAR_FS, FX_VS, FX_FS } from "./glassShaders.js";
import {
  MAX_FRONTS, MAX_GLOWS, fadeProgress, mercatorOffsetM, clipToPx,
  type GlassFrame,
} from "./glassMath.js";
import type { RadarFrame } from "./radarSync.js";

declare const google: any;

export interface GlassKnobs {
  maxFps: number; txFps: number; hazeIntensity: number; radarOpacity: number;
  radarMinDbz: number; radarFadeMs: number; txGrowMs: number;
}

export interface GlassLayerOptions {
  map: any;
  home: { lat: number; lng: number };
  knobs: GlassKnobs;
  getFrame: (now: number) => GlassFrame;
}

const MESH_DIV = 32; // mesh subdivisions per axis (equirect → Mercator)

type Gl = WebGL2RenderingContext;
interface Prog { p: WebGLProgram; u: Record<string, WebGLUniformLocation | null> }

export class GlassLayer {
  status = "pending";
  private readonly ov: any;
  private gl: Gl | null = null;
  private radarProg: Prog | null = null;
  private fxProg: Prog | null = null;
  private meshVao: WebGLVertexArrayObject | null = null;
  private meshCount = 0;
  private meshBounds: RadarFrame["meta"]["bounds"] | null = null;
  private fxVao: WebGLVertexArrayObject | null = null;
  private tex: [WebGLTexture | null, WebGLTexture | null] = [null, null];
  private nextIdx = 0;                     // tex[nextIdx] = newest scan
  private texSize: [number, number] = [1, 1];
  private hasRadar = false;
  private pending: RadarFrame | null = null;
  private last: RadarFrame | null = null;  // re-upload after context loss
  private mixStart = 0;
  private alphaFrom = 0;
  private alphaTo = 0;
  private alphaStart = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly t0 = performance.now();
  private readonly fronts = new Float32Array(MAX_FRONTS * 4);
  private readonly frontsB = new Float32Array(MAX_FRONTS * 4);
  private readonly frontsC = new Float32Array(MAX_FRONTS * 3);
  private readonly glows = new Float32Array(MAX_GLOWS * 4);
  private readonly glowsC = new Float32Array(MAX_GLOWS * 3);
  private lastFrame: GlassFrame | null = null;

  constructor(private readonly o: GlassLayerOptions) {
    this.ov = new google.maps.WebGLOverlayView();
    this.ov.onAdd = () => {};
    this.ov.onContextRestored = ({ gl }: { gl: WebGLRenderingContext | Gl }) => this.init(gl);
    this.ov.onContextLost = () => { this.gl = null; this.radarProg = this.fxProg = null; this.meshVao = this.fxVao = null; this.tex = [null, null]; this.meshBounds = null; this.hasRadar = false; this.pending = this.last; };
    this.ov.onDraw = ({ gl, transformer }: { gl: Gl; transformer: any }) => this.draw(gl, transformer);
    this.ov.onRemove = () => {};
    this.ov.setMap(o.map);
    this.schedule();
  }

  setRadar(f: RadarFrame): void { this.pending = f; this.ov.requestRedraw(); }

  setRadarStale(stale: boolean): void {
    this.retargetAlpha(stale ? 0 : 1, performance.now());
    this.ov.requestRedraw();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.ov.setMap(null);
  }

  // ── pacing: redraw at maxFps, txFps while a front grows; idle only when
  // nothing can change (haze off, no fronts/glows, no fades running).
  private schedule(): void {
    const now = performance.now();
    const f = this.lastFrame;
    const fading = fadeProgress(this.mixStart, now, this.o.knobs.radarFadeMs) < 1
      || fadeProgress(this.alphaStart, now, this.o.knobs.radarFadeMs) < 1;
    const animating = this.o.knobs.hazeIntensity > 0 || fading
      || !f || f.fronts.length > 0 || f.glows.length > 0;
    if (animating) this.ov.requestRedraw();
    const fps = f?.growing ? this.o.knobs.txFps : this.o.knobs.maxFps;
    this.timer = setTimeout(() => this.schedule(), animating ? 1000 / Math.max(1, fps) : 1000);
  }

  private retargetAlpha(to: number, now: number): void {
    this.alphaFrom = this.currentAlpha(now);
    this.alphaTo = to;
    this.alphaStart = now;
  }

  private currentAlpha(now: number): number {
    const k = fadeProgress(this.alphaStart, now, this.o.knobs.radarFadeMs);
    return this.alphaFrom + (this.alphaTo - this.alphaFrom) * k;
  }

  private init(raw: WebGLRenderingContext | Gl): void {
    if (typeof WebGL2RenderingContext === "undefined" || !(raw instanceof WebGL2RenderingContext)) {
      this.status = "off:no-webgl2";
      return;
    }
    const gl = raw;
    this.radarProg = link(gl, RADAR_VS, RADAR_FS, ["uMvp", "uPrev", "uNext", "uTexSize", "uMix", "uAlpha", "uMinDbz", "uOpacity"]);
    this.fxProg = link(gl, FX_VS, FX_FS, ["uRes", "uTime", "uHaze", "uFrontA", "uFrontB", "uFrontC", "uNFronts", "uGlowA", "uGlowC", "uNGlows"]);
    if (!this.radarProg || !this.fxProg) { this.status = "off:shader"; return; }
    const saved = saveGl(gl);
    this.fxVao = gl.createVertexArray();
    gl.bindVertexArray(this.fxVao);
    const fxBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, fxBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(this.fxProg.p, "aPos");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    for (let i = 0; i < 2; i++) {
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.tex[i] = t;
    }
    restoreGl(gl, saved);
    this.gl = gl;
    this.status = "on";
    if (this.last && !this.pending) this.pending = this.last;
  }

  private buildMesh(gl: Gl, b: RadarFrame["meta"]["bounds"]): void {
    const n = MESH_DIV + 1;
    const pos = new Float32Array(n * n * 2), uv = new Float32Array(n * n * 2);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const lat = b.n - ((b.n - b.s) * i) / MESH_DIV;
        const lng = b.w + ((b.e - b.w) * j) / MESH_DIV;
        const [x, y] = mercatorOffsetM(lat, lng, this.o.home);
        const k = (i * n + j) * 2;
        pos[k] = x; pos[k + 1] = y;
        uv[k] = j / MESH_DIV; uv[k + 1] = i / MESH_DIV; // v=0 = north row (first uploaded)
      }
    }
    const idx = new Uint16Array(MESH_DIV * MESH_DIV * 6);
    let p = 0;
    for (let i = 0; i < MESH_DIV; i++) for (let j = 0; j < MESH_DIV; j++) {
      const a = i * n + j, c = a + n;
      idx.set([a, c, a + 1, a + 1, c, c + 1], p); p += 6;
    }
    const prog = this.radarProg!.p;
    this.meshVao = gl.createVertexArray();
    gl.bindVertexArray(this.meshVao);
    const bind = (data: Float32Array, name: string): void => {
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      const l = gl.getAttribLocation(prog, name);
      gl.enableVertexAttribArray(l);
      gl.vertexAttribPointer(l, 2, gl.FLOAT, false, 0, 0);
    };
    bind(pos, "aPos");
    bind(uv, "aUv");
    const ebo = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ebo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
    this.meshCount = idx.length;
    this.meshBounds = b;
  }

  private upload(gl: Gl, t: WebGLTexture | null, f: RadarFrame): void {
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, f.meta.width, f.meta.height, 0, gl.RED, gl.UNSIGNED_BYTE, f.bytes);
  }

  private takePending(gl: Gl, now: number): void {
    const f = this.pending;
    if (!f) return;
    this.pending = null;
    this.last = f;
    const b = f.meta.bounds, mb = this.meshBounds;
    const sameGrid = this.hasRadar && mb && mb.n === b.n && mb.s === b.s && mb.e === b.e && mb.w === b.w
      && this.texSize[0] === f.meta.width && this.texSize[1] === f.meta.height;
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    if (sameGrid) {
      // Crossfade: the old "next" becomes "prev"; the new scan goes in the other slot.
      this.nextIdx = 1 - this.nextIdx;
      this.upload(gl, this.tex[this.nextIdx]!, f);
      this.mixStart = now;
    } else {
      // First scan (or a new crop box): no honest "previous", so fill both
      // slots and fade the layer in from empty.
      if (!mb || mb.n !== b.n || mb.s !== b.s || mb.e !== b.e || mb.w !== b.w) this.buildMesh(gl, b);
      this.upload(gl, this.tex[0]!, f);
      this.upload(gl, this.tex[1]!, f);
      this.texSize = [f.meta.width, f.meta.height];
      this.mixStart = now - this.o.knobs.radarFadeMs; // mix already complete
      if (!this.hasRadar) this.retargetAlpha(f.meta.stale ? 0 : 1, now);
      this.hasRadar = true;
    }
  }

  private draw(gl: Gl, transformer: any): void {
    if (!this.gl || this.gl !== gl || !this.radarProg || !this.fxProg) return;
    const now = performance.now();
    const saved = saveGl(gl);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
    this.takePending(gl, now);

    const W = gl.drawingBufferWidth, H = gl.drawingBufferHeight;
    const k = this.o.knobs;

    // (1) radar
    const alpha = this.currentAlpha(now);
    if (this.hasRadar && this.meshVao && alpha > 0.001) {
      const u = this.radarProg.u;
      gl.useProgram(this.radarProg.p);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      const mvp = transformer.fromLatLngAltitude({ lat: this.o.home.lat, lng: this.o.home.lng, altitude: 0 });
      gl.uniformMatrix4fv(u.uMvp!, false, Float32Array.from(mvp));
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.tex[1 - this.nextIdx]!);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.tex[this.nextIdx]!);
      gl.uniform1i(u.uPrev!, 0);
      gl.uniform1i(u.uNext!, 1);
      gl.uniform2f(u.uTexSize!, this.texSize[0], this.texSize[1]);
      gl.uniform1f(u.uMix!, fadeProgress(this.mixStart, now, k.radarFadeMs));
      gl.uniform1f(u.uAlpha!, alpha);
      gl.uniform1f(u.uMinDbz!, k.radarMinDbz);
      gl.uniform1f(u.uOpacity!, k.radarOpacity);
      gl.bindVertexArray(this.meshVao);
      gl.drawElements(gl.TRIANGLES, this.meshCount, gl.UNSIGNED_SHORT, 0);
    }

    // (2) haze + afterglows + fronts
    const frame = this.o.getFrame(Date.now());
    this.lastFrame = frame;
    let nf = 0;
    for (const fr of frame.fronts) {
      if (nf >= MAX_FRONTS) break;
      const m = transformer.fromLatLngAltitude({ lat: fr.lat, lng: fr.lng, altitude: 0 });
      const c = clipToPx(m, 0, 0, 0, W, H), e = clipToPx(m, fr.radiusM, 0, 0, W, H);
      if (!c || !e) continue;
      this.fronts.set([c[0], c[1], Math.hypot(e[0] - c[0], e[1] - c[1]), fr.ageMs / 1000], nf * 4);
      this.frontsB.set([fr.grow, fr.bright, fr.releasing, 0], nf * 4);
      this.frontsC.set(fr.color, nf * 3);
      nf++;
    }
    let ng = 0;
    for (const g of frame.glows) {
      if (ng >= MAX_GLOWS) break;
      const m = transformer.fromLatLngAltitude({ lat: g.lat, lng: g.lng, altitude: 0 });
      const c = clipToPx(m, 0, 0, 0, W, H), e = clipToPx(m, g.radiusM, 0, 0, W, H);
      if (!c || !e) continue;
      this.glows.set([c[0], c[1], Math.hypot(e[0] - c[0], e[1] - c[1]), g.strength], ng * 4);
      this.glowsC.set(g.color, ng * 3);
      ng++;
    }
    if (k.hazeIntensity > 0 || nf > 0 || ng > 0) {
      const u = this.fxProg.u;
      gl.useProgram(this.fxProg.p);
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.uniform2f(u.uRes!, W, H);
      gl.uniform1f(u.uTime!, (now - this.t0) / 1000);
      gl.uniform1f(u.uHaze!, k.hazeIntensity);
      gl.uniform4fv(u.uFrontA!, this.fronts);
      gl.uniform4fv(u.uFrontB!, this.frontsB);
      gl.uniform3fv(u.uFrontC!, this.frontsC);
      gl.uniform1i(u.uNFronts!, nf);
      gl.uniform4fv(u.uGlowA!, this.glows);
      gl.uniform3fv(u.uGlowC!, this.glowsC);
      gl.uniform1i(u.uNGlows!, ng);
      gl.bindVertexArray(this.fxVao);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    restoreGl(gl, saved);
  }
}

function link(gl: Gl, vs: string, fs: string, uniforms: string[]): Prog | null {
  const sh = (type: number, src: string): WebGLShader | null => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      console.error("[glass] shader compile failed:", gl.getShaderInfoLog(s));
      return null;
    }
    return s;
  };
  const v = sh(gl.VERTEX_SHADER, vs), f = sh(gl.FRAGMENT_SHADER, fs);
  if (!v || !f) return null;
  const p = gl.createProgram()!;
  gl.attachShader(p, v);
  gl.attachShader(p, f);
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    console.error("[glass] program link failed:", gl.getProgramInfoLog(p));
    return null;
  }
  const u: Prog["u"] = {};
  for (const name of uniforms) u[name] = gl.getUniformLocation(p, name);
  return { p, u };
}

interface SavedGl {
  program: WebGLProgram | null; vao: WebGLVertexArrayObject | null; arrayBuffer: WebGLBuffer | null;
  activeTexture: number; tex0: WebGLTexture | null; tex1: WebGLTexture | null;
  blend: boolean; depth: boolean; cull: boolean;
  srcRgb: number; dstRgb: number; srcA: number; dstA: number; eqRgb: number; eqA: number;
  unpack: number;
}

function saveGl(gl: Gl): SavedGl {
  const activeTexture = gl.getParameter(gl.ACTIVE_TEXTURE) as number;
  gl.activeTexture(gl.TEXTURE0);
  const tex0 = gl.getParameter(gl.TEXTURE_BINDING_2D) as WebGLTexture | null;
  gl.activeTexture(gl.TEXTURE1);
  const tex1 = gl.getParameter(gl.TEXTURE_BINDING_2D) as WebGLTexture | null;
  gl.activeTexture(activeTexture);
  return {
    program: gl.getParameter(gl.CURRENT_PROGRAM), vao: gl.getParameter(gl.VERTEX_ARRAY_BINDING),
    arrayBuffer: gl.getParameter(gl.ARRAY_BUFFER_BINDING), activeTexture, tex0, tex1,
    blend: gl.isEnabled(gl.BLEND), depth: gl.isEnabled(gl.DEPTH_TEST), cull: gl.isEnabled(gl.CULL_FACE),
    srcRgb: gl.getParameter(gl.BLEND_SRC_RGB), dstRgb: gl.getParameter(gl.BLEND_DST_RGB),
    srcA: gl.getParameter(gl.BLEND_SRC_ALPHA), dstA: gl.getParameter(gl.BLEND_DST_ALPHA),
    eqRgb: gl.getParameter(gl.BLEND_EQUATION_RGB), eqA: gl.getParameter(gl.BLEND_EQUATION_ALPHA),
    unpack: gl.getParameter(gl.UNPACK_ALIGNMENT),
  };
}

function restoreGl(gl: Gl, s: SavedGl): void {
  gl.bindVertexArray(s.vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, s.arrayBuffer);
  gl.useProgram(s.program);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, s.tex0);
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, s.tex1);
  gl.activeTexture(s.activeTexture);
  if (s.blend) gl.enable(gl.BLEND); else gl.disable(gl.BLEND);
  if (s.depth) gl.enable(gl.DEPTH_TEST); else gl.disable(gl.DEPTH_TEST);
  if (s.cull) gl.enable(gl.CULL_FACE); else gl.disable(gl.CULL_FACE);
  gl.blendFuncSeparate(s.srcRgb, s.dstRgb, s.srcA, s.dstA);
  gl.blendEquationSeparate(s.eqRgb, s.eqA);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, s.unpack);
}
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: clean. (The files aren't imported by `map.ts` yet, but `tsconfig.frontend.json` covers all of `src/frontend`.)

- [ ] **Step 4: Commit**

```bash
git add src/frontend/map/glassShaders.ts src/frontend/map/glassLayer.ts
git commit -m "feat(glass): WebGLOverlayView layer — real-radar mesh + additive fx pass

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 9: Wire the layer in and retire the tile radar

**Files:**
- Modify: `kiosk/src/backend/config/schema.ts` (remove `radarProduct`, add `glass`)
- Modify: `kiosk/src/frontend/map/map.ts`:
  - the radar block (comment "── Radar overlay" through the `setInterval` that pops/pushes `overlayMapTypes`)
  - the WS handler
  - `reportRenderDiag`
  - the legend copy in `renderMap`
- Modify: `kiosk/src/backend/server.ts` (`/api/kiosk/diag`)
- Modify: `docs/API.md` (the diag row)
- Test: `kiosk/test/schema.test.ts`, `kiosk/test/api.test.ts` (diag)

**Interfaces:**
- Consumes: `GlassLayer`, `GlassKnobs` (Task 8); `RadarSync`, `httpRadarFetchers` (Task 7); `EMPTY_FRAME` (Task 6).
- Produces:
  - `config.display.glass: GlassKnobs` (all defaults filled)
  - the diag body's optional `glass: string`, logged as ` glass=<v>`

- [ ] **Step 1: Write the failing tests**

Append to `kiosk/test/schema.test.ts`:
```ts
describe("display.glass + radarProduct retirement", () => {
  const base = () => ({ ...defaultConfig(), display: { weatherLat: 39.1, weatherLon: -94.58 } });
  it("fills the glass defaults", () => {
    expect(configSchema.parse(base()).display!.glass).toEqual({
      maxFps: 30, txFps: 60, hazeIntensity: 0.35, radarOpacity: 0.6,
      radarMinDbz: 15, radarFadeMs: 20_000, txGrowMs: 900,
    });
  });
  it("an old config carrying radarProduct still loads, and the key is stripped", () => {
    const cfg = configSchema.parse({ ...base(), display: { ...base().display, radarProduct: "mrms-reflectivity" } });
    expect("radarProduct" in cfg.display!).toBe(false);
  });
  it("rejects out-of-range knobs", () => {
    expect(() => configSchema.parse({ ...base(), display: { ...base().display, glass: { maxFps: 0 } } })).toThrow();
    expect(() => configSchema.parse({ ...base(), display: { ...base().display, glass: { hazeIntensity: 2 } } })).toThrow();
  });
});
```

Find the existing `/api/kiosk/diag` test in `kiosk/test/api.test.ts` (search for `kiosk/diag`) and add this case beside it, using that file's `makeApp()`:
```ts
  it("POST /api/kiosk/diag logs the optional glass status, sanitised", async () => {
    const { server } = makeApp();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await request(server).post("/api/kiosk/diag")
      .send({ renderingType: "VECTOR", fps: 30, p95Ms: 34, maxMs: 40, glass: "off:no-webgl2<script>" });
    expect(res.status).toBe(200);
    expect(err.mock.calls.at(-1)?.[0]).toBe("[kiosk] map rendering=VECTOR display=30 fps p95=34 ms max=40 ms glass=off:no-webgl2script");
    err.mockRestore();
  });
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run test/schema.test.ts test/api.test.ts`
Expected: FAIL. `glass` is undefined, `radarProduct` survives, and the diag line has no `glass=`.

- [ ] **Step 3: Implement the schema**

In `kiosk/src/backend/config/schema.ts`:
1. Delete the whole `radarProduct` field and its comment block. Put this note in its place:
```ts
    // (radarProduct — the retired n0q/MRMS tile picker — is gone: Weather
    // Glass draws IEM's raw n0q composite itself. Old config files that still
    // carry it parse fine; zod strips the unknown key.)
```
2. After the `radar` block from Task 4, add:
```ts
    // Weather Glass layer (frontend/map/glassLayer.ts). Reaches the wall on
    // its next load: PUT /api/config, then POST /api/kiosk/reload.
    glass: z.object({
      maxFps: z.number().int().min(1).max(60).default(30),        // steady redraw rate
      txFps: z.number().int().min(1).max(60).default(60),         // while a front is growing
      hazeIntensity: z.number().min(0).max(1).default(0.35),      // ambient haze, 0 = off
      radarOpacity: z.number().min(0).max(1).default(0.6),
      radarMinDbz: z.number().min(-30).max(60).default(15),       // invisible below (drizzle, clutter)
      radarFadeMs: z.number().int().min(0).max(120_000).default(20_000), // crossfade between scans
      txGrowMs: z.number().int().min(100).max(5_000).default(900),       // front expand time
    }).default({}),
```

- [ ] **Step 4: Implement the diag field**

In `kiosk/src/backend/server.ts`'s `/api/kiosk/diag` handler, replace the `console.error(...)` line with:
```ts
      const glass = typeof b.glass === "string" ? ` glass=${b.glass.replace(/[^a-z0-9:-]/gi, "").slice(0, 32)}` : "";
      console.error(`[kiosk] map rendering=${rt} display=${b.fps} fps p95=${b.p95Ms} ms max=${b.maxMs} ms${glass}`);
```
In `docs/API.md`, change the `/api/kiosk/diag` row's body description to `{ renderingType, fps, p95Ms, maxMs, glass? }` and add: "`glass` is the Weather Glass layer status (`on`, `off:<reason>`)."

- [ ] **Step 5: Implement the map wiring**

In `kiosk/src/frontend/map/map.ts`:
1. Add the imports:
```ts
import { GlassLayer } from "./glassLayer.js";
import { RadarSync, httpRadarFetchers } from "./radarSync.js";
import { EMPTY_FRAME } from "./glassMath.js";
```
2. Replace the entire radar block (from `// ── Radar overlay (ROADMAP Idea 2 follow-on` through the closing `}, spec.refreshMs);` of the pop/push `setInterval`, including `radarProduct`, `MERC_MAX`, `tileBbox`, `RadarSpec`, `RADAR` and `radarLayer`) with:
```ts
    // ── Weather Glass (spec 2026-10-01): one GPU layer inside Google's GL
    // context. Radar is IEM's real n0q composite, cropped by the backend
    // (/api/radar) and crossfaded between scans. Needs a vector map (Map ID).
    const display = cfg.display!;
    const glass = mapId
      ? new GlassLayer({ map, home, knobs: display.glass, getFrame: () => EMPTY_FRAME })
      : null;
    const glassStatus = (): string => (glass ? glass.status : "off:no-mapid");
    const radarSync = glass && display.radar.enabled
      ? new RadarSync({
          ...httpRadarFetchers,
          onFrame: (f) => glass.setRadar(f),
          onStale: (stale) => glass.setRadarStale(stale),
          staleMs: display.radar.staleMs,
        })
      : null;
    if (radarSync) {
      void radarSync.poll();
      setInterval(() => void radarSync.poll(), display.radar.refreshMs);
      setInterval(() => radarSync.checkStale(), 30_000);
    }
```
3. Change `if (!interactive) reportRenderDiag(map);` to `if (!interactive) reportRenderDiag(map, glassStatus);`. Because `glassStatus` is now declared after that line, move the `reportRenderDiag` call to directly below the new Weather Glass block.
4. In the WS handler, add a branch before `} else if (ev.type === "aircraft") {`:
```ts
      } else if (ev.type === "radar") {
        void radarSync?.poll(); // a new scan landed — fetch it once
```
5. Change the signature of `reportRenderDiag` to `function reportRenderDiag(map: { getRenderingType?: () => string }, glassStatus: () => string): void`, and add `glass: glassStatus(),` to its `body` object.
6. In `renderMap`'s legend, change `Weather: live NEXRAD` to `Weather: live NEXRAD (IEM)`.

- [ ] **Step 6: Run the tests and typecheck**

Run: `npm test && npm run typecheck`
Expected: all pass, clean. If an existing test asserted on `radarProduct`, delete that assertion; the key is retired by design.

- [ ] **Step 7: Commit**

```bash
git add src/backend/config/schema.ts src/backend/server.ts src/frontend/map/map.ts test/schema.test.ts test/api.test.ts ../docs/API.md
git commit -m "feat(glass): mount Weather Glass radar + haze; retire ImageMapType radar and radarProduct

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 10: Ship PR 2 (prove it on the wall)

- [ ] **Step 1: Capture the baseline BEFORE deploying** (the old tile radar is still live)

Grab a screenshot:
```bash
XDG_RUNTIME_DIR=/run/user/1000 WAYLAND_DISPLAY=wayland-0 grim /tmp/claude-1000/before.png
```
Then take a 10-minute thermal/CPU baseline. Run this with `run_in_background: true`; foreground `sleep` is blocked:
```bash
for i in $(seq 20); do curl -s localhost:8080/api/system | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const n=JSON.parse(s).now;console.log(n.tempC,n.cpuPct)})'; sleep 30; done | awk '{t+=$1;c+=$2;n++} END{printf "BEFORE tempC=%.1f cpuPct=%.1f n=%d\n",t/n,c/n,n}' > /tmp/claude-1000/thermal-before.txt
```
Also note chromium CPU from the second iteration of `top -b -d 10 -n 2 | grep chrome`.

- [ ] **Step 2: Definition-of-done checks**

Run: `npm test && npm run test:native && npm run typecheck && npm run build`
Expected: all pass.

- [ ] **Step 3: Deploy**

The schema and diag changes are backend, so restart, then reload the wall:
```bash
sudo systemctl restart kerchunk-kiosk
# wait for /api/status to answer, then:
curl -X POST localhost:8080/api/kiosk/reload
```
Wait ~15 s. Check the journal: `journalctl -u kerchunk-kiosk --since "-2 min" | grep "\[kiosk\] map"`.
Expected: `rendering=VECTOR ... glass=on`.

- [ ] **Step 4: Prove registration and look**

Grab a screenshot:
```bash
XDG_RUNTIME_DIR=/run/user/1000 WAYLAND_DISPLAY=wayland-0 grim /tmp/claude-1000/after.png
```
Read `before.png` and `after.png`. Check:
- (a) echo cells ≥15 dBZ appear in the same places relative to the pins and towns as the old tiles' yellow/green ≥15 dBZ areas;
- (b) there are no blocky pixels and no tile seams;
- (c) clear-air drizzle green is gone;
- (d) the haze drifts (take two screenshots 10 s apart and compare).

If (a) is off, compare one distinctive cell's lat/lon against `/api/radar` bounds. A uniform north/south shift means the `uv` v-orientation is wrong; an east/west scale error means `mercatorOffsetM`'s anchor is wrong. Fix it and re-prove.

- [ ] **Step 5: Prove the crossfade**

Wait for the next scan (≤5 min; watch `curl -s localhost:8080/api/radar | grep -o '"scanTime":[0-9]*'`). Take screenshots 0 s, 10 s and 25 s after the WS event.
Expected: the old and new echoes blend, with no blank frame, no tile patchwork and no pop.

- [ ] **Step 6: Thermal after**

Run the same 10-minute loop as Step 1 into `/tmp/claude-1000/thermal-after.txt`, and the same `top` check.
Expected: within about +3 °C and +10 % chromium CPU of the baseline. If it's worse, try `display.glass.maxFps` 20 via `PUT /api/config` + `kiosk/reload`, re-measure, and report both numbers honestly in the PR.

- [ ] **Step 7: Push, open the PR, merge, clean up**

```bash
git push -u origin feat/glass-radar
gh pr create --title "feat(glass): Weather Glass radar + haze — real NEXRAD, no more tiles (PR 2/4)" --body "$(cat <<'EOF'
Replaces the ImageMapType tile radar with the Weather Glass GPU layer (spec: docs/superpowers/specs/2026-10-01-weather-glass-design.md).

- WebGLOverlayView inside Google's GL context: georeferenced radar mesh (B-spline, palette by real dBZ, crossfade between scans) + additive haze pass
- Radar fades out when stale (>20 min) instead of freezing
- Retires display.radarProduct (nowCOAST/MRMS tile paths); old configs strip the key
- Diag journal line gains glass=on|off:<reason>

Knobs (src/backend/config/schema.ts, `display.glass`, apply via PUT /api/config + POST /api/kiosk/reload): maxFps 30, txFps 60, hazeIntensity 0.35, radarOpacity 0.6, radarMinDbz 15, radarFadeMs 20000, txGrowMs 900.

Proof: <before/after screenshots notes, crossfade observation, thermal before/after numbers>

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
gh pr merge <n> --merge --delete-branch && git checkout main && git pull --ff-only && git fetch --prune && git branch -d feat/glass-radar
```

---

## PR 3 — Glass transmissions

> **Superseded** by docs/superpowers/plans/2026-10-02-fixed-stage-event-pacing.md (PR B / dropped). Do not execute.

Start: `git checkout main && git pull --ff-only && git checkout -b feat/glass-transmissions`

### Task 11: glassState — transmission and afterglow lifecycle

**Files:**
- Create: `kiosk/src/frontend/map/glassState.ts`
- Test: `kiosk/test/glassState.test.ts`

**Interfaces:**
- Consumes: `Rgb`, `Front`, `Glow`, `GlassFrame`, `MAX_FRONTS`, `MAX_GLOWS`, `easeOutCubic`, `fadeProgress` (Task 6).
- Produces:
```ts
export interface GlassSite { key: string; lat: number; lng: number; color: Rgb }
export interface GlassTimings { growMs: number; releaseMs: number; glowLifetimeMs: number; ttlMs: number }
export const RELEASE_MS = 1500;
export const SIGNAL_FLOOR_DBFS = -45;
export const SIGNAL_CEIL_DBFS = -10;
export const DEFAULT_BRIGHT = 0.6;
export function rampStrength(hits: number): number;   // 0.5 + 0.5*min(hits,6)/6
export class GlassState {
  constructor(t: GlassTimings);
  keyUp(id: string, site: GlassSite, radiusM: number, now: number): void;  // existing id = re-arm (born + radius latched)
  rearm(id: string, now: number): void;
  signal(id: string, dbfs: number): void;
  release(id: string, now: number): void;
  releaseAll(now: number): void;
  seedGlow(site: GlassSite, radiusM: number, ts: number, now: number): void;
  hits(key: string): number;
  frame(now: number): GlassFrame;
}
```

- [ ] **Step 1: Write the failing tests**

`kiosk/test/glassState.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { GlassState, rampStrength, RELEASE_MS, DEFAULT_BRIGHT } from "../src/frontend/map/glassState.js";
import { MAX_FRONTS, MAX_GLOWS } from "../src/frontend/map/glassMath.js";

const T = { growMs: 900, releaseMs: RELEASE_MS, glowLifetimeMs: 60_000, ttlMs: 60_000 };
const site = (key = "a", color: readonly [number, number, number] = [1, 0, 0]) => ({ key, lat: 39, lng: -94, color });

describe("GlassState", () => {
  it("key-up grows (eased) then holds; growing flag only during the grow", () => {
    const s = new GlassState(T);
    s.keyUp("ch1", site(), 5000, 0);
    const f0 = s.frame(450);
    expect(f0.growing).toBe(true);
    expect(f0.fronts[0]!.grow).toBeCloseTo(0.875, 3);   // easeOutCubic(0.5)
    expect(f0.fronts[0]!.bright).toBe(DEFAULT_BRIGHT);
    const f1 = s.frame(2000);
    expect(f1.growing).toBe(false);
    expect(f1.fronts[0]).toMatchObject({ grow: 1, releasing: 0, radiusM: 5000, ageMs: 2000 });
    expect(f1.glows).toEqual([]);
  });

  it("a re-key of a live id re-arms: born and radius stay latched", () => {
    const s = new GlassState(T);
    s.keyUp("ch1", site(), 5000, 0);
    s.keyUp("ch1", site(), 9000, 50_000);
    const f = s.frame(70_000);                 // past the first ttl, inside the re-armed one
    expect(f.fronts).toHaveLength(1);
    expect(f.fronts[0]).toMatchObject({ radiusM: 5000, ageMs: 70_000 });
    expect(s.hits("a")).toBe(1);               // a re-arm is not a new hit
  });

  it("release dissolves the rim over RELEASE_MS and starts the afterglow at once", () => {
    const s = new GlassState(T);
    s.keyUp("ch1", site(), 5000, 0);
    s.release("ch1", 10_000);
    const mid = s.frame(10_750);
    expect(mid.fronts[0]!.releasing).toBeCloseTo(0.5, 6);
    expect(mid.glows).toHaveLength(1);
    expect(mid.glows[0]!.strength).toBeCloseTo(rampStrength(1) * (1 - 750 / 60_000), 6);
    const after = s.frame(10_000 + RELEASE_MS);
    expect(after.fronts).toEqual([]);
    expect(after.glows).toHaveLength(1);
  });

  it("the afterglow fades to nothing over the lifetime and the site's hits reset", () => {
    const s = new GlassState(T);
    s.keyUp("ch1", site(), 5000, 0);
    s.release("ch1", 1000);
    expect(s.frame(60_999).glows).toHaveLength(1);
    expect(s.frame(61_000).glows).toEqual([]);
    expect(s.hits("a")).toBe(0);
  });

  it("hits ramp the afterglow strength, capped at 6", () => {
    expect(rampStrength(1)).toBeCloseTo(0.5 + 0.5 / 6, 9);
    expect(rampStrength(6)).toBe(1);
    expect(rampStrength(40)).toBe(1);
    const s = new GlassState(T);
    for (let i = 0; i < 3; i++) { s.keyUp(`k${i}`, site(), 5000, i * 100); s.release(`k${i}`, i * 100 + 50); }
    expect(s.hits("a")).toBe(3);
    expect(s.frame(400).glows[0]!.strength).toBeCloseTo(rampStrength(3) * (1 - 150 / 60_000), 6);
  });

  it("a missed release: the ttl ends the front into an afterglow", () => {
    const s = new GlassState(T);
    s.keyUp("ch1", site(), 5000, 0);
    const f = s.frame(60_000 + 100);
    expect(f.fronts[0]!.releasing).toBeCloseTo(100 / RELEASE_MS, 6);
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

  it("signal maps dBFS to brightness, clamped; unknown ids are ignored", () => {
    const s = new GlassState(T);
    s.keyUp("ch1", site(), 5000, 0);
    s.signal("ch1", -10);
    expect(s.frame(1).fronts[0]!.bright).toBe(1);
    s.signal("ch1", -27.5);
    expect(s.frame(1).fronts[0]!.bright).toBeCloseTo(0.5, 6);
    s.signal("ch1", -90);
    expect(s.frame(1).fronts[0]!.bright).toBe(0.15);
    expect(() => s.signal("nope", -20)).not.toThrow();
    expect(() => s.release("nope", 1)).not.toThrow();
    expect(() => s.rearm("nope", 1)).not.toThrow();
  });

  it("seedGlow backfills a pre-decayed afterglow; an expired row seeds nothing", () => {
    const s = new GlassState(T);
    s.seedGlow(site("a"), 4000, 100_000 - 30_000, 100_000);
    s.seedGlow(site("b"), 4000, 100_000 - 61_000, 100_000);
    const f = s.frame(100_000);
    expect(f.glows.map((g) => g.key)).toEqual(["a"]);
    expect(f.glows[0]!.strength).toBeCloseTo(rampStrength(1) * 0.5, 6);
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
    expect(glows.map((x) => x.key)).not.toContain("g0");   // the faintest (oldest) dropped
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run test/glassState.test.ts`
Expected: FAIL, because the module can't be resolved.

- [ ] **Step 3: Implement**

`kiosk/src/frontend/map/glassState.ts`:
```ts
// Pure transmission/afterglow lifecycle for Weather Glass (spec 2026-10-01 §3).
// key-up → eased grow → breathing hold (brightness follows signal dBFS) →
// release dissolves the rim over RELEASE_MS while the site's afterglow starts
// at full and fades over the blip lifetime. Replaces BlipField + txRing: the
// front latches its radius itself, so a re-armed carrier never pops.
import {
  MAX_FRONTS, MAX_GLOWS, easeOutCubic, fadeProgress,
  type Rgb, type Front, type Glow, type GlassFrame,
} from "./glassMath.js";

export interface GlassSite { key: string; lat: number; lng: number; color: Rgb }
export interface GlassTimings { growMs: number; releaseMs: number; glowLifetimeMs: number; ttlMs: number }

export const RELEASE_MS = 1500;
// Rim brightness window for the audible channel's `signal` telemetry.
export const SIGNAL_FLOOR_DBFS = -45;
export const SIGNAL_CEIL_DBFS = -10;
const MIN_BRIGHT = 0.15;
export const DEFAULT_BRIGHT = 0.6;   // open channels without signal telemetry

/** Afterglow weight by hits in the window — the old blip ramp's 1..6 cap. */
export function rampStrength(hits: number): number {
  return 0.5 + (0.5 * Math.min(Math.max(hits, 0), 6)) / 6;
}

interface LiveFront { id: string; site: GlassSite; radiusM: number; born: number; until: number; bright: number; releasedAt: number | null }
interface SiteState { site: GlassSite; radiusM: number; hits: number; glowStart: number | null }

export class GlassState {
  private readonly fronts = new Map<string, LiveFront>();
  private readonly sites = new Map<string, SiteState>();

  constructor(private readonly t: GlassTimings) {}

  keyUp(id: string, site: GlassSite, radiusM: number, now: number): void {
    const existing = this.fronts.get(id);
    if (existing && existing.releasedAt === null) { existing.until = now + this.t.ttlMs; return; }
    this.fronts.set(id, { id, site, radiusM, born: now, until: now + this.t.ttlMs, bright: DEFAULT_BRIGHT, releasedAt: null });
    const s = this.sites.get(site.key);
    if (s) { s.hits++; s.radiusM = radiusM; s.site = site; }
    else this.sites.set(site.key, { site, radiusM, hits: 1, glowStart: null });
    // Cap live fronts: drop the oldest.
    if (this.fronts.size > MAX_FRONTS) {
      const oldest = [...this.fronts.values()].sort((a, b) => a.born - b.born)[0];
      if (oldest) this.fronts.delete(oldest.id);
    }
  }

  rearm(id: string, now: number): void {
    const f = this.fronts.get(id);
    if (f && f.releasedAt === null) f.until = now + this.t.ttlMs;
  }

  signal(id: string, dbfs: number): void {
    const f = this.fronts.get(id);
    if (!f) return;
    const k = (dbfs - SIGNAL_FLOOR_DBFS) / (SIGNAL_CEIL_DBFS - SIGNAL_FLOOR_DBFS);
    f.bright = Math.min(1, Math.max(MIN_BRIGHT, k));
  }

  release(id: string, now: number): void {
    const f = this.fronts.get(id);
    if (!f || f.releasedAt !== null) return;
    f.releasedAt = now;
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

  frame(now: number): GlassFrame {
    const fronts: Front[] = [];
    let growing = false;
    for (const f of [...this.fronts.values()]) {
      // A missed release: the ttl acts as one.
      if (f.releasedAt === null && now >= f.until) this.release(f.id, f.until);
      const releasing = f.releasedAt === null ? 0 : fadeProgress(f.releasedAt, now, this.t.releaseMs);
      if (releasing >= 1) { this.fronts.delete(f.id); continue; }
      const p = fadeProgress(f.born, now, this.t.growMs);
      if (p < 1) growing = true;
      fronts.push({
        id: f.id, key: f.site.key, lat: f.site.lat, lng: f.site.lng, radiusM: f.radiusM, color: f.site.color,
        ageMs: now - f.born, grow: easeOutCubic(p), bright: f.bright, releasing,
      });
    }
    const liveKeys = new Set([...this.fronts.values()].map((f) => f.site.key));
    const glows: Glow[] = [];
    for (const [key, s] of this.sites) {
      const age = s.glowStart === null ? null : now - s.glowStart;
      if (age !== null && age >= this.t.glowLifetimeMs) s.glowStart = null;
      if (s.glowStart === null) {
        if (!liveKeys.has(key)) this.sites.delete(key);   // window over: hits reset
        continue;
      }
      glows.push({
        key, lat: s.site.lat, lng: s.site.lng, radiusM: s.radiusM, color: s.site.color,
        strength: rampStrength(s.hits) * (1 - (now - s.glowStart) / this.t.glowLifetimeMs),
      });
    }
    glows.sort((a, b) => b.strength - a.strength);
    return { fronts, glows: glows.slice(0, MAX_GLOWS), growing };
  }
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx vitest run test/glassState.test.ts`
Expected: PASS (10 tests). If the "missed release" test fails on `releasing`, check that `frame()` calls `release(f.id, f.until)` (the ttl moment) and not `release(f.id, now)`.

- [ ] **Step 5: Commit**

```bash
git add src/frontend/map/glassState.ts test/glassState.test.ts
git commit -m "feat(glass): glassState — fronts, signal brightness, release, afterglow

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 12: `/api/test/tx` preview driver

**Files:**
- Modify: `kiosk/src/backend/server.ts` (directly after the `/api/test/alert` route)
- Modify: `docs/API.md` (the Appliance plumbing table)
- Test: `kiosk/test/testTxRoute.test.ts`

**Interfaces:**
- Produces: `POST /api/test/tx { channelId?: string; holdMs?: number }`.
  - Response: `200 { ok: true, channelId, holdMs }`, or `404` when there's no such located channel.
  - Behaviour: broadcasts `active` + `audible{channel}` immediately, `signal` every 400 ms, then `release` + `audible{null}` after `holdMs`.
  - `holdMs` defaults to 6000 and is clamped to 1000..60000.
  - With no `channelId`, it picks a random enabled channel that has a location.

- [ ] **Step 1: Write the failing test**

`kiosk/test/testTxRoute.test.ts`:
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
    // Real timers: fake ones would also stall supertest's sockets. holdMs is
    // clamped to >= 1000, so this test waits ~1.1 s.
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

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run test/testTxRoute.test.ts`
Expected: FAIL, because the route falls through (404/SPA).

- [ ] **Step 3: Implement**

In `kiosk/src/backend/server.ts`, directly after the `/api/test/alert` route block, add:
```ts
    // Weather Glass preview driver: play a synthetic transmission on a located
    // channel through the WS only — no engine, no audio, no history — so the
    // operator can watch fronts on the passive wall (CLAUDE.md "Previewing
    // wall states"). Script it to cycle sites.
    if (method === "POST" && path === "/api/test/tx") {
      const body = await readBody(req).catch(() => undefined);
      const located = config.channels.filter((c) => c.enabled && c.location?.lat != null && c.location.lon != null);
      const ch = typeof body?.channelId === "string"
        ? located.find((c) => c.id === body.channelId)
        : located[Math.floor(Math.random() * located.length)];
      if (!ch) return json(res, 404, { error: "no such located channel" });
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
In `docs/API.md`, add a row after `/api/test/alert`:
```markdown
| POST | `/api/test/tx` | Weather Glass preview: play a synthetic transmission (`active` → `audible` → `signal`… → `release`) on a located channel over the WS only — no engine/audio/history. `{ channelId?, holdMs? }` (random located channel; hold 6000 ms, clamped 1000–60000) → `{ ok, channelId, holdMs }`; `404` if none. |
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx vitest run test/testTxRoute.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/backend/server.ts test/testTxRoute.test.ts ../docs/API.md
git commit -m "feat(glass): POST /api/test/tx — WS-only synthetic transmission for wall previews

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 13: Replace both Circle systems with glass fronts and afterglows

**Files:**
- Modify: `kiosk/src/frontend/map/map.ts`
- Modify: `kiosk/src/frontend/map/blips.ts` (delete the `BlipInput`, `Blip` and `BlipField` exports; keep `GeoPoint`, `syntheticPoint` and `coverageRadiusM`)
- Delete: `kiosk/src/frontend/map/txRing.ts`, `kiosk/test/txRing.test.ts`
- Modify: `kiosk/test/blips.test.ts` (delete the `BlipField` describe block and its import)

**Interfaces:**
- Consumes: `GlassState`, `GlassSite`, `RELEASE_MS` (Task 11); `hexToGlowRgb` (Task 6); `GlassLayer` (Task 8); `display.glass.txGrowMs`.

- [ ] **Step 1: Delete the dead modules and their tests**

```bash
git rm src/frontend/map/txRing.ts test/txRing.test.ts
```
In `src/frontend/map/blips.ts`:
- delete the `BlipInput` interface, the `Blip` interface and the `BlipField` class;
- replace the file's header comment with: `// Geometry helpers for the activity map: synthetic placement for unlocated traffic and the FCC coverage-radius estimate.`

In `test/blips.test.ts`, remove `BlipField` from the import and delete its `describe` block.

- [ ] **Step 2: Rewire map.ts**

In `kiosk/src/frontend/map/map.ts`:
1. Imports:
   - remove `import { BlipField, coverageRadiusM } from "./blips.js";` and `import { heldTxRadius } from "./txRing.js";`;
   - add `import { coverageRadiusM } from "./blips.js";`, `import { GlassState, RELEASE_MS, type GlassSite } from "./glassState.js";` and `import { hexToGlowRgb } from "./glassMath.js";`.
2. Remove `EMPTY_FRAME` from the `glassMath.js` import added in Task 9. In the Weather Glass block, create the state before the layer and feed it in:
```ts
    const glassState = new GlassState({
      growMs: display.glass.txGrowMs, releaseMs: RELEASE_MS,
      glowLifetimeMs: BLIP_LIFETIME_MS, ttlMs: TX_TTL_MS,
    });
    const glass = mapId
      ? new GlassLayer({ map, home, knobs: display.glass, getFrame: (now) => glassState.frame(now) })
      : null;
```
   `TX_TTL_MS` is currently declared further down. Move `const TX_TTL_MS = 60_000;` (with its comment) up to sit beside `BLIP_LIFETIME_MS` at module scope.
3. Delete all of the following:
   - `const field = new BlipField(...)`
   - the `circles` map and its comment
   - `TX_GROW_MS`, `GROW_FRAME_DELAY_MS` and their comments
   - `liveTx`, `txRings`
   - `ticking`, `wake()`, `tick()` (the entire render loop, through its final `wake();` call)
   - every `wake();` call
4. Add a site helper below `tagsFor`:
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
5. Replace `startTx` and `endTx` with:
```ts
    function startTx(id: string, lat: number, lng: number, freq: number | undefined, kind: "active" | "closecall"): void {
      const s = glassSite(lat, lng, freq, kind);
      glassState.keyUp(id, s, siteRadius(s.key, glassState.hits(s.key) + 1), Date.now());
    }
    function endTx(id: string): void {
      glassState.release(id, Date.now());
    }
```
6. Replace `push()` with:
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
      }
    }
```
7. In the WS handler:
   - `active`: change the `push(...)` call to pass `true` as the new last argument (`push(ch.location.lat, ch.location.lon, ch.alphaTag || fmtFreq(ev.freq), "active", Date.now(), ev.freq, true);`). The history backfill call keeps the default `false`.
   - `release`: keep `endTx(ev.channelId);`.
   - `idle`: replace the loop with `glassState.releaseAll(Date.now());` (keep `audibleId = null;`).
   - `signal`: replace the body with:
```ts
        if (audibleId) { glassState.rearm(audibleId, Date.now()); glassState.signal(audibleId, ev.dbfs); }
```
8. Search `map.ts` for any remaining `circles`, `liveTx`, `txRings`, `field.` or `google.maps.Circle` and remove them. `rg -n "circles|liveTx|txRings|field\.|Circle\(" src/frontend/map/map.ts` must print nothing.

- [ ] **Step 3: Test and typecheck**

Run: `npm test && npm run typecheck`
Expected: all pass, clean.

- [ ] **Step 4: Commit**

```bash
git add -A src/frontend/map test/blips.test.ts
git commit -m "feat(glass): transmissions as glass fronts + afterglows; drop Circle rings, BlipField, txRing

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 14: Ship PR 3

- [ ] **Step 1: Definition-of-done checks**

Run: `npm test && npm run test:native && npm run typecheck && npm run build`

- [ ] **Step 2: Deploy** (the new route is backend)

`sudo systemctl restart kerchunk-kiosk`, wait for `/api/status`, then `curl -X POST localhost:8080/api/kiosk/reload`. Wait ~15 s.

- [ ] **Step 3: Drive previews and screenshot**

Run this with `run_in_background: true`. It cycles 8 transmissions across the city, 9 s apart:
```bash
for i in $(seq 8); do curl -s -X POST localhost:8080/api/test/tx -H 'content-type: application/json' -d '{"holdMs":6000}'; echo; sleep 9; done
```
While it runs, take screenshots at roughly 0.3 s, 3 s and 7.5 s into a transmission, plus one 20 s after the last:
```bash
XDG_RUNTIME_DIR=/run/user/1000 WAYLAND_DISPLAY=wayland-0 grim /tmp/claude-1000/tx-$(date +%s).png
```
Check:
- (a) the front centres sit exactly on their service pins;
- (b) it grows to the site's coverage and holds as a breathing rim;
- (c) on release it dissolves into a soft afterglow disc that is still visible 20 s later;
- (d) there are no flat Google circles left anywhere.

Also confirm a real transmission behaves the same when one happens. Ask the operator to watch the wall during the cycle.

- [ ] **Step 4: Thermal spot-check**

Run the 10-minute loop from Task 10 Step 1 while traffic is normal.
Expected: comparable to Task 10's "after" (fronts only add work during transmissions).

- [ ] **Step 5: Push, open the PR, merge, clean up**

```bash
git push -u origin feat/glass-transmissions
gh pr create --title "feat(glass): transmissions as light fronts + afterglows (PR 3/4)" --body "$(cat <<'EOF'
Replaces both Google Circle systems (live tx rings, decaying blips) with Weather Glass fronts (spec §3).

- Key-up flash → eased grow to coverage → breathing rim (brightness follows live signal dBFS) → release dissolves into a 60 s afterglow (hit-ramped)
- Backfilled history seeds pre-decayed afterglows; a missed release ends via the 60 s TTL
- POST /api/test/tx drives synthetic transmissions over the WS for wall previews
- Deletes BlipField and txRing.ts (glassState latches the radius itself)

Knob: `display.glass.txGrowMs` (900). Constants: RELEASE_MS, SIGNAL_FLOOR/CEIL_DBFS in src/frontend/map/glassState.ts; MAX_FRONTS/MAX_GLOWS in glassMath.ts.

Proof: <screenshot notes per check, thermal>

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
gh pr merge <n> --merge --delete-branch && git checkout main && git pull --ff-only && git fetch --prune && git branch -d feat/glass-transmissions
```

---

## PR 4 — Gentle camera + docs

> **Superseded** by docs/superpowers/plans/2026-10-02-fixed-stage-event-pacing.md (PR B / dropped). Do not execute.

Start: `git checkout main && git pull --ff-only && git checkout -b feat/glass-camera`

### Task 15: cameraTween — eased tween and fitCamera

**Files:**
- Create: `kiosk/src/frontend/map/cameraTween.ts`
- Test: `kiosk/test/cameraTween.test.ts`

**Interfaces:**
- Produces:
```ts
export interface Cam { lat: number; lng: number; zoom: number }
export function easeInOutCubic(t: number): number;
export class CameraTween { start(from: Cam, to: Cam, durMs: number, now: number): void; at(now: number): Cam | null; readonly active: boolean }
export function fitCamera(b: { n: number; s: number; e: number; w: number }, vp: { width: number; height: number },
  pad: { top: number; right: number; bottom: number; left: number }, maxZoom?: number): Cam;   // maxZoom default 22
```
- `at()` returns the eased camera while active. On the first call at or after the end it returns `to` exactly and becomes inactive. It returns `null` when idle.

- [ ] **Step 1: Write the failing tests**

`kiosk/test/cameraTween.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { CameraTween, easeInOutCubic, fitCamera } from "../src/frontend/map/cameraTween.js";

describe("easeInOutCubic", () => {
  it("is symmetric with fixed endpoints", () => {
    expect(easeInOutCubic(0)).toBe(0);
    expect(easeInOutCubic(1)).toBe(1);
    expect(easeInOutCubic(0.5)).toBe(0.5);
    expect(easeInOutCubic(0.25)).toBeCloseTo(1 - easeInOutCubic(0.75), 9);
  });
});

describe("CameraTween", () => {
  const A = { lat: 39, lng: -94.5, zoom: 10.6 }, B = { lat: 39.2, lng: -94.3, zoom: 11.6 };
  it("eases centre and zoom together, lands exactly, then goes idle", () => {
    const t = new CameraTween();
    expect(t.at(0)).toBeNull();
    t.start(A, B, 1000, 0);
    expect(t.active).toBe(true);
    const mid = t.at(500)!;
    expect(mid.lat).toBeCloseTo(39.1, 9);
    expect(mid.zoom).toBeCloseTo(11.1, 9);
    expect(t.at(1200)).toEqual(B);
    expect(t.active).toBe(false);
    expect(t.at(1300)).toBeNull();
  });
  it("retargets mid-flight from where the camera is — no snap", () => {
    const t = new CameraTween();
    t.start(A, B, 1000, 0);
    const here = t.at(300)!;
    const C = { lat: 38.9, lng: -94.7, zoom: 11 };
    t.start(here, C, 1000, 300);
    expect(t.at(300)).toEqual(here);
    expect(t.at(1300)).toEqual(C);
  });
  it("a zero duration lands immediately", () => {
    const t = new CameraTween();
    t.start(A, B, 0, 50);
    expect(t.at(50)).toEqual(B);
  });
});

describe("fitCamera", () => {
  const none = { top: 0, right: 0, bottom: 0, left: 0 };
  it("fits a box the way Google's world-pixel math does", () => {
    expect(fitCamera({ n: 10, s: -10, e: 90, w: -90 }, { width: 512, height: 512 }, none))
      .toEqual({ lat: expect.closeTo(0, 9), lng: expect.closeTo(0, 9), zoom: expect.closeTo(2, 9) });
    const c = fitCamera({ n: 39.3, s: 38.8, e: -94.2, w: -94.9 }, { width: 1920, height: 1080 }, none);
    expect(c.lat).toBeCloseTo(39.05044, 4);
    expect(c.lng).toBeCloseTo(-94.55, 9);
    expect(c.zoom).toBeCloseTo(11.20390, 4);
  });
  it("asymmetric kiosk padding shifts the centre (top 250 > bottom 120 → centre moves north)", () => {
    const c = fitCamera({ n: 39.3, s: 38.8, e: -94.2, w: -94.9 }, { width: 1920, height: 1080 }, { top: 250, left: 80, right: 80, bottom: 120 });
    expect(c.lat).toBeCloseTo(39.09620, 4);
    expect(c.lng).toBeCloseTo(-94.55, 9);
    expect(c.zoom).toBeCloseTo(10.59875, 4);
  });
  it("degenerate bounds (a single site) cap at maxZoom instead of Infinity", () => {
    const c = fitCamera({ n: 39, s: 39, e: -94, w: -94 }, { width: 1920, height: 1080 }, none);
    expect(c.zoom).toBe(22);
    expect(fitCamera({ n: 39, s: 39, e: -94, w: -94 }, { width: 1920, height: 1080 }, none, 13).zoom).toBe(13);
    expect(c.lat).toBeCloseTo(39, 9);
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run test/cameraTween.test.ts`
Expected: FAIL, because the module can't be resolved.

- [ ] **Step 3: Implement**

`kiosk/src/frontend/map/cameraTween.ts`:
```ts
// One eased curve for the kiosk camera (spec 2026-10-01 §3): centre and
// fractional zoom move together via map.moveCamera(), replacing panTo +
// setZoom (two different curves) and the fitBounds jump back. Pure math.

export interface Cam { lat: number; lng: number; zoom: number }

export function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

export class CameraTween {
  private from: Cam | null = null;
  private to: Cam | null = null;
  private t0 = 0;
  private dur = 0;

  get active(): boolean { return this.to !== null; }

  start(from: Cam, to: Cam, durMs: number, now: number): void {
    this.from = from; this.to = to; this.t0 = now; this.dur = durMs;
  }

  at(now: number): Cam | null {
    const from = this.from, to = this.to;
    if (!from || !to) return null;
    const p = this.dur <= 0 ? 1 : Math.min(1, Math.max(0, (now - this.t0) / this.dur));
    if (p >= 1) { this.from = this.to = null; return to; }
    const k = easeInOutCubic(p);
    return {
      lat: from.lat + (to.lat - from.lat) * k,
      lng: from.lng + (to.lng - from.lng) * k,
      zoom: from.zoom + (to.zoom - from.zoom) * k,
    };
  }
}

const TILE = 256;
const worldX = (lng: number): number => (lng + 180) / 360;
const worldY = (lat: number): number => {
  const r = (lat * Math.PI) / 180;
  return (1 - Math.log(Math.tan(Math.PI / 4 + r / 2)) / Math.PI) / 2;
};

/** The camera Google's fitBounds would land on (fractional zoom, vector map),
 *  honouring asymmetric padding like KIOSK_FIT_PAD. */
export function fitCamera(
  b: { n: number; s: number; e: number; w: number },
  vp: { width: number; height: number },
  pad: { top: number; right: number; bottom: number; left: number },
  maxZoom = 22,
): Cam {
  const dx = Math.max(worldX(b.e) - worldX(b.w), 1e-12);
  const dy = Math.max(worldY(b.s) - worldY(b.n), 1e-12);
  const aw = Math.max(1, vp.width - pad.left - pad.right);
  const ah = Math.max(1, vp.height - pad.top - pad.bottom);
  const zoom = Math.min(Math.log2(aw / (TILE * dx)), Math.log2(ah / (TILE * dy)), maxZoom);
  const S = TILE * Math.pow(2, zoom);
  const cx = ((worldX(b.w) + worldX(b.e)) / 2) * S - (pad.left - pad.right) / 2;
  const cy = ((worldY(b.n) + worldY(b.s)) / 2) * S - (pad.top - pad.bottom) / 2;
  return {
    lat: ((2 * Math.atan(Math.exp(Math.PI * (1 - (2 * cy) / S))) - Math.PI / 2) * 180) / Math.PI,
    lng: (cx / S) * 360 - 180,
    zoom,
  };
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx vitest run test/cameraTween.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/frontend/map/cameraTween.ts test/cameraTween.test.ts
git commit -m "feat(glass): cameraTween — one eased curve + fitCamera

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 16: Camera knobs and wiring

**Files:**
- Modify: `kiosk/src/backend/config/schema.ts` (add `display.camera` after `glass`)
- Modify: `kiosk/src/frontend/map/map.ts` (the "Activity camera" block: `PUNCH_HOLD_MS`, `PUNCH_ZOOM_IN`, `punch()`, the pull-back `setInterval`)
- Test: `kiosk/test/schema.test.ts`

**Interfaces:**
- Consumes: `CameraTween`, `fitCamera`, `Cam` (Task 15).
- Produces: `config.display.camera: { pushZoom: number; pushMs: number; holdMs: number; returnMs: number }`.

- [ ] **Step 1: Write the failing test**

Append to `kiosk/test/schema.test.ts`:
```ts
describe("display.camera", () => {
  it("fills the gentle-camera defaults", () => {
    const cfg = configSchema.parse({ ...defaultConfig(), display: { weatherLat: 39.1, weatherLon: -94.58 } });
    expect(cfg.display!.camera).toEqual({ pushZoom: 1, pushMs: 2500, holdMs: 12_000, returnMs: 4000 });
  });
});
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run test/schema.test.ts`
Expected: FAIL, because `camera` is undefined.

- [ ] **Step 3: Implement the schema**

After the `glass` block in `display`:
```ts
    // Kiosk activity camera (frontend/map/cameraTween.ts): a slow eased push
    // toward the audible speaker, a hold, then a drift back to the framing.
    camera: z.object({
      pushZoom: z.number().min(0).max(4).default(1),               // levels in from the home framing
      pushMs: z.number().int().min(0).max(20_000).default(2_500),
      holdMs: z.number().int().min(1_000).max(120_000).default(12_000), // quiet time before returning
      returnMs: z.number().int().min(0).max(20_000).default(4_000),
    }).default({}),
```

- [ ] **Step 4: Implement the map wiring**

In `kiosk/src/frontend/map/map.ts`:
1. Add the import: `import { CameraTween, fitCamera, type Cam } from "./cameraTween.js";`.
2. Replace the block from `const PUNCH_HOLD_MS = 12_000;` through the end of the `if (!interactive) { setInterval(... fitBounds ...) }` pull-back with:
```ts
    const camCfg = display.camera;
    const camTween = new CameraTween();
    let camRaf = 0;
    let punchedUntil = 0;
    function homeCam(): Cam {
      const b = framedBounds();
      const ne = b.getNorthEast(), sw = b.getSouthWest();
      const r = root.getBoundingClientRect();
      return fitCamera({ n: ne.lat(), s: sw.lat(), e: ne.lng(), w: sw.lng() }, { width: r.width, height: r.height }, fitPad, 13);
    }
    function camStep(): void {
      camRaf = 0;
      const c = camTween.at(performance.now());
      if (!c) return;
      map.moveCamera({ center: { lat: c.lat, lng: c.lng }, zoom: c.zoom });
      if (camTween.active) camRaf = requestAnimationFrame(camStep);
    }
    function camGoto(to: Cam, durMs: number): void {
      const c = map.getCenter();
      // Start from wherever the camera IS (mid-tween included): no snap.
      camTween.start({ lat: c.lat(), lng: c.lng(), zoom: map.getZoom() }, to, durMs, performance.now());
      if (!camRaf) camRaf = requestAnimationFrame(camStep);
    }
    function punch(lat: number, lng: number): void {
      if (interactive) return;
      punchedUntil = Date.now() + camCfg.holdMs;
      camGoto({ lat, lng, zoom: Math.min(homeCam().zoom + camCfg.pushZoom, 13) }, camCfg.pushMs);
    }
    if (!interactive) {
      setInterval(() => {
        if (punchedUntil && Date.now() >= punchedUntil) {
          punchedUntil = 0;
          camGoto(homeCam(), camCfg.returnMs);
        }
      }, 1500);
    }
```
3. `homeZoom` is now unused. Delete its declaration and the `google.maps.event.addListenerOnce(map, "idle", () => { homeZoom = map.getZoom(); });` line, and update the comment above the initial `fitBounds` so it no longer mentions `homeZoom`. The initial framing stays an instant `fitBounds`.
4. `camStep` re-arms only through rAF, but a dropped rAF just leaves the camera parked mid-move until the next `camGoto`. The 1500 ms return interval re-kicks it within one hold, so no wall-clock fallback is needed. Put a comment saying so above `camStep`.

- [ ] **Step 5: Test and typecheck**

Run: `npm test && npm run typecheck`
Expected: all pass, clean.

- [ ] **Step 6: Commit**

```bash
git add src/backend/config/schema.ts src/frontend/map/map.ts test/schema.test.ts
git commit -m "feat(glass): gentle camera — one eased push/return via moveCamera, display.camera knobs

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 17: Docs + ship PR 4

**Files:**
- Modify: `docs/ROADMAP.md` (Idea 3 section)
- Modify: `CLAUDE.md` (repo root; "Architecture notes" and "Do-not-undo invariants")

- [ ] **Step 1: Update ROADMAP Idea 3**

Directly under the `## Idea 3 — An artistic treatment of the data on hand (brainstorm)` heading's operator-note blockquote, add:
```markdown
> **Shipped 2026-10 — Weather Glass** (spec `docs/superpowers/specs/2026-10-01-weather-glass-design.md`):
> the map-stage art became one GPU layer inside Google's GL context — real
> NEXRAD (IEM n0q, crossfaded between scans, never interpolated), an ambient
> haze so a quiet wall still moves, and transmissions as light fronts with
> 60 s afterglows. Chosen over Isobars and Halftone from live shader mockups.
```

- [ ] **Step 2: Update CLAUDE.md**

In "Architecture notes", add a bullet:
```markdown
- **Weather Glass layer.** The kiosk/`/map` art is one `WebGLOverlayView`
  (`src/frontend/map/glassLayer.ts`) drawing inside Google's GL context:
  - real radar from `RadarFeed` (`src/backend/radar/`, IEM n0q composite,
    cropped around the QTH, served raw at `/api/radar/frame`);
  - haze, transmission fronts and afterglows, with all their timing in pure
    `glassState.ts`.

  Knobs: `display.radar.*` (backend, needs a restart), `display.glass.*` and
  `display.camera.*` (page, reload). It needs a Map ID (vector). Preview
  fronts on the passive wall with `POST /api/test/tx`.
```
In "Do-not-undo invariants", add:
```markdown
- **Radar is real data only.** Weather Glass may restyle radar (palette,
  B-spline reconstruction, crossfade between two real scans) but never
  shimmer, refract or motion-interpolate it — operator mandate. Stale scans
  fade out; they are never shown as current.
- **Glass GL state is saved/restored around every draw**, and texture
  uploads happen only inside `onDraw`. Google owns the context; skipping
  this corrupts the base map.
```

- [ ] **Step 3: Definition-of-done checks**

Run: `npm test && npm run test:native && npm run typecheck && npm run build`

- [ ] **Step 4: Deploy** (the schema is backend)

`sudo systemctl restart kerchunk-kiosk`, wait for `/api/status`, then `curl -X POST localhost:8080/api/kiosk/reload`. Wait ~15 s.

- [ ] **Step 5: Prove the camera**

Fire one test transmission (`curl -s -X POST localhost:8080/api/test/tx -H 'content-type: application/json' -d '{"holdMs":4000}'`). Take screenshots at 0 s, 1.2 s and 2.5 s (the push), then at about 16.5 s and 18.5 s (12 s hold + 1.5 s interval, then the 4 s return).
Check:
- (a) the push is one smooth curve, roughly one zoom level in;
- (b) no snap when a second `/api/test/tx` fires mid-push (repeat it with two calls 1 s apart);
- (c) the return lands on the same framing as page load (compare with a fresh-load screenshot).

Have the operator watch a live transmission too.

- [ ] **Step 6: Push, open the PR, merge, clean up**

```bash
git add ../docs/ROADMAP.md ../CLAUDE.md
git commit -m "docs: Weather Glass shipped — roadmap Idea 3, CLAUDE.md architecture + invariants

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push -u origin feat/glass-camera
gh pr create --title "feat(glass): gentle camera + Weather Glass docs (PR 4/4)" --body "$(cat <<'EOF'
- Camera push/return is one eased curve via map.moveCamera (centre + fractional zoom together); a new speaker mid-move retargets from where the camera is
- ROADMAP Idea 3 + CLAUDE.md record the shipped layer and its invariants

Knobs (src/backend/config/schema.ts, `display.camera`, apply via PUT /api/config + POST /api/kiosk/reload): pushZoom 1, pushMs 2500, holdMs 12000, returnMs 4000.

Proof: <screenshot notes>

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
gh pr merge <n> --merge --delete-branch && git checkout main && git pull --ff-only && git fetch --prune && git branch -d feat/glass-camera
```
