# Engine knobs in the admin: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose every native-engine knob in the admin Settings page. A **Sound**
card holds the everyday knobs and a live loudness curve. A collapsed, full-width
**Advanced (engine)** card holds the rest in four bands, each labelled with what a
save costs.

**Architecture:** One pure field table (`src/frontend/admin/engineKnobs.ts`) drives
markup, load, save, validation and dirty tracking. Pure helpers in the same module
compute:
- the loudness curve;
- the group-shape preview (it reuses the backend's pure `groupChannels`);
- the save-button cost text.

`admin.ts` only wires the DOM. The knob defaults move into a zod-free module
(`src/backend/config/engineDefaults.ts`), so the admin bundle can import them. A
vitest keeps the C++-mirrored values in step with `native/src/constants.hpp`.
There is no API or behaviour change on the backend.

**Tech Stack:** TypeScript (ESM, `.js` import extensions, `strict` +
`noUncheckedIndexedAccess`), vanilla DOM, Vite, vitest (node environment).

**Spec:** `docs/superpowers/specs/2026-09-27-engine-knobs-admin-design.md`

## Global Constraints

- Vanilla TS only, no frontend framework. Icons come from `lucide-static` only (none are needed here).
- Relative imports carry `.js` extensions, even from `.ts` source.
- The admin bundle must not import zod at runtime. Only type imports from `backend/config/schema.js` are allowed.
- Styling uses the existing admin tokens (`--panel`, `--rule`, `--etch`, `--ink`, `--label`, `--dim`, `--mark`, `--amber`, `--caution`, `--green`, `--red`, `--t-*`) and the DESIGN.md radius scale (card 8px, control 4px). No `backdrop-filter`.
- Copy is sentence case with plain verbs. Blank field = default, as for every other Settings field.
- Cost labels are exactly "Restarts scanning", "Applies live" and "Needs a backend restart".
- Run commands from `kiosk/`: `npm test`, `npm run typecheck` (both tsconfigs), `npm run build`, `npm run test:native`.
- The branch is `feat/engine-knobs-admin`. It already carries the spec commit. The work ships as one PR.

## Deviations from the spec (found while planning)

1. **Cycle estimate:** the spec says Σ dwell + groups × 0.64 s. The dwell timer runs
   from the tune, so the warm-up is already inside each dwell. Live measurement
   on 2026-09-27: 10 groups at `groupDwellMs` 1500 gave a ~15.5 s cycle. The
   estimate is Σ(`groupDwellMs` × max bank `dwellWeight`) only.
2. **Closed by default:** at ≥ 700 px, `applySettingsLayout()` in `admin.ts`
   forces every `.settingsCard` open. The Advanced card is exempt from that, so it
   stays closed. Below 700 px it joins the existing accordion unchanged.
3. **Server 400 text:** `api.ts`'s `j()` throws only `error` ("invalid config").
   It now appends the first zod issue, so the spec's "first zod issue message"
   actually reaches the UI. This also improves every other admin save error.

## File structure

| File | Responsibility |
|---|---|
| Create `kiosk/src/backend/config/engineDefaults.ts` | Zod-free home for scanner and helper knob defaults and limits (moved from `schema.ts` and `WidebandEngine.ts`), plus mirrors of the C++ defaults |
| Modify `kiosk/src/backend/config/schema.ts:95-108` | Import and re-export the moved constants (existing importers unchanged) |
| Modify `kiosk/src/backend/engine/WidebandEngine.ts:117,139-140` | Import `DEFAULT_GROUP_DWELL_MS` / `DEFAULT_READY_TIMEOUT_MS` / `DEFAULT_SILENCE_TIMEOUT_MS` instead of defining them |
| Create `kiosk/test/engineDefaults.test.ts` | Parity with `native/src/constants.hpp` |
| Create `kiosk/src/frontend/admin/engineKnobs.ts` | Field table, load/save/validate/dirty helpers, save-cost text, loudness curve and SVG, group preview |
| Create `kiosk/test/engineKnobs.test.ts` | Unit tests for all of the above |
| Modify `kiosk/src/frontend/lib/api.ts:3-13` | `j()` appends the first zod issue |
| Create `kiosk/test/apiErrors.test.ts` | That behaviour |
| Modify `kiosk/src/frontend/admin/admin.ts` | Markup for the two cards, DOM wiring, the layout exemption |
| Modify `kiosk/src/frontend/admin/admin.css` | Styles for the curve, bands, cost labels, preview and dirty inputs |
| Modify `docs/DEPLOY.md` | One line: the knobs are editable under Settings |

---

### Task 1: Zod-free engine defaults + C++ parity test

**Files:**
- Create: `kiosk/src/backend/config/engineDefaults.ts`
- Modify: `kiosk/src/backend/config/schema.ts:95-108`
- Modify: `kiosk/src/backend/engine/WidebandEngine.ts:117` and `:139-140`
- Test: `kiosk/test/engineDefaults.test.ts`

**Interfaces:**
- Produces (all exported from `engineDefaults.ts`):
  - `DEFAULT_WINDOW_BANDWIDTH_HZ = 2_400_000`, `DEFAULT_LANES_PER_GROUP = 32`,
    `DEFAULT_SAMPLE_RATE_HZ = 2_500_000`, `DEFAULT_FLAT_BANDWIDTH_HZ = 2_000_000`
  - `LANE_HZ = 50_000`, `MAX_LANES_PER_GROUP = 64`, `MIN_SAMPLE_RATE_HZ = 950_000`,
    `MAX_SAMPLE_RATE_HZ = 3_200_000`
  - `DEFAULT_GROUP_DWELL_MS = 3000`, `DEFAULT_READY_TIMEOUT_MS = 10_000`,
    `DEFAULT_SILENCE_TIMEOUT_MS = 5_000`
  - `HELPER_DEFAULTS` (readonly): `{ agcTargetDb, agcMaxGainDb, agcMinGainDb,
    agcAttackMs, agcReleaseMs, agcHoldBelowDb, limiterCeiling, limiterReleaseMs,
    fmAudioLpfHz, fmAudioHpfHz, nativeAmGainDb }`
  - re-exports `AUTO_DWELL_DEFAULTS`, `PRIORITY_REVISIT_DEFAULTS` from `../engine/scanSchedule.js`

- [ ] **Step 1: Write the failing test**

`kiosk/test/engineDefaults.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { HELPER_DEFAULTS, MAX_LANES_PER_GROUP } from "../src/backend/config/engineDefaults.js";

// The admin shows these as placeholders ("blank = default"), so they must be
// the helper's real defaults. The helper's truth is native/src/constants.hpp.
const hpp = readFileSync(fileURLToPath(new URL("../native/src/constants.hpp", import.meta.url)), "utf8");
function cpp(name: string): number {
  const m = new RegExp(`constexpr\\s+(?:double|float|int)\\s+${name}\\s*=\\s*(-?[\\d.]+)`).exec(hpp);
  if (!m) throw new Error(`${name} not found in constants.hpp`);
  return Number(m[1]);
}

describe("engine defaults mirror native/src/constants.hpp", () => {
  it.each([
    ["agcTargetDb", "AGC_TARGET_DB"],
    ["agcMaxGainDb", "AGC_MAX_GAIN_DB"],
    ["agcMinGainDb", "AGC_MIN_GAIN_DB"],
    ["agcAttackMs", "AGC_ATTACK_MS"],
    ["agcReleaseMs", "AGC_RELEASE_MS"],
    ["agcHoldBelowDb", "AGC_HOLD_BELOW_DB"],
    ["limiterCeiling", "LIMITER_CEILING"],
    ["limiterReleaseMs", "LIMITER_RELEASE_MS"],
    ["fmAudioLpfHz", "SPEAKER_LPF_HZ"],
    ["fmAudioHpfHz", "SPEAKER_HPF_HZ"],
  ] as const)("%s == %s", (ts, c) => {
    expect(HELPER_DEFAULTS[ts]).toBe(cpp(c));
  });

  it("MAX_LANES_PER_GROUP == MAX_LANES", () => {
    expect(MAX_LANES_PER_GROUP).toBe(cpp("MAX_LANES"));
  });

  it("nativeAmGainDb defaults to 0 dB (Node sends no --am-gain-db)", () => {
    expect(HELPER_DEFAULTS.nativeAmGainDb).toBe(0);
  });
});
```

- [ ] **Step 2: Run it and check that it fails**

Run: `cd kiosk && npx vitest run test/engineDefaults.test.ts`
Expected: FAIL, because `engineDefaults.js` doesn't exist yet.

- [ ] **Step 3: Create `engineDefaults.ts`**

```ts
// Engine knob defaults and limits shared by the backend and the admin UI.
// Zod-free on purpose: the admin bundle imports this at runtime and must not
// pull in zod (schema.ts re-exports these for the backend). HELPER_DEFAULTS
// mirrors kerchunk-dsp's own defaults (native/src/constants.hpp) — the value a
// knob takes when config omits it; test/engineDefaults.test.ts fails on drift.
export { AUTO_DWELL_DEFAULTS, PRIORITY_REVISIT_DEFAULTS } from "../engine/scanSchedule.js";

// Scanner front-end defaults, used when config omits the scan field (the
// engine and the schema's window/rate refine share them).
export const DEFAULT_WINDOW_BANDWIDTH_HZ = 2_400_000;   // measured 2026-09-26: RTL floor -1.4 dB at +-1.0 MHz, -4.8 dB at +-1.2 MHz
export const DEFAULT_LANES_PER_GROUP = 32;
export const DEFAULT_SAMPLE_RATE_HZ = 2_500_000;
// RTL flat passband (grouping keeps channels inside +-flat/2 where free): -1.4 dB at +-1.0 MHz.
export const DEFAULT_FLAT_BANDWIDTH_HZ = 2_000_000;
// A lane is 50 kHz wide: the rate must be a whole number of lanes, and a
// channel's lane can sit no closer than half a lane to the band edge, so the
// usable window is (rate - LANE_HZ).
export const LANE_HZ = 50_000;
export const MAX_LANES_PER_GROUP = 64;   // kerchunk-dsp MAX_LANES (native/src/constants.hpp)
export const MIN_SAMPLE_RATE_HZ = 950_000;   // librtlsdr: 900 001..3 200 000 (and 225 001..300 000); first 50 kHz multiple
export const MAX_SAMPLE_RATE_HZ = 3_200_000;

export const DEFAULT_GROUP_DWELL_MS = 3000;
// Helper liveness watchdogs (scan.helperReadyTimeoutMs / helperSilenceTimeoutMs).
export const DEFAULT_READY_TIMEOUT_MS = 10_000;
export const DEFAULT_SILENCE_TIMEOUT_MS = 5_000;

export const HELPER_DEFAULTS = {
  agcTargetDb: -18,
  agcMaxGainDb: 15,
  agcMinGainDb: -20,
  agcAttackMs: 10,
  agcReleaseMs: 400,
  agcHoldBelowDb: -50,
  limiterCeiling: 0.7,
  limiterReleaseMs: 50,
  fmAudioLpfHz: 2700,
  fmAudioHpfHz: 300,
  // Node-side: omitted = no --am-gain-db flag = 0 dB on top of the helper's fixed AM_GAIN.
  nativeAmGainDb: 0,
} as const;
```

- [ ] **Step 4: Make `schema.ts` re-export the moved constants**

In `kiosk/src/backend/config/schema.ts`, replace the block from
`// Scanner front-end defaults, used when config omits the scan field` through
`export const MAX_SAMPLE_RATE_HZ = 3_200_000;` (lines ~95–108) with the code
below. The block includes the private `const LANE_HZ = 50_000;`.

```ts
// Scanner front-end defaults and limits live in engineDefaults.ts (zod-free,
// so the admin bundle can import them); re-exported for existing importers.
import {
  DEFAULT_WINDOW_BANDWIDTH_HZ, DEFAULT_LANES_PER_GROUP, DEFAULT_SAMPLE_RATE_HZ,
  DEFAULT_FLAT_BANDWIDTH_HZ, LANE_HZ, MAX_LANES_PER_GROUP, MIN_SAMPLE_RATE_HZ, MAX_SAMPLE_RATE_HZ,
} from "./engineDefaults.js";
export {
  DEFAULT_WINDOW_BANDWIDTH_HZ, DEFAULT_LANES_PER_GROUP, DEFAULT_SAMPLE_RATE_HZ,
  DEFAULT_FLAT_BANDWIDTH_HZ, MAX_LANES_PER_GROUP, MIN_SAMPLE_RATE_HZ, MAX_SAMPLE_RATE_HZ,
};
```

ESM hoists imports, so an `import` in the middle of the file is legal. If the
repo's lint or style prefers it, move the `import` line to the top next to
`import { z } from "zod";` and keep the `export { … }` where the block was.

- [ ] **Step 5: Make `WidebandEngine.ts` import the dwell and watchdog defaults**

In `kiosk/src/backend/engine/WidebandEngine.ts`:
- delete the line `const DEFAULT_GROUP_DWELL_MS = 3000;` (line 117);
- delete the lines `const DEFAULT_READY_TIMEOUT_MS = 10_000;` and
  `const DEFAULT_SILENCE_TIMEOUT_MS = 5_000;` (lines 139–140);
- add this beside the other config imports:

```ts
import { DEFAULT_GROUP_DWELL_MS, DEFAULT_READY_TIMEOUT_MS, DEFAULT_SILENCE_TIMEOUT_MS } from "../config/engineDefaults.js";
```

Keep any comment that sat above the deleted watchdog lines, on the import instead.

- [ ] **Step 6: Run the tests and typecheck**

Run: `cd kiosk && npx vitest run test/engineDefaults.test.ts && npm test && npm run typecheck`
Expected: the parity test passes (13 cases), the full suite passes, and typecheck exits 0.

- [ ] **Step 7: Commit**

```bash
git add kiosk/src/backend/config/engineDefaults.ts kiosk/src/backend/config/schema.ts kiosk/src/backend/engine/WidebandEngine.ts kiosk/test/engineDefaults.test.ts
git commit -m "refactor(config): zod-free engineDefaults module + constants.hpp parity test"
```

---

### Task 2: Field table and load/save/validate/dirty helpers

**Files:**
- Create: `kiosk/src/frontend/admin/engineKnobs.ts`
- Test: `kiosk/test/engineKnobs.test.ts`

**Interfaces:**
- Consumes: everything Task 1 exports from `../../backend/config/engineDefaults.js`.
- Produces (exported from `engineKnobs.ts`):
  - `type Band = "sound" | "loudness" | "shape" | "schedule" | "watchdog"`
  - `type Cost = "scan" | "live" | "backend"`
  - `BAND_COST: Record<Band, Cost>`, `COST_LABEL: Record<Cost, string>`
  - `interface KnobField { id; path: readonly string[]; band: Band; label; hint; unit; kind: "number" | "switch"; scale: number; int?: boolean; min; max; step; def: number | boolean; allowZero?: boolean; sub?: string }`
  - `KNOB_FIELDS: readonly KnobField[]`, `KNOB_BY_ID: Record<string, KnobField>`
  - `ADVANCED_BANDS: ReadonlyArray<{ band: Exclude<Band, "sound">; title: string; purpose: string }>`
  - `type KnobValues = Record<string, string | boolean>`
  - `readKnob(cfg: Config, f: KnobField): string | boolean`
  - `parseKnob(f: KnobField, raw: string): number | undefined` (throws `Error` on invalid input)
  - `knobUi(values: KnobValues, id: string): number` (the UI value, or the field default when blank or invalid)
  - `windowError(windowHz: number, rateHz: number): string | null`
  - `applyKnobs(cfg: Config, fields: readonly KnobField[], values: KnobValues): Config` (mutates and returns `cfg`; throws on the first invalid field or a window/rate conflict)
  - `dirtyBands(fields: readonly KnobField[], loaded: KnobValues, current: KnobValues): Set<Band>`
  - `saveCost(card: "sound" | "advanced", bands: ReadonlySet<Band>): { label: string; note: string; warn: boolean }`

- [ ] **Step 1: Write the failing tests**

`kiosk/test/engineKnobs.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import type { Config } from "../src/backend/config/schema.js";
import {
  KNOB_FIELDS, KNOB_BY_ID, readKnob, parseKnob, knobUi, windowError, applyKnobs,
  dirtyBands, saveCost, BAND_COST,
} from "../src/frontend/admin/engineKnobs.js";

const baseCfg = (): Config => ({
  channels: [], banks: [],
  scan: { dwellMs: 2000, gain: "auto", sampleRate: 2400000, squelchLevel: 0 },
  audio: { sink: "default", volume: 40, muted: false },
} as unknown as Config);

describe("engine knob field table", () => {
  it("covers every knob the spec lists, once", () => {
    const paths = KNOB_FIELDS.map((f) => f.path.join("."));
    expect(new Set(paths).size).toBe(paths.length);
    expect(paths).toEqual(expect.arrayContaining([
      "audio.agcTargetDb", "audio.agcMaxGainDb", "scan.fmAudioLpfHz", "scan.fmAudioHpfHz", "scan.nativeAmGainDb",
      "audio.agcAttackMs", "audio.agcReleaseMs", "audio.agcHoldBelowDb", "audio.agcMinGainDb",
      "audio.limiterCeiling", "audio.limiterReleaseMs",
      "scan.lanesPerGroup", "scan.sampleRateHz", "scan.windowBandwidthHz", "scan.flatBandwidthHz",
      "scan.autoDwell.enabled", "scan.autoDwell.halfLifeMin", "scan.autoDwell.minFactor", "scan.autoDwell.maxFactor",
      "scan.priorityRevisit.enabled", "scan.priorityRevisit.everyMs", "scan.priorityRevisit.lookMs",
      "scan.helperReadyTimeoutMs", "scan.helperSilenceTimeoutMs",
    ]));
    expect(KNOB_FIELDS).toHaveLength(24);
    expect(KNOB_FIELDS.filter((f) => f.band === "sound").map((f) => f.id))
      .toEqual(["kAgcTarget", "kAgcMax", "kLpf", "kHpf", "kAmGain"]);
  });

  it("maps bands to costs", () => {
    expect(BAND_COST).toEqual({ sound: "scan", loudness: "scan", shape: "scan", schedule: "live", watchdog: "backend" });
  });
});

describe("readKnob", () => {
  it("blank for an unset number, scaled to UI units when set", () => {
    const cfg = baseCfg();
    expect(readKnob(cfg, KNOB_BY_ID.kRate!)).toBe("");
    cfg.scan.sampleRateHz = 2_500_000;
    expect(readKnob(cfg, KNOB_BY_ID.kRate!)).toBe("2.5");
    cfg.scan.priorityRevisit = { everyMs: 8000 };
    expect(readKnob(cfg, KNOB_BY_ID.kRevisitEvery!)).toBe("8");
  });

  it("switches fall back to their default", () => {
    const cfg = baseCfg();
    expect(readKnob(cfg, KNOB_BY_ID.kAutoDwell!)).toBe(true);
    cfg.scan.autoDwell = { enabled: false };
    expect(readKnob(cfg, KNOB_BY_ID.kAutoDwell!)).toBe(false);
  });
});

describe("parseKnob", () => {
  it("blank = undefined (the default)", () => {
    expect(parseKnob(KNOB_BY_ID.kAgcTarget!, "  ")).toBeUndefined();
  });
  it("rejects out-of-range and non-numbers with the label and range", () => {
    expect(() => parseKnob(KNOB_BY_ID.kAgcTarget!, "-2")).toThrow("Target loudness: −40…−3 dBFS");
    expect(() => parseKnob(KNOB_BY_ID.kAgcTarget!, "loud")).toThrow("Target loudness");
  });
  it("hum filter accepts 0 (off) but not 1…49", () => {
    expect(parseKnob(KNOB_BY_ID.kHpf!, "0")).toBe(0);
    expect(() => parseKnob(KNOB_BY_ID.kHpf!, "20")).toThrow("0 (off) or 50…1000 Hz");
    expect(parseKnob(KNOB_BY_ID.kHpf!, "250")).toBe(250);
  });
  it("converts to config units and rounds integer fields", () => {
    expect(parseKnob(KNOB_BY_ID.kRate!, "2.55")).toBe(2_550_000);
    expect(parseKnob(KNOB_BY_ID.kRevisitLook!, "0.7")).toBe(700);
    expect(parseKnob(KNOB_BY_ID.kLanes!, "31.6")).toBe(32);
    expect(parseKnob(KNOB_BY_ID.kLimCeil!, "0.65")).toBe(0.65);
  });
  it("sample rate must be a multiple of 50 kHz", () => {
    expect(() => parseKnob(KNOB_BY_ID.kRate!, "2.52")).toThrow("multiple of 0.05");
  });
});

describe("knobUi", () => {
  it("returns the typed UI value, or the default when blank/invalid", () => {
    expect(knobUi({ kAgcTarget: "-20" }, "kAgcTarget")).toBe(-20);
    expect(knobUi({ kAgcTarget: "" }, "kAgcTarget")).toBe(-18);
    expect(knobUi({ kAgcTarget: "x" }, "kAgcTarget")).toBe(-18);
    expect(knobUi({}, "kWindow")).toBe(2.4);
  });
});

describe("windowError / applyKnobs", () => {
  it("window must fit inside rate − 50 kHz", () => {
    expect(windowError(2_400_000, 2_500_000)).toBeNull();
    expect(windowError(2_500_000, 2_500_000)).toBe("Window 2.5 MHz is wider than rate − 0.05 (2.45). Raise the rate or narrow the window.");
  });

  it("writes set fields, deletes blank ones, keeps unrelated config", () => {
    const cfg = baseCfg();
    cfg.audio.agcReleaseMs = 900;
    cfg.scan.priorityRevisit = { everyMs: 9000, lookMs: 800 };
    const out = applyKnobs(cfg, KNOB_FIELDS, {
      kAgcTarget: "-20", kAgcRelease: "", kRevisitEvery: "", kRevisitLook: "1.2", kRevisit: false, kAutoDwell: true,
    });
    expect(out.audio.agcTargetDb).toBe(-20);
    expect("agcReleaseMs" in out.audio).toBe(false);
    expect(out.scan.priorityRevisit).toEqual({ lookMs: 1200, enabled: false });
    expect(out.scan.autoDwell).toEqual({ enabled: true });
    expect(out.audio.volume).toBe(40);
  });

  it("drops an emptied nested object entirely", () => {
    const cfg = baseCfg();
    cfg.scan.autoDwell = { halfLifeMin: 10 };
    applyKnobs(cfg, [KNOB_BY_ID.kHalfLife!], { kHalfLife: "" });
    expect(cfg.scan.autoDwell).toBeUndefined();
  });

  it("rejects a window wider than the (new or existing) rate allows", () => {
    const cfg = baseCfg();
    cfg.scan.sampleRateHz = 2_500_000;
    expect(() => applyKnobs(cfg, KNOB_FIELDS, { kWindow: "2.5" })).toThrow("wider than rate");
    expect(() => applyKnobs(baseCfg(), KNOB_FIELDS, { kWindow: "2.5", kRate: "2.6" })).not.toThrow();
  });
});

describe("dirtyBands / saveCost", () => {
  it("collects the bands whose values changed", () => {
    const loaded = { kAgcTarget: "", kHalfLife: "30", kReadyTo: "" };
    expect(dirtyBands(KNOB_FIELDS, loaded, { ...loaded })).toEqual(new Set());
    expect(dirtyBands(KNOB_FIELDS, loaded, { ...loaded, kHalfLife: "20", kReadyTo: "12" }))
      .toEqual(new Set(["schedule", "watchdog"]));
  });

  it("sound card names the restart once dirty", () => {
    expect(saveCost("sound", new Set())).toEqual({
      label: "Save sound", note: "Volume and mute stay on the Now panel and apply instantly.", warn: false,
    });
    expect(saveCost("sound", new Set(["sound"]))).toEqual({
      label: "Save and restart scanning", note: "Audio cuts for a moment and the wall replays its warm-up.", warn: true,
    });
  });

  it("advanced card joins the costs of dirty bands", () => {
    expect(saveCost("advanced", new Set())).toEqual({ label: "Save engine settings", note: "Nothing changed.", warn: false });
    expect(saveCost("advanced", new Set(["schedule"]))).toEqual({
      label: "Save engine settings", note: "Scheduling applies at once.", warn: false,
    });
    expect(saveCost("advanced", new Set(["shape", "schedule", "watchdog"]))).toEqual({
      label: "Save and restart scanning",
      note: "Audio cuts for a moment; scheduling applies at once; watchdogs apply after a backend restart (System → Restart radio backend).",
      warn: true,
    });
  });
});
```

- [ ] **Step 2: Run it and check that it fails**

Run: `cd kiosk && npx vitest run test/engineKnobs.test.ts`
Expected: FAIL, because `engineKnobs.js` doesn't exist yet.

- [ ] **Step 3: Create `engineKnobs.ts` with the table and helpers**

```ts
// Engine knobs in the admin (spec docs/superpowers/specs/2026-09-27-engine-knobs-admin-design.md).
// Pure (no DOM): ONE field table drives markup, load, save, validation and dirty
// tracking, so ~24 knobs aren't 24 hand-written blocks. Values in the table's
// min/max/step/def are UI units; config value = UI value x scale.
import type { Config } from "../../backend/config/schema.js";
import {
  AUTO_DWELL_DEFAULTS, PRIORITY_REVISIT_DEFAULTS, HELPER_DEFAULTS,
  DEFAULT_LANES_PER_GROUP, DEFAULT_SAMPLE_RATE_HZ, DEFAULT_WINDOW_BANDWIDTH_HZ, DEFAULT_FLAT_BANDWIDTH_HZ,
  DEFAULT_READY_TIMEOUT_MS, DEFAULT_SILENCE_TIMEOUT_MS,
  LANE_HZ, MAX_LANES_PER_GROUP, MIN_SAMPLE_RATE_HZ, MAX_SAMPLE_RATE_HZ,
} from "../../backend/config/engineDefaults.js";

export type Band = "sound" | "loudness" | "shape" | "schedule" | "watchdog";
export type Cost = "scan" | "live" | "backend";

// What a save of each band costs — mirrors the server's PUT /api/config diff:
// autoDwell/priorityRevisit are stripped and applied live; the watchdogs are
// read at engine construction; everything else restarts the engine.
export const BAND_COST: Record<Band, Cost> = {
  sound: "scan", loudness: "scan", shape: "scan", schedule: "live", watchdog: "backend",
};
export const COST_LABEL: Record<Cost, string> = {
  scan: "Restarts scanning", live: "Applies live", backend: "Needs a backend restart",
};

export interface KnobField {
  id: string;
  path: readonly string[];
  band: Band;
  label: string;
  hint: string;
  unit: string;
  kind: "number" | "switch";
  /** config value = UI value x scale */
  scale: number;
  /** config value is an integer (rounded after scaling) */
  int?: boolean;
  min: number;
  max: number;
  step: number;
  def: number | boolean;
  /** 0 is valid below min (hum filter: 0 = off) */
  allowZero?: boolean;
  /** sub-heading rendered above this row */
  sub?: string;
}

const H = HELPER_DEFAULTS;
const num = (f: Omit<KnobField, "kind" | "scale"> & { scale?: number }): KnobField =>
  ({ kind: "number", scale: 1, ...f });
const sw = (f: Pick<KnobField, "id" | "path" | "band" | "label" | "hint" | "def" | "sub">): KnobField =>
  ({ kind: "switch", unit: "", scale: 1, min: 0, max: 1, step: 1, ...f });

export const KNOB_FIELDS: readonly KnobField[] = [
  // ---- Sound card (everyday)
  num({ id: "kAgcTarget", path: ["audio", "agcTargetDb"], band: "sound", label: "Target loudness", hint: "Where every transmission is steered", unit: "dBFS", min: -40, max: -3, step: 1, def: H.agcTargetDb }),
  num({ id: "kAgcMax", path: ["audio", "agcMaxGainDb"], band: "sound", label: "Max boost", hint: "Most a quiet talker is lifted", unit: "dB", min: 0, max: 30, step: 1, def: H.agcMaxGainDb }),
  num({ id: "kLpf", path: ["scan", "fmAudioLpfHz"], band: "sound", label: "Hiss cut (FM)", hint: "Lower = less weak-signal hiss, duller voice", unit: "Hz", min: 1000, max: 24000, step: 100, def: H.fmAudioLpfHz }),
  num({ id: "kHpf", path: ["scan", "fmAudioHpfHz"], band: "sound", label: "Hum filter (FM)", hint: "Strips the sub-audible tone; 0 = off", unit: "Hz", min: 50, max: 1000, step: 10, def: H.fmAudioHpfHz, allowZero: true }),
  num({ id: "kAmGain", path: ["scan", "nativeAmGainDb"], band: "sound", label: "Airband balance", hint: "AM loudness against FM", unit: "dB", min: -30, max: 20, step: 1, def: H.nativeAmGainDb }),
  // ---- Loudness detail
  num({ id: "kAgcAttack", path: ["audio", "agcAttackMs"], band: "loudness", label: "Attack", hint: "How fast a loud burst is pulled down", unit: "ms", min: 1, max: 200, step: 1, def: H.agcAttackMs }),
  num({ id: "kAgcRelease", path: ["audio", "agcReleaseMs"], band: "loudness", label: "Release", hint: "How fast a quiet talker is lifted", unit: "ms", min: 20, max: 5000, step: 10, def: H.agcReleaseMs }),
  num({ id: "kAgcHold", path: ["audio", "agcHoldBelowDb"], band: "loudness", label: "Hold below", hint: "Pauses quieter than this freeze the gain", unit: "dBFS", min: -90, max: -20, step: 1, def: H.agcHoldBelowDb }),
  num({ id: "kAgcMin", path: ["audio", "agcMinGainDb"], band: "loudness", label: "Min gain", hint: "Most a loud talker is cut", unit: "dB", min: -40, max: 0, step: 1, def: H.agcMinGainDb }),
  num({ id: "kLimCeil", path: ["audio", "limiterCeiling"], band: "loudness", label: "Limiter ceiling", hint: "Peak level, linear (at most 0.8)", unit: "FS", min: 0.05, max: 0.8, step: 0.05, def: H.limiterCeiling }),
  num({ id: "kLimRel", path: ["audio", "limiterReleaseMs"], band: "loudness", label: "Limiter release", hint: "Recovery after a clipped peak", unit: "ms", min: 5, max: 1000, step: 5, def: H.limiterReleaseMs }),
  // ---- Group shape
  num({ id: "kLanes", path: ["scan", "lanesPerGroup"], band: "shape", label: "Lanes per group", hint: "Channels one tune can hold", unit: "", min: 1, max: MAX_LANES_PER_GROUP, step: 1, def: DEFAULT_LANES_PER_GROUP, int: true }),
  num({ id: "kRate", path: ["scan", "sampleRateHz"], band: "shape", label: "Sample rate", hint: "Above ~2.56 Msps dongles tend to drop samples", unit: "Msps", scale: 1e6, int: true, min: MIN_SAMPLE_RATE_HZ / 1e6, max: MAX_SAMPLE_RATE_HZ / 1e6, step: 0.05, def: DEFAULT_SAMPLE_RATE_HZ / 1e6 }),
  num({ id: "kWindow", path: ["scan", "windowBandwidthHz"], band: "shape", label: "Window", hint: "Widest group span, at most rate − 0.05", unit: "MHz", scale: 1e6, int: true, min: 0.1, max: (MAX_SAMPLE_RATE_HZ - LANE_HZ) / 1e6, step: 0.05, def: DEFAULT_WINDOW_BANDWIDTH_HZ / 1e6 }),
  num({ id: "kFlat", path: ["scan", "flatBandwidthHz"], band: "shape", label: "Flat passband", hint: "Grouping keeps channels inside this where it's free", unit: "MHz", scale: 1e6, int: true, min: 0.1, max: (MAX_SAMPLE_RATE_HZ - LANE_HZ) / 1e6, step: 0.05, def: DEFAULT_FLAT_BANDWIDTH_HZ / 1e6 }),
  // ---- Scheduling
  sw({ id: "kAutoDwell", path: ["scan", "autoDwell", "enabled"], band: "schedule", label: "Smart dwell", hint: "Busy groups get longer, idle ones shorter", def: AUTO_DWELL_DEFAULTS.enabled }),
  num({ id: "kHalfLife", path: ["scan", "autoDwell", "halfLifeMin"], band: "schedule", label: "Memory", hint: "Half-life of the activity count", unit: "min", min: 1, max: 1440, step: 1, def: AUTO_DWELL_DEFAULTS.halfLifeMin }),
  num({ id: "kMinFactor", path: ["scan", "autoDwell", "minFactor"], band: "schedule", label: "Idle group floor", hint: "Shortest dwell, as a multiple of group dwell", unit: "×", min: 0.2, max: 1, step: 0.1, def: AUTO_DWELL_DEFAULTS.minFactor }),
  num({ id: "kMaxFactor", path: ["scan", "autoDwell", "maxFactor"], band: "schedule", label: "Busy group ceiling", hint: "Longest dwell, as a multiple of group dwell", unit: "×", min: 1, max: 5, step: 0.1, def: AUTO_DWELL_DEFAULTS.maxFactor }),
  sw({ id: "kRevisit", path: ["scan", "priorityRevisit", "enabled"], band: "schedule", label: "Peek at priority channels", hint: "", def: PRIORITY_REVISIT_DEFAULTS.enabled, sub: "Priority revisit" }),
  num({ id: "kRevisitEvery", path: ["scan", "priorityRevisit", "everyMs"], band: "schedule", label: "Every", hint: "Quiet scanning between peeks", unit: "s", scale: 1000, int: true, min: 1, max: 60, step: 0.5, def: PRIORITY_REVISIT_DEFAULTS.everyMs / 1000 }),
  num({ id: "kRevisitLook", path: ["scan", "priorityRevisit", "lookMs"], band: "schedule", label: "Look", hint: "Length of one peek (0.7 s or more to open)", unit: "s", scale: 1000, int: true, min: 0.3, max: 5, step: 0.1, def: PRIORITY_REVISIT_DEFAULTS.lookMs / 1000 }),
  // ---- Helper watchdogs
  num({ id: "kReadyTo", path: ["scan", "helperReadyTimeoutMs"], band: "watchdog", label: "Ready timeout", hint: "Startup grace before a respawn", unit: "s", scale: 1000, int: true, min: 1, max: 120, step: 1, def: DEFAULT_READY_TIMEOUT_MS / 1000 }),
  num({ id: "kSilenceTo", path: ["scan", "helperSilenceTimeoutMs"], band: "watchdog", label: "Silence timeout", hint: "No events for this long counts as stalled", unit: "s", scale: 1000, int: true, min: 1, max: 120, step: 1, def: DEFAULT_SILENCE_TIMEOUT_MS / 1000 }),
];

export const KNOB_BY_ID: Record<string, KnobField> = Object.fromEntries(KNOB_FIELDS.map((f) => [f.id, f]));

export const ADVANCED_BANDS: ReadonlyArray<{ band: Exclude<Band, "sound">; title: string; purpose: string }> = [
  { band: "loudness", title: "Loudness detail", purpose: "How fast the leveller reacts, and the peak limiter behind it." },
  { band: "shape", title: "Group shape", purpose: "How many channels one SDR tune covers. Fewer groups make a shorter cycle." },
  { band: "schedule", title: "Scheduling", purpose: "How long each group gets, and peeks at priority channels." },
  { band: "watchdog", title: "Helper watchdogs", purpose: "When a stalled DSP helper is killed and respawned. Saved now, used after the next backend restart (System → Restart radio backend)." },
];

export type KnobValues = Record<string, string | boolean>;

// Trim float noise (2.5000000001 -> "2.5") for display.
const fmt = (n: number): string => String(Number(n.toFixed(4)));
const minus = (s: string): string => s.replace(/-/g, "−");

function getAt(obj: unknown, path: readonly string[]): unknown {
  let cur: unknown = obj;
  for (const k of path) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

// Set (or, for undefined, delete) a nested key, creating intermediate objects
// and removing any intermediate object the delete leaves empty.
function setAt(obj: Record<string, unknown>, path: readonly string[], value: unknown): void {
  const [head, ...rest] = path;
  if (head === undefined) return;
  if (rest.length === 0) {
    if (value === undefined) delete obj[head];
    else obj[head] = value;
    return;
  }
  const child = obj[head];
  const next: Record<string, unknown> = child !== null && typeof child === "object" ? child as Record<string, unknown> : {};
  setAt(next, rest, value);
  if (Object.keys(next).length === 0) delete obj[head];
  else obj[head] = next;
}

export function readKnob(cfg: Config, f: KnobField): string | boolean {
  const v = getAt(cfg, f.path);
  if (f.kind === "switch") return typeof v === "boolean" ? v : f.def as boolean;
  return typeof v === "number" ? fmt(v / f.scale) : "";
}

function rangeText(f: KnobField): string {
  const u = f.unit ? ` ${f.unit}` : "";
  const r = `${minus(fmt(f.min))}…${minus(fmt(f.max))}${u}`;
  return f.allowZero ? `0 (off) or ${r}` : r;
}

export function parseKnob(f: KnobField, raw: string): number | undefined {
  const s = raw.trim();
  if (s === "") return undefined;
  const n = Number(s);
  const inRange = Number.isFinite(n) && ((n >= f.min && n <= f.max) || (f.allowZero === true && n === 0));
  if (!inRange) throw new Error(`${f.label}: ${rangeText(f)}`);
  const v = f.scale === 1 && !f.int ? n : Math.round(n * f.scale);
  if (f.path.join(".") === "scan.sampleRateHz" && v % LANE_HZ !== 0) {
    throw new Error(`${f.label}: a multiple of ${fmt(LANE_HZ / 1e6)} Msps`);
  }
  return v;
}

export function knobUi(values: KnobValues, id: string): number {
  const f = KNOB_BY_ID[id];
  if (!f) throw new Error(`unknown knob ${id}`);
  const raw = values[id];
  if (typeof raw === "string" && raw.trim() !== "") {
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
  }
  return f.def as number;
}

export function windowError(windowHz: number, rateHz: number): string | null {
  if (windowHz <= rateHz - LANE_HZ) return null;
  return `Window ${fmt(windowHz / 1e6)} MHz is wider than rate − ${fmt(LANE_HZ / 1e6)} (${fmt((rateHz - LANE_HZ) / 1e6)}). Raise the rate or narrow the window.`;
}

export function applyKnobs(cfg: Config, fields: readonly KnobField[], values: KnobValues): Config {
  const root = cfg as unknown as Record<string, unknown>;
  for (const f of fields) {
    if (!(f.id in values)) continue;
    const raw = values[f.id];
    const v = f.kind === "switch" ? raw === true : parseKnob(f, typeof raw === "string" ? raw : "");
    setAt(root, f.path, v);
  }
  const rate = cfg.scan.sampleRateHz ?? DEFAULT_SAMPLE_RATE_HZ;
  const win = cfg.scan.windowBandwidthHz ?? DEFAULT_WINDOW_BANDWIDTH_HZ;
  const err = windowError(win, rate);
  if (err) throw new Error(err);
  return cfg;
}

export function dirtyBands(fields: readonly KnobField[], loaded: KnobValues, current: KnobValues): Set<Band> {
  const out = new Set<Band>();
  for (const f of fields) {
    if (f.id in current && current[f.id] !== loaded[f.id]) out.add(f.band);
  }
  return out;
}

export function saveCost(card: "sound" | "advanced", bands: ReadonlySet<Band>): { label: string; note: string; warn: boolean } {
  if (card === "sound") {
    return bands.size > 0
      ? { label: "Save and restart scanning", note: "Audio cuts for a moment and the wall replays its warm-up.", warn: true }
      : { label: "Save sound", note: "Volume and mute stay on the Now panel and apply instantly.", warn: false };
  }
  const costs = new Set([...bands].map((b) => BAND_COST[b]));
  const bits: string[] = [];
  if (costs.has("scan")) bits.push("audio cuts for a moment");
  if (costs.has("live")) bits.push("scheduling applies at once");
  if (costs.has("backend")) bits.push("watchdogs apply after a backend restart (System → Restart radio backend)");
  const note = bits.length ? bits.join("; ").replace(/^./, (c) => c.toUpperCase()) + "." : "Nothing changed.";
  return { label: costs.has("scan") ? "Save and restart scanning" : "Save engine settings", note, warn: costs.has("scan") };
}
```

The `{ kAutoDwell: true }` case in the test writes `enabled: true` explicitly.
That's intended: a switch always saves its state. If the operator never touched
it, it saves the value it was loaded with, which is the same thing.

- [ ] **Step 4: Run the tests and check they pass**

Run: `cd kiosk && npx vitest run test/engineKnobs.test.ts`
Expected: PASS. If `parseKnob(kRate, "2.55")` fails on float rounding, check that
`Math.round(2.55 * 1e6) === 2550000`. It is, and the multiple-of-50 kHz check
runs after rounding.

- [ ] **Step 5: Typecheck**

Run: `cd kiosk && npm run typecheck`
Expected: exit 0. If `cfg.scan.priorityRevisit = { everyMs: 8000 }` in the test fails
typecheck because the schema type requires other keys, cast with `as Config["scan"]["priorityRevisit"]`.

- [ ] **Step 6: Commit**

```bash
git add kiosk/src/frontend/admin/engineKnobs.ts kiosk/test/engineKnobs.test.ts
git commit -m "feat(admin): engine knob field table with load/save/validate/dirty helpers"
```

---

### Task 3: Loudness curve and group-shape preview helpers

**Files:**
- Modify: `kiosk/src/frontend/admin/engineKnobs.ts` (append)
- Test: `kiosk/test/engineKnobs.test.ts` (append)

**Interfaces:**
- Consumes: `windowError` (Task 2); `groupChannels` from `../../backend/engine/grouping.js` (`groupChannels(channels, windowHz, maxPerGroup, { flatHz })` → `Array<{ centerHz: number; channels: Channel[] }>`); `isScannable(c, banks)` and `profileFor(c, banks)` from `../../backend/config/banks.js`.
- Produces:
  - `interface CurveParams { targetDb: number; maxGainDb: number; minGainDb: number; holdBelowDb: number; limiterCeiling: number }`
  - `loudnessOut(xDb: number, p: CurveParams): number`
  - `loudnessCurve(p: CurveParams): { points: Array<[number, number]>; ceilDb: number; caption: string }`
  - `curveSvg(p: CurveParams): string` (inner markup for `<svg viewBox="0 0 300 150">`, CSS classes `lc-*`)
  - `interface PreviewInput { channels: Channel[]; banks: Bank[]; lanes: number; windowHz: number; flatHz: number; rateHz: number; groupDwellMs: number }`
  - `type Preview = { ok: true; groups: number; channels: number; edge: number; cycleS: number; priorityGroups: number } | { ok: false; error: string }`
  - `previewGroups(i: PreviewInput): Preview`, `previewText(p: Preview): string`, `revisitHint(p: Preview): string`

- [ ] **Step 1: Append the failing tests**

Append to `kiosk/test/engineKnobs.test.ts`. Merge the new names into the existing
import from `engineKnobs.js`, and add the type import:

```ts
import type { Channel } from "../src/backend/config/schema.js";
import { loudnessOut, loudnessCurve, curveSvg, previewGroups, previewText, revisitHint } from "../src/frontend/admin/engineKnobs.js";

const P = { targetDb: -18, maxGainDb: 15, minGainDb: -20, holdBelowDb: -50, limiterCeiling: 0.7 };

describe("loudness curve", () => {
  it("steers the level window to the target, clamps outside it, caps at the limiter", () => {
    expect(loudnessOut(-30, P)).toBe(-18);             // inside the boost range
    expect(loudnessOut(-40, P)).toBe(-25);             // quieter than target-max: +15 only
    expect(loudnessOut(-5, P)).toBe(-18);              // cut 13 dB (within -20)
    expect(loudnessOut(0, { ...P, targetDb: -3, minGainDb: 0 })).toBeCloseTo(20 * Math.log10(0.7), 6); // limiter cap
  });
  it("captions the flat range", () => {
    expect(loudnessCurve(P).caption).toBe("Talkers from −33 to 2 dBFS come out at −18");
    expect(loudnessCurve(P).points).toHaveLength(71);   // -70..0 dB in 1 dB steps
  });
  it("renders SVG with the curve, target, ceiling and hold region", () => {
    const svg = curveSvg(P);
    for (const cls of ["lc-hold", "lc-unity", "lc-target", "lc-ceil", "lc-curve", "lc-axis"]) expect(svg).toContain(`class="${cls}"`);
    expect(svg).toContain("target −18");
  });
});

const ch = (freq: number, extra: Partial<Channel> = {}): Channel =>
  ({ id: `c${freq}`, freq, alphaTag: String(freq), mode: "nfm", enabled: true, ...extra } as Channel);

describe("group-shape preview", () => {
  const channels = [
    ch(146_000_000), ch(146_500_000), ch(147_100_000, { priority: true }),  // one group at 2.4 MHz
    ch(462_000_000), ch(462_700_000),                                         // another
    ch(155_000_000, { enabled: false }),                                      // archived: not scanned
  ];
  const base = { channels, banks: [], lanes: 32, windowHz: 2_400_000, flatHz: 2_000_000, rateHz: 2_500_000, groupDwellMs: 1500 };

  it("counts groups, channels, edge channels, cycle and priority groups", () => {
    const p = previewGroups(base);
    expect(p).toEqual({ ok: true, groups: 2, channels: 5, edge: 0, cycleS: 3, priorityGroups: 1 });
    expect(previewText(p)).toBe("2 groups from 5 channels, 0 outside the flat passband. Quiet cycle ≈ 3 s.");
    expect(revisitHint(p)).toBe("Peeks at 1 priority group");
  });

  it("lane cap splits groups; narrow flat flags edges", () => {
    expect(previewGroups({ ...base, lanes: 1 })).toMatchObject({ ok: true, groups: 5 });
    const p = previewGroups({ ...base, flatHz: 200_000 });
    expect(p.ok && p.edge).toBeGreaterThan(0);
  });

  it("errors when the window doesn't fit the rate", () => {
    const p = previewGroups({ ...base, windowHz: 2_500_000 });
    expect(p).toEqual({ ok: false, error: "Window 2.5 MHz is wider than rate − 0.05 (2.45). Raise the rate or narrow the window." });
    expect(previewText(p)).toBe(p.ok ? "" : p.error);
  });

  it("idle revisit hint when nothing is priority", () => {
    const p = previewGroups({ ...base, channels: channels.map((c) => ({ ...c, priority: false })) });
    expect(revisitHint(p)).toBe("No channel is marked priority yet, so this is idle");
  });
});
```

- [ ] **Step 2: Run it and check that it fails**

Run: `cd kiosk && npx vitest run test/engineKnobs.test.ts`
Expected: FAIL, because `loudnessOut` (and the other new helpers) aren't exported yet.

- [ ] **Step 3: Append the implementation to `engineKnobs.ts`**

Add to the imports at the top:

```ts
import type { Bank, Channel } from "../../backend/config/schema.js";
import { groupChannels } from "../../backend/engine/grouping.js";
import { isScannable, profileFor } from "../../backend/config/banks.js";
```

This merges with the existing `import type { Config }` into
`import type { Bank, Channel, Config }`. Then append:

```ts
// ---- Loudness curve: first-order steady-state picture of the speaker AGC +
// limiter (attack/release not modelled): out = min(ceil, x + clamp(target - x,
// minGain, maxGain)), levels in dBFS, ceiling = 20 log10(limiterCeiling).
export interface CurveParams { targetDb: number; maxGainDb: number; minGainDb: number; holdBelowDb: number; limiterCeiling: number }

const CURVE_LO = -70;
const CURVE_HI = 0;

export function loudnessOut(xDb: number, p: CurveParams): number {
  const ceil = 20 * Math.log10(p.limiterCeiling);
  const gain = Math.max(p.minGainDb, Math.min(p.maxGainDb, p.targetDb - xDb));
  return Math.min(ceil, xDb + gain);
}

export function loudnessCurve(p: CurveParams): { points: Array<[number, number]>; ceilDb: number; caption: string } {
  const points: Array<[number, number]> = [];
  for (let x = CURVE_LO; x <= CURVE_HI; x++) points.push([x, loudnessOut(x, p)]);
  const caption = `Talkers from ${minus(fmt(p.targetDb - p.maxGainDb))} to ${minus(fmt(p.targetDb - p.minGainDb))} dBFS come out at ${minus(fmt(p.targetDb))}`;
  return { points, ceilDb: 20 * Math.log10(p.limiterCeiling), caption };
}

export function curveSvg(p: CurveParams): string {
  const L = 30, R = 292, T = 8, B = 128;
  const sx = (x: number): number => L + (x - CURVE_LO) / (CURVE_HI - CURVE_LO) * (R - L);
  const sy = (y: number): number => B - (Math.max(CURVE_LO, y) - CURVE_LO) / (CURVE_HI - CURVE_LO) * (B - T);
  const { points, ceilDb } = loudnessCurve(p);
  const d = points.map(([x, y], i) => `${i ? "L" : "M"}${sx(x).toFixed(1)} ${sy(y).toFixed(1)}`).join("");
  const holdX = sx(Math.max(CURVE_LO, Math.min(CURVE_HI, p.holdBelowDb)));
  const ticks = [-60, -40, -20, 0].map((v) => `<text x="${sx(v)}" y="${B + 12}" text-anchor="middle">${minus(String(v))}</text>`).join("");
  return (
    `<rect class="lc-hold" x="${L}" y="${T}" width="${(holdX - L).toFixed(1)}" height="${B - T}"/>` +
    `<text x="${L + 4}" y="${T + 12}">gain held</text>` +
    `<line class="lc-unity" x1="${sx(CURVE_LO)}" y1="${sy(CURVE_LO)}" x2="${sx(CURVE_HI)}" y2="${sy(CURVE_HI)}"/>` +
    `<line class="lc-target" x1="${L}" y1="${sy(p.targetDb).toFixed(1)}" x2="${R}" y2="${sy(p.targetDb).toFixed(1)}"/>` +
    `<text x="${R - 2}" y="${(sy(p.targetDb) - 4).toFixed(1)}" text-anchor="end">target ${minus(fmt(p.targetDb))}</text>` +
    `<line class="lc-ceil" x1="${L}" y1="${sy(ceilDb).toFixed(1)}" x2="${R}" y2="${sy(ceilDb).toFixed(1)}"/>` +
    `<text x="${L + 4}" y="${(sy(ceilDb) - 3).toFixed(1)}">limiter</text>` +
    `<path class="lc-curve" d="${d}"/>` +
    `<line class="lc-axis" x1="${L}" y1="${B}" x2="${R}" y2="${B}"/>` +
    ticks
  );
}

// ---- Group-shape preview: the same pure grouping the engine runs, over the
// channels the server would scan (isScannable, as toScanConfig filters). No
// NWR background channel: the appliance has a dedicated weather radio.
// Cycle = sum of each group's dwell (groupDwellMs x its max bank dwellWeight) at
// autoDwell factor 1. The dwell timer runs from the tune, so the ~0.64 s post-
// hop warm-up is inside it (measured 2026-09-27: 10 groups at 1500 ms ~ 15.5 s).
// "Quiet" because holds lengthen it.
export interface PreviewInput { channels: Channel[]; banks: Bank[]; lanes: number; windowHz: number; flatHz: number; rateHz: number; groupDwellMs: number }
export type Preview =
  | { ok: true; groups: number; channels: number; edge: number; cycleS: number; priorityGroups: number }
  | { ok: false; error: string };

export function previewGroups(i: PreviewInput): Preview {
  const err = windowError(i.windowHz, i.rateHz);
  if (err) return { ok: false, error: err };
  const scannable = i.channels.filter((c) => isScannable(c, i.banks));
  const groups = groupChannels(scannable, i.windowHz, Math.max(1, Math.round(i.lanes)), { flatHz: i.flatHz });
  let channels = 0, edge = 0, dwellMs = 0, priorityGroups = 0;
  for (const g of groups) {
    channels += g.channels.length;
    edge += g.channels.filter((c) => Math.abs(c.freq - g.centerHz) > i.flatHz / 2).length;
    dwellMs += i.groupDwellMs * Math.max(1, ...g.channels.map((c) => profileFor(c, i.banks).dwellWeight ?? 1));
    if (g.channels.some((c) => c.priority === true)) priorityGroups++;
  }
  return { ok: true, groups: groups.length, channels, edge, cycleS: Math.round(dwellMs / 100) / 10, priorityGroups };
}

export function previewText(p: Preview): string {
  if (!p.ok) return p.error;
  return `${p.groups} group${p.groups === 1 ? "" : "s"} from ${p.channels} channels, ${p.edge} outside the flat passband. Quiet cycle ≈ ${fmt(p.cycleS)} s.`;
}

export function revisitHint(p: Preview): string {
  if (!p.ok || p.priorityGroups === 0) return "No channel is marked priority yet, so this is idle";
  return `Peeks at ${p.priorityGroups} priority group${p.priorityGroups === 1 ? "" : "s"}`;
}
```

Why `Math.max(1, …dwellWeight)`: the engine uses
`Math.max(...group.channels.map((c) => c.dwellWeight ?? 1))`. The leading `1`
matches that for every real group, and it also guards an empty spread.

- [ ] **Step 4: Run the tests and check they pass**

Run: `cd kiosk && npx vitest run test/engineKnobs.test.ts`
Expected: PASS. The `cycleS: 3` case is 2 groups × 1500 ms × dwellWeight 1.
If the grouping test's `groups: 2` fails, print `previewGroups(base)`. 146.0–147.1
spans 1.1 MHz, which fits one 2.4 MHz group. 462.0–462.7 is the second group.

- [ ] **Step 5: Commit**

```bash
git add kiosk/src/frontend/admin/engineKnobs.ts kiosk/test/engineKnobs.test.ts
git commit -m "feat(admin): loudness curve and group-shape preview helpers"
```

---

### Task 4: Server validation errors reach the UI

**Files:**
- Modify: `kiosk/src/frontend/lib/api.ts:3-13`
- Test: `kiosk/test/apiErrors.test.ts`

**Interfaces:**
- Produces: `api.putConfig` rejects with the message `"<error>: <path.joined> — <message>"` when the server's 400 body carries `issues[0]`. Otherwise the message is unchanged.

- [ ] **Step 1: Write the failing test**

`kiosk/test/apiErrors.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { api } from "../src/frontend/lib/api.js";
import type { Config } from "../src/backend/config/schema.js";

afterEach(() => { vi.unstubAllGlobals(); });

describe("api error text", () => {
  it("appends the first zod issue to a 400", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      error: "invalid config",
      issues: [{ path: ["scan", "windowBandwidthHz"], message: "windowBandwidthHz 2500000 exceeds sampleRateHz 2500000 minus 50000 (edge channels can't be placed)" }],
    }), { status: 400 })));
    await expect(api.putConfig({} as Config)).rejects.toThrow(
      "invalid config: scan.windowBandwidthHz — windowBandwidthHz 2500000 exceeds sampleRateHz 2500000 minus 50000 (edge channels can't be placed)");
  });

  it("keeps a plain error unchanged", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "stale config" }), { status: 409 })));
    await expect(api.putConfig({} as Config)).rejects.toThrow(/^stale config$/);
  });
});
```

- [ ] **Step 2: Run it and check that it fails**

Run: `cd kiosk && npx vitest run test/apiErrors.test.ts`
Expected: the first test FAILS (message is just "invalid config") and the second passes.
If importing `api.ts` throws under node (a `window`/`document` reference at
module load), stop and report it. Don't add a DOM environment for this.

- [ ] **Step 3: Change `j()` in `kiosk/src/frontend/lib/api.ts`**

Replace:

```ts
      const parsed = JSON.parse(text) as { error?: string };
      throw new Error(parsed.error ?? text);
```

with:

```ts
      const parsed = JSON.parse(text) as { error?: string; issues?: Array<{ path?: Array<string | number>; message?: string }> };
      // A zod 400 ("invalid config") says nothing on its own: name the first
      // failing field so the card can show why the save was refused.
      const issue = parsed.issues?.[0];
      const detail = issue?.message ? `: ${(issue.path ?? []).join(".")} — ${issue.message}` : "";
      throw new Error((parsed.error ?? text) + detail);
```

- [ ] **Step 4: Run the tests and check they pass**

Run: `cd kiosk && npx vitest run test/apiErrors.test.ts && npm test`
Expected: PASS, and the whole suite passes.

- [ ] **Step 5: Commit**

```bash
git add kiosk/src/frontend/lib/api.ts kiosk/test/apiErrors.test.ts
git commit -m "fix(admin): show the first zod issue when a save is refused"
```

---

### Task 5: Sound and Advanced (engine) cards in the admin

**Files:**
- Modify: `kiosk/src/frontend/admin/admin.ts` (imports; markup in the Settings template; wiring beside the Scanning card code around `:2540-2620`; layout exemption at `:2686-2703`)
- Modify: `kiosk/src/frontend/admin/admin.css` (append)

**Interfaces:**
- Consumes: from `./engineKnobs.js`: `KNOB_FIELDS`, `ADVANCED_BANDS`, `BAND_COST`, `COST_LABEL`, `KnobField`, `KnobValues`, `readKnob`, `knobUi`, `applyKnobs`, `dirtyBands`, `saveCost`, `curveSvg`, `loudnessCurve`, `previewGroups`, `previewText`, `revisitHint`. From `../../backend/config/engineDefaults.js`: `DEFAULT_GROUP_DWELL_MS`.
- Produces: DOM ids `kCurve`, `kCurveSay`, `kSndSave`, `kSndNote`, `kSndErr`, `kPreview`, `kAdvSave`, `kAdvNote`, `kAdvErr`, `kRevisitHint`, plus one input per field id. Cards `details.settingsCard.soundCard` and `details.settingsCard.engineCard`.

- [ ] **Step 1: Import the helpers in `admin.ts`**

Next to the other `../../backend/config/*.js` imports near the top of `admin.ts`, add:

```ts
import {
  KNOB_FIELDS, ADVANCED_BANDS, BAND_COST, COST_LABEL, type KnobField, type KnobValues,
  readKnob, knobUi, applyKnobs, dirtyBands, saveCost, curveSvg, loudnessCurve,
  previewGroups, previewText, revisitHint,
} from "./engineKnobs.js";
import { DEFAULT_GROUP_DWELL_MS } from "../../backend/config/engineDefaults.js";
```

Add a module-level markup helper next to the other small render helpers (for
example just above the function that builds the admin template):

```ts
// One Settings row per engine knob, in the same label/hint/inputUnit shape as
// the hand-written rows (placeholder = the default: blank saves "default").
function knobRow(f: KnobField): string {
  const sub = f.sub ? `<p class="engineSub">${f.sub}</p>` : "";
  if (f.kind === "switch") {
    const hintId = f.id === "kRevisit" ? ` id="kRevisitHint"` : "";
    return `${sub}<label class="switchRow"><span>${f.label} <small${hintId}>${f.hint}</small></span><input id="${f.id}" type="checkbox" /></label>`;
  }
  const lo = f.allowZero ? 0 : f.min;
  return `${sub}<label><span>${f.label} <small>${f.hint}</small></span><span class="inputUnit"><input id="${f.id}" type="number" min="${lo}" max="${f.max}" step="${f.step}" placeholder="${f.def}" /><b>${f.unit}</b></span></label>`;
}
```

- [ ] **Step 2: Add the Sound card markup after the Scanning card**

In the Settings template, find the end of the Scanning card:

```html
        <div class="formActions"><button id="tSave" class="primary">Save scanning</button><span id="tErr" class="err"></span></div>
        </div>
      </details>
```

and insert right after it:

```html
      <details class="settingsCard soundCard">
        <summary><h2>Sound</h2><span class="cardHint">Loudness and filters</span></summary>
        <div class="cardBody">
        <figure class="loudCurve">
          <svg id="kCurve" viewBox="0 0 300 150" role="img" aria-label="Speaker level: input level against output level, steady state (attack and release not shown)"></svg>
          <figcaption id="kCurveSay"></figcaption>
        </figure>
        <div class="settingGroups">${KNOB_FIELDS.filter((f) => f.band === "sound").map(knobRow).join("")}</div>
        <div class="formActions"><button id="kSndSave" class="primary">Save sound</button><span id="kSndNote" class="hint"></span><span id="kSndErr" class="err"></span></div>
        </div>
      </details>
```

- [ ] **Step 3: Add the Advanced (engine) card markup after the Integrations card**

Find the end of the Integrations card:

```html
        <div class="formActions"><button id="igSave" class="primary">Save integrations</button><span id="igErr" class="err"></span></div>
        </div>
      </details>
```

and insert right after it, before the `</div>` that closes `.settingsCards`:

```html
      <details class="settingsCard engineCard">
        <summary><h2>Advanced (engine)</h2><span class="cardHint">Tuned for this appliance. Leave blank for the default.</span></summary>
        <div class="cardBody">
        <div class="engineBands">
          ${ADVANCED_BANDS.map((b) => `
          <div class="engineBand" role="group" aria-labelledby="kBand_${b.band}">
            <h3 id="kBand_${b.band}">${b.title} <span class="cost cost-${BAND_COST[b.band]}">${COST_LABEL[BAND_COST[b.band]]}</span></h3>
            <p class="hint">${b.purpose}</p>
            <div class="settingGroups">${KNOB_FIELDS.filter((f) => f.band === b.band).map(knobRow).join("")}</div>
            ${b.band === "shape" ? `<div id="kPreview" class="derived" role="status" aria-live="polite"></div>` : ""}
          </div>`).join("")}
        </div>
        <div class="formActions"><button id="kAdvSave" class="primary">Save engine settings</button><span id="kAdvNote" class="hint"></span><span id="kAdvErr" class="err"></span></div>
        </div>
      </details>
```

The bands use `<div class="engineBand">`, not `<section>`, because the existing
`.admin section { … }` rule would restyle them.

- [ ] **Step 4: Wire load, dirty, curve, preview and save**

In `admin.ts`, directly after the Scanning card's `#tSave` click handler (the
block ending `} catch (e) { setFieldStatus(tErr, (e as Error).message, "err"); }\n  });`),
insert:

