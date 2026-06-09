# Lane-fit DSP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build only the channelizer lanes (and demod paths) the config needs — `N = max group size` lanes, each with only its required FM/AM path — instead of a fixed 12 lanes each running both, without changing the build-once/retune-per-hop architecture.

**Architecture:** A pure TypeScript `lanePlan.ts` derives `{ laneCount, perLane: {fm, am}[] }` from the engine's existing `ChannelGroup[]` grouping (Phase 1, off-server, unit-tested). The plan is passed to the helper via spawn args; `wideband_helper.py` builds `laneCount` lanes and each `Lane` constructs only its requested path (Phase 2, hardware-gated — DSP correctness provable only on the kiosk).

**Tech Stack:** TypeScript (ESM `.js` imports, strict + noUncheckedIndexedAccess), vitest; Python 3 + GNU Radio (`wideband_helper.py`, system python). All commands from `kiosk/`.

---

## CRITICAL: two phases, do not blur them

- **Phase 1 (Tasks 1–3): off-server.** Pure lane-plan logic + its wiring into the spawn-arg array. Fully buildable and unit-testable here. The helper IGNORES unknown args until Phase 2, so Phase 1 is safe to ship alone (it just computes + passes a plan nothing consumes yet — verify the helper tolerates the new args, see Task 3).
- **Phase 2 (Tasks 4–5): hardware-gated.** The `wideband_helper.py` DSP change. Its correctness (clean demod, no glitches, CPU actually drops) is a signal-processing property `FakeEngine`/vitest CANNOT assert. **Build on the kiosk, prove against real signals, then PR.** Do NOT mark Phase 2 done off-server.

Spec: [`docs/superpowers/specs/2026-06-09-lane-fit-dsp-design.md`](../specs/2026-06-09-lane-fit-dsp-design.md).

## Background the engineer needs

