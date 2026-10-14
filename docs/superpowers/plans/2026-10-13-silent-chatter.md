# Silent Chatter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Only air/rail/marine/ham/GMRS (and weather) reach the speaker. All other traffic takes no scan time but still shows on the glass map. Unlocated silent traffic gets a stable invented metro spot and colour. Every live transmission throws sparks.

**Architecture:** A shared family classifier (`config/family.ts`) feeds a runtime audibility gate in `toScanConfig` and an exact audible-range partition (`ccAudibleHz`) that the C++ helper uses to silence Close Call lanes. `WidebandEngine` drops visual hold, never lets silent traffic hold or re-arm dwell, emits `release` on every hop, and meters scan coverage for `/api/system`. On the frontend, a pure `scatter.ts` places silent unlocated hits, and `glassState` gains an event-paced live-spark tick that the FX shader draws.

**Tech Stack:** TypeScript (Node ≥24 ESM, `.js` import extensions, `strict` + `noUncheckedIndexedAccess`), vitest, zod, C++17 helper (cmake, `native/test` CHECK/TEST macros), WebGL2 GLSL ES 3.00.

**Spec:** `docs/superpowers/specs/2026-10-13-silent-chatter-design.md`

## Global Constraints

- All commands run from `kiosk/`. Relative imports carry `.js`.
- `audio.audibleFamilies` default `["air","rail","marine","ham","gmrs"]`. `"weather"` is never a member and is always audible.
- The family gate applies in `scan` mode only. `weather` and `monitor` modes are untouched.
- `ccAudibleHz` absent = today's behaviour (every Close Call hit audible). Present (even `[]`) = CC hits outside every range are silent.
- `/api/status`, `/api/logs`, `/api/weather` shapes must not change (external consumer). New telemetry goes on `/api/system`.
- `display.glass.liveSparkStepMs` default 750, 0 = off, else 250–6000. `display.glass.scatter` = `{ enabled: true, marginPx: 80 }`.
- `scan.visualHold` stays parseable (optional, ignored, marked deprecated).
- No `backdrop-filter`, no new full-screen overlay, no standing animation. A quiet band must still produce zero glass redraws.
- Boot goes through `toScanConfig`. SAME break-in stays a `retune()`. The `breakIn` guard stays.
- Definition of done (CLAUDE.md): `npm test`, `npm run test:native`, `npm run typecheck`, `npm run build` all pass; proven on hardware; knobs stated; PR from branch `feat/silent-chatter`.
- Engine work: stop `kerchunk-kiosk` while iterating on engine code; start it only for proof (memory: engine-work-take-kiosk-down).

## Review Focus

1. **Alert pull-in on a silent channel.** An `alerts` match on a business-band channel must still break into the speaker. `server.ts:403` uses `isAudible` to decide whether to `alertUnmute`, so it must see the family gate (Task 2 test).
2. **Operator tag overrides the band.** A 462 MHz "biz/PS" channel tagged `ham` (or `public-safety` with `publicsafety` added to the list) must be audible, both as a scan channel and on the map (Task 2 test).
3. **Unallocated frequencies.** 225–420 MHz, paging and anything outside the table classify as `unknown`, so they are silent and scatter. Their Close Call hits must be silent in the helper too (Task 3 boundary test).
4. **Monitor / weather modes.** An operator's direct tune to a business frequency must still play (Task 2 test).
5. **Hop while a silent lane is open, then the helper's late `close`.** The map must not double-release, and the engine must not re-arm dwell from the stale close (Task 5 test).

---

### Task 0: Scan-coverage meter + baseline capture

The before/after proof needs a readout that exists *before* behaviour changes. Ship the meter first and capture a baseline with visual hold still active.

**Files:**
- Create: `src/backend/engine/coverage.ts`
- Modify: `src/backend/engine/ScannerEngine.ts` (optional `scanCoverage()` on the interface)
- Modify: `src/backend/engine/WidebandEngine.ts` (record time in the dwell tick)
- Modify: `src/backend/server.ts:1139-1155` (`/api/system` adds `scanCoverage`)
- Modify: `../docs/API.md` (`/api/system` section)
- Test: `test/coverage.test.ts`, `test/api.test.ts`

**Interfaces:**
- Produces: `type CoverageKind = "audible" | "silent" | "quiet" | "sweep"`; `class CoverageMeter { constructor(windowMs = 600_000, bucketMs = 60_000); record(kind: CoverageKind, ms: number, now: number): void; fractions(now: number): Record<CoverageKind, number> & { windowMs: number } }`; `ScannerEngine.scanCoverage?(): ReturnType<CoverageMeter["fractions"]>`.

- [ ] **Step 1: Write the failing test**

```ts
// test/coverage.test.ts
import { describe, it, expect } from "vitest";
import { CoverageMeter } from "../src/backend/engine/coverage.js";

describe("CoverageMeter", () => {
  it("reports fractions of recorded time per kind", () => {
    const m = new CoverageMeter(600_000, 60_000);
    m.record("audible", 3000, 1000);
    m.record("quiet", 1000, 2000);
    const f = m.fractions(2000);
    expect(f.audible).toBeCloseTo(0.75);
    expect(f.quiet).toBeCloseTo(0.25);
    expect(f.silent).toBe(0);
    expect(f.sweep).toBe(0);
    expect(f.windowMs).toBe(600_000);
  });
  it("forgets buckets older than the window", () => {
    const m = new CoverageMeter(600_000, 60_000);
    m.record("silent", 5000, 0);
    m.record("quiet", 1000, 700_000);
    const f = m.fractions(700_000);
    expect(f.silent).toBe(0);
    expect(f.quiet).toBe(1);
  });
  it("all zeros with nothing recorded", () => {
    const f = new CoverageMeter().fractions(0);
    expect([f.audible, f.silent, f.quiet, f.sweep]).toEqual([0, 0, 0, 0]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/coverage.test.ts`
Expected: FAIL, cannot resolve `coverage.js`.

- [ ] **Step 3: Implement**

```ts
// src/backend/engine/coverage.ts
// Rolling scan-coverage meter (spec 2026-10-13 silent chatter): where the
// scanner's wall time goes — holding for audible opens, holding for silent
// ones (visual hold, until it is retired), quiet dwell, sweep stops. Fixed
// one-minute buckets over a ten-minute window: O(1) record, no per-tick alloc.
export type CoverageKind = "audible" | "silent" | "quiet" | "sweep";
const KINDS: readonly CoverageKind[] = ["audible", "silent", "quiet", "sweep"];

interface Bucket { start: number; ms: Record<CoverageKind, number> }

export class CoverageMeter {
  private readonly buckets: Bucket[] = [];
  constructor(private readonly windowMs = 600_000, private readonly bucketMs = 60_000) {}

  record(kind: CoverageKind, ms: number, now: number): void {
    if (!(ms > 0)) return;
    const start = Math.floor(now / this.bucketMs) * this.bucketMs;
    let b = this.buckets[this.buckets.length - 1];
    if (!b || b.start !== start) {
      b = { start, ms: { audible: 0, silent: 0, quiet: 0, sweep: 0 } };
      this.buckets.push(b);
    }
    b.ms[kind] += ms;
    this.prune(now);
  }

  fractions(now: number): Record<CoverageKind, number> & { windowMs: number } {
    this.prune(now);
    const sum: Record<CoverageKind, number> = { audible: 0, silent: 0, quiet: 0, sweep: 0 };
    for (const b of this.buckets) for (const k of KINDS) sum[k] += b.ms[k];
    const total = KINDS.reduce((t, k) => t + sum[k], 0);
    const out = { windowMs: this.windowMs } as Record<CoverageKind, number> & { windowMs: number };
    for (const k of KINDS) out[k] = total > 0 ? sum[k] / total : 0;
    return out;
  }

  private prune(now: number): void {
    const cutoff = now - this.windowMs;
    while (this.buckets.length && this.buckets[0]!.start + this.bucketMs <= cutoff) this.buckets.shift();
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/coverage.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Wire into the engine.** In `ScannerEngine.ts`, add to the interface after `updateScheduling?`:

```ts
import type { CoverageKind } from "./coverage.js";   // top of file
// …
  /** Rolling scan-coverage fractions (spec 2026-10-13); engines without a
   *  hop loop omit it. */
  scanCoverage?(): Record<CoverageKind, number> & { windowMs: number };
```

In `WidebandEngine.ts`, add a field `private readonly coverage = new CoverageMeter();` (import from `./coverage.js`) and a public method:

```ts
  scanCoverage(): Record<CoverageKind, number> & { windowMs: number } {
    return this.coverage.fractions(this.now());
  }
```

In `startDwellTimer`'s interval, right after `this.lastTickAt = tickAt;`, classify the elapsed tick **before** the hold logic runs:

```ts
      this.coverage.record(
        this.sweeping ? "sweep"
          : this.hasAudibleOpen() ? "audible"
          : this.hasVisualOpen() ? "silent"
          : "quiet",
        deltaMs, tickAt);