```ts
  // Engine knobs (Sound + Advanced (engine) cards) — table-driven, see
  // engineKnobs.ts. Each card saves only its own fields; the server's PUT diff
  // decides the real cost (scheduling live, everything else restarts scanning).
  const knobEl = (id: string): HTMLInputElement => root.querySelector<HTMLInputElement>(`#${id}`)!;
  const SOUND_FIELDS = KNOB_FIELDS.filter((f) => f.band === "sound");
  const ENGINE_FIELDS = KNOB_FIELDS.filter((f) => f.band !== "sound");
  const knobValues = (fields: readonly KnobField[]): KnobValues =>
    Object.fromEntries(fields.map((f) => [f.id, f.kind === "switch" ? knobEl(f.id).checked : knobEl(f.id).value]));
  const kCurve = root.querySelector<SVGSVGElement>("#kCurve")!;
  const kCurveSay = root.querySelector<HTMLElement>("#kCurveSay")!;
  const kPreview = root.querySelector<HTMLElement>("#kPreview")!;
  const kRevisitHint = root.querySelector<HTMLElement>("#kRevisitHint")!;
  const kSndSave = root.querySelector<HTMLButtonElement>("#kSndSave")!;
  const kSndNote = root.querySelector<HTMLElement>("#kSndNote")!;
  const kSndErr = root.querySelector<HTMLElement>("#kSndErr")!;
  const kAdvSave = root.querySelector<HTMLButtonElement>("#kAdvSave")!;
  const kAdvNote = root.querySelector<HTMLElement>("#kAdvNote")!;
  const kAdvErr = root.querySelector<HTMLElement>("#kAdvErr")!;
  let knobLoaded: KnobValues = {};
  let knobCfg: Config | null = null;

  function writeKnob(f: KnobField, cfg: Config): void {
    const v = readKnob(cfg, f);
    if (typeof v === "boolean") knobEl(f.id).checked = v;
    else knobEl(f.id).value = v;
    knobLoaded[f.id] = v;
  }

  function refreshKnobs(): void {
    const cur = knobValues(KNOB_FIELDS);
    const p = {
      targetDb: knobUi(cur, "kAgcTarget"), maxGainDb: knobUi(cur, "kAgcMax"), minGainDb: knobUi(cur, "kAgcMin"),
      holdBelowDb: knobUi(cur, "kAgcHold"), limiterCeiling: knobUi(cur, "kLimCeil"),
    };
    kCurve.innerHTML = curveSvg(p);
    kCurveSay.textContent = loudnessCurve(p).caption;
    for (const f of KNOB_FIELDS) knobEl(f.id).classList.toggle("dirty", cur[f.id] !== knobLoaded[f.id]);
    const snd = saveCost("sound", dirtyBands(SOUND_FIELDS, knobLoaded, cur));
    kSndSave.textContent = snd.label;
    kSndNote.textContent = snd.note;
    kSndNote.classList.toggle("warn", snd.warn);
    const adv = saveCost("advanced", dirtyBands(ENGINE_FIELDS, knobLoaded, cur));
    kAdvSave.textContent = adv.label;
    kAdvNote.textContent = adv.note;
    kAdvNote.classList.toggle("warn", adv.warn);
    if (knobCfg) {
      const pv = previewGroups({
        channels: knobCfg.channels, banks: knobCfg.banks ?? [],
        lanes: knobUi(cur, "kLanes"), rateHz: knobUi(cur, "kRate") * 1e6,
        windowHz: knobUi(cur, "kWindow") * 1e6, flatHz: knobUi(cur, "kFlat") * 1e6,
        groupDwellMs: knobCfg.scan.groupDwellMs ?? DEFAULT_GROUP_DWELL_MS,
      });
      kPreview.textContent = previewText(pv);
      kPreview.classList.toggle("warn", !pv.ok);
      kAdvSave.disabled = !pv.ok;
      kRevisitHint.textContent = revisitHint(pv);
    }
  }

  function fillKnobs(cfg: Config): void {
    knobCfg = cfg;
    knobLoaded = {};
    for (const f of KNOB_FIELDS) writeKnob(f, cfg);
    refreshKnobs();
  }

  async function saveKnobs(fields: readonly KnobField[], errEl: HTMLElement): Promise<void> {
    errEl.textContent = "";
    try {
      const cfg = await api.getConfig();
      applyKnobs(cfg, fields, knobValues(fields));
      const saved = await api.putConfig(cfg);
      knobCfg = saved;
      for (const f of fields) writeKnob(f, saved);  // this card only: keep the other card's unsaved edits
      refreshKnobs();
      setFieldStatus(errEl, "Saved", "ok", SAVED_MESSAGE_MS);
    } catch (e) { setFieldStatus(errEl, (e as Error).message, "err"); }
  }

  root.querySelectorAll<HTMLInputElement>(".soundCard input, .engineCard input").forEach((el) => {
    el.addEventListener("input", refreshKnobs);
    el.addEventListener("change", refreshKnobs);
  });
  kSndSave.addEventListener("click", () => { void saveKnobs(SOUND_FIELDS, kSndErr); });
  kAdvSave.addEventListener("click", () => { void saveKnobs(ENGINE_FIELDS, kAdvErr); });
