# Close Call Audio Samples Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture a short audio clip at the moment a Close Call hit plays, play it back from the discovery row in admin, and delete it when the discovery is triaged.

**Architecture:** The wideband helper already tees the post-limiter speaker feed on fd 3 (48 kHz mono s16le); today it only builds that tee when remote listening is on. A new config knob makes the tee build for recording too. A pure-PCM recorder module keeps a 2 s pre-roll ring, starts a clip when the engine's `audible` event names a `cc_<freqHz>` lane, stops when the lane loses the speaker or a length cap is hit, decimates 48 k → 8 k and writes a WAV keyed by frequency. A small disk-store module owns paths, listing, deletion, orphan sweeping and a size cap. Three new HTTP routes expose play/delete/list; cleanup on triage hangs off the existing `PUT /api/config` handler by diffing the discoveries array.

**Tech Stack:** TypeScript (Node ≥24, ESM), vitest + supertest, vanilla-TS admin frontend, `lucide-static` icons, zod config schema.

**Spec:** `docs/superpowers/specs/2026-08-03-close-call-audio-samples-design.md`
**Issue:** #222

## Global Constraints

- All application code lives under `kiosk/`. `cd kiosk` before running any command.
- ESM: relative imports MUST carry the `.js` extension even from `.ts` source (`import { CcSampleStore } from "./ccSampleStore.js"`). Omitting it breaks the build.
- `tsconfig` is `strict` + `noUncheckedIndexedAccess`: indexed access (`arr[i]`, `map[key]`) is typed `T | undefined` — handle the undefined case explicitly.
- Icons come from `lucide-static` raw SVG imports only. Never hand-roll an SVG, never use a typed character (▶ ⏹) as an icon. The `play` and `stop` glyphs already exist in the admin's `ICONS` registry.
- Do not change the response shape of `/api/status`, `/api/logs`, or `/api/weather` — jeremyfuksa.com polls those over the tailnet.
- Do-not-undo invariant: the engine must ALWAYS drain the helper's fd-3 audio tee, or the helper blocks. `spawnHelper` already does; do not make draining conditional.
- Audio format from the tee: 48 000 Hz, mono, signed 16-bit little-endian. Clips are written at 8 000 Hz, mono, signed 16-bit little-endian.
- Decimation factor is exactly 6 (48 000 / 8 000).
- `PREROLL_SECONDS = 2` is a module constant in `ccRecorder.ts`, deliberately NOT a config knob.
- Config knob defaults, exact values: `recordCloseCalls` = `false`, `closeCallSampleSeconds` = `20`, `closeCallSampleMaxMb` = `50`.
- Clip filenames are keyed by FREQUENCY, not discovery id: `<stateDir>/cc-samples/<freqHz>.wav`. A frequency's first hit is recorded before any discovery row exists (filing needs 2 hits).
- Verification gates for the whole branch: `npm test` passes, `npx tsc -p tsconfig.json --noEmit` is clean, `npm run build` succeeds, and the feature is proven on the live appliance.
- Every change ships through a PR off `main`. The branch for this work is `feat/close-call-samples`.

---

## File Structure

**Created:**

| File | Responsibility |
|---|---|
| `kiosk/src/backend/ccSampleStore.ts` | Disk only: clip paths, write, metadata, delete, orphan sweep, size cap. Knows nothing about PCM or engines. |
| `kiosk/src/backend/ccRecorder.ts` | PCM only: pre-roll ring, decimator, WAV encoding, and the start/stop state machine driven by `audible` events. Writes through the store. |
| `kiosk/test/ccSampleStore.test.ts` | Store unit tests (real tmpdir). |
| `kiosk/test/ccRecorder.test.ts` | Pure-function + state-machine unit tests. |

**Modified:**

| File | Change |
|---|---|
| `kiosk/src/backend/config/schema.ts` | Three new optional fields under `scan`. |
| `kiosk/src/backend/engine/ScannerEngine.ts` | `ScanConfig.recordCloseCalls?: boolean`. |
| `kiosk/src/backend/engine/WidebandEngine.ts` | `helperArgs()` builds the tee when `remoteListening \|\| recordCloseCalls`. |
| `kiosk/src/backend/server.ts` | `toScanConfig` mapping; `ServerDeps.ccSampleDir`; recorder wiring; 3 routes; discovery-diff cleanup in the config PUT handler. |
| `kiosk/src/backend/index.ts` | Pass `ccSampleDir`. |
| `kiosk/src/frontend/lib/api.ts` | `getDiscoverySamples`, `deleteDiscoverySample`. |
| `kiosk/src/frontend/admin/admin.ts` | Row Play button; drawer player block. |
| `kiosk/src/frontend/admin/admin.css` | Player block styling. |
| `kiosk/test/api.test.ts` | Route + cleanup integration tests. |
| `kiosk/docs/../docs/API.md` (repo `docs/API.md`) | Document the 3 routes. |

---

### Task 1: Config knobs and the engine tee gate

Adds the three config fields and makes the wideband helper build its fd-3 PCM tee for recording, not just for remote listening. Nothing records yet — this is the plumbing that makes audio available at all.

**Files:**
- Modify: `kiosk/src/backend/config/schema.ts` (the `scan` object, after the `closeCallDb` field around line 102)
- Modify: `kiosk/src/backend/engine/ScannerEngine.ts` (the `ScanConfig` interface, near the existing `remoteListening` field)
- Modify: `kiosk/src/backend/engine/WidebandEngine.ts:356-360` (`helperArgs`)
- Modify: `kiosk/src/backend/server.ts` (`toScanConfig`, the returned object around lines 101-139)
- Test: `kiosk/test/WidebandEngine.test.ts`, `kiosk/test/schema.test.ts`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `config.scan.recordCloseCalls?: boolean`, `config.scan.closeCallSampleSeconds?: number`, `config.scan.closeCallSampleMaxMb?: number`; `ScanConfig.recordCloseCalls?: boolean`.

- [ ] **Step 1: Write the failing engine test**

Append to `kiosk/test/WidebandEngine.test.ts`, inside the existing top-level `describe`:

```ts
it("builds the PCM tee when only close call recording is on", async () => {
  const engine = new WidebandEngine({ helperCmd: ["/bin/true"] });
  const args = (engine as unknown as { helperArgs(): string[] }).helperArgs.call(
    Object.assign(engine, { config: { channels: [], recordCloseCalls: true } }),
  );
  expect(args).toContain("--audio-fd");
});
```

Note: match the construction style already used by the other tests in that file — if they build the engine with a different options object, copy theirs and only add `recordCloseCalls: true` to the config. The assertion is the point.

- [ ] **Step 2: Run it to make sure it fails**

```sh
cd kiosk && npx vitest run test/WidebandEngine.test.ts -t "PCM tee"
```

Expected: FAIL — the args array has no `--audio-fd` because only `remoteListening` gates it today.

- [ ] **Step 3: Add the ScanConfig field**

In `kiosk/src/backend/engine/ScannerEngine.ts`, directly beneath the existing `remoteListening?: boolean;` field and its comment:

```ts
  // Close Call sample recording: when true the wideband helper builds the same
  // fd-3 PCM tee remote listening uses, so the server can record a clip at each
  // Close Call hit. Independent of remoteListening — recording must not require
  // exposing /api/stream.wav.
  recordCloseCalls?: boolean;
```

- [ ] **Step 4: Widen the tee gate**

In `kiosk/src/backend/engine/WidebandEngine.ts`, replace line 360:

```ts
    if (cfg.remoteListening) args.push("--audio-fd", "3");
```

with:

```ts
    // Either consumer wants the tee: remote listening drains it live over
    // /api/stream.wav, Close Call recording drains it into clips. One tee
    // serves both — the helper has no notion of who is listening.
    if (cfg.remoteListening || cfg.recordCloseCalls) args.push("--audio-fd", "3");
```

Also update the comment block immediately above (lines 356-359) so it no longer claims remote listening is the only gate.

- [ ] **Step 5: Run the engine test to verify it passes**

```sh
cd kiosk && npx vitest run test/WidebandEngine.test.ts
```

Expected: PASS, and no previously-passing test in that file regresses.

- [ ] **Step 6: Write the failing schema test**

Append to `kiosk/test/schema.test.ts`, inside the existing top-level `describe`:

```ts
it("accepts close call sample recording knobs", () => {
  const base = defaultConfig();
  const parsed = configSchema.safeParse({
    ...base,
    scan: {
      ...base.scan,
      recordCloseCalls: true,
      closeCallSampleSeconds: 20,
      closeCallSampleMaxMb: 50,
    },
  });
  expect(parsed.success).toBe(true);
});

it("rejects a non-positive close call sample length", () => {
  const base = defaultConfig();
  const parsed = configSchema.safeParse({
    ...base,
    scan: { ...base.scan, closeCallSampleSeconds: 0 },
  });
  expect(parsed.success).toBe(false);
});
```

If `defaultConfig` or `configSchema` are not already imported in that file, add them from `../src/backend/config/schema.js`.

