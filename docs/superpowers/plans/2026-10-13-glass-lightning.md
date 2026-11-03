# Glass Lightning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replay real GOES-19 GLM lightning flashes as cloud blooms on the kiosk's Weather Glass. Blooms step on a shared 3 s tick, about 75 s behind the sky.

**Architecture:** A backend `LightningFeed` (modeled on `RadarFeed`) polls NOAA's public S3 bucket and reads each new 20-s GLM file with **h5wasm**. It keeps in-box flashes in a 5-min buffer and serves them over a WS `lightning` event plus a `GET /api/lightning?since=` route that fills gaps after a page load or missed event. On the wall, a pure `LightningState` scheduler assigns each flash to a grid tick (`t + replayDelayMs`, snapped up), and a new additive `STRIKE_FS` pass in `GlassLayer` draws the blooms between radar and smoke. Pacing merges into the glass's existing `nextChangeAt`, so a quiet sky costs zero redraws.

**Tech Stack:** TypeScript (Node ≥24, ESM, `.js` import suffixes), zod config, vitest + supertest, h5wasm 0.10.3, WebGL2 GLSL ES 3.00 inside Google's `WebGLOverlayView`.

**Spec:** `docs/superpowers/specs/2026-10-13-glass-lightning-design.md`

## Global Constraints

- Every change ships through a PR from a branch; never commit to `main`. PR 1 = `feat/lightning-feed` (Tasks 1–6), PR 2 = `feat/glass-lightning` (Tasks 7–11).
- All commands run from `kiosk/` unless stated. Relative imports carry `.js`. `tsconfig` is `strict` + `noUncheckedIndexedAccess`: handle `undefined` from every indexed read.
- `/api/status`, `/api/logs`, `/api/weather` response shapes do not change (external consumer).
- Bucket `noaa-goes19` (`display.lightning.satellite` "goes19"), product `GLM-L2-LCFA`. CF scaling (`scale_factor`, `add_offset`, `_Unsigned`) **must** be applied.
- Backend knobs (boot-time, restart): `display.lightning.{enabled true, satellite "goes19", pollMs 20000, bufferMs 300000, staleMs 180000, fetchTimeoutMs 30000, maxCatchupFiles 6, spanDeg {w:4,h:3}}`.
- Wall knobs (on `kiosk/reload`): `display.glass.lightning.{enabled true, stepMs 3000, replayDelayMs 75000, bloomSteps 2, bloomIntensity 0.75, bloomScale 1.0, maxBlooms 32}`.
- Bloom: radius = `√(areaKm2/π)` km × `bloomScale`; intensity = `bloomIntensity × level × min(1, 0.35 + log10(1+energyFj)/3)`; level = `1 − i/bloomSteps`; colour core `(0.92,0.94,1.0)` → periwinkle `(0.72,0.78,1.0)`.
- No standing animation, no `backdrop-filter`, no full-screen overlays above the map. The strike pass only draws on frames that are already redrawing.
- Definition of done per PR: `npm test`, `npm run test:native`, `npm run typecheck`, full `npm run build` all pass, plus proof on hardware.

**Deviations from the spec, flagged for the operator:**
1. The `replayDelayMs` floor is **30 000**, not 0. GLM files are 20–50 s old on arrival and the late rule drops anything more than one tick late, so a delay under ~30 s would silently drop almost every flash.
2. The fixture is **400 KB**, not ~250 KB. Every GLM file from the storm was ~400 KB, and the smallest one with KC flashes is used.
3. **New, not in the spec:** bloom radius is capped at `MAX_STRIKE_RADIUS_KM` = 30. One giant GLM flash (≥ 2 800 km²) would otherwise wash the whole stage.
4. **The HDF5 reader is already decided: h5wasm.** The spec's "try jsfive first" probe ran while this plan was being written. jsfive reads the values correctly but returns **no attributes** on the scaled int16 variables (`scale_factor`, `add_offset`, `_Unsigned` all undefined). h5wasm reads values and attributes, 6–40 ms per file, matching h5py.
5. **New, not in the spec:** the feed logs an hourly `[lightning] last hour: …` line. Task 6's bandwidth proof needs it, and it's useful in operation.

## Review Focus

- **A GLM file with zero flashes worldwide** (quiet hemisphere) → `[]`, no throw. Pinned in Task 1 (`toFlashes` with empty arrays).
- **Listing across a day or New Year boundary** (`2026/365/23` → `2027/001/00`) → both hour prefixes listed, no flash gap. Pinned in Task 2.
- **The same flash arriving by WS and by the backfill poll** → blooms once. Pinned in Task 7.
- **A giant flash** (GLM areas reach thousands of km²) → bloom radius capped, not a full-screen white-out. Pinned in Task 7.
- **A download failure versus a parse failure** → the download retries next poll (still inside the window); a corrupt file is skipped for good and never re-downloaded each poll. Pinned in Task 3.

---

## File structure

**PR 1: backend**
- Create `kiosk/src/backend/lightning/types.ts`: `Flash`, `Box`. No imports, because the frontend type-imports it.
- Create `kiosk/src/backend/lightning/glm.ts`: h5wasm read → `RawGlm`, pure `toFlashes()`, `parseGlm()`.
- Create `kiosk/src/backend/lightning/keys.ts`: S3 key/prefix/time helpers and the listing XML parse.
- Create `kiosk/src/backend/lightning/LightningFeed.ts`: poller, buffer, stale flag, `LightningSource`.
- Create `kiosk/test/fixtures/glm/OR_GLM-L2-LCFA_G19_s20262870229000_e20262870229200_c20262870229219.nc` (real file, 400 KB).
- Create tests `kiosk/test/lightningGlm.test.ts`, `kiosk/test/lightningKeys.test.ts`, `kiosk/test/lightningFeed.test.ts`, `kiosk/test/lightningRoutes.test.ts`.
- Modify `kiosk/src/backend/config/schema.ts` (`display.lightning`, `display.glass.lightning`), `kiosk/test/schema.test.ts`.
- Modify `kiosk/src/backend/engine/ScannerEngine.ts` (WS union), `kiosk/src/backend/server.ts` (deps, route, broadcast), `kiosk/src/backend/index.ts` (wiring), `docs/API.md`, `kiosk/package.json` (h5wasm).

**PR 2: wall**
- Create `kiosk/src/frontend/map/lightningState.ts`: pure scheduler and bloom maths.
- Create `kiosk/src/frontend/map/lightningSync.ts`: page-load fill-in + WS ingest.
- Create `kiosk/src/backend/lightning/testStorm.ts`: canned 229-flash storm.
- Modify `kiosk/src/frontend/map/glassState.ts` (export `nextTick`), `glassShaders.ts` (`STRIKE_FS`), `glassLayer.ts` (strike pass + pacing merge), `map.ts` (wiring), `server.ts` (`POST /api/test/lightning`), `docs/API.md`.
- Create tests `kiosk/test/lightningState.test.ts`, `kiosk/test/lightningSync.test.ts`, `kiosk/test/lightningTestRoute.test.ts`; modify `kiosk/test/glassShaders.palette.test.ts` (or add `kiosk/test/strikeShader.test.ts`).

---

## PR 1: backend feed (`feat/lightning-feed`)

### Task 0: Branch

- [ ] **Step 1:** Make sure the spec branch is merged or sitting on `main`, then branch:

```bash
cd /home/kiosk/kerchunk-kiosk && git checkout main && git pull --ff-only && git checkout -b feat/lightning-feed
```

### Task 1: GLM reader (`types.ts`, `glm.ts`, fixture, h5wasm)

**Files:**
- Create: `kiosk/src/backend/lightning/types.ts`, `kiosk/src/backend/lightning/glm.ts`
- Create: `kiosk/test/fixtures/glm/OR_GLM-L2-LCFA_G19_s20262870229000_e20262870229200_c20262870229219.nc`
- Test: `kiosk/test/lightningGlm.test.ts`
- Modify: `kiosk/package.json` (dependency)

**Interfaces:**
- Produces: `interface Flash { t: number; lat: number; lon: number; energyFj: number; areaKm2: number }`, `interface Box { n: number; s: number; e: number; w: number }` (types.ts); `toFlashes(raw: RawGlm, box: Box): Flash[]`, `readGlm(bytes: Uint8Array): Promise<RawGlm>`, `parseGlm(bytes: Uint8Array, box: Box): Promise<Flash[]>`, `J2000_MS` (glm.ts).

- [ ] **Step 1: Add the dependency and the fixture**

```bash
cd /home/kiosk/kerchunk-kiosk/kiosk
npm install h5wasm@0.10.3 --save-exact
mkdir -p test/fixtures/glm
cp ../.superpowers/lightning-data/OR_GLM-L2-LCFA_G19_s20262870229000_e20262870229200_c20262870229219.nc test/fixtures/glm/
```

Fallback if `.superpowers/lightning-data/` is gone: `curl -o test/fixtures/glm/<name> https://noaa-goes19.s3.amazonaws.com/GLM-L2-LCFA/2026/287/02/<name>` (NOAA keeps the archive).

- [ ] **Step 2: Write the failing test** (`kiosk/test/lightningGlm.test.ts`)

Ground truth comes from h5py on the same file (2026-10-13 spike): 398 flashes worldwide, 32 inside the KC box; the earliest in-box flash at `1791944938918.5` ms, lat 39.48687, lon −93.01659, 403.28 fJ, 798.26 km²; the next at `1791944939494.9`, lat 39.16328, lon −94.62715, 50.28 fJ, 145.28 km².

```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseGlm, readGlm, toFlashes, J2000_MS, type RawGlm } from "../src/backend/lightning/glm.js";

const FIXTURE = join(import.meta.dirname, "fixtures/glm/OR_GLM-L2-LCFA_G19_s20262870229000_e20262870229200_c20262870229219.nc");
// QTH 39.29, -94.5 ± spanDeg/2 (4 x 3)
const KC = { n: 40.79, s: 37.79, e: -92.5, w: -96.5 };
const WORLD = { n: 90, s: -90, e: 180, w: -180 };

describe("parseGlm (real GOES-19 file, values cross-checked with h5py)", () => {
  it("reads every flash and applies the CF scaling", async () => {
    const all = await parseGlm(new Uint8Array(readFileSync(FIXTURE)), WORLD);
    expect(all).toHaveLength(398);
  });

  it("keeps only flashes in the box, time-ordered, with h5py's values", async () => {
    const kc = await parseGlm(new Uint8Array(readFileSync(FIXTURE)), KC);
    expect(kc).toHaveLength(32);
    const [a, b] = kc;
    expect(a!.t).toBe(1791944938919);                 // rounded ms
    expect(a!.lat).toBeCloseTo(39.48687, 4);
    expect(a!.lon).toBeCloseTo(-93.01659, 4);
    expect(a!.energyFj).toBeCloseTo(403.28, 1);
    expect(a!.areaKm2).toBeCloseTo(798.26, 1);
    expect(b!.t).toBe(1791944939495);
    expect(b!.energyFj).toBeCloseTo(50.28, 1);
    expect(b!.areaKm2).toBeCloseTo(145.28, 1);
    for (let i = 1; i < kc.length; i++) expect(kc[i]!.t).toBeGreaterThanOrEqual(kc[i - 1]!.t);
  });

  it("reads product_time as seconds since J2000 noon", async () => {
    const raw = await readGlm(new Uint8Array(readFileSync(FIXTURE)));
    expect(J2000_MS + raw.productTime * 1000).toBe(Date.parse("2026-10-14T02:29:00Z"));
  });

  it("rejects bytes that are not HDF5", async () => {
    await expect(parseGlm(new Uint8Array([1, 2, 3, 4]), KC)).rejects.toThrow();
  });
});

describe("toFlashes", () => {
  const v = (values: number[], scale = 1, offset = 0, unsigned = false) => ({ values, scale, offset, unsigned });
  const raw = (o: Partial<RawGlm> = {}): RawGlm => ({
    productTime: 0, lat: [39], lon: [-94.5],
    time: v([0]), energy: v([0]), area: v([0]), ...o,
  });

  it("a quiet hemisphere (zero flashes) is an empty list, not a throw", () => {
    expect(toFlashes(raw({ lat: [], lon: [], time: v([]), energy: v([]), area: v([]) }), KC)).toEqual([]);
  });

  it("_Unsigned int16 wraps negatives before scaling", () => {
    const [f] = toFlashes(raw({ area: v([-1], 2, 0, true) }), KC);
    expect(f!.areaKm2).toBeCloseTo((65535 * 2) / 1e6, 9);
  });

  it("box edges are inclusive", () => {
    expect(toFlashes(raw({ lat: [40.79], lon: [-96.5] }), KC)).toHaveLength(1);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run test/lightningGlm.test.ts`