```

Then, inside the existing initial load `api.getConfig().then((cfg) => { … })` in
the same function (the one that sets `tGroupDwell.value`), add as its last line:

```ts
    fillKnobs(cfg);
```

`Config` is already imported as a type at the top of `admin.ts`
(`import type { Channel, Config } from "../../backend/config/schema.js";`).
`setFieldStatus` and `SAVED_MESSAGE_MS` are already in scope; the Scanning card uses them.

- [ ] **Step 5: Keep the Advanced card closed on wide screens**

In `applySettingsLayout()` (around `admin.ts:2689`), replace:

```ts
    if (wide.matches) {
      settingsCards.forEach((d) => { d.open = true; });
      return;
    }
```

with:

```ts
    if (wide.matches) {
      // Every card opens on wide screens except Advanced (engine): its knobs
      // are rarely touched, so it stays a deliberate click (spec 2026-09-27).
      settingsCards.forEach((d) => { d.open = !d.classList.contains("engineCard"); });
      return;
    }
```

- [ ] **Step 6: Append styles to `admin.css`**

```css
/* Engine knobs (spec 2026-09-27): Sound curve + Advanced (engine) bands. */
.settingsCard.engineCard { grid-column: 1 / -1; }
.engineBands { display: grid; grid-template-columns: 1fr 1fr; gap: 1.1rem 1.75rem; }
.engineBand h3 { margin: 0; display: flex; align-items: baseline; gap: 0.5rem; color: var(--ink); font-size: var(--t-body); }
.engineBand > .hint { margin: 0.15rem 0 0.3rem; }
.engineSub { margin: 0.7rem 0 0; color: var(--label); font-size: var(--t-caption); }
.cost { font-size: var(--t-micro); font-weight: 600; }
.cost-scan { color: var(--caution); }
.cost-live { color: var(--green); }
.cost-backend { color: var(--red); }
.derived { margin-top: 0.5rem; padding: 0.5rem 0.65rem; border: 1px solid var(--rule); border-radius: 4px; background: var(--etch); color: var(--label); font-size: var(--t-caption); }
.derived.warn, .formActions .hint.warn { color: var(--caution); }
.settingGroups input.dirty { border-color: var(--amber); }
.loudCurve { margin: 0 0 0.6rem; padding: 0.6rem 0.6rem 0.35rem; border: 1px solid var(--rule); border-radius: 4px; background: var(--etch); }
.loudCurve svg { display: block; width: 100%; height: auto; }
.loudCurve figcaption { margin-top: 0.25rem; color: var(--dim); font-size: var(--t-micro); }
.loudCurve text { fill: var(--mark); font-size: 10px; }
.loudCurve .lc-hold { fill: var(--ink); opacity: 0.04; }
.loudCurve .lc-unity { stroke: var(--mark); stroke-dasharray: 3 4; }
.loudCurve .lc-target { stroke: var(--amber); stroke-opacity: 0.35; }
.loudCurve .lc-ceil { stroke: var(--caution); stroke-opacity: 0.5; stroke-dasharray: 2 3; }
.loudCurve .lc-curve { fill: none; stroke: var(--amber); stroke-width: 2.25; stroke-linejoin: round; }
.loudCurve .lc-axis { stroke: var(--panel-edge); }
@media (max-width: 699.98px) {
  .engineBands { grid-template-columns: 1fr; }
}
```

The `699.98px` breakpoint is the same phone breakpoint the existing
`.settingsCards { grid-template-columns: 1fr; }` rule uses.

- [ ] **Step 7: Typecheck, test and build**

Run: `cd kiosk && npm run typecheck && npm test && npm run build`
Expected: typecheck exits 0, all tests pass, and the build finishes with
`Built target kerchunk-dsp`. Vite doesn't typecheck, so the `typecheck` run is
what catches type errors in `admin.ts`.

- [ ] **Step 8: Headless screenshot of the Settings page (DOM page, works headless)**

```bash
mkdir -p ~/shots && timeout 60 chromium --headless=new --disable-gpu --window-size=1400,2600 \
  --screenshot=$HOME/shots/engine-knobs.png "http://localhost:8080/admin/#/scan"