- **Read [`CLAUDE.md`](../../../CLAUDE.md).** ESM `.js` imports; `build:backend` copies `wideband_helper.py` into `dist/` (run `npm run build`, not bare `tsc`); GNU Radio needs `/usr/bin/python3`.
- **`ChannelGroup<T>`** ([`src/backend/engine/grouping.ts`](../../../kiosk/src/backend/engine/grouping.ts)): `{ centerHz: number; channels: T[] }`, `channels` ascending by freq, each a `Channel` with `.mode: "fm" | "nfm" | "am"`.
- **`WidebandEngine`** ([`src/backend/engine/WidebandEngine.ts`](../../../kiosk/src/backend/engine/WidebandEngine.ts)): `MAX_CHANNELS_PER_GROUP = 12` (line 58, MUST stay in sync with the helper's `MAX_CHANS`). `this.groups = groupChannels(..., MAX_CHANNELS_PER_GROUP)` computed in `start()` (~214) and the live-reconfigure path (~264). Spawn args assembled as an `args` array (~289) then `spawn`ed (~327). `spawnHelper()` is also called on respawn (~644).
- **Helper** ([`src/backend/engine/wideband_helper.py`](../../../kiosk/src/backend/engine/wideband_helper.py)): `MAX_CHANS = 12` (line 72). `argparse` block at line 886+. Chains built `for i in range(MAX_CHANS)` (~440), with `same_fd` only on lane `MAX_CHANS - 1` (the SAME/weather lane). `Lane.__init__` (~156) builds both FM (`self.demod`) and AM (`self.am_*`) paths unconditionally; `build_power` (~194) is the existing precedent for conditional construction.
- **Channel assignment is POSITIONAL:** `for i, chain in enumerate(self.chains): c = regs[i]` (~507) — group's channels fill slots 0..n in order. Slots have positional, not semantic, identity.

## File structure

- **Create** `src/backend/engine/lanePlan.ts` — pure `computeLanePlan(groups, maxChans)` → `LanePlan`. One responsibility.
- **Create** `test/lanePlan.test.ts` — unit tests.
- **Modify** `src/backend/engine/WidebandEngine.ts` — compute the plan from `this.groups`; pass it via spawn args.
- **Modify** `src/backend/engine/wideband_helper.py` — `--lanes` + per-lane mode mask args; build `N` lanes; `Lane` builds only requested path(s). (Phase 2.)
- **Modify** `test/wideband_dsp_math_test.py` or a new helper test — only if a pure-Python arg-parse helper is extracted; the DSP itself isn't unit-testable.

---

## PHASE 1 — off-server

## Task 1: `computeLanePlan` pure function

**Files:**
- Create: `kiosk/src/backend/engine/lanePlan.ts`
- Test: `kiosk/test/lanePlan.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// kiosk/test/lanePlan.test.ts
import { describe, it, expect } from "vitest";
import { computeLanePlan } from "../src/backend/engine/lanePlan.js";
import type { ChannelGroup } from "../src/backend/engine/grouping.js";
import type { Channel } from "../src/backend/config/schema.js";

const ch = (freq: number, mode: Channel["mode"]): Channel =>
  ({ id: `c${freq}`, freq, alphaTag: "T", mode, enabled: true });
const group = (...cs: Channel[]): ChannelGroup => ({ centerHz: cs[0]!.freq, channels: cs });

describe("computeLanePlan", () => {
  it("laneCount = max group size, capped at maxChans", () => {
    const plan = computeLanePlan([
      group(ch(146e6, "nfm"), ch(147e6, "nfm")),
      group(ch(150e6, "nfm"), ch(151e6, "nfm"), ch(152e6, "nfm")),
    ], 12);
    expect(plan.laneCount).toBe(3); // biggest group has 3
  });

  it("caps laneCount at maxChans even if a group is larger", () => {
    const big = group(...Array.from({ length: 20 }, (_, i) => ch(146e6 + i * 1e5, "nfm")));
    expect(computeLanePlan([big], 12).laneCount).toBe(12);
  });

  it("a pure-FM config builds FM-only on every pruned slot; SAME lane keeps both", () => {
    const plan = computeLanePlan([group(ch(146e6, "nfm"), ch(147e6, "fm"))], 12);
    expect(plan.laneCount).toBe(2);
    // slot 0 is non-SAME (laneCount-1 == 1 is the SAME lane) → FM-only
    expect(plan.perLane[0]).toEqual({ fm: true, am: false });
    // last lane (slot 1) is the SAME/weather lane → always both
    expect(plan.perLane[1]).toEqual({ fm: true, am: true });
  });

  it("per-slot mode union is POSITIONAL across groups", () => {
    // slot 0: nfm in group A, am in group B → both. slot 1: only group A (nfm).
    const plan = computeLanePlan([
      group(ch(146e6, "nfm"), ch(147e6, "nfm")),
      group(ch(120e6, "am")),
    ], 12);
    expect(plan.laneCount).toBe(2);
    // slot 0 sees nfm (A) + am (B) → fm&am; but slot 1 is the SAME lane (laneCount-1) → both anyway
    expect(plan.perLane[0]).toEqual({ fm: true, am: true });
    expect(plan.perLane[1]).toEqual({ fm: true, am: true }); // SAME lane
  });

  it("an AM-only low slot (3+ lanes so it isn't the SAME lane) builds AM-only", () => {
    const plan = computeLanePlan([
      group(ch(120e6, "am"), ch(146e6, "nfm"), ch(147e6, "nfm")),
    ], 12);
    expect(plan.laneCount).toBe(3);
    expect(plan.perLane[0]).toEqual({ fm: false, am: true }); // slot 0 only ever am here
    expect(plan.perLane[1]).toEqual({ fm: true, am: false });  // slot 1 only ever nfm
    expect(plan.perLane[2]).toEqual({ fm: true, am: true });   // slot 2 = SAME lane
  });

  it("no groups → a single SAME lane (both paths), never zero", () => {
    const plan = computeLanePlan([], 12);
    expect(plan.laneCount).toBe(1);
    expect(plan.perLane[0]).toEqual({ fm: true, am: true });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd kiosk && npx vitest run test/lanePlan.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

```ts
// kiosk/src/backend/engine/lanePlan.ts
// Pure lane plan for the wideband helper (spec 2026-06-09): size the channelizer
// to the config instead of a fixed MAX_CHANS, and build only each lane's needed
// demod path. Channel→lane assignment is POSITIONAL (helper packs group.channels
// into slots 0..n), so a slot's mode set is the union over groups of the mode at
// that position. The LAST built lane is the SAME/weather lane — it always keeps
// both paths (decoder tap lives there; excluded from type-pruning to bound risk).
import type { ChannelGroup } from "./grouping.js";

export interface LaneMode { fm: boolean; am: boolean; }
export interface LanePlan {
  laneCount: number;
  /** Per-slot demod paths to build, index 0..laneCount-1. */
  perLane: LaneMode[];
}

const isAm = (mode: string): boolean => mode === "am";
const isFm = (mode: string): boolean => mode === "fm" || mode === "nfm";

export function computeLanePlan(groups: ChannelGroup[], maxChans: number): LanePlan {
  const biggest = groups.reduce((m, g) => Math.max(m, g.channels.length), 0);
  // Never zero: the helper always builds at least the SAME/weather lane.
  const laneCount = Math.max(1, Math.min(maxChans, biggest));
  const sameLane = laneCount - 1;

  const perLane: LaneMode[] = [];
  for (let i = 0; i < laneCount; i++) {
    if (i === sameLane) {
      // SAME/weather lane: always both paths, regardless of mode union.
      perLane.push({ fm: true, am: true });
      continue;
    }
    let fm = false, am = false;
    for (const g of groups) {
      const c = g.channels[i];
      if (!c) continue; // this group doesn't fill slot i
      if (isFm(c.mode)) fm = true;
      if (isAm(c.mode)) am = true;
    }
    // A slot that some group fills but with neither recognized mode still needs
    // an FM path (the engine's default demod) so it can carry audio.
    if (!fm && !am) fm = true;
    perLane.push({ fm, am });
  }
  return { laneCount, perLane };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd kiosk && npx vitest run test/lanePlan.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
cd kiosk
git add src/backend/engine/lanePlan.ts test/lanePlan.test.ts
git commit -m "feat(engine): pure computeLanePlan (lane count + per-slot demod paths)"
```

---

## Task 2: Serialize the plan to a spawn-arg string (pure)

**Files:**
- Modify: `kiosk/src/backend/engine/lanePlan.ts`
- Test: `kiosk/test/lanePlan.test.ts`

The helper needs the plan as CLI args. Use `--lanes N` + `--lane-modes <mask>` where the mask is one char per lane: `f`=FM-only, `a`=AM-only, `b`=both. Pure + testable.

- [ ] **Step 1: Append the failing test**

```ts
import { lanePlanArgs } from "../src/backend/engine/lanePlan.js";

describe("lanePlanArgs", () => {
  it("emits --lanes and a per-lane mode mask (f/a/b)", () => {
    const plan = { laneCount: 3, perLane: [
      { fm: true, am: false }, { fm: false, am: true }, { fm: true, am: true },
    ]};
    expect(lanePlanArgs(plan)).toEqual(["--lanes", "3", "--lane-modes", "fab"]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd kiosk && npx vitest run test/lanePlan.test.ts -t "lanePlanArgs"`
Expected: FAIL — not exported.

- [ ] **Step 3: Implement** (append to `lanePlan.ts`)

```ts
/** Serialize a plan to helper CLI args: --lanes N --lane-modes <mask>.
 *  Mask is one char/lane: f=FM-only, a=AM-only, b=both. */
export function lanePlanArgs(plan: LanePlan): string[] {
  const mask = plan.perLane
    .map((m) => (m.fm && m.am ? "b" : m.am ? "a" : "f"))
    .join("");
  return ["--lanes", String(plan.laneCount), "--lane-modes", mask];
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd kiosk && npx vitest run test/lanePlan.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
cd kiosk
git add src/backend/engine/lanePlan.ts test/lanePlan.test.ts
git commit -m "feat(engine): lanePlanArgs serializer for the helper CLI"
```

---

## Task 3: Wire the plan into WidebandEngine spawn args

**Files:**
- Modify: `kiosk/src/backend/engine/WidebandEngine.ts`

No new unit test (the pure pieces are tested; this is wiring). Verify by build + that existing engine tests still pass. **Safe to ship in Phase 1: the helper currently ignores unknown args, so passing `--lanes`/`--lane-modes` is inert until Phase 2** — but CONFIRM that (Step 3).

- [ ] **Step 1: Import the plan helpers**

In `WidebandEngine.ts`, add to the grouping import or a new line:
```ts
import { computeLanePlan, lanePlanArgs } from "./lanePlan.js";
```

- [ ] **Step 2: Build the args from the current groups**

In `spawnHelper()` where the `args` array is assembled (~line 289), after the array is built and the conditional `args.push(...)` calls, add:
```ts
    const plan = computeLanePlan(this.groups, MAX_CHANNELS_PER_GROUP);
    args.push(...lanePlanArgs(plan));
```
(`this.groups` is already populated before `spawnHelper()` runs — it's set in `start()`/reconfigure before spawn. Confirm by reading the call sites; if `this.groups` could be empty here, `computeLanePlan` returns a 1-lane plan, which is safe.)

- [ ] **Step 3: Confirm the helper tolerates unknown args (Phase-1 safety)**

Read `wideband_helper.py`'s `argparse` setup (~line 886). Standard `argparse` ERRORS on unknown args by default (`--lanes` would crash the helper). **Therefore Phase 1 is NOT safe to ship before the helper accepts these args.** Resolve by ordering: do Task 4 (helper accepts + ignores the args, no DSP change yet) BEFORE this wiring reaches a running helper. Since Task 4 is hardware-gated, the SAFE Phase-1 boundary is: land Tasks 1–2 (pure, inert) now; Task 3's `args.push` must land together with Task 4's argparse acceptance. **Mark Task 3 as blocked-on-Task-4 and move it into the hardware phase.** (This is the one ordering correction — see "Phase boundary" below.)

- [ ] **Step 4: Build**

Run: `cd kiosk && npm run build`
Expected: succeeds (the TS compiles; the args are just strings).

- [ ] **Step 5: Commit (only when paired with Task 4 on the kiosk)**

```bash
cd kiosk
git add src/backend/engine/WidebandEngine.ts
git commit -m "feat(engine): pass lane plan to the helper spawn args"
```

---

## Phase boundary (correction from Task 3 Step 3)

`argparse` rejects unknown args, so **Task 3's `args.push` and Task 4's argparse acceptance must land in the same change** (otherwise the running helper crashes on `--lanes`). Therefore:
- **Phase 1, shippable off-server NOW:** Tasks 1 + 2 only — the pure `lanePlan.ts` (`computeLanePlan` + `lanePlanArgs`) with full unit tests. Nothing consumes them yet; zero runtime effect. This is a clean, safe, reviewable PR.
- **Phase 2, on the kiosk:** Tasks 3 + 4 + 5 together — wire the args AND teach the helper to accept them AND apply them to lane construction, proven against real signals.

## PHASE 2 — hardware-gated (build + prove on the kiosk)

## Task 4: Helper accepts `--lanes`/`--lane-modes` and builds N lanes with chosen paths

**Files:**
- Modify: `kiosk/src/backend/engine/wideband_helper.py`

- [ ] **Step 1: Add the args** to the `argparse` block (~line 886):
```python
    ap.add_argument("--lanes", type=int, default=MAX_CHANS,
                    help="number of channelizer lanes to build (<= MAX_CHANS)")
    ap.add_argument("--lane-modes", type=str, default="",
                    help="per-lane demod path mask: f=FM, a=AM, b=both; one char per lane")
```

- [ ] **Step 2: Derive lane count + masks** where the flowgraph is set up (before the `self.chains = [...]` build ~line 440):
```python
        lane_count = max(1, min(MAX_CHANS, args.lanes))
        modes = args.lane_modes or ("b" * lane_count)  # default: both, == today's behavior
        def lane_flags(i):
            c = modes[i] if i < len(modes) else "b"
            return (c in ("f", "b"), c in ("a", "b"))  # (build_fm, build_am)
```

- [ ] **Step 3: Build `lane_count` chains, each with its flags**, replacing the `range(MAX_CHANS)` loop (~440). The SAME lane is now the LAST BUILT lane (`lane_count - 1`):
```python
        self.chains = [Chain(self, self.src, taps, args.rate, self.adder, i,
                             same_fd=(same_fd if i == lane_count - 1 else None),
                             build_power=build_power,
                             build_fm=fm, build_am=am)
                       for i, (fm, am) in ((j, lane_flags(j)) for j in range(lane_count))]
```
(Adapt to the real constructor signature/keyword style. The adder port math uses `port + MAX_CHANS` for the AM path — confirm that still addresses correctly when fewer lanes exist; if the adder is sized to `2 * MAX_CHANS` inputs, leaving high ports unconnected is fine, but VERIFY the adder construction and AM port offset.)

- [ ] **Step 4: `Lane.__init__` honors `build_fm` / `build_am`** (~line 156). Add params `build_fm=True, build_am=True`; guard the FM block (`self.demod` + its connects + the audio_sq/leveler chain that hangs off `self.demod`) behind `build_fm`, and the AM block (`self.am_*` + its connects) behind `build_am`. **CRITICAL nuance to verify on the kiosk:** the leveler/audio probe hangs off `self.demod` (the FM path); if a lane is AM-only, that measurement chain must hang off the AM audio instead, or be conditionalized. Resolve this against the real wiring — it's the main DSP-correctness risk. The SAME lane always passes `build_fm=True, build_am=True`.

- [ ] **Step 5: Wire Task 3** — apply the `WidebandEngine` `args.push(...lanePlanArgs(...))` from Task 3 now (same change set).

- [ ] **Step 6: Build + hardware prove** (ON THE KIOSK):
```sh
cd kiosk && npm run build && sudo systemctl restart kerchunk-kiosk
```
Then verify against real signals:
  - Every active channel in every group still demodulates cleanly (FM and AM both — listen).
  - The host-health panel's "N / M cores" reading DROPS vs. the fixed-12 baseline.
  - The SAME/weather lane still decodes (visiting-slot proof-of-life).
  - Group-hop still just retunes (no rebuild stutter); boot opens the SDR once.
  - A pure-FM config builds no AM paths (confirm via reduced CPU and a debug log of the mask).

- [ ] **Step 7: Commit** (on the kiosk, only after the demod is proven clean):
```bash
cd kiosk
git add src/backend/engine/wideband_helper.py src/backend/engine/WidebandEngine.ts
git commit -m "feat(dsp): build only the lanes and demod paths the config needs"
```

---

## Task 5: Hardware verification + PR

**Files:** none.

- [ ] **Step 1:** On the kiosk, run the full Task 4 Step 6 checklist again on the operator's REAL config (the busiest real group, with any AM/airband channels present). Record the before/after helper-CPU "N / M cores" figure.
- [ ] **Step 2:** Run `npm test` on the kiosk — the pure `lanePlan` tests + the full suite stay green.
- [ ] **Step 3:** Open the PR with the measured CPU delta in the description.

---

## Out of scope
- Polyphase channelizer rewrite; per-group rebuild; efficiency items #2–#4; changing `MAX_CHANS`, group-floor math, or SAME behavior.

## Success criteria (from the spec)
- Busiest group `< 12` → fewer lanes built, helper CPU drops (measured on hardware).
- Pure-FM configs build no AM paths on pruned slots; AM channels still demodulate.
- SAME/weather lane unchanged and still decodes.
- Group-hop stays a retune; SDR opened once at boot.
- No audible regression on any active channel (hardware gate).
- `lanePlan` logic covered by off-server unit tests; helper change proven on hardware before its PR.