Expected: FAIL. Cannot find module `../src/backend/lightning/glm.js`.

- [ ] **Step 4: Write `types.ts`**

```ts
// GLM lightning shapes (spec 2026-10-13 glass lightning). No imports: the
// frontend type-imports this file, directly and via ScannerEngine's event union.

/** One GLM flash inside the crop box. */
export interface Flash {
  /** Epoch ms of the flash's first optical event. */
  t: number;
  lat: number;
  lon: number;
  /** Total optical energy, femtojoules. */
  energyFj: number;
  /** Footprint, km². */
  areaKm2: number;
}

/** Inclusive lat/lon box (degrees). */
export interface Box { n: number; s: number; e: number; w: number }
```

- [ ] **Step 5: Write `glm.ts`**

```ts
// Reads one GOES-R GLM L2 LCFA file (NetCDF4/HDF5) into flashes. h5wasm, not
// jsfive: jsfive reads the arrays but drops the CF attributes (scale_factor,
// add_offset, _Unsigned) on the scaled int16 variables, and without them time,
// energy and area are garbage (spike 2026-10-13). h5wasm's Node build opens
// real paths, so each file goes through a temp file.
import { writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as h5wasm from "h5wasm/node";
import type { Box, Flash } from "./types.js";

/** GOES-R epoch: product_time is seconds since 2000-01-01 12:00:00 UTC. */
export const J2000_MS = Date.UTC(2000, 0, 1, 12);

export interface ScaledVar { values: ArrayLike<number>; scale: number; offset: number; unsigned: boolean }
export interface RawGlm {
  /** File start, seconds since J2000 noon. */
  productTime: number;
  lat: ArrayLike<number>;
  lon: ArrayLike<number>;
  /** Seconds relative to productTime. */
  time: ScaledVar;
  /** Joules. */
  energy: ScaledVar;
  /** m². */
  area: ScaledVar;
}

function unscale(v: ScaledVar, i: number): number {
  let x = v.values[i] ?? 0;
  if (v.unsigned && x < 0) x += 65_536;   // GLM's scaled vars are int16 flagged _Unsigned
  return x * v.scale + v.offset;
}

/** Pure: raw arrays → in-box flashes, time-ordered. */
export function toFlashes(raw: RawGlm, box: Box): Flash[] {
  const n = Math.min(raw.lat.length, raw.lon.length, raw.time.values.length, raw.energy.values.length, raw.area.values.length);
  const base = J2000_MS + raw.productTime * 1000;
  const out: Flash[] = [];
  for (let i = 0; i < n; i++) {
    const lat = raw.lat[i]!, lon = raw.lon[i]!;
    if (!(lat <= box.n && lat >= box.s && lon >= box.w && lon <= box.e)) continue;
    out.push({
      t: Math.round(base + unscale(raw.time, i) * 1000),
      lat, lon,
      energyFj: unscale(raw.energy, i) * 1e15,
      areaKm2: unscale(raw.area, i) / 1e6,
    });
  }
  return out.sort((a, b) => a.t - b.t);
}

const arr = (v: unknown): ArrayLike<number> =>
  ArrayBuffer.isView(v) ? (v as unknown as ArrayLike<number>) : typeof v === "number" ? [v] : [];
const first = (v: unknown, dflt: number): number => {
  const x = ArrayBuffer.isView(v) ? (v as unknown as ArrayLike<number>)[0] : v;
  return typeof x === "number" ? x : dflt;
};

let ready: Promise<unknown> | null = null;
let seq = 0;

export async function readGlm(bytes: Uint8Array): Promise<RawGlm> {
  ready ??= h5wasm.ready;
  await ready;
  const path = join(tmpdir(), `kerchunk-glm-${process.pid}-${seq++}.nc`);
  await writeFile(path, bytes);
  try {
    const f = new h5wasm.File(path, "r");
    try {
      const ds = (name: string): h5wasm.Dataset => {
        const d = f.get(name);
        if (!(d instanceof h5wasm.Dataset)) throw new Error(`GLM file has no ${name}`);
        return d;
      };
      const scaled = (name: string): ScaledVar => {
        const d = ds(name);
        return {
          values: arr(d.value),
          scale: first(d.attrs["scale_factor"]?.value, 1),
          offset: first(d.attrs["add_offset"]?.value, 0),
          unsigned: d.attrs["_Unsigned"]?.value === "true",
        };
      };
      return {
        productTime: first(ds("product_time").value, NaN),
        lat: arr(ds("flash_lat").value),
        lon: arr(ds("flash_lon").value),
        time: scaled("flash_time_offset_of_first_event"),
        energy: scaled("flash_energy"),
        area: scaled("flash_area"),
      };
    } finally {
      f.close();
    }
  } finally {
    await unlink(path).catch(() => { /* already gone */ });
  }
}

export async function parseGlm(bytes: Uint8Array, box: Box): Promise<Flash[]> {
  const raw = await readGlm(bytes);
  if (!Number.isFinite(raw.productTime)) throw new Error("GLM product_time missing");
  return toFlashes(raw, box);
}
```

If `npm run typecheck` later complains about `h5wasm.Dataset` as a type in the namespace import, use `InstanceType<typeof h5wasm.Dataset>`. If `d.attrs[...]` is typed non-optional, the `?.` is still legal.

- [ ] **Step 6: Run the tests**

Run: `npx vitest run test/lightningGlm.test.ts`
Expected: PASS (7 tests). If the non-HDF5 test fails because h5wasm logs instead of throwing, check `f.get("product_time")` for `null`; the `ds()` guard turns that into a throw.

- [ ] **Step 7: Typecheck and commit**

```bash
npm run typecheck
git add package.json package-lock.json src/backend/lightning/types.ts src/backend/lightning/glm.ts test/lightningGlm.test.ts test/fixtures/glm
git commit -m "feat(lightning): GLM L2 reader via h5wasm with CF scaling

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 2: S3 key helpers (`keys.ts`)

**Files:**
- Create: `kiosk/src/backend/lightning/keys.ts`
- Test: `kiosk/test/lightningKeys.test.ts`

**Interfaces:**
- Produces: `GLM_PRODUCT`, `stamp(ms): string`, `hourPrefix(ms): string`, `hourPrefixes(from, to): string[]`, `keyFloor(ms, sat): string`, `keyTimes(key): { start: number; end: number } | null`, `parseListing(xml): { keys: string[]; next: string | null }`.

- [ ] **Step 1: Write the failing test** (`kiosk/test/lightningKeys.test.ts`)

```ts
import { describe, it, expect } from "vitest";
import { hourPrefix, hourPrefixes, keyFloor, keyTimes, parseListing, stamp } from "../src/backend/lightning/keys.js";

const REAL = "GLM-L2-LCFA/2026/287/02/OR_GLM-L2-LCFA_G19_s20262870229000_e20262870229200_c20262870229219.nc";