```

Read `~/shots/engine-knobs.png`. The PNG must be inside `$HOME`, not the
scratchpad. Check that:
- the Sound card shows the curve with its caption and five rows;
- the Advanced (engine) card is full width and closed;
- nothing else in the Settings layout moved.

There's no way to click in headless, so the open Advanced card gets checked in
the operator's browser (Task 6).

- [ ] **Step 9: Commit**

```bash
git add kiosk/src/frontend/admin/admin.ts kiosk/src/frontend/admin/admin.css
git commit -m "feat(admin): Sound and Advanced (engine) cards for the native engine knobs"
```

---

### Task 6: Prove on the appliance, document, and ship

**Files:**
- Modify: `docs/DEPLOY.md` (the "Engine (kerchunk-dsp)" notes)

- [ ] **Step 1: Deploy the frontend (no backend restart for the UI)**

The build from Task 5 is already in `dist/`, and the backend serves it statically.
Refresh the admin tab. Task 1 touched backend code, but its behaviour is
identical and it takes effect at the next natural restart, so don't restart the
service just for this.

- [ ] **Step 2: A scheduling-only save must not restart the helper**

Record the scanner helper's PID before and after.

```bash
pgrep -f 'kerchunk-dsp.*KIOSK01'
```

In the admin, open Advanced (engine), set Memory to `20`, and check the label and note:
- the button reads "Save engine settings";
- the note reads "Scheduling applies at once.".

Click Save, then confirm:

```bash
pgrep -f 'kerchunk-dsp.*KIOSK01'          # same PID as before
curl -s localhost:8080/api/config | jq '.scan.autoDwell'   # {"halfLifeMin":20, "enabled":true, ...}
```

Clear the field and save again to restore the default. Check that `.scan.autoDwell`
drops `halfLifeMin`.

- [ ] **Step 3: A Sound save restarts the helper with the new flag**

In Sound, set Hum filter to `250`. The button must read "Save and restart
scanning" and the note must turn caution-coloured. Click Save, then:

```bash
pgrep -a kerchunk-dsp | grep -o -- '--audio-hpf-hz [^ ]*'   # --audio-hpf-hz 250
```

Then clear the field (back to the 300 default), save, and confirm the flag reads `300`.
Afterwards the operator's values must be as they were:

```bash
curl -s localhost:8080/api/config | jq -c '{q:.scan.nativeQuietDb, am:.scan.nativeAmGainDb, hpf:.scan.fmAudioHpfHz, v:.audio.volume}'
# expect q=-7, am=-6, hpf=null, v unchanged
```

- [ ] **Step 4: The preview and the window guard**

In Group shape, check that the preview reads close to the live grouping:
"10 groups from 101 channels, … Quiet cycle ≈ 15 s" at `groupDwellMs` 1500.
Type Window `2.5` and check that:
- the preview turns into the caution message;
- "Save engine settings" is disabled.

Clear the field again. Don't save a shape change; it would restart scanning for nothing.

- [ ] **Step 5: Document**

In `docs/DEPLOY.md`, under "Engine (kerchunk-dsp)" → the Notes list, add one bullet
after the scan-scheduling table:

```markdown
- **Admin:** every knob above (group shape, scheduling, quieting, AM gain, FM
  filters, speaker AGC/limiter, watchdogs) is editable under Settings → **Sound**
  and **Advanced (engine)**. Each band says what a save costs; blank = default.