- [ ] **Step 7: Run it to make sure it fails**

```sh
cd kiosk && npx vitest run test/schema.test.ts -t "close call sample"
```

Expected: the "rejects" test FAILS — zod strips unknown keys rather than validating them, so a `0` is accepted today.

- [ ] **Step 8: Add the schema fields**

In `kiosk/src/backend/config/schema.ts`, inside the `scan` object immediately after the `closeCallDb` field (around line 102):

```ts
    // Close Call sample recording (#222): capture a short clip of each Close
    // Call hit so a discovery can be triaged by ear instead of by retuning the
    // live radio at a frequency that is usually quiet. Flipping this is an
    // ENGINE RESTART — it changes a helper spawn arg (the fd-3 PCM tee).
    recordCloseCalls: z.boolean().optional(),
    // Per-clip length cap, seconds. The clip includes a 2 s pre-roll.
    closeCallSampleSeconds: z.number().positive().optional(),
    // Total budget for the clip directory, MB. Oldest clips are evicted first.
    closeCallSampleMaxMb: z.number().positive().optional(),
```

- [ ] **Step 9: Map the knob into ScanConfig**

In `kiosk/src/backend/server.ts`, in the object literal `toScanConfig` returns (near the existing `remoteListening` mapping around lines 101-139), add:

```ts
    recordCloseCalls: cfg.scan.recordCloseCalls === true,
```

This is deliberately part of the scan config: the PUT handler's `scanChanged` diff will then restart the engine when the operator flips the knob, which is exactly what is required to (re)build the helper tee.

- [ ] **Step 10: Run the full suite and typecheck**

```sh
cd kiosk && npm test && npx tsc -p tsconfig.json --noEmit
```

Expected: all tests PASS, typecheck clean.

- [ ] **Step 11: Commit**

```sh
cd /home/kiosk/kerchunk-kiosk
git add kiosk/src/backend/config/schema.ts kiosk/src/backend/engine/ScannerEngine.ts \
        kiosk/src/backend/engine/WidebandEngine.ts kiosk/src/backend/server.ts \
        kiosk/test/WidebandEngine.test.ts kiosk/test/schema.test.ts
git commit -m "feat(scan): gate the helper PCM tee on close call recording too

Recording a Close Call hit needs the same fd-3 speaker tee remote listening
drains, but must not require exposing /api/stream.wav to get it."
```

---

### Task 2: PCM primitives — decimator, WAV encoder, pre-roll ring

The three pure pieces the recorder is built from. All synchronous, all testable without a filesystem or an engine.

**Files:**
- Create: `kiosk/src/backend/ccRecorder.ts`
- Test: `kiosk/test/ccRecorder.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces:
  - `export const PREROLL_SECONDS = 2`
  - `export const SOURCE_RATE = 48_000`
  - `export const CLIP_RATE = 8_000`
  - `export function decimate48kTo8k(pcm: Buffer): Buffer` — s16le in, s16le out
  - `export function encodeWav8k(pcm8k: Buffer): Buffer` — 44-byte header + data
  - `export class PrerollRing { constructor(byteCapacity: number); write(chunk: Buffer): void; read(): Buffer; clear(): void; }`

- [ ] **Step 1: Write the failing tests**

Create `kiosk/test/ccRecorder.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { decimate48kTo8k, encodeWav8k, PrerollRing } from "../src/backend/ccRecorder.js";

function s16(samples: number[]): Buffer {
  const buf = Buffer.alloc(samples.length * 2);
  samples.forEach((v, i) => buf.writeInt16LE(v, i * 2));
  return buf;
}
function readS16(buf: Buffer): number[] {
  const out: number[] = [];
  for (let i = 0; i < buf.length / 2; i++) out.push(buf.readInt16LE(i * 2));
  return out;
}

describe("decimate48kTo8k", () => {
  it("averages each run of six samples into one", () => {
    const out = decimate48kTo8k(s16([0, 0, 0, 60, 60, 60, 12, 12, 12, 12, 12, 12]));
    expect(readS16(out)).toEqual([30, 12]);
  });

  it("drops a trailing partial run rather than distorting it", () => {
    const out = decimate48kTo8k(s16([6, 6, 6, 6, 6, 6, 100, 100]));
    expect(readS16(out)).toEqual([6]);
  });

  it("preserves negative amplitudes", () => {
    const out = decimate48kTo8k(s16([-30, -30, -30, -30, -30, -30]));
    expect(readS16(out)).toEqual([-30]);
  });
});

describe("encodeWav8k", () => {
  it("writes a 44-byte 8 kHz mono s16 header ahead of the data", () => {
    const data = s16([1, 2, 3, 4]);
    const wav = encodeWav8k(data);
    expect(wav.length).toBe(44 + data.length);
    expect(wav.subarray(0, 4).toString()).toBe("RIFF");
    expect(wav.readUInt32LE(4)).toBe(36 + data.length);
    expect(wav.subarray(8, 12).toString()).toBe("WAVE");
    expect(wav.readUInt16LE(20)).toBe(1);      // PCM
    expect(wav.readUInt16LE(22)).toBe(1);      // mono
    expect(wav.readUInt32LE(24)).toBe(8000);   // sample rate
    expect(wav.readUInt32LE(28)).toBe(16000);  // byte rate
    expect(wav.readUInt16LE(32)).toBe(2);      // block align
    expect(wav.readUInt16LE(34)).toBe(16);     // bits
    expect(wav.subarray(36, 40).toString()).toBe("data");
    expect(wav.readUInt32LE(40)).toBe(data.length);
    expect(wav.subarray(44)).toEqual(data);
  });
});

describe("PrerollRing", () => {
  it("returns everything written while under capacity", () => {
    const ring = new PrerollRing(8);
    ring.write(s16([1, 2]));
    expect(readS16(ring.read())).toEqual([1, 2]);
  });

  it("keeps only the most recent bytes once it wraps, in order", () => {
    const ring = new PrerollRing(8); // 4 samples
    ring.write(s16([1, 2, 3, 4]));
    ring.write(s16([5, 6]));
    expect(readS16(ring.read())).toEqual([3, 4, 5, 6]);
  });

  it("handles a single write larger than capacity", () => {
    const ring = new PrerollRing(8);
    ring.write(s16([1, 2, 3, 4, 5, 6, 7]));
    expect(readS16(ring.read())).toEqual([4, 5, 6, 7]);
  });

  it("clear() empties it", () => {
    const ring = new PrerollRing(8);
    ring.write(s16([1, 2]));
    ring.clear();
    expect(ring.read().length).toBe(0);
  });
});
```

- [ ] **Step 2: Run to make sure they fail**

```sh
cd kiosk && npx vitest run test/ccRecorder.test.ts
```

Expected: FAIL — `ccRecorder.js` does not exist.

- [ ] **Step 3: Implement the primitives**

Create `kiosk/src/backend/ccRecorder.ts`:

```ts
// Close Call sample recording (#222). The wideband helper tees the post-limiter
// speaker feed on fd 3 as 48 kHz mono s16le; this module turns the span of that
// feed during a Close Call hit into a small WAV on disk.

/** Pre-roll kept ahead of every clip. The engine's `audible` event lands
 *  slightly after the carrier opens, so a clip that began there would lose the
 *  first syllable. A correctness margin, not a taste dial — deliberately not a
 *  config knob. */
export const PREROLL_SECONDS = 2;

/** The helper's tee rate. */
export const SOURCE_RATE = 48_000;
/** Clips are voice-triage grade: 8 kHz mono s16 is ~16 KB/s, a sixth of the
 *  tee, and plenty to answer "is this worth adding". */
export const CLIP_RATE = 8_000;

const DECIMATION = SOURCE_RATE / CLIP_RATE; // 6

/** 48 kHz -> 8 kHz by averaging each run of six samples. A box filter is
 *  adequate anti-aliasing at this job: the clip exists to be recognised, not
 *  measured. A trailing partial run is dropped rather than averaged over a
 *  shorter window, which would misrepresent its amplitude. */
export function decimate48kTo8k(pcm: Buffer): Buffer {
  const inSamples = Math.floor(pcm.length / 2);
  const outSamples = Math.floor(inSamples / DECIMATION);
  const out = Buffer.alloc(outSamples * 2);
  for (let i = 0; i < outSamples; i++) {
    let sum = 0;
    for (let j = 0; j < DECIMATION; j++) sum += pcm.readInt16LE((i * DECIMATION + j) * 2);
    out.writeInt16LE(Math.round(sum / DECIMATION), i * 2);
  }
  return out;
}

/** Canonical 44-byte RIFF/WAVE header for 8 kHz mono s16, followed by the data.
 *  Lengths are real (not the 0xffffffff the endless /stream.wav uses) so the
 *  browser's <audio> can show a duration and seek. */