describe("GLM S3 keys", () => {
  it("stamp is yyyydddhhmmss + tenths", () => {
    expect(stamp(Date.parse("2026-10-14T02:29:00.000Z"))).toBe("20262870229000");
    expect(stamp(Date.parse("2026-01-01T00:00:00.950Z"))).toBe("20260010000009");
  });

  it("hourPrefix uses day-of-year", () => {
    expect(hourPrefix(Date.parse("2026-10-14T02:29:00Z"))).toBe("GLM-L2-LCFA/2026/287/02/");
  });

  it("keyFloor sorts just before the real key at the same start", () => {
    const floor = keyFloor(Date.parse("2026-10-14T02:29:00Z"), 19);
    expect(REAL.startsWith(floor)).toBe(true);
    expect(REAL > floor).toBe(true);
    expect(keyFloor(Date.parse("2026-10-14T02:29:00.100Z"), 19) > REAL).toBe(true);
  });

  it("keyTimes reads start and end", () => {
    expect(keyTimes(REAL)).toEqual({ start: Date.parse("2026-10-14T02:29:00Z"), end: Date.parse("2026-10-14T02:29:20Z") });
    expect(keyTimes("nonsense")).toBeNull();
  });

  it("hourPrefixes spans a New Year boundary", () => {
    expect(hourPrefixes(Date.parse("2026-12-31T23:58:30Z"), Date.parse("2027-01-01T00:00:30Z")))
      .toEqual(["GLM-L2-LCFA/2026/365/23/", "GLM-L2-LCFA/2027/001/00/"]);
  });

  it("hourPrefixes inside one hour is one prefix", () => {
    expect(hourPrefixes(Date.parse("2026-10-14T02:20:00Z"), Date.parse("2026-10-14T02:29:00Z"))).toEqual(["GLM-L2-LCFA/2026/287/02/"]);
  });

  it("parseListing reads keys and the continuation token only when truncated", () => {
    const xml = `<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>ab+c/d=&amp;</NextContinuationToken>`
      + `<Contents><Key>${REAL}</Key><Size>400000</Size></Contents><Contents><Key>k2</Key></Contents></ListBucketResult>`;
    expect(parseListing(xml)).toEqual({ keys: [REAL, "k2"], next: "ab+c/d=&" });
    expect(parseListing(xml.replace("<IsTruncated>true", "<IsTruncated>false")).next).toBeNull();
    expect(parseListing("<ListBucketResult></ListBucketResult>")).toEqual({ keys: [], next: null });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/lightningKeys.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Write `keys.ts`**

```ts
// GOES-R GLM object keys on NOAA's public S3 buckets:
//   GLM-L2-LCFA/<yyyy>/<ddd>/<hh>/OR_GLM-L2-LCFA_G19_s<yyyydddhhmmsst>_e<…>_c<…>.nc
// Keys sort lexicographically in time order within the product, which is what
// lets the feed list with start-after instead of tracking a seen-set.
export const GLM_PRODUCT = "GLM-L2-LCFA";

const pad = (n: number, w: number): string => String(n).padStart(w, "0");
const DAY_MS = 86_400_000, HOUR_MS = 3_600_000;

function dayOfYear(d: Date): number {
  return Math.floor((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - Date.UTC(d.getUTCFullYear(), 0, 1)) / DAY_MS) + 1;
}

/** yyyydddhhmmss + tenths, the format inside _s/_e/_c. */
export function stamp(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}${pad(dayOfYear(d), 3)}${pad(d.getUTCHours(), 2)}${pad(d.getUTCMinutes(), 2)}`
    + `${pad(d.getUTCSeconds(), 2)}${Math.floor(d.getUTCMilliseconds() / 100)}`;
}

export function hourPrefix(ms: number): string {
  const d = new Date(ms);
  return `${GLM_PRODUCT}/${d.getUTCFullYear()}/${pad(dayOfYear(d), 3)}/${pad(d.getUTCHours(), 2)}/`;
}

/** Hour prefixes covering [from, to], oldest first. */
export function hourPrefixes(from: number, to: number): string[] {
  const out: string[] = [];
  for (let h = Math.floor(from / HOUR_MS) * HOUR_MS; h <= to; h += HOUR_MS) out.push(hourPrefix(h));
  return out;
}

/** A key prefix that sorts just before any file starting at/after `ms`. */
export function keyFloor(ms: number, sat: number): string {
  return `${hourPrefix(ms)}OR_${GLM_PRODUCT}_G${sat}_s${stamp(ms)}`;
}

const STAMPS = /_s(\d{4})(\d{3})(\d{2})(\d{2})(\d{2})(\d)_e(\d{4})(\d{3})(\d{2})(\d{2})(\d{2})(\d)_/;
const toMs = (p: string[]): number =>
  Date.UTC(Number(p[0]), 0, 1) + (Number(p[1]) - 1) * DAY_MS + Number(p[2]) * HOUR_MS
  + Number(p[3]) * 60_000 + Number(p[4]) * 1000 + Number(p[5]) * 100;

export function keyTimes(key: string): { start: number; end: number } | null {
  const m = STAMPS.exec(key);
  if (!m) return null;
  const g = m.slice(1);
  return { start: toMs(g.slice(0, 6)), end: toMs(g.slice(6, 12)) };
}

const unxml = (s: string): string => s.replace(/&quot;/g, "\"").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/** S3 ListObjectsV2 XML → keys + continuation token (null when complete). */
export function parseListing(xml: string): { keys: string[]; next: string | null } {
  const keys = [...xml.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => unxml(m[1]!));
  const tok = /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(xml)?.[1];
  const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
  return { keys, next: truncated && tok ? unxml(tok) : null };
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/lightningKeys.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/backend/lightning/keys.ts test/lightningKeys.test.ts
git commit -m "feat(lightning): GLM S3 key, prefix and listing helpers

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 3: `LightningFeed`

**Files:**
- Create: `kiosk/src/backend/lightning/LightningFeed.ts`
- Test: `kiosk/test/lightningFeed.test.ts`

**Interfaces:**
- Consumes: `parseGlm`, `Box`, `Flash` (Task 1); `hourPrefixes`, `keyFloor`, `keyTimes`, `parseListing` (Task 2).
- Produces:

```ts
export interface LightningSource {
  since(ms: number): Flash[];            // buffered flashes with t > ms
  isStale(now?: number): boolean;
  latestEnd(): number | null;           // scan-end of the newest processed file
  onFlashes(cb: (flashes: Flash[]) => void): void;
  start(): void;
  stop(): void;
}
export class LightningFeed implements LightningSource { /* + pollOnce(), stats() */ }
```

- [ ] **Step 1: Write the failing test** (`kiosk/test/lightningFeed.test.ts`)

```ts
import { describe, it, expect, vi } from "vitest";
import { LightningFeed, type LightningFetchResponse } from "../src/backend/lightning/LightningFeed.js";
import { keyFloor, stamp } from "../src/backend/lightning/keys.js";
import type { Box, Flash } from "../src/backend/lightning/types.js";

const T0 = Date.parse("2026-10-14T02:30:00Z");
const keyAt = (ms: number) => `${keyFloor(ms, 19)}_e${stamp(ms + 20_000)}_c${stamp(ms + 21_000)}.nc`;
const flashAt = (t: number): Flash => ({ t, lat: 39.3, lon: -94.5, energyFj: 50, areaKm2: 200 });

/** A fake S3: prefix + start-after + paging (pageSize keys per page). */
function fakeS3(keys: () => string[], opts: { pageSize?: number; failGet?: Set<string> } = {}) {
  const pageSize = opts.pageSize ?? 1000;
  const fetcher = vi.fn(async (url: string): Promise<LightningFetchResponse> => {
    const u = new URL(url);
    if (u.searchParams.get("list-type") === "2") {
      const prefix = u.searchParams.get("prefix") ?? "";
      const after = u.searchParams.get("start-after") ?? "";
      const token = Number(u.searchParams.get("continuation-token") ?? "0");
      const all = keys().filter((k) => k.startsWith(prefix) && k > after).sort();
      const page = all.slice(token, token + pageSize);
      const more = token + pageSize < all.length;
      const xml = `<ListBucketResult><IsTruncated>${more}</IsTruncated>${more ? `<NextContinuationToken>${token + pageSize}</NextContinuationToken>` : ""}`
        + page.map((k) => `<Contents><Key>${k}</Key></Contents>`).join("") + "</ListBucketResult>";
      return { ok: true, status: 200, text: async () => xml, arrayBuffer: async () => new ArrayBuffer(0) };
    }
    const key = decodeURIComponent(u.pathname.slice(1));
    if (opts.failGet?.has(key)) return { ok: false, status: 503, text: async () => "", arrayBuffer: async () => new ArrayBuffer(0) };
    const bytes = new TextEncoder().encode(key);   // the parse stub reads the key back out
    return { ok: true, status: 200, text: async () => "", arrayBuffer: async () => bytes.buffer as ArrayBuffer };
  });
  return fetcher;
}

function makeFeed(o: {
  keys: () => string[]; now: () => number; pageSize?: number; failGet?: Set<string>;
  parse?: (key: string, box: Box) => Flash[]; windowMs?: number; maxCatchupFiles?: number;
}) {
  const fetcher = fakeS3(o.keys, { pageSize: o.pageSize, failGet: o.failGet });
  const parsed: string[] = [];
  const parse = vi.fn(async (bytes: Uint8Array, box: Box) => {
    const key = new TextDecoder().decode(bytes);
    parsed.push(key);
    return o.parse ? o.parse(key, box) : [];
  });
  const feed = new LightningFeed({
    center: { lat: 39.29, lon: -94.5 }, span: { w: 4, h: 3 }, satellite: "goes19",
    pollMs: 20_000, bufferMs: 300_000, staleMs: 180_000, fetchTimeoutMs: 30_000,
    maxCatchupFiles: o.maxCatchupFiles ?? 6, windowMs: o.windowMs ?? 120_000,
    baseUrl: "https://s3.test", fetcher, parse, now: o.now,
  });
  return { feed, fetcher, parse, parsed };
}

/** Files every 20 s, starting at `from`, ending before `to`. */
const filesBetween = (from: number, to: number) => {
  const out: string[] = [];
  for (let t = from; t < to; t += 20_000) out.push(keyAt(t));
  return out;
};

describe("LightningFeed", () => {
  it("boot: only files inside the window, oldest first", async () => {
    const keys = filesBetween(T0 - 600_000, T0 - 20_000);         // 10 min of files
    const { feed, parsed } = makeFeed({ keys: () => keys, now: () => T0 });
    await feed.pollOnce();
    expect(parsed).toEqual(keys.filter((k) => k >= keyFloor(T0 - 120_000, 19)));
    expect(parsed).toHaveLength(6);
  });

  it("resumes after the last key: a second poll parses only the new file", async () => {
    let now = T0;
    const keys = filesBetween(T0 - 120_000, T0 - 20_000);
    const { feed, parsed } = makeFeed({ keys: () => keys, now: () => now });
    await feed.pollOnce();
    const before = parsed.length;
    keys.push(keyAt(T0));
    now = T0 + 40_000;
    await feed.pollOnce();
    expect(parsed.slice(before)).toEqual([keyAt(T0)]);
  });

  it("lists both hours across the hour boundary", async () => {
    const now = Date.parse("2026-10-14T03:00:30Z");
    const keys = filesBetween(now - 110_000, now - 10_000);         // 02:58:40 … 03:00:20
    const { feed, parsed, fetcher } = makeFeed({ keys: () => keys, now: () => now });
    await feed.pollOnce();
    expect(parsed).toEqual(keys);
    const prefixes = fetcher.mock.calls.map(([u]) => new URL(u).searchParams.get("prefix")).filter(Boolean);
    expect(prefixes).toEqual(["GLM-L2-LCFA/2026/287/02/", "GLM-L2-LCFA/2026/287/03/"]);
  });

  it("follows continuation tokens", async () => {
    const keys = filesBetween(T0 - 120_000, T0 - 20_000);
    const { feed, parsed } = makeFeed({ keys: () => keys, now: () => T0, pageSize: 2 });
    await feed.pollOnce();
    expect(parsed).toEqual(keys);
  });

  it("after an outage it takes only the newest maxCatchupFiles", async () => {
    const keys = filesBetween(T0 - 600_000, T0 - 20_000);
    const { feed, parsed } = makeFeed({ keys: () => keys, now: () => T0, windowMs: 600_000, maxCatchupFiles: 6 });
    await feed.pollOnce();
    expect(parsed).toEqual(keys.slice(-6));
  });

  it("a failed download is retried on the next poll", async () => {
    const keys = filesBetween(T0 - 60_000, T0 - 20_000);   // 2 files
    const failGet = new Set([keys[0]!]);
    const { feed, parsed } = makeFeed({ keys: () => keys, now: () => T0, failGet });
    await feed.pollOnce();
    expect(parsed).toEqual([]);                              // stops at the failure, keeps order
    failGet.clear();
    await feed.pollOnce();
    expect(parsed).toEqual(keys);
  });

  it("a file that fails to parse is skipped for good", async () => {
    const keys = filesBetween(T0 - 60_000, T0 - 20_000);
    const parse = (key: string) => { if (key === keys[0]) throw new Error("not HDF5"); return []; };
    const { feed, parsed } = makeFeed({ keys: () => keys, now: () => T0, parse });
    await feed.pollOnce();
    await feed.pollOnce();
    expect(parsed).toEqual(keys);                            // keys[0] attempted once only
  });

  it("buffers flashes, serves since(), prunes past bufferMs, and announces only fresh ones", async () => {
    let now = T0;
    const keys = [keyAt(T0 - 40_000)];
    const parse = (key: string) => [flashAt(key === keys[0] ? T0 - 39_000 : T0 + 390_000)];
    const { feed } = makeFeed({ keys: () => keys, now: () => now, parse });
    const seen: Flash[][] = [];
    feed.onFlashes((f) => seen.push(f));
    await feed.pollOnce();
    expect(feed.since(0).map((f) => f.t)).toEqual([T0 - 39_000]);
    expect(seen).toHaveLength(1);
    await feed.pollOnce();                                   // nothing new: no announcement
    expect(seen).toHaveLength(1);
    now = T0 + 400_000;                                      // past bufferMs
    keys.push(keyAt(T0 + 380_000));
    await feed.pollOnce();
    expect(feed.since(0).map((f) => f.t)).toEqual([T0 + 390_000]);       // the first flash pruned
    expect(feed.since(T0 + 390_000)).toEqual([]);                         // since() is strictly after
    expect(seen).toHaveLength(2);
  });

  it("is stale until a file lands, then fresh until staleMs past its end", async () => {
    let now = T0;
    const keys = [keyAt(T0 - 40_000)];
    const { feed } = makeFeed({ keys: () => keys, now: () => now });
    expect(feed.isStale()).toBe(true);
    expect(feed.latestEnd()).toBeNull();
    await feed.pollOnce();
    expect(feed.latestEnd()).toBe(T0 - 20_000);
    expect(feed.isStale()).toBe(false);
    now = T0 - 20_000 + 180_001;                             // > staleMs past the file's end
    expect(feed.isStale()).toBe(true);
  });

  it("counts files, bytes and flashes for the hourly log", async () => {
    const keys = filesBetween(T0 - 60_000, T0 - 20_000);
    const { feed } = makeFeed({ keys: () => keys, now: () => T0, parse: () => [flashAt(T0 - 30_000)] });
    await feed.pollOnce();
    const s = feed.stats();
    expect(s.files).toBe(2);
    expect(s.flashes).toBe(2);
    expect(s.bytes).toBe(keys.reduce((n, k) => n + new TextEncoder().encode(k).length, 0));
  });

  it("start() polls and stop() halts", async () => {
    vi.useFakeTimers();
    try {
      const { feed, fetcher } = makeFeed({ keys: () => [], now: () => T0 });
      feed.start();
      await vi.advanceTimersByTimeAsync(0);
      const n = fetcher.mock.calls.length;
      expect(n).toBeGreaterThan(0);
      feed.stop();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(fetcher.mock.calls.length).toBe(n);
    } finally { vi.useRealTimers(); }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/lightningFeed.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Write `LightningFeed.ts`**

```ts
// GOES-19 GLM lightning for the Weather Glass (spec 2026-10-13 glass
// lightning). Lifecycle mirrors RadarFeed: start/stop, injectable fetcher,
// and a poll never throws. Every pollMs it lists NOAA's public S3 bucket for
// files newer than the last processed key, but never older than windowMs (so
// boot and an outage both replay at most the replay window, never a backlog),
// downloads each whole (~400 KB / 20 s; range reads were measured and not
// worth it), keeps the flashes inside the QTH box, and announces the fresh
// ones. Staleness (no new file for staleMs), not an error, is what the
// route reports.
import { parseGlm } from "./glm.js";
import { hourPrefixes, keyFloor, keyTimes, parseListing } from "./keys.js";
import type { Box, Flash } from "./types.js";

export interface LightningSource {
  since(ms: number): Flash[];
  isStale(now?: number): boolean;
  latestEnd(): number | null;
  onFlashes(cb: (flashes: Flash[]) => void): void;
  start(): void;
  stop(): void;
}

export interface LightningFetchResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface LightningFeedOpts {
  center: { lat: number; lon: number };
  span: { w: number; h: number };
  /** "goes19" → bucket noaa-goes19, keys …_G19_… */
  satellite: string;
  pollMs: number;
  bufferMs: number;
  staleMs: number;
  fetchTimeoutMs: number;
  maxCatchupFiles: number;
  /** How far back a poll looks: the wall's replayDelayMs + 45 s. */
  windowMs: number;
  baseUrl?: string;
  fetcher?: (url: string) => Promise<LightningFetchResponse>;
  parse?: (bytes: Uint8Array, box: Box) => Promise<Flash[]>;
  now?: () => number;
}

const HOUR_MS = 3_600_000;

export class LightningFeed implements LightningSource {
  private readonly box: Box;
  private readonly base: string;
  private readonly sat: number;
  private readonly fetcher: (url: string) => Promise<LightningFetchResponse>;
  private readonly parse: (bytes: Uint8Array, box: Box) => Promise<Flash[]>;
  private readonly now: () => number;
  private lastKey: string | null = null;
  private buf: Flash[] = [];
  private end: number | null = null;
  private cb: ((flashes: Flash[]) => void) | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;
  private readonly failing = new Set<string>();
  private readonly totals = { files: 0, bytes: 0, flashes: 0 };
  private hourMark = { at: 0, files: 0, bytes: 0, flashes: 0 };

  constructor(private readonly o: LightningFeedOpts) {
    const { lat, lon } = o.center;
    this.box = { n: lat + o.span.h / 2, s: lat - o.span.h / 2, e: lon + o.span.w / 2, w: lon - o.span.w / 2 };
    this.base = o.baseUrl ?? `https://noaa-${o.satellite}.s3.amazonaws.com`;
    this.sat = Number(/(\d+)$/.exec(o.satellite)?.[1] ?? "19");
    this.fetcher = o.fetcher ?? ((u) => fetch(u, { signal: AbortSignal.timeout(o.fetchTimeoutMs) }));
    this.parse = o.parse ?? parseGlm;
    this.now = o.now ?? Date.now;
  }

  since(ms: number): Flash[] { return this.buf.filter((f) => f.t > ms); }
  latestEnd(): number | null { return this.end; }
  isStale(now = this.now()): boolean { return this.end === null || now - this.end > this.o.staleMs; }
  onFlashes(cb: (flashes: Flash[]) => void): void { this.cb = cb; }
  stats(): { files: number; bytes: number; flashes: number } { return { ...this.totals }; }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.hourMark = { at: this.now(), ...this.totals };
    void this.loop();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  }

  /** One list + download/parse of each new file. Public for tests. */
  async pollOnce(): Promise<void> {
    const now = this.now();
    const fresh: Flash[] = [];
    try {
      const from = now - this.o.windowMs;
      const floor = keyFloor(from, this.sat);
      const after = this.lastKey !== null && this.lastKey > floor ? this.lastKey : floor;
      const keys = (await this.list(from, now, after)).filter((k) => k > after).sort();
      this.ok("list");
      for (const key of keys.slice(-this.o.maxCatchupFiles)) {
        let bytes: Uint8Array;
        try {
          bytes = await this.download(key);
          this.ok("download");
        } catch (err) {
          this.warn("download", err, key);
          break;                       // keep order: retry from here next poll
        }
        this.lastKey = key;
        this.totals.files++;
        this.totals.bytes += bytes.length;
        try {
          const got = await this.parse(bytes, this.box);
          fresh.push(...got);
          this.totals.flashes += got.length;
          const end = keyTimes(key)?.end;
          if (end !== undefined) this.end = Math.max(this.end ?? end, end);
          this.ok("parse");
        } catch (err) {
          this.warn("parse", err, key); // a bad file never heals: lastKey already moved past it
        }
      }
    } catch (err) {
      this.warn("list", err);
    }
    const cut = now - this.o.bufferMs;
    this.buf = [...this.buf, ...fresh].filter((f) => f.t > cut).sort((a, b) => a.t - b.t);
    if (fresh.length > 0) this.cb?.(fresh);
  }

  private async list(from: number, to: number, after: string): Promise<string[]> {
    const keys: string[] = [];
    for (const prefix of hourPrefixes(from, to)) {
      let token: string | null = null;
      do {
        const q = new URLSearchParams({ "list-type": "2", prefix, "start-after": after });
        if (token) q.set("continuation-token", token);
        const res = await this.fetcher(`${this.base}/?${q.toString()}`);
        if (!res.ok) throw new Error(`list HTTP ${res.status}`);
        const page = parseListing(await res.text());
        keys.push(...page.keys);
        token = page.next;
      } while (token);
    }
    return keys;
  }

  private async download(key: string): Promise<Uint8Array> {
    const res = await this.fetcher(`${this.base}/${key}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  /** Log the first failure of each kind; quiet until that kind succeeds again. */
  private warn(kind: string, err: unknown, key?: string): void {
    if (this.failing.has(kind)) return;
    this.failing.add(kind);
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[lightning] ${kind} failed${key ? ` (${key.split("/").pop()})` : ""}: ${msg}`.slice(0, 240));
  }

  private ok(kind: string): void { this.failing.delete(kind); }

  private logHour(): void {
    const now = this.now();
    if (now - this.hourMark.at < HOUR_MS) return;
    const t = this.totals, m = this.hourMark;
    const mb = (t.bytes - m.bytes) / 1e6;
    console.log(`[lightning] last hour: ${t.files - m.files} files, ${mb.toFixed(1)} MB (${(mb * 1e3 / ((now - m.at) / 1000)).toFixed(1)} KB/s), ${t.flashes - m.flashes} flashes in box`);
    this.hourMark = { at: now, ...t };
  }

  private async loop(): Promise<void> {
    if (this.stopped) return;
    await this.pollOnce();
    this.logHour();
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.loop(), this.o.pollMs);
    this.timer.unref?.();
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/lightningFeed.test.ts`
Expected: PASS (11 tests). The `start()` test uses fake timers; if `AbortSignal.timeout` interferes, it doesn't apply, because the test injects `fetcher`.

- [ ] **Step 5: Commit**

```bash
git add src/backend/lightning/LightningFeed.ts test/lightningFeed.test.ts
git commit -m "feat(lightning): LightningFeed polls GOES-19 GLM on S3 into a flash buffer

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 4: Config knobs

**Files:**
- Modify: `kiosk/src/backend/config/schema.ts` (inside `display: z.object({…})`, after `radar: …` at ~line 381; and inside `glass: z.object({…})` after `liveSparkStepMs` at ~line 426)
- Modify: `kiosk/test/schema.test.ts` (glass defaults `toEqual` at ~line 528; new describe)

**Interfaces:**
- Produces: `cfg.display.lightning.{enabled, satellite, pollMs, bufferMs, staleMs, fetchTimeoutMs, maxCatchupFiles, spanDeg:{w,h}}`, `cfg.display.glass.lightning.{enabled, stepMs, replayDelayMs, bloomSteps, bloomIntensity, bloomScale, maxBlooms}`.

- [ ] **Step 1: Write the failing tests** (append to `kiosk/test/schema.test.ts`, and add `lightning` to the existing glass-defaults expectation)

In the existing `"fills the glass defaults"` expectation, after `liveSparkStepMs: 750,` add:

```ts
      lightning: { enabled: true, stepMs: 3000, replayDelayMs: 75_000, bloomSteps: 2, bloomIntensity: 0.75, bloomScale: 1, maxBlooms: 32 },
```

New block:

```ts
describe("display.lightning (spec 2026-10-13 glass lightning)", () => {
  const base = () => ({ ...defaultConfig(), display: { weatherLat: 39.1, weatherLon: -94.58 } });
  it("fills the feed defaults", () => {
    expect(configSchema.parse(base()).display!.lightning).toEqual({
      enabled: true, satellite: "goes19", pollMs: 20_000, bufferMs: 300_000, staleMs: 180_000,
      fetchTimeoutMs: 30_000, maxCatchupFiles: 6, spanDeg: { w: 4, h: 3 },
    });
  });
  it("rejects a poll faster than GLM's 20-s files can justify", () => {
    expect(configSchema.safeParse({ ...base(), display: { ...base().display, lightning: { pollMs: 5_000 } } }).success).toBe(false);
  });
  it("replayDelayMs has a 30 s floor (late flashes drop: below GLM latency nothing would bloom)", () => {
    const ok = (v: number) => configSchema.safeParse({ ...base(), display: { ...base().display, glass: { lightning: { replayDelayMs: v } } } }).success;
    expect([ok(29_999), ok(30_000), ok(300_000), ok(300_001)]).toEqual([false, true, true, false]);
  });
  it("maxBlooms is capped at the shader's 64 slots", () => {
    const ok = (v: number) => configSchema.safeParse({ ...base(), display: { ...base().display, glass: { lightning: { maxBlooms: v } } } }).success;
    expect([ok(64), ok(65)]).toEqual([true, false]);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/schema.test.ts`
Expected: FAIL. `lightning` is undefined, and the glass defaults are missing `lightning`.

- [ ] **Step 3: Add the schema**

After the `radar: z.object({ … }).default({}),` block inside `display`:

```ts
    // GLM lightning feed for the Weather Glass (backend/lightning/, spec
    // 2026-10-13 glass lightning). NOAA GOES-19 on public S3: one ~400 KB
    // file per 20 s, the whole hemisphere every time (~1–2.5 GB/day). Read at
    // boot like radar.*: changing it needs a kerchunk-kiosk restart.
    lightning: z.object({
      enabled: z.boolean().default(true),
      satellite: z.enum(["goes19", "goes18", "goes16"]).default("goes19"),   // bucket noaa-<satellite>
      pollMs: z.number().int().min(10_000).max(120_000).default(20_000),
      bufferMs: z.number().int().min(60_000).max(1_800_000).default(300_000),  // served by /api/lightning
      staleMs: z.number().int().min(60_000).max(3_600_000).default(180_000),
      fetchTimeoutMs: z.number().int().min(5_000).max(120_000).default(30_000),
      maxCatchupFiles: z.number().int().min(1).max(30).default(6),             // never a backlog after an outage
      spanDeg: z.object({
        w: z.number().positive().max(20).default(4),
        h: z.number().positive().max(15).default(3),
      }).default({}),
    }).default({}),
```

Inside `glass: z.object({ … })`, after `liveSparkStepMs`:

```ts
      // Lightning blooms (spec 2026-10-13): each GLM flash blooms on the first
      // stepMs tick at/after its strike time + replayDelayMs, for bloomSteps
      // ticks — redraws/min ≈ 60000 / stepMs while a storm is on screen, 0
      // otherwise. Keep stepMs a divisor of smokeStepMs so ticks coincide.
      // replayDelayMs floor 30 s: GLM files arrive 20–50 s late and a flash
      // more than one tick late is dropped.
      lightning: z.object({
        enabled: z.boolean().default(true),
        stepMs: z.number().int().min(1_000).max(60_000).default(3_000),
        replayDelayMs: z.number().int().min(30_000).max(300_000).default(75_000),
        bloomSteps: z.number().int().min(1).max(6).default(2),
        bloomIntensity: z.number().min(0).max(1.5).default(0.75),
        bloomScale: z.number().min(0.2).max(3).default(1),
        maxBlooms: z.number().int().min(1).max(64).default(32),
      }).default({}),
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/schema.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/backend/config/schema.ts test/schema.test.ts
git commit -m "feat(lightning): display.lightning feed + display.glass.lightning bloom knobs

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 5: Route, WS event, wiring, API docs

**Files:**
- Modify: `kiosk/src/backend/engine/ScannerEngine.ts:157` (event union)
- Modify: `kiosk/src/backend/server.ts` (`ServerDeps` ~line 62, route next to `/api/radar` ~line 1379, broadcast next to radar ~line 1460)
- Modify: `kiosk/src/backend/index.ts` (~line 285 and the `createServer` call ~line 292)
- Modify: `docs/API.md` (routes table ~line 173; WS list ~line 201 and the `radar` paragraph ~line 208)
- Test: `kiosk/test/lightningRoutes.test.ts`

**Interfaces:**
- Consumes: `LightningSource` (Task 3), `Flash` (Task 1), config (Task 4).
- Produces: `GET /api/lightning?since=<ms>` → `{ flashes: Flash[], stale: boolean, latestEnd: number | null }` (404 when disabled); WS `{ type: "lightning"; flashes: Flash[]; clear?: boolean; ts: number }`; `ServerDeps.lightning?: LightningSource`.

- [ ] **Step 1: Write the failing test** (`kiosk/test/lightningRoutes.test.ts`)

```ts
import { describe, it, expect, afterEach } from "vitest";
import request from "supertest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../src/backend/server.js";
import { ConfigStore } from "../src/backend/config/ConfigStore.js";
import { ActivityLog } from "../src/backend/activityLog.js";
import { WsHub } from "../src/backend/ws.js";
import { FakeEngine } from "../src/backend/engine/FakeEngine.js";
import type { EngineEvent } from "../src/backend/engine/ScannerEngine.js";
import type { LightningSource } from "../src/backend/lightning/LightningFeed.js";
import type { Flash } from "../src/backend/lightning/types.js";

const fl = (t: number): Flash => ({ t, lat: 39.3, lon: -94.5, energyFj: 40, areaKm2: 250 });

class FakeLightning implements LightningSource {
  buf: Flash[] = [];
  stale = false;
  end: number | null = null;
  started = false;
  stopped = false;
  private cb: ((f: Flash[]) => void) | null = null;
  since(ms: number) { return this.buf.filter((f) => f.t > ms); }
  isStale() { return this.stale; }
  latestEnd() { return this.end; }
  onFlashes(cb: (f: Flash[]) => void) { this.cb = cb; }
  start() { this.started = true; }
  stop() { this.stopped = true; }
  fire(f: Flash[]) { this.buf.push(...f); this.cb?.(f); }
}

let dir: string;
function makeApp(lightning?: LightningSource) {
  dir = mkdtempSync(join(tmpdir(), "klightning-"));
  const wsHub = new WsHub();
  const sent: EngineEvent[] = [];
  const real = wsHub.broadcast.bind(wsHub);
  wsHub.broadcast = (e: EngineEvent) => { sent.push(e); real(e); };
  const { server } = createServer({
    configStore: new ConfigStore(join(dir, "config.json")), engine: new FakeEngine(),
    activityLog: new ActivityLog(100), wsHub, staticDir: dir, ...(lightning ? { lightning } : {}),
  });
  return { server, sent };
}
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("lightning route + WS", () => {
  it("404 when the feed is disabled", async () => {
    const { server } = makeApp();
    expect((await request(server).get("/api/lightning")).status).toBe(404);
  });

  it("returns buffered flashes after `since`, the stale flag and latestEnd", async () => {
    const lt = new FakeLightning();
    lt.buf = [fl(1000), fl(2000), fl(3000)];
    lt.end = 3500; lt.stale = true;
    const { server } = makeApp(lt);
    const res = await request(server).get("/api/lightning?since=1500");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ flashes: [fl(2000), fl(3000)], stale: true, latestEnd: 3500 });
  });

  it("a missing or junk `since` returns the whole buffer", async () => {
    const lt = new FakeLightning();
    lt.buf = [fl(1000)];
    const { server } = makeApp(lt);
    expect((await request(server).get("/api/lightning")).body.flashes).toHaveLength(1);
    expect((await request(server).get("/api/lightning?since=abc")).body.flashes).toHaveLength(1);
  });

  it("starts the feed and broadcasts fresh flashes", async () => {
    const lt = new FakeLightning();
    const { sent } = makeApp(lt);
    expect(lt.started).toBe(true);
    lt.fire([fl(5000)]);
    const ev = sent.find((e) => e.type === "lightning");
    expect(ev).toMatchObject({ type: "lightning", flashes: [fl(5000)] });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/lightningRoutes.test.ts`
Expected: FAIL. TS error on the `lightning` dep, or a 404 on every request.

- [ ] **Step 3: Implement**

`ScannerEngine.ts`: add `import type { Flash } from "../lightning/types.js";` at the top, and after the `radar` member of the union:

```ts
  // New GLM flashes landed in LightningFeed (Weather Glass blooms). clear:true
  // (test route only) drops the wall's pending flashes. Synthesized by the server.
  | { type: "lightning"; flashes: Flash[]; clear?: boolean; ts: number }
```

`server.ts`: import `import type { LightningSource } from "./lightning/LightningFeed.js";` and add to `ServerDeps` after `radar?`:

```ts
  /** GOES GLM lightning for the Weather Glass blooms (off when display.lightning.enabled is false). */
  lightning?: LightningSource;
```

Route, right after the `/api/radar` block:

```ts
    if (method === "GET" && path === "/api/lightning") {
      if (!deps.lightning) return json(res, 404, { error: "lightning disabled" });
      const since = Number(sp.get("since"));
      return json(res, 200, {
        flashes: deps.lightning.since(Number.isFinite(since) ? since : -Infinity),
        stale: deps.lightning.isStale(),
        latestEnd: deps.lightning.latestEnd(),
      });
    }
```

(`sp` is the URLSearchParams already in scope where `/api/stats` reads `since`. If it isn't in scope at that point, use `new URL(req.url ?? "", "http://x").searchParams`.)

Broadcast, after the radar block near the end of `createServer`:

```ts
  // Lightning: push each batch of fresh flashes; pages schedule them locally.
  if (deps.lightning) {
    deps.lightning.onFlashes((flashes) => {
      deps.wsHub.broadcast({ type: "lightning", flashes, ts: Date.now() });
    });
    deps.lightning.start();
    server.on("close", () => deps.lightning?.stop());
  }
```

`index.ts`: import `import { LightningFeed } from "./lightning/LightningFeed.js";` and after the radar construction:

```ts
// GOES-19 GLM lightning for the Weather Glass blooms (spec 2026-10-13). On by
// default with a QTH; display.lightning.enabled=false opts out. The poll
// window follows the wall's replay delay so boot fills it and nothing older.
const lightningCfg = config.display?.lightning;
const lightning = config.display && lightningCfg?.enabled
  ? new LightningFeed({
      center: { lat: config.display.weatherLat, lon: config.display.weatherLon },
      span: lightningCfg.spanDeg,
      satellite: lightningCfg.satellite,
      pollMs: lightningCfg.pollMs,
      bufferMs: lightningCfg.bufferMs,
      staleMs: lightningCfg.staleMs,
      fetchTimeoutMs: lightningCfg.fetchTimeoutMs,
      maxCatchupFiles: lightningCfg.maxCatchupFiles,
      windowMs: config.display.glass.lightning.replayDelayMs + 45_000,
    })
  : undefined;
```

and add `lightning` to the `createServer({ … lookup, weather, history, aircraftFeed, radar, lightning, … })` call.

`docs/API.md`: after the `/api/radar/frame` row add:

```markdown
| GET | `/api/lightning?since=<epoch ms>` | GOES-19 GLM flashes inside `display.lightning.spanDeg` around the QTH, buffered for `display.lightning.bufferMs` (5 min): `{ flashes: [{ t, lat, lon, energyFj, areaKm2 }], stale, latestEnd }`. `t` = epoch ms of the flash's first event; `latestEnd` = scan end of the newest processed 20-s file (null before the first); `stale` = no file for `display.lightning.staleMs`. `since` omitted or invalid → the whole buffer. `404` when `display.lightning.enabled` is false. Source: NOAA `noaa-goes19` S3, `GLM-L2-LCFA`. |
```

Add `lightning` to the WS event list, and after the `radar` paragraph:

```markdown
`lightning` (`{ flashes, clear? }`) carries each batch of fresh GLM flashes
(one per 20-s file with any in-box flash). Pages schedule them locally
(`display.glass.lightning`); `clear: true` comes only from
`POST /api/test/lightning`.
```

- [ ] **Step 4: Run the tests and typecheck**

Run: `npx vitest run test/lightningRoutes.test.ts && npm run typecheck`
Expected: PASS, clean. If `admin/live.ts` `reduceEvent` has an exhaustive `switch` that now errors, add `case "lightning":` falling through to its `default:` no-op.

- [ ] **Step 5: Commit**

```bash
git add src/backend/engine/ScannerEngine.ts src/backend/server.ts src/backend/index.ts test/lightningRoutes.test.ts ../docs/API.md
git commit -m "feat(lightning): /api/lightning route, WS lightning event, boot wiring

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 6: PR 1: verify, prove, ship

- [ ] **Step 1: Full checks**

```bash
cd /home/kiosk/kerchunk-kiosk/kiosk
npm test && npm run test:native && npm run typecheck && npm run build
```

Expected: all pass. Report any failure verbatim. Don't claim done.

- [ ] **Step 2: CPU baseline before the deploy**

```bash
PID=$(systemctl show -p MainPID --value kerchunk-kiosk); for i in 1 2 3 4 5; do ps -o %cpu= -p $PID; sleep 60; done
```

Use `Monitor` with an until-loop rather than a foreground `sleep` (the harness blocks foreground sleep); record the five values.

- [ ] **Step 3: Deploy (backend change → restart)**

```bash
sudo systemctl restart kerchunk-kiosk && sleep 15 && journalctl -u kerchunk-kiosk --since "-1 min" | grep -i lightning
curl -s localhost:8080/api/lightning | jq '{n: (.flashes|length), stale, latestEnd}'
```

Expected: no `[lightning] … failed` lines. After ≤ 40 s `stale` is false and `latestEnd` is within ~60 s of now. `n` ≥ 0 (0 on a quiet sky is correct).

- [ ] **Step 4: One hour live.** After ≥ 60 min:

```bash
journalctl -u kerchunk-kiosk --since "-70 min" | grep "\[lightning\]"
PID=$(systemctl show -p MainPID --value kerchunk-kiosk); ps -o %cpu= -p $PID
```

Pass: a `last hour:` line showing ~180 files and 11–30 KB/s; node CPU within noise of the baseline. Report the numbers.

- [ ] **Step 5: PR**

```bash
git push -u origin feat/lightning-feed
gh pr create --title "feat(lightning): GOES-19 GLM feed + /api/lightning (glass lightning PR 1)" --body "$(cat <<'EOF'
Backend half of docs/superpowers/specs/2026-10-13-glass-lightning-design.md. Nothing visible on the wall yet.

- `LightningFeed` polls `noaa-goes19` S3 every 20 s, reads each GLM file with h5wasm (jsfive drops the CF attrs), and keeps in-box flashes for 5 min
- `GET /api/lightning?since=` + WS `lightning` event; status/logs/weather untouched
- Knobs: `display.lightning.*` (boot-time) and `display.glass.lightning.*` (used by PR 2)

Proof on hardware: <paste the hourly log line + CPU before/after>

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

After CI is green and the operator merges (or says to): `gh pr merge <n> --merge --delete-branch && git checkout main && git pull --ff-only && git fetch --prune && git branch -d feat/lightning-feed`.

---

## PR 2: wall blooms (`feat/glass-lightning`)

- [ ] **Step 0:** `git checkout main && git pull --ff-only && git checkout -b feat/glass-lightning`

### Task 7: `LightningState` scheduler

**Files:**
- Modify: `kiosk/src/frontend/map/glassState.ts:62` (`function nextTick` → `export function nextTick`)
- Create: `kiosk/src/frontend/map/lightningState.ts`
- Test: `kiosk/test/lightningState.test.ts`

**Interfaces:**
- Consumes: `Flash` from `../../backend/lightning/types.js`; `gridTick`, `nextTick` from `./glassState.js`.
- Produces:

```ts
export interface LightningTimings { stepMs: number; replayDelayMs: number; bloomSteps: number; bloomIntensity: number; bloomScale: number; maxBlooms: number }
export interface Strike { lat: number; lng: number; radiusM: number; intensity: number }
export interface StrikeFrame { strikes: Strike[]; nextChangeAt: number | null }
export const MAX_STRIKES = 64;
export const MAX_STRIKE_RADIUS_KM = 30;
export function strikeEnergy(energyFj: number): number;
export function strikeRadiusM(areaKm2: number, scale: number): number;
export function minAt(a: number | null, b: number | null): number | null;
export class LightningState { add(flashes: readonly Flash[], now: number): number | null; clear(): void; frame(now: number): StrikeFrame }
```

- [ ] **Step 1: Write the failing test** (`kiosk/test/lightningState.test.ts`)

```ts
import { describe, it, expect } from "vitest";
import {
  LightningState, MAX_STRIKE_RADIUS_KM, minAt, strikeEnergy, strikeRadiusM, type LightningTimings,
} from "../src/frontend/map/lightningState.js";
import type { Flash } from "../src/backend/lightning/types.js";

const K: LightningTimings = { stepMs: 3000, replayDelayMs: 75_000, bloomSteps: 2, bloomIntensity: 0.75, bloomScale: 1, maxBlooms: 32 };
const BASE = 1_800_000_000_000;                     // a multiple of 6000: smoke and lightning grids coincide
const fl = (t: number, o: Partial<Flash> = {}): Flash => ({ t, lat: 39.3, lon: -94.5, energyFj: 100, areaKm2: 200, ...o });

describe("bloom maths", () => {
  it("energy curve: 0.35 floor, log rise, capped at 1", () => {
    expect(strikeEnergy(0)).toBeCloseTo(0.35);
    expect(strikeEnergy(99)).toBeCloseTo(0.35 + 2 / 3);
    expect(strikeEnergy(1e6)).toBe(1);
  });
  it("radius = √(area/π) km × scale, capped so a giant flash can't wash the stage", () => {
    expect(strikeRadiusM(Math.PI * 100, 1)).toBeCloseTo(10_000);
    expect(strikeRadiusM(Math.PI * 100, 0.5)).toBeCloseTo(5_000);
    expect(strikeRadiusM(50_000, 1)).toBeCloseTo(MAX_STRIKE_RADIUS_KM * 1000);
  });
  it("minAt treats null as never", () => {
    expect([minAt(null, null), minAt(5, null), minAt(null, 7), minAt(5, 7)]).toEqual([null, 5, 7, 5]);
  });
});

describe("LightningState", () => {
  it("fires on the first tick at/after t + delay, then 2 steps (1, 0.5), then gone", () => {
    const s = new LightningState(K);
    const t = BASE + 1_000;                                     // fire = ceil((t+75000)/3000)*3000 = BASE+78000
    expect(s.add([fl(t)], BASE)).toBe(BASE + 78_000);           // waiting: next change = its fire tick
    expect(s.frame(BASE + 77_999).strikes).toHaveLength(0);
    const a = s.frame(BASE + 78_000);
    expect(a.strikes).toHaveLength(1);
    expect(a.strikes[0]!.intensity).toBeCloseTo(0.75 * 1 * strikeEnergy(100));
    expect(a.nextChangeAt).toBe(BASE + 81_000);
    expect(s.frame(BASE + 81_500).strikes[0]!.intensity).toBeCloseTo(0.75 * 0.5 * strikeEnergy(100));
    const gone = s.frame(BASE + 84_000);
    expect(gone.strikes).toHaveLength(0);
    expect(gone.nextChangeAt).toBeNull();                        // idle: zero redraws
  });

  it("ticks land on the smoke grid (stepMs 3000 divides smokeStepMs 6000)", () => {
    const s = new LightningState(K);
    s.add([fl(BASE + 2_345)], BASE);
    const at = s.frame(BASE).nextChangeAt!;
    expect(at % 3000).toBe(0);
  });

  it("the same flash via WS and backfill blooms once", () => {
    const s = new LightningState(K);
    s.add([fl(BASE)], BASE);
    s.add([fl(BASE), { ...fl(BASE) }], BASE);
    expect(s.frame(BASE + 75_000).strikes).toHaveLength(1);
  });

  it("a flash one tick late fires on the next tick; two ticks late is dropped", () => {
    const s = new LightningState(K);
    const now = BASE + 90_000;
    s.add([fl(now - 75_000 - 3_000)], now);                    // fire tick = now − 3000: one tick late
    s.add([fl(now - 75_000 - 6_000, { lat: 1 })], now);        // two ticks late
    expect(s.frame(now).strikes).toHaveLength(0);
    const f = s.frame(now + 3_000);
    expect(f.strikes).toHaveLength(1);
    expect(f.strikes[0]!.lat).toBe(39.3);
  });

  it("a flash due on the current tick shows immediately", () => {
    const s = new LightningState(K);
    const now = BASE + 90_000;
    s.add([fl(now - 75_000)], now + 1_000);
    expect(s.frame(now + 1_000).strikes).toHaveLength(1);
  });

  it("caps blooms at maxBlooms, strongest first", () => {
    const s = new LightningState({ ...K, maxBlooms: 2 });
    s.add([fl(BASE, { energyFj: 1, lat: 1 }), fl(BASE, { energyFj: 1000, lat: 2 }), fl(BASE, { energyFj: 10, lat: 3 })], BASE);
    expect(s.frame(BASE + 75_000).strikes.map((x) => x.lat)).toEqual([2, 3]);
  });

  it("clear() drops everything pending", () => {
    const s = new LightningState(K);
    s.add([fl(BASE)], BASE);
    s.clear();
    expect(s.frame(BASE + 75_000)).toEqual({ strikes: [], nextChangeAt: null });
  });

  it("prunes expired flashes (a page open for days doesn't grow)", () => {
    const s = new LightningState(K);
    for (let i = 0; i < 500; i++) s.add([fl(BASE + i * 1000, { lat: i })], BASE + i * 1000);
    s.frame(BASE + 2_000_000);
    expect((s as unknown as { byKey: Map<string, unknown> }).byKey.size).toBe(0);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/lightningState.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Export `nextTick`** in `glassState.ts` (change `function nextTick(` to `export function nextTick(`). Its doc comment stays.

- [ ] **Step 4: Write `lightningState.ts`**

```ts
// Pure lightning scheduler for Weather Glass (spec 2026-10-13 glass
// lightning). Each GLM flash blooms on the first stepMs grid tick at/after
// its strike time + replayDelayMs (delayed replay: blooms keep the storm's
// rhythm, not GLM's 20-s file clumps), bright then dimmer for bloomSteps
// ticks, then gone. The grid is the same epoch grid smoke uses, so with
// stepMs dividing smokeStepMs the redraws coincide. frame() says when the
// scene next changes: waiting flashes cost no redraws.
import { gridTick, nextTick } from "./glassState.js";
import type { Flash } from "../../backend/lightning/types.js";

export interface LightningTimings {
  stepMs: number; replayDelayMs: number; bloomSteps: number;
  bloomIntensity: number; bloomScale: number; maxBlooms: number;
}
export interface Strike { lat: number; lng: number; radiusM: number; intensity: number }
export interface StrikeFrame { strikes: Strike[]; nextChangeAt: number | null }

/** Uniform-array size compiled into STRIKE_FS (glassShaders.ts) — keep in sync. */
export const MAX_STRIKES = 64;
/** GLM flashes can span thousands of km²; past this a bloom would wash the stage. */
export const MAX_STRIKE_RADIUS_KM = 30;
/** Memory guard for a pathological burst; a real storm holds ~30 pending. */
const MAX_PENDING = 2000;

/** Mockup curve (bloom-tick.html): weak flashes stay faint, strong ones saturate. */
export function strikeEnergy(energyFj: number): number {
  return Math.min(1, 0.35 + Math.log10(1 + Math.max(0, energyFj)) / 3);
}

export function strikeRadiusM(areaKm2: number, scale: number): number {
  return Math.min(MAX_STRIKE_RADIUS_KM, Math.sqrt(Math.max(0, areaKm2) / Math.PI)) * 1000 * scale;
}

/** Earliest of two optional change times (null = never). */
export function minAt(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.min(a, b);
}

interface Sched { f: Flash; fireAt: number }

export class LightningState {
  private readonly byKey = new Map<string, Sched>();

  constructor(private readonly t: LightningTimings) {}

  /** Schedule flashes (deduped); returns when the scene next changes. */
  add(flashes: readonly Flash[], now: number): number | null {
    const step = this.t.stepMs, cur = gridTick(now, step);
    for (const f of flashes) {
      const key = `${f.t}|${f.lat}|${f.lon}`;
      if (this.byKey.has(key)) continue;
      let fireAt = Math.ceil((f.t + this.t.replayDelayMs) / step) * step;
      const late = Math.round((cur - fireAt) / step);
      if (late >= 2) continue;                  // stale: a reconnect must not dump blooms
      if (late === 1) fireAt = nextTick(now, step);
      this.byKey.set(key, { f, fireAt });
    }
    if (this.byKey.size > MAX_PENDING) {
      const oldest = [...this.byKey].sort((a, b) => a[1].fireAt - b[1].fireAt);
      for (const [k] of oldest.slice(0, this.byKey.size - MAX_PENDING)) this.byKey.delete(k);
    }
    return this.frame(now).nextChangeAt;
  }

  clear(): void { this.byKey.clear(); }

  frame(now: number): StrikeFrame {
    const step = this.t.stepMs, cur = gridTick(now, step), steps = Math.max(1, this.t.bloomSteps);
    const strikes: Strike[] = [];
    let pending = Infinity;
    for (const [k, s] of this.byKey) {
      const i = Math.round((cur - s.fireAt) / step);
      if (i >= steps) { this.byKey.delete(k); continue; }
      if (i < 0) { pending = Math.min(pending, s.fireAt); continue; }
      strikes.push({
        lat: s.f.lat, lng: s.f.lon,
        radiusM: strikeRadiusM(s.f.areaKm2, this.t.bloomScale),
        intensity: this.t.bloomIntensity * (1 - i / steps) * strikeEnergy(s.f.energyFj),
      });
    }
    strikes.sort((a, b) => b.intensity - a.intensity);
    const cap = Math.min(MAX_STRIKES, Math.max(1, this.t.maxBlooms));
    const nextChangeAt = strikes.length > 0 ? nextTick(now, step) : Number.isFinite(pending) ? pending : null;
    return { strikes: strikes.slice(0, cap), nextChangeAt };
  }
}
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run test/lightningState.test.ts test/glassState.test.ts`
Expected: PASS (glassState unchanged apart from the export).

- [ ] **Step 6: Commit**

```bash
git add src/frontend/map/glassState.ts src/frontend/map/lightningState.ts test/lightningState.test.ts
git commit -m "feat(glass): LightningState — delayed-replay bloom scheduler on the shared grid

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 8: `LightningSync`

**Files:**
- Create: `kiosk/src/frontend/map/lightningSync.ts`
- Test: `kiosk/test/lightningSync.test.ts`

**Interfaces:**
- Consumes: `Flash`.
- Produces: `class LightningSync { constructor(d: LightningSyncDeps); poll(): Promise<void>; ingest(flashes: Flash[]): void }`, `httpFetchSince(since: number): Promise<Flash[] | null>`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from "vitest";
import { LightningSync } from "../src/frontend/map/lightningSync.js";
import type { Flash } from "../src/backend/lightning/types.js";

const fl = (t: number): Flash => ({ t, lat: 39.3, lon: -94.5, energyFj: 40, areaKm2: 250 });

describe("LightningSync", () => {
  it("poll asks for the last lookbackMs and hands flashes on", async () => {
    const fetchSince = vi.fn(async () => [fl(1)]);
    const onFlashes = vi.fn();
    await new LightningSync({ fetchSince, onFlashes, lookbackMs: 105_000, now: () => 1_000_000 }).poll();
    expect(fetchSince).toHaveBeenCalledWith(895_000);
    expect(onFlashes).toHaveBeenCalledWith([fl(1)]);
  });

  it("a 404 (feed off), an empty list, or a throw hands nothing on", async () => {
    const onFlashes = vi.fn();
    for (const fetchSince of [async () => null, async () => [], async () => { throw new Error("net"); }]) {
      await new LightningSync({ fetchSince, onFlashes, lookbackMs: 1, now: () => 0 }).poll();
    }
    expect(onFlashes).not.toHaveBeenCalled();
  });

  it("concurrent polls share one request", async () => {
    let resolve!: (f: Flash[]) => void;
    const fetchSince = vi.fn(() => new Promise<Flash[]>((r) => { resolve = r; }));
    const s = new LightningSync({ fetchSince, onFlashes: () => {}, lookbackMs: 1, now: () => 0 });
    const a = s.poll(), b = s.poll();
    resolve([]);
    await Promise.all([a, b]);
    expect(fetchSince).toHaveBeenCalledTimes(1);
  });

  it("ingest passes WS flashes straight on, ignoring empty batches", () => {
    const onFlashes = vi.fn();
    const s = new LightningSync({ fetchSince: async () => null, onFlashes, lookbackMs: 1 });
    s.ingest([]);
    s.ingest([fl(2)]);
    expect(onFlashes).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/lightningSync.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Write `lightningSync.ts`**

```ts
// Keeps the wall's LightningState fed (spec 2026-10-13 glass lightning). WS
// "lightning" events carry fresh flashes; poll() fills in from
// /api/lightning on page load and as a 60-s backstop for events missed across
// a backend restart. Dedupe lives in LightningState, so overlap is harmless.
import type { Flash } from "../../backend/lightning/types.js";

export interface LightningSyncDeps {
  fetchSince: (since: number) => Promise<Flash[] | null>;
  onFlashes: (flashes: Flash[]) => void;
  /** replayDelayMs + 30 s: everything that could still bloom. */
  lookbackMs: number;
  now?: () => number;
}

export class LightningSync {
  private inFlight: Promise<void> | null = null;
  private readonly now: () => number;

  constructor(private readonly d: LightningSyncDeps) {
    this.now = d.now ?? Date.now;
  }

  poll(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = (async () => {
      try {
        const f = await this.d.fetchSince(this.now() - this.d.lookbackMs);
        if (f && f.length > 0) this.d.onFlashes(f);
      } catch { /* the next poll or WS event recovers */ } finally {
        this.inFlight = null;
      }
    })();
    return this.inFlight;
  }

  ingest(flashes: Flash[]): void {
    if (flashes.length > 0) this.d.onFlashes(flashes);
  }
}

export async function httpFetchSince(since: number): Promise<Flash[] | null> {
  const r = await fetch(`/api/lightning?since=${Math.floor(since)}`);
  if (!r.ok) return null;
  const j = await r.json() as { flashes?: unknown };
  return Array.isArray(j.flashes) ? j.flashes as Flash[] : null;
}
```

- [ ] **Step 4: Run the tests** (`npx vitest run test/lightningSync.test.ts`, expect PASS), then commit:

```bash
git add src/frontend/map/lightningSync.ts test/lightningSync.test.ts
git commit -m "feat(glass): LightningSync — page-load fill + WS ingest for lightning

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 9: Test storm + `POST /api/test/lightning`

**Files:**
- Create: `kiosk/src/backend/lightning/testStorm.ts` (generated)
- Modify: `kiosk/src/backend/server.ts` (next to `/api/test/alert`, ~line 1019), `docs/API.md`
- Test: `kiosk/test/lightningTestRoute.test.ts`

**Interfaces:**
- Produces: `TEST_STORM_CENTER: { lat: number; lon: number }`, `TEST_STORM: ReadonlyArray<readonly [offsetS: number, lat: number, lon: number, energyFj: number, areaKm2: number]>`; route `POST /api/test/lightning` `{clear?: true}` → `{ ok: true, flashes: number }`.

- [ ] **Step 1: Generate `testStorm.ts`** from the brainstorm replay data (the 229 real flashes, 2026-10-14 02:20–02:30 UTC):

```bash
cd /home/kiosk/kerchunk-kiosk/kiosk
python3 -I - <<'EOF'
import json
rows = json.load(open("../.superpowers/lightning-data/flashes.json"))
lines = ",\n".join(f"  [{r[0]}, {r[1]}, {r[2]}, {r[3]}, {r[4]}]" for r in rows)
open("src/backend/lightning/testStorm.ts", "w").write(f"""// A real storm for previews and the thermal A/B (spec 2026-10-13): the {len(rows)}
// GOES-19 GLM flashes that hit the wall's frame over KC, 2026-10-14
// 02:20-02:30 UTC. [offset s from the first flash, lat, lon, energy fJ, area km²].
// POST /api/test/lightning shifts it onto the configured QTH.
export const TEST_STORM_CENTER = {{ lat: 39.29, lon: -94.5 }};

export const TEST_STORM: ReadonlyArray<readonly [number, number, number, number, number]> = [
{lines},
];
""")
print(len(rows))
EOF
```

Expected output: `229`.

- [ ] **Step 2: Write the failing test** (`kiosk/test/lightningTestRoute.test.ts`)

```ts
import { describe, it, expect, afterEach, vi } from "vitest";
import request from "supertest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../src/backend/server.js";
import { ConfigStore } from "../src/backend/config/ConfigStore.js";
import { ActivityLog } from "../src/backend/activityLog.js";
import { WsHub } from "../src/backend/ws.js";
import { FakeEngine } from "../src/backend/engine/FakeEngine.js";
import type { EngineEvent } from "../src/backend/engine/ScannerEngine.js";
import { TEST_STORM, TEST_STORM_CENTER } from "../src/backend/lightning/testStorm.js";

let dir: string;
function makeApp(display?: Record<string, unknown>) {
  dir = mkdtempSync(join(tmpdir(), "kltest-"));
  if (display) writeFileSync(join(dir, "config.json"), JSON.stringify({ display }));
  const wsHub = new WsHub();
  const sent: EngineEvent[] = [];
  wsHub.broadcast = (e: EngineEvent) => { sent.push(e); };
  const { server } = createServer({
    configStore: new ConfigStore(join(dir, "config.json")), engine: new FakeEngine(),
    activityLog: new ActivityLog(100), wsHub, staticDir: dir,
  });
  return { server, sent };
}
afterEach(() => { rmSync(dir, { recursive: true, force: true }); vi.useRealTimers(); });

describe("POST /api/test/lightning", () => {
  it("broadcasts the canned storm, re-based so the first flash blooms within a tick", async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000, toFake: ["Date"] });
    const { server, sent } = makeApp({ weatherLat: TEST_STORM_CENTER.lat + 1, weatherLon: TEST_STORM_CENTER.lon });
    const res = await request(server).post("/api/test/lightning").send({});
    expect(res.body).toEqual({ ok: true, flashes: TEST_STORM.length });
    const ev = sent.find((e) => e.type === "lightning");
    if (ev?.type !== "lightning") throw new Error("no lightning event");
    expect(ev.flashes).toHaveLength(TEST_STORM.length);
    const first = ev.flashes[0]!;
    expect(first.t).toBe(1_800_000_000_000 - 75_000 + 2_000);   // default replayDelayMs
    expect(first.lat).toBeCloseTo(TEST_STORM[0]![1] + 1, 6);     // shifted onto the QTH
  });

  it("clear sends an empty clear batch", async () => {
    const { server, sent } = makeApp();
    await request(server).post("/api/test/lightning").send({ clear: true });
    expect(sent.find((e) => e.type === "lightning")).toMatchObject({ type: "lightning", flashes: [], clear: true });
  });
});
```

If `ConfigStore` rejects a partial `{ display }` file, use the same config-seeding approach `test/api.test.ts` uses for `/api/test/alert` (grep it), or drop the QTH-shift assertion to `toBeCloseTo(TEST_STORM[0]![1] + (cfgLat − 39.29))` using whatever default config the store produces.

- [ ] **Step 3: Run it to verify it fails** (`npx vitest run test/lightningTestRoute.test.ts`). Expected: FAIL, 404.

- [ ] **Step 4: Implement the route** in `server.ts` right after the `/api/test/alert` block, with `import { TEST_STORM, TEST_STORM_CENTER } from "./lightning/testStorm.js";` at the top:

```ts
    // Wall preview / thermal A/B driver: replay a real 10-minute storm through
    // the WS only (not the feed's buffer, so a page reload drops it). Re-based
    // so the first flash blooms on the wall's next tick and shifted onto the QTH.
    if (method === "POST" && path === "/api/test/lightning") {
      const body = await readBody(req).catch(() => undefined);
      if (body?.clear === true) {
        deps.wsHub.broadcast({ type: "lightning", flashes: [], clear: true, ts: Date.now() });
        return json(res, 200, { ok: true, flashes: 0 });
      }
      const delay = config.display?.glass?.lightning?.replayDelayMs ?? 75_000;
      const start = Date.now() - delay + 2_000;
      const dLat = (config.display?.weatherLat ?? TEST_STORM_CENTER.lat) - TEST_STORM_CENTER.lat;
      const dLon = (config.display?.weatherLon ?? TEST_STORM_CENTER.lon) - TEST_STORM_CENTER.lon;
      const flashes = TEST_STORM.map(([s, lat, lon, energyFj, areaKm2]) => ({
        t: start + Math.round(s * 1000), lat: lat + dLat, lon: lon + dLon, energyFj, areaKm2,
      }));
      deps.wsHub.broadcast({ type: "lightning", flashes, ts: Date.now() });
      return json(res, 200, { ok: true, flashes: flashes.length });
    }
```

Add to `docs/API.md` next to `/api/test/alert`:

```markdown
| POST | `/api/test/lightning` | Wall preview / thermal A/B: broadcasts a real 229-flash, 10-minute storm (KC, 2026-10-14) as one WS `lightning` event, re-based so it starts on the wall's next tick and shifted onto the QTH. `{ clear: true }` drops pending flashes on the wall. Not stored in the feed buffer. → `{ ok, flashes }`. |
```

- [ ] **Step 5: Run the tests and typecheck** (`npx vitest run test/lightningTestRoute.test.ts && npm run typecheck`), then commit:

```bash
git add src/backend/lightning/testStorm.ts src/backend/server.ts test/lightningTestRoute.test.ts ../docs/API.md
git commit -m "feat(lightning): POST /api/test/lightning replays a real storm on the wall

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 10: Strike pass in the glass + map wiring

**Files:**
- Modify: `kiosk/src/frontend/map/glassShaders.ts` (append `STRIKE_FS`; update the header comment's program list)
- Modify: `kiosk/src/frontend/map/glassLayer.ts` (options, init, context loss, draw, reschedule)
- Modify: `kiosk/src/frontend/map/map.ts` (~lines 242–291 and the WS handler ~line 644)
- Test: `kiosk/test/strikeShader.test.ts`

**Interfaces:**
- Consumes: `LightningState`, `StrikeFrame`, `MAX_STRIKES`, `minAt` (Task 7); `LightningSync`, `httpFetchSince` (Task 8); `cfg.display.glass.lightning` (Task 4); WS `lightning` (Task 5).
- Produces: `GlassLayerOptions.getStrikes?: (now: number) => StrikeFrame`.

- [ ] **Step 1: Write the failing test** (`kiosk/test/strikeShader.test.ts`)

```ts
import { describe, it, expect } from "vitest";
import { STRIKE_FS } from "../src/frontend/map/glassShaders.js";
import { MAX_STRIKES } from "../src/frontend/map/lightningState.js";

describe("STRIKE_FS", () => {
  it("uniform array and loop bound match MAX_STRIKES", () => {
    expect(STRIKE_FS).toContain(`uniform vec4 uStrike[${MAX_STRIKES}]`);
    expect(STRIKE_FS).toContain(`i < ${MAX_STRIKES}`);
  });
  it("uses the spec's cool-white core and periwinkle halo", () => {
    expect(STRIKE_FS).toContain("vec3(0.92, 0.94, 1.0)");
    expect(STRIKE_FS).toContain("vec3(0.72, 0.78, 1.0)");
  });
});
```

- [ ] **Step 2: Run it to verify it fails.** Expected: FAIL, `STRIKE_FS` undefined.

- [ ] **Step 3: Add the shader** (end of `glassShaders.ts`; add `//  STRIKE — additive lightning blooms (spec 2026-10-13), drawn after radar.` to the header list):

```ts
export const STRIKE_FS = `#version 300 es
precision highp float;
uniform vec4 uStrike[64];   // centre px (xy), radius px, intensity (MAX_STRIKES in lightningState.ts)
uniform int uNStrikes;
out vec4 O;
void main() {
  vec2 p = gl_FragCoord.xy;
  vec3 c = vec3(0.0);
  for (int i = 0; i < 64; i++) {
    if (i >= uNStrikes) break;
    vec4 s = uStrike[i];
    float d = length(p - s.xy) / max(s.z, 1.0);
    if (d > 1.3) continue;
    float core = exp(-d * d * 9.0);
    float halo = exp(-d * d * 2.5) * (1.0 - smoothstep(0.9, 1.3, d));
    c += s.w * (core * vec3(0.92, 0.94, 1.0) * 0.75 + halo * vec3(0.72, 0.78, 1.0) * 0.38);
  }
  O = vec4(c, 0.0);
}`;
```

- [ ] **Step 4: Wire `GlassLayer`.** Make these edits in `glassLayer.ts`:

1. Imports: `import { RADAR_VS, RADAR_FS, FX_VS, FX_FS, SMOKE_FS, STRIKE_FS } from "./glassShaders.js";` and `import { MAX_STRIKES, minAt, type StrikeFrame } from "./lightningState.js";`
2. `GlassLayerOptions`: add `/** Lightning blooms (spec 2026-10-13); absent = no strike pass. */ getStrikes?: (now: number) => StrikeFrame;`
3. Fields: `private strikeProg: Prog | null = null;`, `private readonly strikeBuf = new Float32Array(MAX_STRIKES * 4);`, `private lastStrikes: StrikeFrame | null = null;`
4. `onContextLost`: add `this.strikeProg = null;` to the reset list.
5. `init`: after `smokeProg` is linked: `this.strikeProg = link(gl, FX_VS, STRIKE_FS, ["uStrike", "uNStrikes"]);` and extend the give-up check to `|| !this.strikeProg`.
6. `draw`: add `|| !this.strikeProg` to the opening guard. Between the `// (1) radar` block and `// (2) haze + smoke + fronts` add:

```ts
    // (1b) lightning blooms (spec 2026-10-13): additive, under smoke and fronts.
    const sf = this.o.getStrikes?.(Date.now()) ?? null;
    this.lastStrikes = sf;
    if (sf && sf.strikes.length > 0) {
      let ns = 0;
      for (const s of sf.strikes) {
        if (ns >= MAX_STRIKES) break;
        const m = transformer.fromLatLngAltitude({ lat: s.lat, lng: s.lng, altitude: 0 });
        const c = clipToPx(m, 0, 0, 0, W, H), e = clipToPx(m, s.radiusM, 0, 0, W, H);
        if (!c || !e) continue;
        this.strikeBuf.set([c[0], c[1], Math.hypot(e[0] - c[0], e[1] - c[1]), s.intensity], ns * 4);
        ns++;
      }
      if (ns > 0) {
        const u = this.strikeProg.u;
        gl.useProgram(this.strikeProg.p);
        gl.blendFunc(gl.ONE, gl.ONE);
        gl.uniform4fv(u.uStrike!, this.strikeBuf);
        gl.uniform1i(u.uNStrikes!, ns);
        gl.bindVertexArray(this.fxVao);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      }
    }
```

7. `reschedule`: replace `const delay = paceDelay(f, Date.now(), {` with:

```ts
    const at = minAt(f.nextChangeAt, this.lastStrikes?.nextChangeAt ?? null);
    const delay = paceDelay({ ...f, nextChangeAt: at }, Date.now(), {
```

Then run `npx vitest run test/strikeShader.test.ts test/glassLayer.test.ts` and expect PASS. The existing glassLayer tests exercise `init` → `off:no-webgl2` before any linking, so the extra program doesn't affect them.

- [ ] **Step 5: Wire `map.ts`.** Imports at the top:

```ts
import { LightningState } from "./lightningState.js";
import { LightningSync, httpFetchSince } from "./lightningSync.js";
import type { Flash } from "../../backend/lightning/types.js";
```

Just before `const glassState = new GlassState({` … add:

```ts
    // Lightning (spec 2026-10-13): GLM flashes replayed as cloud blooms on a
    // shared tick. Needs the glass; a disabled backend feed just 404s (no blooms).
    const lk = display.glass.lightning;
    const lightning = mapId && lk.enabled
      ? new LightningState({
          stepMs: lk.stepMs, replayDelayMs: lk.replayDelayMs, bloomSteps: lk.bloomSteps,
          bloomIntensity: lk.bloomIntensity, bloomScale: lk.bloomScale, maxBlooms: lk.maxBlooms,
        })
      : null;
```

Change the `GlassLayer` construction to pass strikes:

```ts
    const glass = mapId
      ? new GlassLayer({
          map, home, knobs: display.glass, getFrame: (now) => glassState.frame(now),
          ...(lightning ? { getStrikes: (now: number) => lightning.frame(now) } : {}),
        })
      : null;
```

After the radar polling block (`if (radarSync) { … }`):

```ts
    const strikesIn = (flashes: Flash[]): void => {
      if (!lightning || !glass || glass.off) return;
      const at = lightning.add(flashes, Date.now());
      if (at !== null) glass.redrawAt(at);
    };
    const lightningSync = lightning && glass
      ? new LightningSync({ fetchSince: httpFetchSince, onFlashes: strikesIn, lookbackMs: lk.replayDelayMs + 30_000 })
      : null;
    if (lightningSync) {
      void lightningSync.poll();
      setInterval(() => { if (!glass?.off) void lightningSync.poll(); }, 60_000);
    }
```

In the WS handler, after the `ev.type === "radar"` branch:

```ts
      } else if (ev.type === "lightning") {
        if (ev.clear) { lightning?.clear(); poke(); }
        else lightningSync?.ingest(ev.flashes);
```

- [ ] **Step 6: Full checks**

```bash
npm test && npm run typecheck && npm run build
```

Expected: all pass. `typecheck` covers `tsconfig.frontend.json`, which is where `map.ts` errors would show up.

- [ ] **Step 7: Commit**

```bash
git add src/frontend/map/glassShaders.ts src/frontend/map/glassLayer.ts src/frontend/map/map.ts test/strikeShader.test.ts
git commit -m "feat(glass): lightning bloom pass, paced on the shared tick

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 11: On the wall: look, thermal A/B, ship

- [ ] **Step 1: Deploy.** The frontend changed, and `server.ts` gained the test route, so a backend restart is required:

```bash
cd /home/kiosk/kerchunk-kiosk/kiosk && npm test && npm run test:native && npm run typecheck && npm run build
sudo systemctl restart kerchunk-kiosk
```

Then use `Monitor` to wait ~10 s, and `curl -X POST localhost:8080/api/kiosk/reload` (re-send if it races the WS reconnect). Wait ~15 s more.

- [ ] **Step 2: Look.** `curl -s -X POST localhost:8080/api/test/lightning -H 'content-type: application/json' -d '{}'`. Within ~5 s blooms start. Capture:

```bash
XDG_RUNTIME_DIR=/run/user/1000 WAYLAND_DISPLAY=wayland-0 grim /tmp/claude-1000/kiosk-lightning.png
```

Read the PNG: blooms should be cool-white with a periwinkle halo, over the KC cores, under the smoke. Take 2–3 captures 3 s apart and confirm they change. Ask the operator to watch for a few minutes and give a verdict on the look. Tune `bloomIntensity` and `bloomScale` via `PUT /api/config` + `kiosk/reload` if asked.

- [ ] **Step 3: Thermal A/B.** Write `../.superpowers/lightning-data/ab.sh` (gitignored):

```bash
#!/usr/bin/env bash
# Usage: ab.sh on|off minutes — sets display.glass.lightning.enabled, reloads the wall,
# replays the test storm every 10 min, and logs pkg temp + chromium CPU each 30 s.
set -euo pipefail
state=$1; mins=$2
want=$([ "$state" = on ] && echo true || echo false)
curl -s localhost:8080/api/config | jq ".display.glass.lightning.enabled=$want" \
  | curl -s -X PUT -H 'content-type: application/json' --data-binary @- localhost:8080/api/config >/dev/null
curl -s -X POST localhost:8080/api/kiosk/reload >/dev/null; sleep 20
pkg=$(grep -l x86_pkg_temp /sys/class/thermal/thermal_zone*/type | head -1 | xargs dirname)
end=$(( $(date +%s) + mins * 60 )); next=0
while [ "$(date +%s)" -lt "$end" ]; do
  if [ "$(date +%s)" -ge "$next" ]; then curl -s -X POST -H 'content-type: application/json' -d '{}' localhost:8080/api/test/lightning >/dev/null; next=$(( $(date +%s) + 600 )); fi
  t=$(( $(cat $pkg/temp) / 1000 ))
  cpu=$(ps -C chrome,chromium -o %cpu= | awk '{s+=$1} END {print s+0}')
  echo "$(date +%T) $state temp=${t}C chromium=${cpu}%"
  sleep 30
done
```

Run it in the background, `off` for 30 min then `on` for 30 min (`run_in_background`; wait on it with Monitor). Pull the pacing diag:

```bash
journalctl -u kerchunk-kiosk --since "-65 min" | grep -i pacing
```

Pass criteria (from the spec): with lightning on during the replay, `glassRedrawsPerMin` is ≈ 20 above baseline at most, and package temperature shows no step beyond what smoke at 3 s showed in the stare test. Report both runs' mean temperature and chromium CPU. Afterwards make sure `display.glass.lightning.enabled` is back to **true**, and `POST /api/test/lightning {"clear":true}`.

- [ ] **Step 4: PR** (only if the A/B passed; if it failed, report the numbers and stop):

```bash
git push -u origin feat/glass-lightning
gh pr create --title "feat(glass): lightning cloud blooms (glass lightning PR 2)" --body "$(cat <<'EOF'
Wall half of docs/superpowers/specs/2026-10-13-glass-lightning-design.md.

- `LightningState`: delayed replay (t + 75 s) onto the shared 3 s grid, 2-step blooms, late/dupe/cap handling; idle sky = no redraws
- `STRIKE_FS` additive pass between radar and smoke; pacing merged via `nextChangeAt`
- `POST /api/test/lightning` replays a real 229-flash KC storm for previews
- Knobs: `display.glass.lightning.*` (applies on kiosk/reload)

Thermal A/B: <off vs on: temp, chromium CPU, redraws/min>
Look: <screenshot notes / operator verdict>

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

After merge: `gh pr merge <n> --merge --delete-branch && git checkout main && git pull --ff-only && git fetch --prune && git branch -d feat/glass-lightning`. Then add the shipped state to `docs/ROADMAP.md` in its own small `docs/` PR if the roadmap tracks shipped items.