```

(`hasVisualOpen` is removed in Task 5. That task replaces this expression with the version shown there.)

- [ ] **Step 6: `/api/system`.** In `server.ts`, change the return to:

```ts
      return json(res, 200, { ...snap, safetyMode, health, coreCount: os.cpus().length, scanCoverage: engine.scanCoverage?.() ?? null });
```

Add an api test in the `/api/system` describe (find it with `grep -n "/api/system" test/api.test.ts`) using the existing `makeApp()`:

```ts
  it("GET /api/system carries scanCoverage (null for engines without a hop loop)", async () => {
    const { server } = makeApp();
    const res = await request(server).get("/api/system");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("scanCoverage");
  });
```

- [ ] **Step 7: Docs.** In `../docs/API.md` under `GET /api/system`, add:

```md
- `scanCoverage` — `{ audible, silent, quiet, sweep, windowMs }` or `null`.
  Fractions (0–1) of the scanner's wall time over the last `windowMs`
  (10 min): holding for an audible open, holding for a silent one, plain
  quiet dwell, sweep stops. Wideband engine only.
```

- [ ] **Step 8: Verify and commit**

Run: `npm test && npm run typecheck`
Expected: all pass.

```bash
git add src/backend/engine/coverage.ts src/backend/engine/ScannerEngine.ts src/backend/engine/WidebandEngine.ts src/backend/server.ts test/coverage.test.ts test/api.test.ts ../docs/API.md
git commit -m "feat(engine): scan-coverage meter on /api/system"
```

- [ ] **Step 9: Baseline capture (on hardware).**

```bash
npm run build && sudo systemctl restart kerchunk-kiosk
sleep 900   # let the 10 min window fill — or use Monitor/until-loop rather than foreground sleep
for i in 1 2 3; do curl -s localhost:8080/api/system | python3 -c 'import sys,json;print(json.load(sys.stdin)["scanCoverage"])'; sleep 600; done | tee /tmp/claude-1000/coverage-baseline.txt
```

Also record audible key-ups for the same window from history (rows whose family is in the audible set):

```bash
sqlite3 ~/.local/share/kerchunk/history.db "select count(*) from events where kind='active' and ts > (strftime('%s','now')-1800)*1000;"
```

(Confirm the history DB path from `KERCHUNK_CONFIG` / `src/backend/index.ts` first. If the table name differs, read `src/backend/history.ts`'s CREATE TABLE.) Keep the numbers for the PR.

---

### Task 1: Shared family classifier

**Files:**
- Create: `src/backend/config/family.ts`
- Modify: `src/frontend/lib/serviceColor.ts` (remove the moved code, re-export)
- Test: `test/family.test.ts` (new); `test/serviceColor.test.ts` must still pass unchanged

**Interfaces:**
- Produces: `export type Family = "air" | "rail" | "ham" | "gmrs" | "biz" | "marine" | "weather" | "publicsafety" | "unknown";` `export function familyFor(freqHz: number | undefined, tags?: readonly string[]): Family;` `export function familyForService(svc: string | undefined): Family;` `serviceColor.ts` keeps exporting `PinCategory` (= `Family`) and `categoryFor` (= `familyFor`), so existing callers are untouched.

- [ ] **Step 1: Write the failing test**

```ts
// test/family.test.ts
import { describe, it, expect } from "vitest";
import { familyFor } from "../src/backend/config/family.js";
import { categoryFor } from "../src/frontend/lib/serviceColor.js";