```

- [ ] **Step 6: Final checks**

Run: `cd kiosk && npm test && npm run test:native && npm run typecheck && npm run build`
Expected: all pass. `test:native` is unchanged C++, but it's part of the definition of done.

- [ ] **Step 7: Commit, push, PR, merge, clean up**

```bash
git add docs/DEPLOY.md
git commit -m "docs(deploy): engine knobs are editable in the admin"
git push -u origin feat/engine-knobs-admin
gh pr create --fill   # body: summary, the 3 spec deviations, proof from Steps 2-4, test results
```

After CI is green and the operator has looked at the open Advanced card in their
browser:

```bash
gh pr merge <n> --merge --delete-branch
git checkout main && git pull --ff-only && git fetch --prune && git branch -d feat/engine-knobs-admin
```

---

## Self-review

- **Spec coverage:**
  - Sound card with the curve and 5 rows: Tasks 3 and 5.
  - Four bands with cost labels: Tasks 2 and 5.
  - Group preview, window guard and disabled Save: Tasks 3 and 5.
  - Priority hint: Tasks 3 and 5.
  - Save label and note: Tasks 2 and 5.
  - Load and blank placeholders: Tasks 2 and 5.
  - Validation, including the rate step, window vs rate and the server 400: Tasks 2 and 4.
  - Dirty tracking: Tasks 2 and 5.
  - Defaults mirror with the parity test, watchdog defaults moved: Task 1.
  - Pure-helper module: Tasks 2 and 3.
  - Tokens and radius scale: Task 5.
  - Proof steps: Task 6.
  - DEPLOY.md line: Task 6.
  - Out-of-scope items stay out.
- **Spec deviations**, listed at the top: the cycle formula, the wide-screen closed default, and the `j()` message.
- **Type consistency:** field ids (`kAgcTarget` … `kSilenceTo`) are the same in the table, the tests and the wiring. `Preview`, `CurveParams` and `KnobValues` are used with the same shapes in Tasks 3 and 5.