export function encodeWav8k(pcm8k: Buffer): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm8k.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);           // fmt chunk size
  header.writeUInt16LE(1, 20);            // PCM
  header.writeUInt16LE(1, 22);            // mono
  header.writeUInt32LE(CLIP_RATE, 24);
  header.writeUInt32LE(CLIP_RATE * 2, 28); // byte rate
  header.writeUInt16LE(2, 32);            // block align
  header.writeUInt16LE(16, 34);           // bits per sample
  header.write("data", 36);
  header.writeUInt32LE(pcm8k.length, 40);
  return Buffer.concat([header, pcm8k]);
}

/** Fixed-size ring of raw 48 kHz PCM. Holds RAW samples, not decimated ones:
 *  decimation happens once at flush, so the steady-state cost of running the
 *  ring is a copy per chunk and no arithmetic. */
export class PrerollRing {
  private readonly buf: Buffer;
  private offset = 0;
  private filled = 0;

  constructor(byteCapacity: number) {
    this.buf = Buffer.alloc(Math.max(2, byteCapacity));
  }

  write(chunk: Buffer): void {
    const cap = this.buf.length;
    // A chunk larger than the ring: only its tail can survive, so skip
    // straight to it instead of wrapping the whole thing through.
    const src = chunk.length > cap ? chunk.subarray(chunk.length - cap) : chunk;
    const first = Math.min(src.length, cap - this.offset);
    src.copy(this.buf, this.offset, 0, first);
    if (first < src.length) src.copy(this.buf, 0, first);
    this.offset = (this.offset + src.length) % cap;
    this.filled = Math.min(cap, this.filled + src.length);
  }

  /** Contents oldest-first. */
  read(): Buffer {
    if (this.filled < this.buf.length) return Buffer.from(this.buf.subarray(0, this.filled));
    return Buffer.concat([
      this.buf.subarray(this.offset),
      this.buf.subarray(0, this.offset),
    ]);
  }