describe("familyFor (shared backend/frontend classifier)", () => {
  it("classifies by allocation", () => {
    expect(familyFor(127_250_000)).toBe("air");
    expect(familyFor(146_790_000)).toBe("ham");
    expect(familyFor(160_920_000)).toBe("rail");
    expect(familyFor(156_800_000)).toBe("marine");
    expect(familyFor(162_550_000)).toBe("weather");
    expect(familyFor(462_612_500)).toBe("gmrs");
    expect(familyFor(463_562_500)).toBe("biz");
    expect(familyFor(851_012_500)).toBe("publicsafety");
    expect(familyFor(300_000_000)).toBe("unknown");   // unallocated gap
    expect(familyFor(930_000_000)).toBe("unknown");   // paging
    expect(familyFor(undefined)).toBe("unknown");
  });
  it("operator tags win over the frequency", () => {
    expect(familyFor(463_562_500, ["ham"])).toBe("ham");
    expect(familyFor(463_562_500, ["liberty", "public-safety"])).toBe("publicsafety");
  });
  it("serviceColor.categoryFor is the same function", () => {
    expect(categoryFor).toBe(familyFor);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/family.test.ts`
Expected: FAIL, cannot resolve `family.js`.

- [ ] **Step 3: Create `src/backend/config/family.ts`.** Move `TAG_CATEGORY`, `categoryForService` and `categoryFor` verbatim from `serviceColor.ts` (lines ~38–77), renaming them:

```ts
import { serviceFor } from "./banks.js";

// Service FAMILY of a frequency (spec 2026-10-13 silent chatter): one
// classifier for the map's colours AND the speaker gate. Operator SERVICE
// tags (bank labels) win over the frequency guess. Some services aren't
// separable from business by frequency alone — public safety on conventional
// UHF (462–470) reads as "biz/PS" by allocation — so the operator's tag
// decides. Tags this module doesn't recognize are ignored.
export type Family =
  "air" | "rail" | "ham" | "gmrs" | "biz" | "marine" | "weather" | "publicsafety" | "unknown";

const TAG_FAMILY: Record<string, Family> = {
  "public-safety": "publicsafety",
  air: "air", rail: "rail", ham: "ham", gmrs: "gmrs",
  business: "biz", marine: "marine",
};

export function familyForService(svc: string | undefined): Family {
  if (svc === "air") return "air";
  if (svc === "rail") return "rail";
  if (svc?.startsWith("ham")) return "ham";
  if (svc === "GMRS/FRS") return "gmrs";
  if (svc === "marine") return "marine";
  if (svc === "NOAA wx") return "weather";
  // Public safety gets its own red: the dedicated 700 MHz PS band and 800 MHz
  // trunked systems (the metro's primary PS presence). The mixed conventional
  // "biz/PS" bands and T-band stay biz — not separable from business by freq.
  if (svc === "700 PS" || svc?.includes("trunked")) return "publicsafety";
  if (svc && (svc.includes("biz") || svc === "T-band")) return "biz";
  return "unknown";
}

/** Family for a site: an operator service tag wins, else the frequency's
 *  service allocation. A heard-only site or transient hit with no channel
 *  has no tags and falls back to frequency. */
export function familyFor(freqHz: number | undefined, tags?: readonly string[]): Family {
  if (tags) {
    for (const t of tags) {
      const f = TAG_FAMILY[t];
      if (f) return f;
    }
  }
  return freqHz === undefined ? "unknown" : familyForService(serviceFor(freqHz));
}
```

In `serviceColor.ts`: delete the moved block and the now-unused `serviceFor` import, then add:

```ts
import { familyFor, type Family } from "../../backend/config/family.js";

export type PinCategory = Family;
/** Pin/colour category — the shared family classifier (config/family.ts). */
export const categoryFor = familyFor;
```

Keep `colorFor` and everything else unchanged. It already calls `categoryFor`.

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/family.test.ts test/serviceColor.test.ts test/pins.palette.test.ts test/siteColor.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck`
Expected: clean.

```bash
git add src/backend/config/family.ts src/frontend/lib/serviceColor.ts test/family.test.ts
git commit -m "refactor(family): one service-family classifier for backend and map"
```

---

### Task 2: Audible-family gate (`audio.audibleFamilies`)

**Files:**
- Modify: `src/backend/config/schema.ts` (`audio` object + `defaultConfig`)
- Modify: `src/backend/config/banks.ts:35-38` (`isAudible`)
- Modify: `src/backend/server.ts:80-104` (`toScanConfig`), `:403` (alert pull-in)
- Test: `test/banks.test.ts`, `test/api.test.ts`, `test/schema.test.ts`

**Interfaces:**
- Consumes: `familyFor`, `Family` (Task 1).
- Produces: `export const AUDIBLE_FAMILIES_DEFAULT: Family[]` (schema.ts); `isAudible(channel: Channel, banks: Bank[], audibleFamilies?: readonly Family[]): boolean`. `audibleFamilies` undefined = legacy rule (per-channel flag only).

- [ ] **Step 1: Write the failing tests** (append to `test/banks.test.ts`):

```ts
describe("isAudible with audibleFamilies (spec 2026-10-13)", () => {
  const FAM = ["air", "rail", "marine", "ham", "gmrs"] as const;
  it("disallowed family is silent even when the channel says audible", () => {
    expect(isAudible(ch(463_562_500, { audible: true }), [], FAM)).toBe(false);   // biz
    expect(isAudible(ch(851_012_500), [], FAM)).toBe(false);                      // public safety
    expect(isAudible(ch(300_000_000), [], FAM)).toBe(false);                      // unknown
  });
  it("allowed family follows the channel's own flag", () => {
    expect(isAudible(ch(146_790_000), [], FAM)).toBe(true);
    expect(isAudible(ch(146_790_000, { audible: false }), [], FAM)).toBe(false);
  });
  it("weather is always audible regardless of the list", () => {
    expect(isAudible(ch(162_550_000), [], [])).toBe(true);
  });
  it("an operator tag moves a channel into an allowed family", () => {
    expect(isAudible(ch(463_562_500, { tags: ["ham"] }), [], FAM)).toBe(true);
  });
  it("no list = legacy per-channel rule", () => {
    expect(isAudible(ch(463_562_500), [])).toBe(true);
  });
});
```

Append to the `toScanConfig` describe in `test/api.test.ts`:

```ts
  it("toScanConfig applies audibleFamilies in scan mode only", async () => {
    const { toScanConfig } = await import("../src/backend/server.js");
    const cfg = {
      ...JSON.parse(JSON.stringify((await import("../src/backend/config/schema.js")).defaultConfig())),
      channels: [
        { id: "ham", freq: 146790000, alphaTag: "H", mode: "nfm", enabled: true },
        { id: "biz", freq: 463562500, alphaTag: "B", mode: "nfm", enabled: true },
      ],
    };
    const sc = toScanConfig(cfg, "scan");
    expect(sc.channels.find((c) => c.id === "ham")?.audible).toBe(true);
    expect(sc.channels.find((c) => c.id === "biz")?.audible).toBe(false);
    // Monitor = the operator's direct tune: deliberate listening, never gated.
    const mon = toScanConfig(cfg, "monitor", cfg.channels[1]);
    expect(mon.channels[0]?.audible).not.toBe(false);
  });
```

Add a test for the alert pull-in (Review Focus 1). Find the existing alert test with `grep -n "alertUnmute" test/api.test.ts` and copy its setup, using a channel at `463_562_500` with no `audible` field. Assert `engine.alertUnmuteCalls` (or whatever the FakeEngine records; check `test/fakes`/`FakeEngine.ts`) includes that channel id.

Add to `test/schema.test.ts`:

```ts
  it("audio.audibleFamilies defaults to the five listening families", () => {
    expect(defaultConfig().audio.audibleFamilies).toEqual(["air", "rail", "marine", "ham", "gmrs"]);
  });
  it("audio.audibleFamilies rejects weather and unknown names", () => {
    const c = defaultConfig();
    expect(configSchema.safeParse({ ...c, audio: { ...c.audio, audibleFamilies: ["weather"] } }).success).toBe(false);
    expect(configSchema.safeParse({ ...c, audio: { ...c.audio, audibleFamilies: ["cb"] } }).success).toBe(false);
  });
```

(Use the schema export name the file already imports. Check the top of `test/schema.test.ts`.)

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/banks.test.ts test/api.test.ts test/schema.test.ts`
Expected: FAIL (`isAudible` ignores the third arg; `audibleFamilies` undefined).

- [ ] **Step 3: Schema.** In `schema.ts` `audio: z.object({`, after `remoteListening`, add:

```ts
    // Which service FAMILIES may own the speaker (spec 2026-10-13 silent
    // chatter; config/family.ts). Everything else is SILENT: it still gets a
    // lane, history and the map, but never the speaker and never scan time
    // (no hold, no dwell re-arm). Weather is always audible and is not a
    // member. A runtime gate: per-channel audible:false still silences an
    // allowed family; audible:true can't un-silence a disallowed one — tag
    // the channel into an allowed family instead.
    audibleFamilies: z.array(z.enum(["air", "rail", "marine", "ham", "gmrs", "biz", "publicsafety", "unknown"]))
      .default([...AUDIBLE_FAMILIES_DEFAULT]),
```

and near the top of the file:

```ts
export const AUDIBLE_FAMILIES_DEFAULT = ["air", "rail", "marine", "ham", "gmrs"] as const;
```

In `defaultConfig()` add `audibleFamilies: [...AUDIBLE_FAMILIES_DEFAULT]` to the `audio` literal (line ~547).

- [ ] **Step 4: `isAudible`.** Replace in `banks.ts`:

```ts
import { familyFor, type Family } from "./family.js";

// May this tracked channel own the speaker? The channel's own audible:false
// always silences. With an audibleFamilies list (spec 2026-10-13), a channel
// whose family isn't listed is silent too — except weather, always heard.
// No list = the legacy per-channel rule.
export function isAudible(channel: Channel, _banks: Bank[], audibleFamilies?: readonly Family[]): boolean {
  if (channel.audible === false) return false;
  if (!audibleFamilies) return true;
  const fam = familyFor(channel.freq, channel.tags);
  return fam === "weather" || audibleFamilies.includes(fam);
}
```

(Check `family.ts` imports `banks.ts` and `banks.ts` imports `family.ts`. That is a cycle, but ESM handles it here because both only use each other inside functions. If typecheck or vitest objects, move `ALLOCATIONS` + `serviceFor` into `family.ts` and re-export `serviceFor` from `banks.ts`.)

- [ ] **Step 5: `toScanConfig` and alert pull-in.** In `server.ts` line ~101 change to `audible: isAudible(c, cfg.banks ?? [], cfg.audio.audibleFamilies),`. At line ~403 change to `if (!isAudible(ch, config.banks ?? [], config.audio.audibleFamilies)) {`.

- [ ] **Step 6: Run tests**

Run: `npx vitest run test/banks.test.ts test/api.test.ts test/schema.test.ts test/family.test.ts`
Expected: PASS. Then `npm test` to catch fixtures that build configs by hand (fix them by adding nothing: the field defaults via zod; FakeEngine-based tests that construct `Config` literals may need `audibleFamilies` only if typed without parsing).

- [ ] **Step 7: Typecheck and commit**

```bash
npm run typecheck
git add src/backend/config/schema.ts src/backend/config/banks.ts src/backend/server.ts test/banks.test.ts test/api.test.ts test/schema.test.ts
git commit -m "feat(audio): audibleFamilies gate — only listed families own the speaker"
```

---

### Task 3: Close Call audibility — Node ranges + helper

**Files:**
- Modify: `src/backend/config/family.ts` (add `ccAudibleRanges`)
- Modify: `src/backend/engine/ScannerEngine.ts` (`ScanConfig.ccAudibleHz?`)
- Modify: `src/backend/server.ts` (`toScanConfig` sets it in scan mode)
- Modify: `src/backend/engine/WidebandEngine.ts` (`sendTune`/`sendSweepTune` send it; `findChannel` marks silent CC)
- Modify: `native/src/protocol.hpp`, `native/src/protocol.cpp`, `native/src/scanner.hpp`, `native/src/scanner.cpp`, `native/src/engine.cpp`
- Test: `test/family.test.ts`, `test/WidebandEngine.test.ts`, `native/test/test_protocol.cpp`, `native/test/test_scanner.cpp`

**Interfaces:**
- Consumes: `familyFor`, `familyForService`, `serviceFor`, `Family`.
- Produces: `ccAudibleRanges(families: readonly Family[]): Array<[number, number]>` (sorted, merged, inclusive integer Hz); `ScanConfig.ccAudibleHz?: Array<[number, number]>`; C++ `TuneCmd::cc_audible_hz` (`std::optional<std::vector<std::pair<double,double>>>`), `Scanner::set_cc_audible(std::optional<std::vector<std::pair<double,double>>>)`.

- [ ] **Step 1: Failing TS test** (append to `test/family.test.ts`):

```ts
import { ccAudibleRanges } from "../src/backend/config/family.js";
import { serviceFor } from "../src/backend/config/banks.js";

describe("ccAudibleRanges", () => {
  const FAM = ["air", "rail", "marine", "ham", "gmrs"] as const;
  const inRanges = (r: Array<[number, number]>, f: number) => r.some(([lo, hi]) => f >= lo && f <= hi);
  const audible = (f: number) => { const fam = familyFor(f); return fam === "weather" || (FAM as readonly string[]).includes(fam); };

  it("agrees with familyFor exactly at every allocation edge and its neighbours", () => {
    const r = ccAudibleRanges(FAM);
    const probes: number[] = [];
    for (let f = 100_000_000; f <= 1_000_000_000; f += 12_500) probes.push(f);
    // The table's own edges ±1 Hz: where an off-by-one would hide.
    for (const e of [118e6, 137e6, 144e6, 148e6, 156e6, 157.45e6, 159.81e6, 161.565e6, 161.6e6, 162.025e6,
      162.4e6, 162.55e6, 174e6, 222e6, 225e6, 420e6, 450e6, 462.5375e6, 462.7375e6, 467.5375e6, 467.7375e6,
      470e6, 512e6]) probes.push(e - 1, e, e + 1);
    for (const f of probes) expect(inRanges(r, f), `${f} (${serviceFor(f)})`).toBe(audible(f));
  });
  it("is sorted and merged", () => {
    const r = ccAudibleRanges(FAM);
    for (let i = 1; i < r.length; i++) expect(r[i]![0]).toBeGreaterThan(r[i - 1]![1] + 1);
  });
  it("unknown in the list makes the gaps audible", () => {
    expect(inRanges(ccAudibleRanges(["unknown"]), 300_000_000)).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run test/family.test.ts`
Expected: FAIL, `ccAudibleRanges` is not exported.

- [ ] **Step 3: Implement `ccAudibleRanges`** in `family.ts`. This needs the allocation edges, so export them from `banks.ts` as `export const ALLOCATIONS` (it is currently `const`):

```ts
import { ALLOCATIONS, serviceFor } from "./banks.js";

const MAX_HZ = 6_000_000_000;

/** The exact integer-Hz partition of the service table whose family is
 *  audible (weather always), merged — sent to the helper as ccAudibleHz so a
 *  Close Call hit outside every range never takes the speaker. serviceFor is
 *  constant between consecutive allocation edges (lo, hi+1), so each
 *  elementary interval is classified by its first Hz. */
export function ccAudibleRanges(families: readonly Family[]): Array<[number, number]> {
  const edges = new Set<number>([0, MAX_HZ + 1]);
  for (const a of ALLOCATIONS) { edges.add(a.lo); edges.add(a.hi + 1); }
  const pts = [...edges].sort((a, b) => a - b);
  const out: Array<[number, number]> = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const lo = pts[i]!, hi = pts[i + 1]! - 1;
    const fam = familyForService(serviceFor(lo));
    if (fam !== "weather" && !families.includes(fam)) continue;
    const last = out[out.length - 1];
    if (last && last[1] + 1 === lo) last[1] = hi;
    else out.push([lo, hi]);
  }
  return out;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/family.test.ts`
Expected: PASS.

- [ ] **Step 5: Failing native tests.** Append to `native/test/test_protocol.cpp`:

```cpp
TEST(protocol_parses_cc_audible_ranges) {
  std::string err;
  auto c = kc::parse_command(R"({"cmd":"tune","centerHz":1,"ccAudibleHz":[[118000000,137000000],[144000000,148000000]]})", err);
  CHECK(c.has_value());
  const auto& t = std::get<kc::TuneCmd>(*c);
  CHECK(t.cc_audible_hz.has_value() && t.cc_audible_hz->size() == 2);
  CHECK_NEAR((*t.cc_audible_hz)[1].first, 144000000, 0);
  auto absent = kc::parse_command(R"({"cmd":"tune","centerHz":1})", err);
  CHECK(!std::get<kc::TuneCmd>(*absent).cc_audible_hz.has_value());   // absent = all CC audible
}
```

Append to `native/test/test_scanner.cpp`:

```cpp
TEST(scanner_silent_cc_lane_never_takes_the_speaker) {
  Sim m;
  m.s.tune(146e6, {ch("a")}, false);
  m.s.set_cc_audible(std::vector<std::pair<double, double>>{{144e6, 145e6}});   // 146.0125 outside
  m.run(0.8);
  const int slot = m.s.assign_cc(146012500);
  CHECK(slot >= 0 && !m.s.lane(slot).priority && !m.s.lane(slot).allow_audio);
  m.run(0.8);
  m.set(slot, KEYED, true);
  m.run(0.2);
  CHECK(opens_of(m, "cc_146012500") == 1);
  CHECK(m.s.audible() != slot);
  for (auto& e : m.of("audible")) CHECK(e["id"] != "cc_146012500");
}

TEST(scanner_cc_inside_audible_range_behaves_as_before) {
  Sim m;
  m.s.tune(146e6, {ch("a")}, false);
  m.s.set_cc_audible(std::vector<std::pair<double, double>>{{144e6, 148e6}});
  m.run(0.8);
  const int slot = m.s.assign_cc(146012500);
  CHECK(slot >= 0 && m.s.lane(slot).priority);
  m.run(0.8);
  m.set(slot, KEYED, true);
  m.run(0.2);
  CHECK(m.s.audible() == slot);
}

TEST(scanner_cc_audible_absent_means_all_audible) {
  Sim m;
  m.s.tune(146e6, {ch("a")}, false);
  m.s.set_cc_audible(std::nullopt);
  const int slot = m.s.assign_cc(146012500);
  CHECK(slot >= 0 && m.s.lane(slot).priority);
}
```

(Adjust field names to `LaneState`'s real members. `priority` and `allow_audio` exist per `scanner.hpp:25`.)

- [ ] **Step 6: Run to verify fail**

Run: `npm run test:native`
Expected: compile failure (`cc_audible_hz`, `set_cc_audible` unknown).

- [ ] **Step 7: Implement native.**

`protocol.hpp`, in `TuneCmd` after `known_hz`:

```cpp
  // Close Call speaker gate (spec 2026-10-13): inclusive [lo, hi] Hz ranges whose CC hits may
  // speak. nullopt (field absent) = every CC hit audible, as before.
  std::optional<std::vector<std::pair<double, double>>> cc_audible_hz;
```

`protocol.cpp`, in the `tune` branch after `t.known_hz = ...`:

```cpp
      if (auto it = j.find("ccAudibleHz"); it != j.end() && !it->is_null()) {
        std::vector<std::pair<double, double>> r;
        for (const auto& p : *it) r.emplace_back(p.at(0).get<double>(), p.at(1).get<double>());
        t.cc_audible_hz = std::move(r);
      }
```

`scanner.hpp`, public:

```cpp
  void set_cc_audible(std::optional<std::vector<std::pair<double, double>>> r) { cc_audible_ = std::move(r); }
```

private: `std::optional<std::vector<std::pair<double, double>>> cc_audible_;` (add `#include <optional>`, `<utility>` if missing).

`scanner.cpp` `assign_cc`, after the airband `c.mode` line:

```cpp
    // Silent family (spec 2026-10-13): the hit still opens, logs and parks, but never speaks or
    // pre-empts the audible lanes.
    if (cc_audible_) {
      bool ok = false;
      for (const auto& [lo, hi] : *cc_audible_) if ((double)freq_hz >= lo && (double)freq_hz <= hi) { ok = true; break; }
      if (!ok) { c.audible = false; c.priority = false; }
    }
```

`engine.cpp` `Engine::tune`, before `sc_.tune(...)`: `sc_.set_cc_audible(t.cc_audible_hz);`

- [ ] **Step 8: Run native tests**

Run: `npm run test:native`
Expected: PASS (all, including the existing `scanner_skip_holdoff_and_cc_park`, which never calls `set_cc_audible`).

- [ ] **Step 9: Node side.** In `ScannerEngine.ts` `ScanConfig` add:

```ts
  // Close Call speaker gate (spec 2026-10-13): audible [lo, hi] Hz ranges,
  // sent on every tune. Absent = every CC hit audible.
  ccAudibleHz?: Array<[number, number]>;
```

`server.ts` `toScanConfig`, in the returned object (scan mode only):

```ts
    ...(mode === "scan" ? { ccAudibleHz: ccAudibleRanges(cfg.audio.audibleFamilies) } : {}),
```

`WidebandEngine.ts`: add `...(this.config?.ccAudibleHz ? { ccAudibleHz: this.config.ccAudibleHz } : {}),` to both the `sendTune` `cmd` object and the `sendSweepTune` payload. In `findChannel`'s CC branch add `audible: this.ccAudible(Number(cc[1]))` to the synthesized channel and add:

```ts
  private ccAudible(freqHz: number): boolean {
    const r = this.config?.ccAudibleHz;
    return !r || r.some(([lo, hi]) => freqHz >= lo && freqHz <= hi);
  }
```

`hasAudibleOpen()` already returns `channel.audible !== false` for a found channel, so a silent CC open stops holding automatically.

Add an engine test to `test/WidebandEngine.test.ts`:

```ts
  it("a silent Close Call open does not hold the rotation; an audible one does", async () => {
    for (const [ranges, expectHop] of [[[[144_000_000, 148_000_000]], false], [[], true]] as const) {
      const tunes = tmpFile("tunes");
      const { engine, events } = makeEngine({
        FAKE_WB_TUNES_FILE: tunes,
        FAKE_WB_SCRIPT: `{"ev":"open","id":"cc_146012500","db":-10}`,
      }, { groupDwellMs: 1000 });
      await engine.start(cfg([VHF_A, VHF_B, UHF], { ccAudibleHz: ranges as Array<[number, number]> }));
      expect(await waitFor(() => events.some((e) => e.type === "active" && e.channel.id === "cc_146012500"), 1000)).toBe(true);
      const at = lines(tunes).length;
      const hopped = await waitFor(() => lines(tunes).length > at, 2500);
      await engine.stop();
      expect(hopped).toBe(expectHop);
    }
  });
  it("tune commands carry ccAudibleHz", async () => {
    const tunes = tmpFile("tunes");
    const { engine } = makeEngine({ FAKE_WB_TUNES_FILE: tunes });
    await engine.start(cfg([VHF_A], { ccAudibleHz: [[1, 2]] }));
    await waitFor(() => lines(tunes).length >= 1, 1000);
    await engine.stop();
    expect(JSON.parse(lines(tunes)[0]!).ccAudibleHz).toEqual([[1, 2]]);
  });
```

- [ ] **Step 10: Run all and commit**

Run: `npm test && npm run test:native && npm run typecheck`
Expected: PASS.

```bash
git add src/backend/config/family.ts src/backend/config/banks.ts src/backend/engine/ScannerEngine.ts src/backend/engine/WidebandEngine.ts src/backend/server.ts native/src native/test test/family.test.ts test/WidebandEngine.test.ts
git commit -m "feat(closecall): silent-family CC hits never speak or hold (ccAudibleHz)"
```

---

### Task 4: Silent closes don't re-arm dwell; release on hop

**Files:**
- Modify: `src/backend/engine/WidebandEngine.ts` (`case "close"`, `sendTune`, `sendSweepTune`)
- Test: `test/WidebandEngine.test.ts`

**Interfaces:**
- Consumes: `findChannel` (CC-aware audible flag from Task 3).
- Produces: a `{ type: "release", channelId, ts }` event for every id open at a hop, emitted before the `tuned` event.

- [ ] **Step 1: Failing tests**

```ts
  it("a hop releases every still-open lane (the map's front settles)", async () => {
    const muted = ch(146_790_000, { audible: false });
    const { engine, events } = makeEngine({
      FAKE_WB_SCRIPT: `{"ev":"open","id":"${muted.id}","db":-10}`,   // never closes
    }, { groupDwellMs: 300 });
    await engine.start(cfg([muted, VHF_B, UHF], { visualHold: { enabled: false } }));
    expect(await waitFor(() => events.some((e) => e.type === "release" && e.channelId === muted.id), 2500)).toBe(true);
    await engine.stop();
  });

  it("a silent close does not restart the dwell clock", async () => {
    const muted = ch(146_790_000, { audible: false });
    const tunes = tmpFile("tunes");
    // Opens and closes repeatedly: under the old rule each close re-armed
    // groupStartedAt and the window never hopped.
    const burst = Array.from({ length: 40 }, () =>
      `{"ev":"open","id":"${muted.id}","db":-10}\n{"ev":"close","id":"${muted.id}"}`).join("\n");
    const { engine } = makeEngine({ FAKE_WB_TUNES_FILE: tunes, FAKE_WB_SCRIPT: burst, FAKE_WB_SCRIPT_GAP_MS: "50" },
      { groupDwellMs: 800 });
    await engine.start(cfg([muted, VHF_B, UHF], { visualHold: { enabled: false } }));
    const at = (await waitFor(() => lines(tunes).length >= 1, 1000), lines(tunes).length);
    expect(await waitFor(() => lines(tunes).length > at, 2000)).toBe(true);
    await engine.stop();
  });
```

(Check `test/fakes/fake-wideband-helper.sh` for how it paces scripted lines. If there is no gap variable, add `FAKE_WB_SCRIPT_GAP_MS` support there: `sleep` between lines, default 0. Keep the change minimal.)

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run test/WidebandEngine.test.ts -t "release|dwell clock"`
Expected: both FAIL.

- [ ] **Step 3: Implement.** Add a helper and call it at the top of `sendTune` and `sendSweepTune` (replacing their `this.openIds.clear();`):

```ts
  // A hop ends every open transmission from the map's point of view: emit its
  // release so the glass front settles into rim and smoke instead of hanging
  // until its ttl (spec 2026-10-13). The helper's own late "close" for these
  // ids is ignored — openIds no longer holds them and GlassState.release is
  // idempotent.
  private releaseOpenOnHop(): void {
    const ts = this.now();
    for (const id of this.openIds) this.emit({ type: "release", channelId: id, ts });
    this.openIds.clear();
  }
```

In `case "close":` make the emit conditional so a stale close (id not open) is dropped, and re-arm only for audible closes:

```ts
      case "close": {
        if (typeof ev.id !== "string") return;
        if (!this.openIds.delete(ev.id)) return;   // stale: already released by a hop
        this.emit({ type: "release", channelId: ev.id, ts: this.now() });
        if (this.openIds.size === 0) {
          this.holdStartedAt = 0; // hold ended cleanly; next hold clocks fresh
          this.emit({ type: "idle", ts: this.now() });
          // Idle again: dwell restarts from now so a long AUDIBLE hold doesn't
          // cause an instant hop when it closes. A silent close never re-arms
          // (spec 2026-10-13): silent traffic takes no scan time.
          if (this.findChannel(ev.id)?.audible !== false) this.groupStartedAt = this.now();
        }
        break;
      }
```

(This replaces the `spentMuted`/visual-budget logic in the same block. `visualBudgetLeft` becomes unused here; Task 5 deletes it.)

- [ ] **Step 4: Run engine tests**

Run: `npx vitest run test/WidebandEngine.test.ts`
Expected: the new tests pass. Visual-hold tests may now fail on the re-arm assumption. That's expected only if they test re-arm, and Task 5 deletes them. Note any other failure and fix it here.

- [ ] **Step 5: Commit**

```bash
git add src/backend/engine/WidebandEngine.ts test/WidebandEngine.test.ts test/fakes
git commit -m "feat(engine): silent closes never re-arm dwell; hops release open lanes"
```

---

### Task 5: Retire visual hold

**Files:**
- Modify: `src/backend/engine/WidebandEngine.ts` (remove `visualHold()`, `hasVisualOpen`, `visualBudgetLeft`, `visualVisitStartedAt`, the visual branch in the dwell tick, the visual-hold credit in `recordActivity`)
- Modify: `src/backend/engine/scanSchedule.ts` (remove `VisualHoldConfig`, `VISUAL_HOLD_DEFAULTS`, `resolveVisualHold`)
- Modify: `src/backend/engine/ScannerEngine.ts` (remove `visualHold` from `ScanConfig` and from the `updateScheduling` Pick)
- Modify: `src/backend/engine/FakeEngine.ts:73-74`
- Modify: `src/backend/server.ts:135, 882-897` (stop passing/diffing `visualHold`)
- Modify: `src/backend/config/schema.ts:157-167` (deprecated comment; keep the shape)
- Test: `test/WidebandEngine.test.ts` (delete the `visual hold` describe + the "visualHold disabled" test's option), `test/scanSchedule.test.ts` (delete the resolveVisualHold cases), `test/api.test.ts:982-1020` (rewrite)

**Interfaces:**
- Produces: `updateScheduling?(s: Pick<ScanConfig, "autoDwell" | "priorityRevisit">)`. Coverage kinds stay `"audible" | "silent" | "quiet" | "sweep"`, but `silent` is now never recorded by the engine (kept so the baseline and after numbers share one shape).

- [ ] **Step 1: Rewrite the API tests first** (`test/api.test.ts` ~982–1020). Replace the two visualHold tests with:

```ts
  it("scan.visualHold is accepted (deprecated) and ignored — no restart, no scheduling push", async () => {
    const { server, engine } = makeApp();
    let starts = 0;
    const realStart = engine.start.bind(engine);
    engine.start = async (sc) => { starts++; return realStart(sc); };
    const cfg = (await request(server).get("/api/config")).body;
    cfg.scan.visualHold = { maxMs: 8000 };
    const res = await request(server).put("/api/config").send(cfg);
    expect(res.status).toBe(200);
    expect(starts).toBe(0);
    const updates = (engine as { schedulingUpdates?: Array<Record<string, unknown>> }).schedulingUpdates ?? [];
    expect(updates).toHaveLength(0);
  });
```

Also delete the "rejects out-of-range visualHold" test (~line 1010). The field is still validated by zod, but it's no longer a behaviour worth pinning.


- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run test/api.test.ts -t visualHold`
Expected: FAIL (a scheduling update is still pushed).

- [ ] **Step 3: Remove the code.** Delete every symbol listed under **Files**. In the dwell tick, the structure becomes:

```ts
      this.coverage.record(this.sweeping ? "sweep" : this.hasAudibleOpen() ? "audible" : "quiet", deltaMs, tickAt);
      if (this.hasAudibleOpen()) {
        /* unchanged hold-through + max-hold cap block */
      } else {
        // Nothing audible holds: silent traffic gets no scan time (spec 2026-10-13).
        this.holdStartedAt = 0;
      }
```

In `recordActivity` replace the visual-hold lines with:

```ts
    // Silent carriers earn no dwell (spec 2026-10-13): the scan is for listening.
    if (channel.audible === false) return;
```

and update its doc comment ("a muted carrier counts only with visualHold.creditDwell" → "a silent carrier never counts").

In `server.ts` delete `visualHold: cfg.scan.visualHold,` from `toScanConfig`, drop `visualHold: undefined` from `strip`, and drop it from both the diff and the `updateScheduling` call. Update the comment at line ~882 to list only autoDwell and priorityRevisit.

In `schema.ts` replace the visualHold comment block with:

```ts
    // DEPRECATED (spec 2026-10-13 silent chatter): visual hold is retired —
    // silent traffic takes no scan time. Still parsed so older configs load;
    // ignored everywhere.
```

- [ ] **Step 4: Delete obsolete tests.** Remove `describe("visual hold (scan.visualHold)")` from `test/WidebandEngine.test.ts`, drop `{ visualHold: { enabled: false } }` options from the remaining tests (including the ones added in Task 4), and remove the `resolveVisualHold` cases and imports from `test/scanSchedule.test.ts`. Rename the "visualHold disabled: an open on an INAUDIBLE channel…" test to "an open on a SILENT channel does not hold the rotation".

- [ ] **Step 5: Run everything**

Run: `npm test && npm run typecheck`
Expected: PASS, and `grep -rn "visualHold\|VisualHold" src` only hits `schema.ts`.

- [ ] **Step 6: Commit**

```bash
git add -A src test
git commit -m "feat(engine): retire visual hold — silent traffic takes no scan time"
```

- [ ] **Step 7: On-hardware proof of Sections 1 (needs the service).**

```bash
npm run build && sudo systemctl restart kerchunk-kiosk
journalctl -u kerchunk-kiosk -n 50 --no-pager | grep -i "error\|wideband"   # helper came up, tunes flowing
```

After ~15 min, capture `scanCoverage` three times 10 min apart (same command as Task 0 step 9) to `/tmp/claude-1000/coverage-after.txt`, plus the same history count. Expect `silent` ≈ 0 and `quiet` higher than baseline. Then:

```bash
curl -s -X POST localhost:8080/api/test/alert -H 'content-type: application/json' -d '{"alphaTag":"TEST"}'
```

The operator confirms by ear: SAME/test break-in plays, no business chatter, the listening families come through. Record what was heard. If something is not proven, say so.

---

### Task 6: `scatter.ts` — stable invented metro spots

**Files:**
- Create: `src/frontend/map/scatter.ts`
- Test: `test/scatter.test.ts`

**Interfaces:**
- Consumes: `LatLngBox`, `Rect` from `./stage.js`; `oklchHex` from `../lib/oklch.js`.
- Produces: `export interface ScatterStage { box: LatLngBox; width: number; height: number; inner: Rect }`; `export function scatterSpot(freqHz: number, stage: ScatterStage, marginPx: number): { lat: number; lng: number; hex: string }`; `export const SCATTER_KEY = (freqHz: number) => \`scatter:${freqHz}\``.

- [ ] **Step 1: Failing tests**

```ts
// test/scatter.test.ts
import { describe, it, expect } from "vitest";
import { scatterSpot, type ScatterStage } from "../src/frontend/map/scatter.js";
import { lngLatToViewPx } from "../src/frontend/map/stage.js";

const STAGE: ScatterStage = {
  box: { n: 39.35, s: 38.85, e: -94.2, w: -94.95 }, width: 1920, height: 1080,
  inner: { left: 80, top: 250, right: 1840, bottom: 960 },
};

describe("scatterSpot", () => {
  it("is deterministic per frequency", () => {
    expect(scatterSpot(463_562_500, STAGE, 80)).toEqual(scatterSpot(463_562_500, STAGE, 80));
    expect(scatterSpot(463_562_500, STAGE, 80)).not.toEqual(scatterSpot(463_587_500, STAGE, 80));
  });
  it("lands inside the padded stage less the margin", () => {
    for (let f = 450_000_000; f < 470_000_000; f += 12_500) {
      const s = scatterSpot(f, STAGE, 80);
      const p = lngLatToViewPx(s.lat, s.lng, STAGE.box, STAGE.width, STAGE.height);
      expect(p.x).toBeGreaterThanOrEqual(160 - 0.5);
      expect(p.x).toBeLessThanOrEqual(1760 + 0.5);
      expect(p.y).toBeGreaterThanOrEqual(330 - 0.5);
      expect(p.y).toBeLessThanOrEqual(880 + 0.5);
    }
  });
  it("spreads by area (no centre clumping): each quadrant gets 15–35%", () => {
    const q = [0, 0, 0, 0];
    let n = 0;
    for (let f = 450_000_000; f < 470_000_000; f += 12_500) {
      const s = scatterSpot(f, STAGE, 80);
      const p = lngLatToViewPx(s.lat, s.lng, STAGE.box, STAGE.width, STAGE.height);
      q[(p.x < 960 ? 0 : 1) + (p.y < 605 ? 0 : 2)]!++; n++;
    }
    for (const c of q) { expect(c / n).toBeGreaterThan(0.15); expect(c / n).toBeLessThan(0.35); }
  });
  it("colour is a stable hex, varying across frequencies", () => {
    const hexes = new Set<string>();
    for (let f = 460_000_000; f < 460_250_000; f += 12_500) hexes.add(scatterSpot(f, STAGE, 80).hex);
    expect([...hexes].every((h) => /^#[0-9a-f]{6}$/i.test(h))).toBe(true);
    expect(hexes.size).toBeGreaterThan(12);
  });
  it("a margin larger than the stage collapses to the centre, never outside", () => {
    const s = scatterSpot(463_562_500, STAGE, 5000);
    const p = lngLatToViewPx(s.lat, s.lng, STAGE.box, STAGE.width, STAGE.height);
    expect(Math.abs(p.x - 960)).toBeLessThan(1);
    expect(Math.abs(p.y - 605)).toBeLessThan(1);
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run test/scatter.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement**

```ts
// src/frontend/map/scatter.ts
// Invented metro spots (spec 2026-10-13 silent chatter): a SILENT transmission
// with no honest location lands at a stable made-up point inside the kiosk's
// padded stage, with a stable colour — both pure functions of its frequency,
// so nothing is stored and repeat traffic builds one recognisable place.
// Area-uniform in the stage rect; the camera never moves, so stable on the wall.
import type { LatLngBox, Rect } from "./stage.js";
import { oklchHex } from "../lib/oklch.js";

export interface ScatterStage { box: LatLngBox; width: number; height: number; inner: Rect }

export const SCATTER_KEY = (freqHz: number): string => `scatter:${freqHz}`;

// Glow band of the site palette (FAMILY_OKLCH spans L 0.62–0.84).
const SCATTER_L = 0.74, SCATTER_C = 0.17;

/** FNV-1a over the frequency's decimal digits + a salt → 0..1. */
function u01(freqHz: number, salt: string): number {
  const s = `${salt}:${freqHz}`;
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12;
  return (h >>> 0) / 4294967296;
}

const mercY = (lat: number): number => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
const invMercY = (y: number): number => (360 / Math.PI) * Math.atan(Math.exp(y)) - 90;

export function scatterSpot(freqHz: number, stage: ScatterStage, marginPx: number): { lat: number; lng: number; hex: string } {
  const { box, width, height, inner } = stage;
  const cx = (inner.left + inner.right) / 2, cy = (inner.top + inner.bottom) / 2;
  const halfW = Math.max(0, (inner.right - inner.left) / 2 - marginPx);
  const halfH = Math.max(0, (inner.bottom - inner.top) / 2 - marginPx);
  const x = cx + (u01(freqHz, "x") * 2 - 1) * halfW;
  const y = cy + (u01(freqHz, "y") * 2 - 1) * halfH;
  const lng = box.w + (x / width) * (box.e - box.w);
  const lat = invMercY(mercY(box.n) - (y / height) * (mercY(box.n) - mercY(box.s)));
  const hex = oklchHex({ L: SCATTER_L, C: SCATTER_C, h: u01(freqHz, "hue") * 360 });
  return { lat, lng, hex };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/scatter.test.ts`
Expected: PASS. (If `oklchHex` clips chroma at some hues so two hexes collide, the size>12 check still holds. If it fails, lower `SCATTER_C` to 0.15.)

- [ ] **Step 5: Commit**

```bash
git add src/frontend/map/scatter.ts test/scatter.test.ts
git commit -m "feat(map): scatter — stable invented metro spot + colour per frequency"
```

---

### Task 7: Map wiring — silent unlocated hits use scatter spots

**Files:**
- Modify: `src/backend/config/schema.ts` (`display.glass.scatter`)
- Modify: `src/frontend/map/map.ts` (`active` handler ~550, backfill ~530, stage capture, `glassSite` variant)
- Test: `test/schema.test.ts`; a pure decision helper test in `test/scatter.test.ts`

**Interfaces:**
- Consumes: `scatterSpot`, `SCATTER_KEY`, `ScatterStage` (Task 6); `familyFor` (Task 1); `hexToGlowRgb` (already in map.ts).
- Produces: `export function isSilentHit(freqHz: number, tags: readonly string[] | undefined, channelAudible: boolean | undefined, audibleFamilies: readonly string[]): boolean` in `scatter.ts`.

- [ ] **Step 1: Failing tests.** Append to `test/scatter.test.ts`:

```ts
import { isSilentHit } from "../src/frontend/map/scatter.js";
describe("isSilentHit", () => {
  const FAM = ["air", "rail", "marine", "ham", "gmrs"];
  it("live channel flag wins when present", () => {
    expect(isSilentHit(146_790_000, undefined, false, FAM)).toBe(true);
    expect(isSilentHit(463_562_500, undefined, true, FAM)).toBe(false);
  });
  it("history rows (no flag) fall back to family", () => {
    expect(isSilentHit(463_562_500, undefined, undefined, FAM)).toBe(true);
    expect(isSilentHit(463_562_500, ["ham"], undefined, FAM)).toBe(false);
    expect(isSilentHit(162_550_000, undefined, undefined, [])).toBe(false);   // weather
    expect(isSilentHit(300_000_000, undefined, undefined, FAM)).toBe(true);   // unknown
  });
});
```

Append to `test/schema.test.ts`:

```ts
  it("display.glass scatter + liveSparkStepMs defaults", () => {
    const g = defaultConfig().display.glass;
    expect(g.scatter).toEqual({ enabled: true, marginPx: 80 });
    expect(g.liveSparkStepMs).toBe(750);
  });
  it("liveSparkStepMs accepts 0 and 250–6000 only", () => {
    const c = defaultConfig();
    const ok = (v: number) => configSchema.safeParse({ ...c, display: { ...c.display, glass: { ...c.display.glass, liveSparkStepMs: v } } }).success;
    expect([ok(0), ok(250), ok(6000), ok(100), ok(7000)]).toEqual([true, true, true, false, false]);
  });
```

(`liveSparkStepMs` is added here with the other glass knob so the schema change lands once. Task 8 consumes it. Adjust `defaultConfig().display.glass` if `display` defaults are produced by `.default({})` parsing. Mirror how `test/schema.test.ts` already reads `siteColor`.)

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run test/scatter.test.ts test/schema.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `isSilentHit`** in `scatter.ts`:

```ts
import { familyFor } from "../../backend/config/family.js";

/** Silent by the speaker rule (spec 2026-10-13): a live event carries the
 *  engine-resolved channel.audible; a history row has none, so the family
 *  rule decides (a per-channel mute isn't visible there — acceptable). */
export function isSilentHit(
  freqHz: number, tags: readonly string[] | undefined,
  channelAudible: boolean | undefined, audibleFamilies: readonly string[],
): boolean {
  if (channelAudible !== undefined) return !channelAudible;
  const fam = familyFor(freqHz, tags);
  return fam !== "weather" && !audibleFamilies.includes(fam);
}
```

- [ ] **Step 4: Schema.** In `display.glass` after `hueDominance`:

```ts
      // Silent chatter (spec 2026-10-13): a SILENT transmission with no
      // location lands at a stable invented spot inside the padded stage
      // (map/scatter.ts), inset marginPx more. enabled:false = the old edge
      // glow. Applies on kiosk/reload.
      scatter: z.object({
        enabled: z.boolean().default(true),
        marginPx: z.number().int().min(0).max(400).default(80),
      }).default({}),
      // Live sparks: while a transmission is on the air its transmit point
      // throws embers that reshuffle every liveSparkStepMs — a redraw per step,
      // ONLY while a front is live (quiet band = zero redraws). 0 = off.
      liveSparkStepMs: z.union([z.literal(0), z.number().int().min(250).max(6000)]).default(750),
```

- [ ] **Step 5: Wire `map.ts`.** Imports:

```ts
import { scatterSpot, isSilentHit, SCATTER_KEY, type ScatterStage } from "./scatter.js";
```

After the `glassSite` definition add the stage capture and a scatter site builder:

```ts
    // Scatter stage: captured once, from the home framing, the first time the
    // map is idle (the kiosk camera never moves after that).
    let scatterStage: ScatterStage | null = null;
    google.maps.event.addListenerOnce(map, "idle", () => {
      const b = map.getBounds();
      if (!b) return;
      const ne = b.getNorthEast(), sw = b.getSouthWest();
      const W = root.clientWidth, H = root.clientHeight;
      scatterStage = { box: { n: ne.lat(), s: sw.lat(), e: ne.lng(), w: sw.lng() }, width: W, height: H, inner: padRect(W, H, KIOSK_FIT_PAD) };
    });
    const audibleFamilies: readonly string[] = cfg.audio?.audibleFamilies ?? ["air", "rail", "marine", "ham", "gmrs"];
    const scatter = display.glass.scatter;
    /** An invented site for a silent unlocated hit, or null (edge glow). */
    const scatterSite = (freq: number): GlassSite | null => {
      if (!scatter.enabled || !scatterStage) return null;
      const s = scatterSpot(freq, scatterStage, scatter.marginPx);
      return { key: SCATTER_KEY(freq), lat: s.lat, lng: s.lng, color: hexToGlowRgb(s.hex) };
    };
```

(`map`, `root`, `cfg`, `display`, `padRect`, `KIOSK_FIT_PAD` are all in scope in `mountActivityMap`. Confirm `cfg.audio` is typed on the `api.getConfig()` result. If the frontend config type lacks it, extend that type where `display` is declared.)

Change `startTx` to accept a prebuilt site:

```ts
    function startTxAt(id: string, s: GlassSite): void {
      glassState.keyUp(id, s, siteRadius(s.key, glassState.hits(s.key) + 1), Date.now());
      poke();
    }
    function startTx(id: string, lat: number, lng: number, freq: number | undefined, kind: "active" | "closecall"): void {
      startTxAt(id, glassSite(lat, lng, freq, kind));
    }
```

In the `active` handler's `else` branch:

```ts
        } else {
          // No location. A SILENT hit gets its invented metro spot (spec
          // 2026-10-13: glass/sparks/smoke, no antenna marker — a dot means a
          // real place); an audible one keeps the edge glow.
          const site = isSilentHit(ev.freq, ch.tags, ch.audible, audibleFamilies) ? scatterSite(ev.freq) : null;
          if (site) startTxAt(ch.id, site);
          else nofix(ev.freq);
        }
```

In the backfill loop replace `if (r.lat == null || r.lon == null) continue;` with:

```ts
          if (r.lat == null || r.lon == null) {
            const site = isSilentHit(r.freq, r.tags, undefined, audibleFamilies) ? scatterSite(r.freq) : null;
            if (site) seeds.push({ site, ts: r.ts });
            continue;
          }
```

and add `tags?: string[]` to the row type in that `.then`. **Ordering:** the backfill fetch can resolve before the first `idle`. Gate the backfill on the stage: wrap the fetch in a promise that waits for `scatterStage` (resolve inside the `addListenerOnce` callback; also resolve immediately when `!scatter.enabled`).

The `closecall` event branch keeps calling `nofix` for audible hits. For a silent one the follow-up `active` (the CC lane's open) now places it, so change it to:

```ts
      } else if (ev.type === "closecall") {
        // A silent CC hit is placed by its lane's `active` (scatter spot); an
        // audible one has no honest position yet — edge glow.
        if (!isSilentHit(ev.freqHz, undefined, undefined, audibleFamilies)) nofix(ev.freqHz);
```

- [ ] **Step 6: Run tests, typecheck, build**

Run: `npm test && npm run typecheck && npm run build:frontend`
Expected: PASS / clean / builds.

- [ ] **Step 7: Commit**

```bash
git add src/backend/config/schema.ts src/frontend/map/scatter.ts src/frontend/map/map.ts test/scatter.test.ts test/schema.test.ts
git commit -m "feat(map): silent unlocated hits glow at stable invented metro spots"
```

---

### Task 8: Live sparks

**Files:**
- Modify: `src/frontend/map/glassMath.ts` (`GlassFrame.liveStep`)
- Modify: `src/frontend/map/glassState.ts` (`GlassTimings.liveSparkStepMs`, `frame()`)
- Modify: `src/frontend/map/glassShaders.ts` (`FX_FS` live embers)
- Modify: `src/frontend/map/glassLayer.ts` (uniforms `uLiveStep`, `uSparkDensity` on FX, `uWind`)
- Modify: `src/frontend/map/map.ts` (pass `liveSparkStepMs` into `GlassTimings`)
- Test: `test/glassState.test.ts`, `test/glassPace.test.ts`

**Interfaces:**
- Consumes: `display.glass.liveSparkStepMs` (Task 7 schema).
- Produces: `GlassFrame.liveStep: number` (tick index of the live-spark grid, 0 when none live); `GlassTimings.liveSparkStepMs: number`.

- [ ] **Step 1: Failing tests** (append to `test/glassState.test.ts`, reusing its timings fixture. Find it with `grep -n "GlassTimings\|new GlassState" test/glassState.test.ts`):

```ts
describe("live-spark tick (spec 2026-10-13)", () => {
  const site = { key: "k", lat: 39, lng: -94.5, color: [1, 0.5, 0.2] as [number, number, number] };
  const T = { ...TIMINGS, liveSparkStepMs: 750 };   // TIMINGS = the file's existing fixture
  it("schedules the next live tick while a front is live and fully grown", () => {
    const g = new GlassState(T);
    g.keyUp("a", site, 5000, 0);
    const f = g.frame(10_000);   // well past growMs
    expect(f.nextChangeAt).toBe(10_500);   // next 750 ms grid tick after 10 000
    expect(f.liveStep).toBe(Math.floor(10_000 / 750));
  });
  it("contributes nothing with no live front (quiet band = zero redraws)", () => {
    const g = new GlassState(T);
    expect(g.frame(10_000).nextChangeAt).toBeNull();
  });
  it("0 disables it", () => {
    const g = new GlassState({ ...T, liveSparkStepMs: 0 });
    g.keyUp("a", site, 5000, 0);
    const f = g.frame(10_000);
    expect(f.nextChangeAt).not.toBe(10_500);
    expect(f.liveStep).toBe(0);
  });
});
```

(Ensure the fixture's `ttlMs` > 10 000 so the front is still live at 10 000. Override `ttlMs: 60_000` in `T` if needed.)

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run test/glassState.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement state.** `glassMath.ts`: add to `GlassFrame`:

```ts
  /** Live-spark grid tick (display.glass.liveSparkStepMs); 0 = none live / off. */
  liveStep: number;
```

and `liveStep: 0` in `EMPTY_FRAME`. `glassState.ts`: add to `GlassTimings`:

```ts
  /** Live-spark tick while any front is unreleased (display.glass.liveSparkStepMs); 0 = off. */
  liveSparkStepMs: number;
```

In `frame()` after the fronts loop:

```ts
    const liveMs = this.t.liveSparkStepMs;
    let liveStep = 0;
    if (liveMs > 0 && fronts.some((f) => f.releasing === 0)) {
      liveStep = Math.floor(now / liveMs);
      next = Math.min(next, nextTick(now, liveMs));
    }
```

and include `liveStep` in the returned object. Every `GlassTimings` construction site (`map.ts`, tests) passes `liveSparkStepMs: display.glass.liveSparkStepMs` (tests: `0` unless testing it).

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/glassState.test.ts test/glassPace.test.ts`
Expected: PASS.

- [ ] **Step 5: Shader.** In `FX_FS` add uniforms:

```glsl
uniform float uLiveStep;      // live-spark grid tick (wrapped); embers reshuffle on it
uniform float uSparkDensity;  // shared with the smoke sparks
uniform vec2 uWind;           // downwind unit, gl px (+y north); 0,0 = calm
```

Inside the fronts loop, after `float core = ...;`:

```glsl
    // Live embers (spec 2026-10-13): grain thrown off the transmit point while
    // it is on the air, dense at the source, thinning outward, nudged
    // downwind. Static between live ticks — event-paced like the smoke.
    float ember = 0.0;
    if (live > 0.0 && uSparkDensity > 0.0) {
      vec2 rel = (px - a.xy) / R;
      vec2 up = dot(uWind, uWind) > 0.5 ? uWind : vec2(0.0);
      float reach = length(rel - up * 0.25 * dot(rel, up));
      float dens = exp(-reach * reach * 9.0);
      vec2 cell = floor(px * 0.5);
      float gen = uLiveStep + floor(h21(cell) * 3.0);
      float g = h21(cell + vec2(gen * 61.0, gen * 17.0));
      if (g < dens * dens * uSparkDensity * 0.10) ember = 0.9 * level;
    }
    col += c * ((rim + trail + core + ember) * live + flash);
```

(replacing the existing `col += c * ((rim + trail + core) * live + flash);`).

- [ ] **Step 6: Layer uniforms.** In `glassLayer.ts` add `"uLiveStep", "uSparkDensity", "uWind"` to the `fxProg` uniform list (line 182). Where `uFrontA/B` are set (~352) also set:

```ts
      gl.uniform1f(u.uLiveStep!, frame.liveStep % STEP_WRAP);
      gl.uniform1f(u.uSparkDensity!, k.sparkDensity);
      gl.uniform2f(u.uWind!, ...this.windGl);
```

`windGl` is a `[number, number]` field the layer already has, or one you add. Look at how the smoke pass gets `uPuffB` wind (glass puffs carry `dir`). Add a `setWind(dir: [number, number] | null)` on the layer, called from `map.ts` where it already calls `glassState.setWind`, converting [east, north] to gl px (+y north is already the puff convention). Calm = `[0, 0]`.

- [ ] **Step 7: Typecheck, test, build, commit**

Run: `npm test && npm run typecheck && npm run build`
Expected: PASS.

```bash
git add src/frontend/map test
git commit -m "feat(glass): live sparks while a transmission is on the air (liveSparkStepMs)"
```

- [ ] **Step 8: On-wall proof (visual + thermal).**

```bash
curl -s -X POST localhost:8080/api/kiosk/reload
# wait for real traffic, then:
XDG_RUNTIME_DIR=/run/user/1000 WAYLAND_DISPLAY=wayland-0 grim /tmp/claude-1000/kiosk-live.png
```

Read the PNG: look for embers at a live front and scatter smoke with no dot underneath. To force a live front on demand, use `POST /api/test/tx` if `testTxRoute` exists (`grep -n "api/test" src/backend/server.ts`).

Thermal A/B, ~30 min each with real traffic, logging package temperature and chromium CPU once a minute:

```bash
for i in $(seq 30); do echo "$(date +%T) $(cat /sys/class/thermal/thermal_zone*/temp | sort -n | tail -1) $(ps -C chrome,chromium -o %cpu= | paste -sd+ | bc)"; sleep 60; done > /tmp/claude-1000/thermal-on.txt
```

Then `PUT /api/config` with `display.glass.liveSparkStepMs: 0`, reload, and repeat into `thermal-off.txt`. Restore 750 afterwards. If the mean delta is > ~1 °C, raise the default (try 1500) and note it. Put the numbers in the PR.

---

### Task 9: Docs, PR

**Files:**
- Modify: `../CLAUDE.md` (knobs paragraph: `audio.audibleFamilies`, `display.glass.scatter`, `liveSparkStepMs`; visual hold retired; Close Call `ccAudibleHz`)
- Modify: `../docs/ROADMAP.md` (shipped note; history durations for silent families are censored again)
- Modify: `../docs/API.md` (config fields)
- Modify: `../docs/superpowers/specs/2026-10-03-visual-hold-design.md` (status line: superseded by 2026-10-13)

- [ ] **Step 1: Write the doc edits.** CLAUDE.md, replace the `visualHold` sentence in "Conventions that bite" with:

```md
  Scan scheduling is Node-side and live (no respawn): `config.scan.autoDwell`
  and `priorityRevisit`. Speaker gate: `config.audio.audibleFamilies`
  (default air/rail/marine/ham/gmrs; weather always) — every other family is
  SILENT: lane + history + map, never the speaker, never scan time (no hold,
  no dwell re-arm; `scan.visualHold` is retired and ignored). Close Call hits
  follow it through the tune's `ccAudibleHz` ranges.
```

and in the Weather Glass paragraph add:

```md
  Silent hits with no location glow at a stable invented spot per frequency
  (`map/scatter.ts`, `display.glass.scatter`) — glass only, no marker. Live
  fronts throw embers on `display.glass.liveSparkStepMs` (750; 0 = off),
  only while something is on the air.
```

- [ ] **Step 2: Full Definition-of-done run**

Run: `npm test && npm run test:native && npm run typecheck && npm run build`
Expected: all pass. Paste the summary lines into the PR body.

- [ ] **Step 3: Commit, push, PR**

```bash
git add ../CLAUDE.md ../docs
git commit -m "docs: silent chatter knobs; visual hold superseded"
git push -u origin feat/silent-chatter
gh pr create --title "Silent chatter: hear only air/rail/marine/ham/GMRS, see everything" --body "<summary, knobs + locations, coverage before/after, thermal A/B, by-ear notes, screenshots; end with the Claude Code attribution line>"
```

- [ ] **Step 4: After the operator approves the merge:** `gh pr merge <n> --merge --delete-branch && git checkout main && git pull --ff-only && git fetch --prune && git branch -d feat/silent-chatter`.