  clear(): void {
    this.offset = 0;
    this.filled = 0;
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```sh
cd kiosk && npx vitest run test/ccRecorder.test.ts
```

Expected: PASS — all 8 tests.

- [ ] **Step 5: Commit**

```sh
cd /home/kiosk/kerchunk-kiosk
git add kiosk/src/backend/ccRecorder.ts kiosk/test/ccRecorder.test.ts
git commit -m "feat(cc-samples): PCM primitives — decimator, WAV encoder, pre-roll ring"
```

---

### Task 3: The clip store

Owns the `cc-samples` directory: where a clip lives, what is on disk, what gets deleted. Knows nothing about audio or engines, which is what makes the sweep/eviction rules testable in milliseconds.

**Files:**
- Create: `kiosk/src/backend/ccSampleStore.ts`
- Test: `kiosk/test/ccSampleStore.test.ts`

**Interfaces:**
- Consumes: `encodeWav8k`, `CLIP_RATE` from `./ccRecorder.js` (Task 2).
- Produces:
  - `export interface CcSampleMeta { freqHz: number; bytes: number; seconds: number; ts: number }`
  - `export class CcSampleStore`
    - `constructor(dir: string)`
    - `pathFor(freqHz: number): string`
    - `write(freqHz: number, pcm8k: Buffer): void`
    - `meta(freqHz: number): CcSampleMeta | null`
    - `list(): CcSampleMeta[]` — newest first
    - `delete(freqHz: number): boolean`
    - `sweep(opts: { knownFreqs: number[]; maxBytes: number; nowMs: number }): void`
  - `export const ORPHAN_GRACE_MS = 60 * 60 * 1000`

- [ ] **Step 1: Write the failing tests**

Create `kiosk/test/ccSampleStore.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CcSampleStore, ORPHAN_GRACE_MS } from "../src/backend/ccSampleStore.js";

let dir: string;
let store: CcSampleStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ccs-"));
  store = new CcSampleStore(join(dir, "cc-samples"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** `seconds` of 8 kHz mono s16 silence. */
const pcm = (seconds: number) => Buffer.alloc(Math.round(seconds * 8000) * 2);

/** Backdate a clip so age-sensitive rules can be exercised. */
function ageBy(freqHz: number, ms: number): void {
  const when = new Date(Date.now() - ms);
  utimesSync(store.pathFor(freqHz), when, when);
}

describe("CcSampleStore", () => {
  it("creates its directory lazily and writes a playable clip", () => {
    store.write(154_570_000, pcm(1));
    expect(existsSync(store.pathFor(154_570_000))).toBe(true);
    const meta = store.meta(154_570_000);
    expect(meta?.freqHz).toBe(154_570_000);
    expect(meta?.seconds).toBeCloseTo(1, 2);
  });

  it("overwrites the previous clip for the same frequency", () => {
    store.write(154_570_000, pcm(1));
    store.write(154_570_000, pcm(3));
    expect(store.meta(154_570_000)?.seconds).toBeCloseTo(3, 2);
    expect(store.list().length).toBe(1);
  });

  it("reports no metadata for a frequency it has never seen", () => {
    expect(store.meta(154_570_000)).toBeNull();
  });

  it("deletes a clip and reports whether there was one", () => {
    store.write(154_570_000, pcm(1));
    expect(store.delete(154_570_000)).toBe(true);
    expect(store.delete(154_570_000)).toBe(false);
    expect(store.meta(154_570_000)).toBeNull();
  });

  it("lists clips newest first", () => {
    store.write(154_570_000, pcm(1));
    store.write(155_100_000, pcm(1));
    ageBy(154_570_000, 60_000);
    expect(store.list().map((m) => m.freqHz)).toEqual([155_100_000, 154_570_000]);
  });

  it("sweeps orphans older than the grace period", () => {
    store.write(154_570_000, pcm(1));   // orphan, old
    store.write(155_100_000, pcm(1));   // orphan, fresh
    store.write(156_000_000, pcm(1));   // known
    ageBy(154_570_000, ORPHAN_GRACE_MS + 60_000);
    store.sweep({ knownFreqs: [156_000_000], maxBytes: 1024 * 1024 * 50, nowMs: Date.now() });
    expect(store.meta(154_570_000)).toBeNull();
    expect(store.meta(155_100_000)).not.toBeNull();
    expect(store.meta(156_000_000)).not.toBeNull();
  });

  it("evicts oldest first to stay under the size cap", () => {
    store.write(154_570_000, pcm(1));
    store.write(155_100_000, pcm(1));
    store.write(156_000_000, pcm(1));
    ageBy(154_570_000, 120_000);
    ageBy(155_100_000, 60_000);
    const oneClip = store.meta(156_000_000)!.bytes;
    store.sweep({
      knownFreqs: [154_570_000, 155_100_000, 156_000_000],
      maxBytes: oneClip * 2,
      nowMs: Date.now(),
    });
    expect(store.meta(154_570_000)).toBeNull();     // oldest goes first
    expect(store.meta(155_100_000)).not.toBeNull();
    expect(store.meta(156_000_000)).not.toBeNull();
  });

  it("ignores files that are not clips", () => {
    store.write(154_570_000, pcm(1));
    require("node:fs").writeFileSync(join(dir, "cc-samples", "notes.txt"), "hi");
    expect(store.list().map((m) => m.freqHz)).toEqual([154_570_000]);
  });
});
```

Note: replace the `require` in the last test with a top-level `import { writeFileSync } from "node:fs"` — the file is ESM. It is written inline here only to make the intent obvious; use the import.

- [ ] **Step 2: Run to make sure they fail**

```sh
cd kiosk && npx vitest run test/ccSampleStore.test.ts
```

Expected: FAIL — `ccSampleStore.js` does not exist.

- [ ] **Step 3: Implement the store**

Create `kiosk/src/backend/ccSampleStore.ts`:

```ts
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { encodeWav8k, CLIP_RATE } from "./ccRecorder.js";

export interface CcSampleMeta {
  freqHz: number;
  bytes: number;
  /** Playable length, excluding the 44-byte WAV header. */
  seconds: number;
  /** Last write, ms since epoch. */
  ts: number;
}

/** How long an unclaimed clip is kept. A frequency must hit TWICE to earn a
 *  discovery row and the helper spaces hits >=5 min apart, so a clip recorded
 *  on hit 1 needs to outlive that gap comfortably before it counts as junk. */
export const ORPHAN_GRACE_MS = 60 * 60 * 1000;

const WAV_HEADER_BYTES = 44;
const CLIP_RE = /^(\d+)\.wav$/;

/** The `cc-samples` directory. Clips are keyed by FREQUENCY, not discovery id:
 *  a frequency's first hit is recorded before any discovery row exists, so a
 *  frequency is the only identifier available at write time. */
export class CcSampleStore {
  constructor(private readonly dir: string) {}

  pathFor(freqHz: number): string {
    return join(this.dir, `${freqHz}.wav`);
  }

  write(freqHz: number, pcm8k: Buffer): void {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.pathFor(freqHz), encodeWav8k(pcm8k));
  }

  meta(freqHz: number): CcSampleMeta | null {
    try {
      const st = statSync(this.pathFor(freqHz));
      return {
        freqHz,
        bytes: st.size,
        seconds: Math.max(0, st.size - WAV_HEADER_BYTES) / 2 / CLIP_RATE,
        ts: st.mtimeMs,
      };
    } catch {
      return null; // absent, or an unreadable directory — same answer either way
    }
  }

  /** Newest first. */
  list(): CcSampleMeta[] {
    if (!existsSync(this.dir)) return [];
    const out: CcSampleMeta[] = [];
    for (const name of readdirSync(this.dir)) {
      const m = CLIP_RE.exec(name);
      if (!m?.[1]) continue; // stray file in the directory; not ours to report
      const meta = this.meta(Number(m[1]));
      if (meta) out.push(meta);
    }
    return out.sort((a, b) => b.ts - a.ts);
  }

  delete(freqHz: number): boolean {
    const path = this.pathFor(freqHz);
    if (!existsSync(path)) return false;
    rmSync(path, { force: true });
    return true;
  }

  /** Drop clips nothing will ever claim, then hold the directory under budget.
   *  Orphans go first (they have no row to be played from), then oldest-first
   *  eviction takes whatever is still over the cap. */
  sweep(opts: { knownFreqs: number[]; maxBytes: number; nowMs: number }): void {
    const known = new Set(opts.knownFreqs);
    let clips = this.list();
    for (const clip of clips) {
      if (known.has(clip.freqHz)) continue;
      if (opts.nowMs - clip.ts < ORPHAN_GRACE_MS) continue;
      this.delete(clip.freqHz);
    }
    clips = this.list();
    let total = clips.reduce((sum, c) => sum + c.bytes, 0);
    // list() is newest-first, so walking backwards evicts the oldest.
    for (let i = clips.length - 1; i >= 0 && total > opts.maxBytes; i--) {
      const clip = clips[i];
      if (!clip) continue;
      this.delete(clip.freqHz);
      total -= clip.bytes;
    }
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```sh
cd kiosk && npx vitest run test/ccSampleStore.test.ts
```

Expected: PASS — all 8 tests.

- [ ] **Step 5: Commit**

```sh
cd /home/kiosk/kerchunk-kiosk
git add kiosk/src/backend/ccSampleStore.ts kiosk/test/ccSampleStore.test.ts
git commit -m "feat(cc-samples): clip store with orphan sweep and size cap"
```

---

### Task 4: The recorder state machine

Turns a stream of PCM chunks plus `audible` transitions into clips. This is the piece that guarantees a clip contains the Close Call lane and nothing else.

**Files:**
- Modify: `kiosk/src/backend/ccRecorder.ts` (append the class; primitives from Task 2 stay)
- Test: `kiosk/test/ccRecorder.test.ts` (append a `describe`)

**Interfaces:**
- Consumes: `PrerollRing`, `decimate48kTo8k`, `PREROLL_SECONDS`, `SOURCE_RATE` (Task 2); `CcSampleStore` (Task 3).
- Produces:
  - `export const CC_LANE_RE = /^cc_(\d+)$/`
  - `export interface CcRecorderDeps { store: CcSampleStore; enabled: () => boolean; isRecordable: (freqHz: number) => boolean; maxSeconds: () => number; maxBytes: () => number; knownFreqs: () => number[]; now?: () => number }`
  - `export class CcRecorder { constructor(deps: CcRecorderDeps); onAudible(channelId: string | null): void; onPcm(chunk: Buffer): void; flush(): void }`

- [ ] **Step 1: Write the failing tests**

Append to `kiosk/test/ccRecorder.test.ts`. Add these imports to the top of the file:

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach } from "vitest";
import { CcRecorder } from "../src/backend/ccRecorder.js";
import { CcSampleStore } from "../src/backend/ccSampleStore.js";
```

Then append:

```ts
describe("CcRecorder", () => {
  let dir: string;
  let store: CcSampleStore;
  let enabled: boolean;
  let recordable: boolean;

  function makeRecorder(maxSeconds = 20) {
    return new CcRecorder({
      store,
      enabled: () => enabled,
      isRecordable: () => recordable,
      maxSeconds: () => maxSeconds,
      maxBytes: () => 50 * 1024 * 1024,
      knownFreqs: () => [],
      now: () => Date.now(),
    });
  }

  /** `seconds` of 48 kHz mono s16 tone-ish data (non-zero so it is distinguishable). */
  const feed = (seconds: number) => {
    const buf = Buffer.alloc(Math.round(seconds * 48_000) * 2);
    for (let i = 0; i < buf.length / 2; i++) buf.writeInt16LE(1000, i * 2);
    return buf;
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ccr-"));
    store = new CcSampleStore(join(dir, "cc-samples"));
    enabled = true;
    recordable = true;
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("writes a clip when a close call lane takes and then loses the speaker", () => {
    const rec = makeRecorder();
    rec.onPcm(feed(1));
    rec.onAudible("cc_154570000");
    rec.onPcm(feed(3));
    rec.onAudible(null);
    const meta = store.meta(154_570_000);
    expect(meta).not.toBeNull();
    // 3 s of hit plus the 2 s pre-roll cap, of which only 1 s was buffered.
    expect(meta!.seconds).toBeCloseTo(4, 1);
  });

  it("includes pre-roll from before the audible event", () => {
    const rec = makeRecorder();
    rec.onPcm(feed(5));            // ring keeps the last 2 s
    rec.onAudible("cc_154570000");
    rec.onPcm(feed(1));
    rec.onAudible(null);
    expect(store.meta(154_570_000)!.seconds).toBeCloseTo(3, 1);
  });

  it("ignores audible spans that are not close call lanes", () => {
    const rec = makeRecorder();
    rec.onAudible("ch_abc123");
    rec.onPcm(feed(3));
    rec.onAudible(null);
    expect(store.list()).toEqual([]);
  });

  it("stops at the length cap even while the lane still holds the speaker", () => {
    const rec = makeRecorder(2);
    rec.onAudible("cc_154570000");
    rec.onPcm(feed(10));
    expect(store.meta(154_570_000)!.seconds).toBeCloseTo(2, 1);
  });

  it("does not re-open a clip for the same span after the cap fires", () => {
    const rec = makeRecorder(2);
    rec.onAudible("cc_154570000");
    rec.onPcm(feed(10));
    const first = store.meta(154_570_000)!.ts;
    rec.onPcm(feed(10));
    expect(store.meta(154_570_000)!.ts).toBe(first);
  });

  it("flushes the old clip and starts a new one when the lane changes", () => {
    const rec = makeRecorder();
    rec.onAudible("cc_154570000");
    rec.onPcm(feed(1));
    rec.onAudible("cc_155100000");
    rec.onPcm(feed(1));
    rec.onAudible(null);
    expect(store.meta(154_570_000)).not.toBeNull();
    expect(store.meta(155_100_000)).not.toBeNull();
  });

  it("records nothing while disabled, and keeps no pre-roll", () => {
    enabled = false;
    const rec = makeRecorder();
    rec.onPcm(feed(3));
    rec.onAudible("cc_154570000");
    rec.onPcm(feed(3));
    rec.onAudible(null);
    expect(store.list()).toEqual([]);
  });

  it("skips a frequency the server says is not recordable", () => {
    recordable = false;
    const rec = makeRecorder();
    rec.onAudible("cc_154570000");
    rec.onPcm(feed(3));
    rec.onAudible(null);
    expect(store.list()).toEqual([]);
  });

  it("discards a clip too short to be worth auditioning", () => {
    const rec = makeRecorder();
    rec.onAudible("cc_154570000");
    rec.onPcm(feed(0.1));
    rec.onAudible(null);
    expect(store.meta(154_570_000)).toBeNull();
  });
});
```

- [ ] **Step 2: Run to make sure they fail**

```sh
cd kiosk && npx vitest run test/ccRecorder.test.ts -t "CcRecorder"
```

Expected: FAIL — `CcRecorder` is not exported.

- [ ] **Step 3: Implement the recorder**

Append to `kiosk/src/backend/ccRecorder.ts` (and add `import type { CcSampleStore } from "./ccSampleStore.js";` at the top — a type-only import, so the two modules do not form a runtime cycle):

```ts
/** Close Call lanes are not configured channels, so `WidebandEngine` synthesises
 *  an id carrying the frequency. That id is the ONLY place a hit's frequency and
 *  its speaker ownership are known together. */
export const CC_LANE_RE = /^cc_(\d+)$/;

/** Below this a "clip" is a squelch tail or a detection glitch, not something
 *  an operator can judge a frequency by. */
const MIN_CLIP_SECONDS = 0.35;

export interface CcRecorderDeps {
  store: CcSampleStore;
  /** config.scan.recordCloseCalls */
  enabled: () => boolean;
  /** False for configured channels and locked-out frequencies — mirrors the
   *  filing guard in server.ts so the two cannot drift. */
  isRecordable: (freqHz: number) => boolean;
  /** config.scan.closeCallSampleSeconds */
  maxSeconds: () => number;
  /** config.scan.closeCallSampleMaxMb, in bytes */
  maxBytes: () => number;
  /** Frequencies with a discovery row — anything else on disk is an orphan. */
  knownFreqs: () => number[];
  now?: () => number;
}

/** Records the speaker feed for the span a Close Call lane owns it.
 *
 *  Gated on the engine's `audible` event, NOT on the `closecall` detection
 *  event. The tee is the speaker MIX, not a per-channel tap: detection and
 *  speaker ownership are separate moments, and only `audible` tells us the
 *  bytes arriving right now are the Close Call rather than a neighbouring
 *  channel's traffic. */
export class CcRecorder {
  private readonly ring: PrerollRing;
  private readonly now: () => number;
  private clip: Buffer[] = [];
  private clipBytes = 0;
  private freqHz: number | null = null;
  /** The lane we already flushed at the cap; further audio on the same span is
   *  dropped rather than starting a second clip that overwrites the first. */
  private cappedId: string | null = null;
  private currentId: string | null = null;

  constructor(private readonly deps: CcRecorderDeps) {
    this.ring = new PrerollRing(PREROLL_SECONDS * SOURCE_RATE * 2);
    this.now = deps.now ?? (() => Date.now());
  }

  onPcm(chunk: Buffer): void {
    if (!this.deps.enabled()) return;
    if (this.freqHz === null) { this.ring.write(chunk); return; }
    const cap = Math.max(1, this.deps.maxSeconds()) * SOURCE_RATE * 2;
    const room = cap - this.clipBytes;
    const take = chunk.length > room ? chunk.subarray(0, room) : chunk;
    this.clip.push(Buffer.from(take));
    this.clipBytes += take.length;
    if (this.clipBytes >= cap) {
      this.cappedId = this.currentId;
      this.flush();
    }
  }

  onAudible(channelId: string | null): void {
    if (channelId === this.currentId) return;
    this.currentId = channelId;
    this.flush();
    if (!this.deps.enabled() || channelId === null) return;
    // Same span as the one we already capped: do not start over.
    if (channelId === this.cappedId) return;
    this.cappedId = null;
    const match = CC_LANE_RE.exec(channelId);
    if (!match?.[1]) return;
    const freqHz = Number(match[1]);
    if (!this.deps.isRecordable(freqHz)) return;
    this.freqHz = freqHz;
    // Seed with the pre-roll: the carrier opened slightly before this event.
    const preroll = this.ring.read();
    this.clip = preroll.length > 0 ? [preroll] : [];
    this.clipBytes = preroll.length;
  }

  /** Write whatever is in flight. Safe to call when nothing is recording. */
  flush(): void {
    const freqHz = this.freqHz;
    const clip = this.clip;
    const bytes = this.clipBytes;
    this.freqHz = null;
    this.clip = [];
    this.clipBytes = 0;
    if (freqHz === null || bytes === 0) return;
    if (bytes / 2 / SOURCE_RATE < MIN_CLIP_SECONDS) return;
    try {
      this.deps.store.write(freqHz, decimate48kTo8k(Buffer.concat(clip)));
      this.deps.store.sweep({
        knownFreqs: this.deps.knownFreqs(),
        maxBytes: this.deps.maxBytes(),
        nowMs: this.now(),
      });
    } catch {
      // A full or unwritable state directory must never take the radio down.
    }
  }
}
```

Note on the `enabled === false` case: `onPcm` returns before touching the ring, so nothing is buffered while the feature is off — that is what the "keeps no pre-roll" test asserts.

- [ ] **Step 4: Run the tests to verify they pass**

```sh
cd kiosk && npx vitest run test/ccRecorder.test.ts
```

Expected: PASS — the primitives from Task 2 plus all 9 `CcRecorder` tests.

- [ ] **Step 5: Typecheck**

```sh
cd kiosk && npx tsc -p tsconfig.json --noEmit
```

Expected: clean.

- [ ] **Step 6: Commit**

```sh
cd /home/kiosk/kerchunk-kiosk
git add kiosk/src/backend/ccRecorder.ts kiosk/test/ccRecorder.test.ts
git commit -m "feat(cc-samples): record the speaker feed for the span a CC lane owns it

Gated on the engine's audible event rather than the closecall detection
event: the tee is the speaker MIX, so only audible ownership proves the
bytes arriving now are the Close Call and not a neighbour."
```

---

### Task 5: Server wiring — recorder, routes, and cleanup on triage

Connects the recorder to the live engine, exposes the three routes, and makes triage delete clips.

**Files:**
- Modify: `kiosk/src/backend/server.ts` (`ServerDeps` around line 22-52; recorder wiring near the existing Close Call `engine.on` block at line 630; routes near `/api/stream.wav` at line 1013; cleanup in the `PUT /api/config` handler at lines 751-795)
- Modify: `kiosk/src/backend/index.ts` (the `createServer` call)
- Test: `kiosk/test/api.test.ts`

**Interfaces:**
- Consumes: `CcSampleStore` (Task 3), `CcRecorder` (Task 4), `config.scan.recordCloseCalls` / `closeCallSampleSeconds` / `closeCallSampleMaxMb` (Task 1).
- Produces:
  - `ServerDeps.ccSampleDir?: string`
  - `GET /api/discoveries/samples` → `{ [discoveryId: string]: { bytes: number; seconds: number; ts: number } }`
  - `GET /api/discoveries/:id/sample.wav` → `audio/wav`, or 404
  - `DELETE /api/discoveries/:id/sample` → `{ ok: true }`, or 404

- [ ] **Step 1: Write the failing tests**

In `kiosk/test/api.test.ts`, change `makeApp` so the server gets a clip directory, and return it:

```ts
function makeApp() {
  dir = mkdtempSync(join(tmpdir(), "ksrv-"));
  const configStore = new ConfigStore(join(dir, "config.json"));
  const engine = new FakeEngine();
  const activityLog = new ActivityLog(100);
  const wsHub = new WsHub();
  const ccSampleDir = join(dir, "cc-samples");
  const { server } = createServer({
    configStore, engine, activityLog, wsHub, staticDir: dir, ccSampleDir,
  });
  return { server, engine, configStore, wsHub, ccSampleDir };
}
```

Then append a new `describe` at the end of the file:

```ts
describe("Close Call sample routes", () => {
  /** Put a discovery in config and a matching clip on disk. */
  async function seed(server: any, ccSampleDir: string, freq = 154_570_000) {
    const cfg = (await request(server).get("/api/config")).body;
    cfg.discoveries = [{
      id: "cc_seed01", freq, alphaTag: `Close Call ${freq}`, ts: Date.now(),
    }];
    await request(server).put("/api/config").send(cfg);
    new CcSampleStore(ccSampleDir).write(freq, Buffer.alloc(8000 * 2)); // 1 s
    return "cc_seed01";
  }

  it("lists clips keyed by discovery id", async () => {
    const { server, ccSampleDir } = makeApp();
    const id = await seed(server, ccSampleDir);
    const res = await request(server).get("/api/discoveries/samples");
    expect(res.status).toBe(200);
    expect(res.body[id].seconds).toBeCloseTo(1, 2);
  });

  it("omits clips with no matching discovery", async () => {
    const { server, ccSampleDir } = makeApp();
    await seed(server, ccSampleDir);
    new CcSampleStore(ccSampleDir).write(999_000_000, Buffer.alloc(8000 * 2));
    const res = await request(server).get("/api/discoveries/samples");
    expect(Object.keys(res.body).length).toBe(1);
  });

  it("serves the clip as a WAV", async () => {
    const { server, ccSampleDir } = makeApp();
    const id = await seed(server, ccSampleDir);
    const res = await request(server).get(`/api/discoveries/${id}/sample.wav`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("audio/wav");
    expect(res.body.subarray(0, 4).toString()).toBe("RIFF");
  });

  it("404s for a discovery with no clip", async () => {
    const { server } = makeApp();
    const res = await request(server).get("/api/discoveries/cc_nope/sample.wav");
    expect(res.status).toBe(404);
  });

  it("deletes a clip on request", async () => {
    const { server, ccSampleDir } = makeApp();
    const id = await seed(server, ccSampleDir);
    expect((await request(server).delete(`/api/discoveries/${id}/sample`)).status).toBe(200);
    expect((await request(server).get(`/api/discoveries/${id}/sample.wav`)).status).toBe(404);
  });

  it("deletes the clip when the discovery is triaged away", async () => {
    const { server, ccSampleDir } = makeApp();
    await seed(server, ccSampleDir);
    const cfg = (await request(server).get("/api/config")).body;
    cfg.discoveries = [];
    await request(server).put("/api/config").send(cfg);
    expect(new CcSampleStore(ccSampleDir).meta(154_570_000)).toBeNull();
  });

  it("keeps the clip when the discovery is only edited", async () => {
    const { server, ccSampleDir } = makeApp();
    await seed(server, ccSampleDir);
    const cfg = (await request(server).get("/api/config")).body;
    cfg.discoveries[0].alphaTag = "Renamed";
    await request(server).put("/api/config").send(cfg);
    expect(new CcSampleStore(ccSampleDir).meta(154_570_000)).not.toBeNull();
  });
});
```

Add `import { CcSampleStore } from "../src/backend/ccSampleStore.js";` to the file's imports.

- [ ] **Step 2: Run to make sure they fail**

```sh
cd kiosk && npx vitest run test/api.test.ts -t "Close Call sample"
```

Expected: FAIL — `ccSampleDir` is not a known dep and the routes 404 as unknown paths.

- [ ] **Step 3: Add the dep and construct the store + recorder**

In `kiosk/src/backend/server.ts`, add to `ServerDeps`:

```ts
  /** Directory for Close Call audio clips (#222). Absent (tests that don't
   *  exercise it, non-appliance hosts) disables recording and 404s the sample
   *  routes rather than writing anywhere unexpected. */
  ccSampleDir?: string;
```

Add the imports at the top of the file:

```ts
import { CcSampleStore } from "./ccSampleStore.js";
import { CcRecorder } from "./ccRecorder.js";
```

Then, next to the existing Close Call `engine.on` handler (after the block ending at line 683), add:

```ts
  // Close Call sample recording (#222). The recorder reads every knob through a
  // closure so a live config PUT takes effect without rebuilding it. It is
  // always subscribed and no-ops while disabled — the helper simply sends no
  // audio when the tee isn't built.
  const ccStore = deps.ccSampleDir ? new CcSampleStore(deps.ccSampleDir) : null;
  const ccRecorder = ccStore
    ? new CcRecorder({
        store: ccStore,
        enabled: () => config.scan.recordCloseCalls === true,
        // Mirrors the filing guard above: the operator's own channels and
        // locked-out frequencies are not discoveries and never get a clip.
        isRecordable: (freqHz) =>
          !config.channels.some((c) => c.freq === freqHz)
          && !(config.scan.lockoutHz ?? []).includes(freqHz),
        maxSeconds: () => config.scan.closeCallSampleSeconds ?? 20,
        maxBytes: () => (config.scan.closeCallSampleMaxMb ?? 50) * 1024 * 1024,
        knownFreqs: () => (config.discoveries ?? []).map((d) => d.freq),
      })
    : null;
  if (ccRecorder) {
    const onAudio = (engine as { onAudio?: (l: (c: Buffer) => void) => () => void })
      .onAudio?.bind(engine);
    onAudio?.((chunk) => ccRecorder.onPcm(chunk));
    engine.on((ev) => {
      if (ev.type === "audible") ccRecorder.onAudible(ev.channel?.id ?? null);
    });
  }

  /** Discovery id -> its frequency, the key clips are stored under. */
  function discoveryFreq(id: string): number | null {
    return (config.discoveries ?? []).find((d) => d.id === id)?.freq ?? null;
  }
```

- [ ] **Step 4: Add the three routes**

In `kiosk/src/backend/server.ts`, immediately before the `GET /api/stream.wav` block (line 1013):

```ts
    if (method === "GET" && path === "/api/discoveries/samples") {
      // Which triage rows have something to play. One readdir, so the admin can
      // fold this into its existing 15 s discoveries poll instead of probing
      // every row. Keyed by discovery id — the frequency keying is an
      // implementation detail of the store.
      if (!ccStore) return json(res, 200, {});
      const byFreq = new Map(ccStore.list().map((m) => [m.freqHz, m]));
      const out: Record<string, { bytes: number; seconds: number; ts: number }> = {};
      for (const d of config.discoveries ?? []) {
        const meta = byFreq.get(d.freq);
        if (meta) out[d.id] = { bytes: meta.bytes, seconds: meta.seconds, ts: meta.ts };
      }
      return json(res, 200, out);
    }

    const sampleGet = /^\/api\/discoveries\/([^/]+)\/sample\.wav$/.exec(path);
    if (method === "GET" && sampleGet?.[1]) {
      const freq = ccStore ? discoveryFreq(decodeURIComponent(sampleGet[1])) : null;
      const meta = freq !== null ? ccStore!.meta(freq) : null;
      if (freq === null || !meta) return json(res, 404, { error: "no sample" });
      res.writeHead(200, {
        "Content-Type": "audio/wav",
        "Content-Length": String(meta.bytes),
        // A clip is overwritten by the frequency's next hit, so it must never
        // be cached under a URL that outlives it.
        "Cache-Control": "no-store",
      });
      createReadStream(ccStore!.pathFor(freq)).pipe(res);
      return;
    }

    const sampleDel = /^\/api\/discoveries\/([^/]+)\/sample$/.exec(path);
    if (method === "DELETE" && sampleDel?.[1]) {
      const freq = ccStore ? discoveryFreq(decodeURIComponent(sampleDel[1])) : null;
      if (freq === null || !ccStore.delete(freq)) return json(res, 404, { error: "no sample" });
      return json(res, 200, { ok: true });
    }
```

Add `import { createReadStream } from "node:fs";` to the top of `server.ts` if it is not already imported.

- [ ] **Step 5: Delete clips when a discovery is triaged away**

In `kiosk/src/backend/server.ts`, in the `PUT /api/config` handler, immediately after `saveConfig(config);` (line 767):

```ts
      // Triage cleanup (#222): a discovery that left the list has been added,
      // dismissed, or locked out — its clip has done its job. Done here rather
      // than in each admin action so every path (row buttons, drawer, bulk
      // select) is covered by one rule that cannot drift.
      if (ccStore) {
        const stillFiled = new Set((config.discoveries ?? []).map((d) => d.freq));
        for (const d of prev.discoveries ?? []) {
          if (!stillFiled.has(d.freq)) ccStore.delete(d.freq);
        }
      }
```

- [ ] **Step 6: Pass the directory from index.ts**

In `kiosk/src/backend/index.ts`, add to the `createServer({ ... })` call:

```ts
  ccSampleDir: join(dirname(CONFIG_PATH), "cc-samples"),
```

`join` and `dirname` are already imported there (`history.db` is built the same way).

- [ ] **Step 7: Run the tests to verify they pass**

```sh
cd kiosk && npx vitest run test/api.test.ts
```

Expected: PASS — all 7 new tests plus every pre-existing API test.

- [ ] **Step 8: Full suite, typecheck, build**

```sh
cd kiosk && npm test && npx tsc -p tsconfig.json --noEmit && npm run build
```

Expected: all PASS, typecheck clean, build succeeds.

- [ ] **Step 9: Commit**

```sh
cd /home/kiosk/kerchunk-kiosk
git add kiosk/src/backend/server.ts kiosk/src/backend/index.ts kiosk/test/api.test.ts
git commit -m "feat(cc-samples): wire the recorder, sample routes, and triage cleanup

Cleanup hangs off the config PUT diff rather than each admin action, so
row buttons, drawer, and bulk select are covered by one rule."
```

---

### Task 6: Backend proof on hardware

The clip path is complete. Prove it against the real radio before building UI on top of it — a bug here is much cheaper to find now than through a player.

**Files:** none modified. This task is verification.

**Interfaces:**
- Consumes: everything from Tasks 1-5.
- Produces: a known-good clip on the appliance, and a recorded answer for whether recording disturbs live audio.

- [ ] **Step 1: Deploy the backend**

```sh
cd /home/kiosk/kerchunk-kiosk/kiosk && npm run build && sudo systemctl restart kerchunk-kiosk
```

This restart is expected and unavoidable — a backend change. Note the box temperature before and after (`curl -s localhost:8080/api/system`) so the next step has a baseline.

- [ ] **Step 2: Turn recording on**

```sh
cd /home/kiosk/kerchunk-kiosk
curl -s localhost:8080/api/config > /tmp/claude-1000/cfg.json
python3 -c "
import json
c = json.load(open('/tmp/claude-1000/cfg.json'))
c['scan']['recordCloseCalls'] = True
json.dump(c, open('/tmp/claude-1000/cfg.json','w'))
"
curl -s -X PUT localhost:8080/api/config -H 'content-type: application/json' \
  --data @/tmp/claude-1000/cfg.json > /dev/null
```

Expected: one engine restart (the knob is in the scan diff), then a normal warm-up. Confirm the helper got the tee:

```sh
pgrep -af wideband_helper.py | grep -c -- --audio-fd
```

Expected: `1`.

- [ ] **Step 3: Wait for a real Close Call hit and confirm a clip appears**

```sh
ls -la /var/lib/kerchunk-kiosk/cc-samples/
```

Expected: at least one `<freqHz>.wav` within a few minutes of scanning. If the band is quiet, be patient rather than forcing one — the point is to prove the real trigger path. Confirm the file is a valid WAV and has plausible length:

```sh
python3 -c "
import wave, sys, glob
for p in sorted(glob.glob('/var/lib/kerchunk-kiosk/cc-samples/*.wav')):
    w = wave.open(p)
    print(p, w.getframerate(), 'Hz', w.getnchannels(), 'ch',
          round(w.getnframes()/w.getframerate(), 2), 's')
"
```

Expected: `8000 Hz 1 ch`, duration between ~0.35 s and the configured cap.

- [ ] **Step 4: Listen to it**

```sh
aplay /var/lib/kerchunk-kiosk/cc-samples/<freq>.wav
```

STOP and report to the operator rather than continuing if any of these are true — each is a real defect, not a tuning nit:

- the clip contains a different channel's traffic (the `audible` gating is wrong)
- the clip starts mid-syllable (the pre-roll is not being prepended)
- the clip is silence (the tee is not reaching the recorder)

Note that `aplay` here contends for the exclusive ALSA sink the scanner owns; if it refuses, copy the file off the box and listen there instead of stopping the scanner.

- [ ] **Step 5: Confirm the radio is unharmed**

Ask the operator to confirm by ear that live audio is unchanged — no chop, no dropouts — and compare `curl -s localhost:8080/api/system` temperature against the Step 1 baseline. Report the actual numbers, not an impression. A steady-state rise of more than ~2 °C is worth flagging before going further.

- [ ] **Step 6: Report honestly**

Write down what actually happened: whether a clip appeared, its duration, what it sounded like, the temperature delta. If something failed, say so plainly and stop here rather than building UI on an unproven backend.

---

### Task 7: Admin — Play button on the triage row

Puts the clip one click from the frequency it belongs to. Follows the existing `iconBtn` pattern, so this needs no new visual design.

**Files:**
- Modify: `kiosk/src/frontend/lib/api.ts`
- Modify: `kiosk/src/frontend/admin/admin.ts` (the `renderDiscoveries` row template around line 1814-1821, the action wiring around line 1844, and the poll)
- Modify: `kiosk/src/frontend/admin/admin.css`

**Interfaces:**
- Consumes: `GET /api/discoveries/samples`, `GET /api/discoveries/:id/sample.wav` (Task 5).
- Produces:
  - `api.getDiscoverySamples(): Promise<Record<string, { bytes: number; seconds: number; ts: number }>>`
  - `api.deleteDiscoverySample(id: string): Promise<Response>`
  - Module-level `let dcSamples: Record<string, { bytes: number; seconds: number; ts: number }> = {}` in admin.ts, refreshed by `renderDiscoveries`. Task 8 reads it.
  - `function playSample(id: string, button: HTMLButtonElement): void` — shared by row and drawer.

- [ ] **Step 1: Add the API methods**

In `kiosk/src/frontend/lib/api.ts`, inside the exported `api` object (next to `monitor`):

```ts
  getDiscoverySamples: () =>
    fetch("/api/discoveries/samples")
      .then(j<Record<string, { bytes: number; seconds: number; ts: number }>>),
  deleteDiscoverySample: (id: string) =>
    fetch(`/api/discoveries/${encodeURIComponent(id)}/sample`, { method: "DELETE" }),
```

- [ ] **Step 2: Add the shared playback helper**

In `kiosk/src/frontend/admin/admin.ts`, near the other module-level admin helpers, add:

```ts
/** Clip metadata by discovery id, refreshed with the discoveries poll. Empty
 *  when recording is off or nothing has been captured yet. */
let dcSamples: Record<string, { bytes: number; seconds: number; ts: number }> = {};

/** At most one clip plays at a time — two Close Calls talking over each other
 *  is exactly the confusion this feature exists to remove. */
let nowPlaying: { audio: HTMLAudioElement; button: HTMLButtonElement } | null = null;

function stopSample(): void {
  if (!nowPlaying) return;
  nowPlaying.audio.pause();
  nowPlaying.button.innerHTML = ICONS.play!;
  nowPlaying.button.title = "Play the recorded sample";
  nowPlaying = null;
}

function playSample(id: string, button: HTMLButtonElement): void {
  const wasThis = nowPlaying?.button === button;
  stopSample();
  if (wasThis) return; // second click on the same button = stop
  // Cache-bust: a frequency's clip is overwritten by its next hit, and the URL
  // does not change when it is.
  const audio = new Audio(
    `/api/discoveries/${encodeURIComponent(id)}/sample.wav?t=${dcSamples[id]?.ts ?? 0}`);
  audio.addEventListener("ended", stopSample);
  audio.addEventListener("error", stopSample);
  button.innerHTML = ICONS.stop!;
  button.title = "Stop";
  nowPlaying = { audio, button };
  void audio.play().catch(stopSample);
}
```

- [ ] **Step 3: Fetch clip metadata with the discoveries poll**

In `renderDiscoveries`, after `const cfg = await api.getConfig();`:

```ts
    // Best-effort: a failure here must leave the triage table fully usable,
    // just without Play buttons.
    dcSamples = await api.getDiscoverySamples().catch(() => ({}));
```

- [ ] **Step 4: Add the button to the row**

In the row template's `<td class="actions">`, put the Play button first in the cluster (it is the thing you reach for before deciding), and render it only when there is a clip:

```ts
          <td class="actions">${dcSamples[d.id]
            ? iconBtn("dPlay", "play", `Play the recorded sample (${dcSamples[d.id]!.seconds.toFixed(1)}s)`)
            : ""}${iconBtn("dListen", "listen", "Listen — audition this discovery")}${iconBtn("dAdd", "add", "Add as an enabled channel")}${iconBtn("dLock", "lockout", "Lock out — never Close-Call this frequency again")}${iconBtn("dDismiss", "dismiss", "Dismiss (may be rediscovered later)")}</td>
```

The button is omitted rather than disabled: a disabled control in every row of a mostly-empty table is noise, and the operator already knows what an absent sample means.

- [ ] **Step 5: Wire the click**

In the action-wiring loop (alongside the `dListen` / `dAdd` / `dLock` / `dDismiss` handlers around line 1844):

```ts
      if (b.classList.contains("dPlay")) b.addEventListener("click", () => playSample(id, b));
```

- [ ] **Step 6: Stop playback when the table re-renders**

At the top of `renderDiscoveries`, before `dcRows.innerHTML` is replaced, add `stopSample();` — the button element the audio is bound to is about to be destroyed, and an orphaned `<audio>` would keep playing with no way to stop it.

- [ ] **Step 7: Style the button state**

In `kiosk/src/frontend/admin/admin.css`, next to the other `.iconBtn` rules:

```css
/* Playing state: the amber the admin reserves for live radio state, because a
   clip playing IS audio coming out of the box right now. */
.dPlay[title^="Stop"] { color: var(--live); }
```

Check the actual variable name for the admin's amber "live" token in `admin.css` and use that name — do not introduce a new color.

- [ ] **Step 8: Build and typecheck**

```sh
cd kiosk && npx tsc -p tsconfig.json --noEmit && npm run build
```

Expected: clean, build succeeds. `vite`/`esbuild` does NOT typecheck — the explicit `tsc` run is what catches a mistake here, and a type error shipped to the frontend has silently killed the kiosk map before.

- [ ] **Step 9: Verify in a real browser**

The admin is a DOM page, so a headless screenshot works — write the PNG inside `$HOME`, not the scratchpad:

```sh
cd /home/kiosk/kerchunk-kiosk/kiosk && npm run build \
  && curl -s -X POST localhost:8080/api/kiosk/reload > /dev/null
```

Then open `http://kiosk:8080/admin#/triage` from the operator's machine and confirm: rows with a clip show a Play button, clicking plays audio, the icon flips to stop, clicking again stops it, and starting a second clip stops the first.

- [ ] **Step 10: Commit**

```sh
cd /home/kiosk/kerchunk-kiosk
git add kiosk/src/frontend/lib/api.ts kiosk/src/frontend/admin/admin.ts kiosk/src/frontend/admin/admin.css
git commit -m "feat(admin): play a discovery's recorded sample from the triage row"
```

---

### Task 8: Admin — the drawer player block

A new block in the discovery drawer: play/stop, duration, when it was recorded, and Delete sample. Unlike Task 7 this is not an addition to an existing pattern, so it goes through the design skill.

**Files:**
- Modify: `kiosk/src/frontend/admin/admin.ts` (`renderDiscoveryDrawer`, around lines 1528-1590)
- Modify: `kiosk/src/frontend/admin/admin.css`

**Interfaces:**
- Consumes: `dcSamples`, `playSample`, `stopSample` (Task 7); `api.deleteDiscoverySample` (Task 7).
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Invoke the design skill**

Per the repo's "designed, not rearranged" rule, run `frontend-design` (or `ui-ux-pro-max`) for this block before writing markup. Constraints to give it:

- The admin's committed direction is the "Night Watch" contract recorded at the top of `admin.ts` and in `DESIGN.md`: flat slate plates, hairline rules, tracked micro legends, tabular data, amber spent on live state only.
- No new palette, no new concept layer, no new icon vocabulary — `play`, `stop`, and `del` already exist in `ICONS`.
- The block sits in the drawer between the `dwInfo` definition list and the `locationEditor` section: you hear the frequency before you decide to name it.
- It must have an explicit empty state — most discoveries will have no clip, and "no sample recorded yet" is information, not a gap.

- [ ] **Step 2: Render the block**

In `renderDiscoveryDrawer`, insert between the closing `</dl>` of `dwInfo` and `<section class="locationEditor">`:

```ts
      <section class="dwSample">
        <h4>Recorded sample</h4>
        ${dcSamples[d.id] ? `
          <div class="dwSampleRow">
            ${iconBtn("dwPlay", "play", "Play the recorded sample")}
            <span class="dwSampleMeta">
              <b>${dcSamples[d.id]!.seconds.toFixed(1)}s</b>
              <small>recorded ${new Date(dcSamples[d.id]!.ts).toLocaleString()}</small>
            </span>
            ${iconBtn("dwSampleDel", "del", "Delete this sample")}
          </div>`
          : `<p class="dwSampleEmpty">No sample recorded yet.</p>`}
      </section>
```

Apply whatever structural refinements the design skill produced in Step 1 — the markup above is the content contract (play control, duration, recorded-at, delete, empty state), not a final visual design.

- [ ] **Step 3: Wire the buttons**

After the existing `#dwListen` handler in `renderDiscoveryDrawer`:

```ts
    drawer.querySelector<HTMLButtonElement>(".dwPlay")
      ?.addEventListener("click", (e) => playSample(d.id, e.currentTarget as HTMLButtonElement));
    drawer.querySelector<HTMLButtonElement>(".dwSampleDel")?.addEventListener("click", async () => {
      stopSample();
      await api.deleteDiscoverySample(d.id);
      await renderDiscoveries();
    });
```

- [ ] **Step 4: Stop playback when the drawer closes**

Find `closeDrawer` and add `stopSample();` as its first statement — same reasoning as the table re-render: the button the audio is bound to is going away.

- [ ] **Step 5: Style the block**

Add the styles the design skill specified to `kiosk/src/frontend/admin/admin.css`, scoped under `.dwSample`. Reuse existing spacing, rule, and type tokens — do not introduce new ones.

- [ ] **Step 6: Build and typecheck**

```sh
cd kiosk && npx tsc -p tsconfig.json --noEmit && npm run build
```

Expected: clean, build succeeds.

- [ ] **Step 7: Verify in a real browser**

Open `http://kiosk:8080/admin#/triage`, open a discovery with a clip, and confirm: the block renders, play/stop works, Delete sample removes the clip and the block falls back to its empty state, and closing the drawer mid-playback stops the audio. Screenshot it for the operator.

- [ ] **Step 8: Commit**

```sh
cd /home/kiosk/kerchunk-kiosk
git add kiosk/src/frontend/admin/admin.ts kiosk/src/frontend/admin/admin.css
git commit -m "feat(admin): sample player block in the discovery drawer"
```

---

### Task 9: Documentation, end-to-end proof, and the PR

**Files:**
- Modify: `docs/API.md`
- Modify: `docs/ROADMAP.md`

**Interfaces:**
- Consumes: everything.
- Produces: a merged PR closing #222.

- [ ] **Step 1: Document the routes**

Add to `docs/API.md`, in the same style as the surrounding route entries:

```markdown
### `GET /api/discoveries/samples`

Close Call clips available for playback, keyed by discovery id:

    { "cc_1a2b3c4d": { "bytes": 320044, "seconds": 20.0, "ts": 1754250000000 } }

Empty when `scan.recordCloseCalls` is off or nothing has been captured. One
filesystem listing — cheap enough to ride the admin's 15 s discoveries poll.

### `GET /api/discoveries/:id/sample.wav`

The clip for that discovery: 8 kHz mono 16-bit WAV, `Cache-Control: no-store`
(the frequency's next hit overwrites it). `404` when there is no clip.

### `DELETE /api/discoveries/:id/sample`

Deletes the clip. `200 {"ok":true}`, or `404` when there was none. Clips are
also deleted automatically when the discovery leaves the list (added,
dismissed, or locked out).
```

- [ ] **Step 2: Note the knobs**

Add a line to the Close Call section of `docs/ROADMAP.md` recording that #222 shipped, and where the knobs live: `scan.recordCloseCalls`, `scan.closeCallSampleSeconds` (20), `scan.closeCallSampleMaxMb` (50), plus `PREROLL_SECONDS` at the top of `kiosk/src/backend/ccRecorder.ts`.

- [ ] **Step 3: Run every gate**

```sh
cd /home/kiosk/kerchunk-kiosk/kiosk
npm test && npx tsc -p tsconfig.json --noEmit && npm run build
```

Expected: all PASS. `npm run test:py` is NOT required — no DSP math changed.

- [ ] **Step 4: Full end-to-end proof on the appliance**

```sh
cd /home/kiosk/kerchunk-kiosk/kiosk && npm run build && sudo systemctl restart kerchunk-kiosk
```

Then, with the operator: wait for a Close Call hit, open the triage table, play the clip from the row, open the drawer and play it there, delete it, and confirm that adding/dismissing another discovery removes its clip from `/var/lib/kerchunk-kiosk/cc-samples/`. Confirm live audio is unaffected. Report what actually happened, including anything skipped.

- [ ] **Step 5: Push and open the PR**

```sh
cd /home/kiosk/kerchunk-kiosk
git push -u origin feat/close-call-samples
gh pr create --title "feat: record close call hits for triage by ear (#222)" --body "$(cat <<'EOF'
Closes #222.

A Close Call hit was the only moment that carried information, and it was
gone by the time the operator opened triage — Listen just retunes the live
radio at a frequency that is usually quiet.

Now each hit leaves a short clip, played from the discovery row or drawer,
deleted when the row is triaged.

- Gated on the engine's `audible` event, not the `closecall` detection event:
  the helper tee is the speaker MIX, so only audible ownership proves the
  bytes arriving now are the Close Call rather than a neighbour's traffic.
- 2 s pre-roll ring so a clip doesn't lose the first syllable.
- Clips are keyed by frequency, not discovery id — hit 1 is recorded before
  the row exists (filing needs 2 hits).
- Cleanup hangs off the config PUT diff, so row buttons, drawer, and bulk
  select are covered by one rule.
- Knobs: `scan.recordCloseCalls` (off), `scan.closeCallSampleSeconds` (20),
  `scan.closeCallSampleMaxMb` (50); `PREROLL_SECONDS` in `ccRecorder.ts`.

Turning `recordCloseCalls` on is a one-time engine restart — it changes a
helper spawn arg (the fd-3 PCM tee, shared with remote listening).

Spec: `docs/superpowers/specs/2026-08-03-close-call-audio-samples-design.md`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 6: Merge and clean up**

```sh
gh pr merge <n> --merge --delete-branch
git checkout main && git pull --ff-only && git fetch --prune
git branch -d feat/close-call-samples
```

The repo-local PostToolUse hook may delete the local branch first — that is the hook working, not data loss.

---

## Self-Review

**Spec coverage** — every section maps to a task:

| Spec section | Task |
|---|---|
| Trigger (`audible` gating, `cc_<freqHz>`) | 4 |
| Pre-roll (2 s ring, raw 48 k) | 2, 4 |
| Write (decimate, WAV, path) | 2, 3, 4 |
| Frequency-keyed filenames | 3 |
| Guards (channel / lockout / disabled) | 4 (mechanism), 5 (config-backed predicates) |
| Config knobs (3 fields, defaults) | 1 |
| Engine plumbing (`ScanConfig`, `helperArgs`, `toScanConfig`) | 1 |
| Three API routes | 5 |
| Cleanup on triage (PUT diff) | 5 |
| Manual delete | 5 (route), 8 (button) |
| Sweep (orphans + size cap) | 3 (mechanism), 4 (invocation) |
| Suppressed discoveries keep clips | 5 — `knownFreqs` reads all of `config.discoveries`, which includes suppressed rows, so they are never orphans |
| Admin row Play button | 7 |
| Admin drawer player | 8 |
| Unit tests | 2, 3, 4 |
| Integration tests | 5 |
| Hardware proof | 6, 9 |
| `docs/API.md` | 9 |

**Type consistency** — checked across tasks: `CcSampleStore` methods (`pathFor`, `write`, `meta`, `list`, `delete`, `sweep`) are used with the same names and signatures in Tasks 3, 4, and 5. `CcRecorder`'s `onPcm` / `onAudible` / `flush` match between Task 4's definition and Task 5's wiring. `sweep`'s option object (`knownFreqs`, `maxBytes`, `nowMs`) is identical in Tasks 3 and 4. `dcSamples` entry shape (`bytes`, `seconds`, `ts`) is identical across the route in Task 5, the api method in Task 7, and both consumers in Tasks 7 and 8. `ICONS.play` / `ICONS.stop` / `ICONS.del` all exist in `admin.ts` today — verified, no new icon imports needed.

**Known deviation to flag at execution time:** Task 1's `WidebandEngine` test reaches into a private method. If the existing tests in that file already have a cleaner seam for asserting spawn args, use theirs instead — the assertion (`--audio-fd` present when only `recordCloseCalls` is set) is what matters, not the access route.
