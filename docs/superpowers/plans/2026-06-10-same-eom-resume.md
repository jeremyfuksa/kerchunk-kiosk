# SAME EOM-triggered scan resume — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resume scanning shortly after a SAME weather broadcast actually ends (its `NNNN` end-of-message burst), with an 8s grace window that bridges back-to-back alert clusters, while keeping the existing revert timer as a safety net.

**Architecture:** The GNU Radio helper already emits `NNNN` lines to Node as `{ev:"same", raw}`, and `same.ts` already exports a tested `isEom()`. The only changes are in `kiosk/src/backend/server.ts`: branch on EOM at the top of the SAME handler, start a short grace timer that resumes scanning, cancel that grace timer whenever a fresh covered header arrives (so clusters hold through), and factor the existing revert into a shared `revertToScan()` helper. No engine-interface, helper, or frontend changes.

**Tech Stack:** TypeScript (ESM, `.js` import extensions), Node ≥24, vitest with fake timers, supertest, FakeEngine.

**Spec:** `docs/superpowers/specs/2026-06-10-same-eom-resume-design.md`

---

## File structure

| File | Responsibility | Change |
|------|----------------|--------|
| `kiosk/src/backend/server.ts` | SAME break-in + revert logic | Add `isEom` import; add `EOM_GRACE_MS` + `sameEomTimer`; move `switchMode` out of the handler; add `revertToScan()`; add EOM branch; add grace-cancel on covered headers; route both timers through `revertToScan()`. |
| `kiosk/test/sameEom.test.ts` | Behavioral test for EOM resume | Create. |
| `kiosk/src/backend/same.ts` | SAME parsing + `isEom` | None (already exports `isEom`). |

---

### Task 1: EOM-triggered scan resume

**Files:**
- Create: `kiosk/test/sameEom.test.ts`
- Modify: `kiosk/src/backend/server.ts` (import line ~17; SAME block lines ~465–510)

All commands run from `kiosk/`.

---

- [ ] **Step 1: Write the failing test**

Create `kiosk/test/sameEom.test.ts`:

```ts
import { describe, it, expect, afterEach, vi } from "vitest";
import request from "supertest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../src/backend/server.js";
import { ConfigStore } from "../src/backend/config/ConfigStore.js";
import { ActivityLog } from "../src/backend/activityLog.js";
import { WsHub } from "../src/backend/ws.js";
import { FakeEngine } from "../src/backend/engine/FakeEngine.js";

const SCAN_FREQ = 145_130_000;
const WX_FREQ = 162_550_000;
// Two distinct covered alerts (different raw text → both clear the 90s dedupe).
const TOR = "EAS: ZCZC-WXR-TOR-029047+0030-1561800-KEAX/NWS-";
const SVR = "EAS: ZCZC-WXR-SVR-029047+0045-1561800-KEAX/NWS-";
const EOM = "EAS: NNNN";

let dir: string;
function makeApp() {
  dir = mkdtempSync(join(tmpdir(), "ksrv-eom-"));
  const configStore = new ConfigStore(join(dir, "config.json"));
  const engine = new FakeEngine();
  const { server } = createServer({
    configStore, engine, activityLog: new ActivityLog(100),
    wsHub: new WsHub(), staticDir: dir,
  });
  return { server, engine };
}

// Configure a scan channel + a weather channel so a covered SAME alert breaks in.
async function setup() {
  const { server, engine } = makeApp();
  await request(server).post("/api/channels")
    .send({ freq: SCAN_FREQ, alphaTag: "SCAN", mode: "nfm", enabled: true });
  await request(server).post("/api/weather")
    .send({ freq: WX_FREQ, alphaTag: "NWR", mode: "nfm", enabled: true });
  return { engine };
}

const freqs = (cfg: { channels: { freq: number }[] } | undefined) =>
  (cfg?.channels ?? []).map((c) => c.freq);

afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

describe("SAME EOM-triggered scan resume", () => {
  it("breaks in on a covered alert, then resumes scanning after the EOM grace window", async () => {
    const { engine } = await setup();
    vi.useFakeTimers();

    engine.emitSame(TOR);
    // Break-in: retuned to the weather channel only (no scan freq).
    const wx = engine.retunes.at(-1);
    expect(freqs(wx)).toContain(WX_FREQ);
    expect(freqs(wx)).not.toContain(SCAN_FREQ);

    engine.emitSame(EOM);
    const beforeAdvance = engine.retunes.length;
    // Grace window not yet elapsed → still holding weather.
    vi.advanceTimersByTime(7_000);
    expect(engine.retunes.length).toBe(beforeAdvance);
    // Grace window elapses → resume scanning (retuned back to the scan list).
    vi.advanceTimersByTime(2_000);
    expect(freqs(engine.retunes.at(-1))).toContain(SCAN_FREQ);
  });

  it("holds through a clustered second alert and resumes only after the final EOM", async () => {
    const { engine } = await setup();
    vi.useFakeTimers();

    engine.emitSame(TOR);
    engine.emitSame(EOM);          // grace armed
    vi.advanceTimersByTime(4_000); // mid-grace
    const beforeCluster = engine.retunes.length;

    engine.emitSame(SVR);          // new covered alert → cancels the pending resume
    vi.advanceTimersByTime(10_000);
    // Held through: no resume retune happened from the cancelled grace timer.
    expect(engine.retunes.length).toBe(beforeCluster);

    engine.emitSame(EOM);          // grace re-armed off the final message
    vi.advanceTimersByTime(8_001);
    expect(freqs(engine.retunes.at(-1))).toContain(SCAN_FREQ);
  });

  it("still reverts on the long safety-net timer when no EOM is ever received", async () => {
    const { engine } = await setup();
    vi.useFakeTimers();

    engine.emitSame(TOR);          // purge 0030 → 30 min, clamped to the 10 min cap
    expect(freqs(engine.retunes.at(-1))).not.toContain(SCAN_FREQ);
    // No EOM. Advance past the 10-minute cap → safety-net revert.
    vi.advanceTimersByTime(10 * 60_000 + 1_000);
    expect(freqs(engine.retunes.at(-1))).toContain(SCAN_FREQ);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- sameEom`

Expected: the first two tests **FAIL** — after the EOM the engine never retunes back to the scan list (nothing handles `NNNN` yet), so `freqs(engine.retunes.at(-1))` still lacks `SCAN_FREQ`. (The third "safety-net" test already passes — it's a regression guard, not the red driver.)

- [ ] **Step 3: Add the `isEom` import**

In `kiosk/src/backend/server.ts`, change the `same.js` import (line ~17) from:

```ts
import { parseSame, fipsMatch, fipsNames, isTest } from "./same.js";
```

to:

```ts
import { parseSame, fipsMatch, fipsNames, isTest, isEom } from "./same.js";
```

- [ ] **Step 4: Refactor the SAME block — shared revert, EOM branch, grace cancel**

In `kiosk/src/backend/server.ts`, the current block reads (lines ~465–510):

```ts
  let lastSame: { raw: string; ts: number } | null = null;
  let sameRevertTimer: NodeJS.Timeout | null = null;
  const onSameEvent = (ev: EngineEvent): void => {
    if (ev.type !== "same") return;
    const hdr = parseSame(ev.raw);
    if (!hdr) return;
    if (lastSame && lastSame.raw === hdr.raw && ev.ts - lastSame.ts < 90_000) return;
    lastSame = { raw: hdr.raw, ts: ev.ts };
    const covered = fipsMatch(hdr.fips, config.alerts?.sameFips);
    const counties = fipsNames(hdr.fips, config.alerts?.sameFips);
    const test = isTest(hdr.event);
```

Replace it with (adds the constant, the second timer, the EOM branch, and threads through the new helpers — note the `switchMode`/`revertToScan` helpers are added in Step 4b below and referenced here):

```ts
  let lastSame: { raw: string; ts: number } | null = null;
  let sameRevertTimer: NodeJS.Timeout | null = null;
  // EOM (NNNN) ends a transmission; resume scanning after a short grace window
  // so clustered alerts (a new header inside the window) hold straight through.
  const EOM_GRACE_MS = 8_000;
  let sameEomTimer: NodeJS.Timeout | null = null;
  // Re-point the live graph (retune) rather than stop()+start(): a restart
  // replays the WARMING UP overlay and cold-start audio chop. The helperless
  // RtlFm fallback keeps stop()+start().
  const switchMode = (cfg: ScanConfig): void => {
    if (engine.retune) void engine.retune(cfg);
    else void engine.stop().then(() => engine.start(cfg));
  };
  // Shared revert: clears both timers, lifts the break-in freeze, and (unless
  // the operator changed mode in the meantime) hops back to the scan set.
  const revertToScan = (): void => {
    if (sameRevertTimer) { clearTimeout(sameRevertTimer); sameRevertTimer = null; }
    if (sameEomTimer) { clearTimeout(sameEomTimer); sameEomTimer = null; }
    breakIn = false;                  // break-in over; thermal management resumes
    if (mode !== "weather") return;   // operator changed it; leave alone
    mode = "scan";
    switchMode(toScanConfig(config, "scan"));
  };
  const onSameEvent = (ev: EngineEvent): void => {
    if (ev.type !== "same") return;
    // End of message: resume scanning after the grace window, but only while a
    // break-in is actually in progress. A stray NNNN otherwise is ignored.
    if (isEom(ev.raw)) {
      if (mode === "weather" && breakIn) {
        if (sameEomTimer) clearTimeout(sameEomTimer);
        sameEomTimer = setTimeout(revertToScan, EOM_GRACE_MS);
        sameEomTimer.unref?.();
      }
      return;
    }
    const hdr = parseSame(ev.raw);
    if (!hdr) return;
    if (lastSame && lastSame.raw === hdr.raw && ev.ts - lastSame.ts < 90_000) return;
    lastSame = { raw: hdr.raw, ts: ev.ts };
    const covered = fipsMatch(hdr.fips, config.alerts?.sameFips);
    const counties = fipsNames(hdr.fips, config.alerts?.sameFips);
    const test = isTest(hdr.event);
```

- [ ] **Step 4b: Cancel a pending resume on any covered header, and route the break-in through the shared helper**

Still in the same handler, the current code reads (lines ~484–510):

```ts
    if (!covered || (test && !config.alerts?.sameTests)) return;
    const holdSeconds = Math.min(300, Math.max(60, hdr.purgeMinutes * 60));
    // Break-in (the Idea 11 pitch's second behavior): preempt the scan so the
    // NWR voice message PLAYS, then revert — consumer weather-radio break-in.
    // Applied via retune (re-point the live graph) not stop()+start(): a
    // restart replayed the WARMING UP overlay and cold-start audio chop every
    // time. retune hops in place — no overlay, no chop. The helperless RtlFm
    // fallback path keeps the old stop()+start(). Never preempts a monitor.
    const switchMode = (cfg: ScanConfig): void => {
      if (engine.retune) void engine.retune(cfg);
      else void engine.stop().then(() => engine.start(cfg));
    };
    if (!test && mode === "scan" && config.weatherChannel) {
      mode = "weather";
      monitorChannel = null;
      breakIn = true;   // freeze safetyMode bounces until we revert
      switchMode(toScanConfig(config, "weather"));
      if (sameRevertTimer) clearTimeout(sameRevertTimer);
      sameRevertTimer = setTimeout(() => {
        sameRevertTimer = null;
        breakIn = false;                  // break-in over; thermal management resumes
        if (mode !== "weather") return;   // operator changed it; leave alone
        mode = "scan";
        switchMode(toScanConfig(config, "scan"));
      }, Math.min(10 * 60_000, Math.max(120_000, hdr.purgeMinutes * 60_000)));
      sameRevertTimer.unref?.();
    }
```

Replace it with (the local `switchMode` is gone — it now lives in the outer scope from Step 4; a fresh covered header cancels a pending EOM resume so clusters hold; the long timer now calls the shared `revertToScan`):

```ts
    if (!covered || (test && !config.alerts?.sameTests)) return;
    // A fresh covered header means an active message is playing — cancel any
    // pending EOM resume so a clustered follow-on alert holds straight through.
    if (sameEomTimer) { clearTimeout(sameEomTimer); sameEomTimer = null; }
    const holdSeconds = Math.min(300, Math.max(60, hdr.purgeMinutes * 60));
    // Break-in (the Idea 11 pitch's second behavior): preempt the scan so the
    // NWR voice message PLAYS, then revert — consumer weather-radio break-in.
    // The EOM resume (above) ends it early when the broadcast actually stops;
    // this timer is the safety net if no NNNN is decoded. Never preempts a
    // monitor. The helperless RtlFm path falls back to stop()+start() in
    // switchMode.
    if (!test && mode === "scan" && config.weatherChannel) {
      mode = "weather";
      monitorChannel = null;
      breakIn = true;   // freeze safetyMode bounces until we revert
      switchMode(toScanConfig(config, "weather"));
      if (sameRevertTimer) clearTimeout(sameRevertTimer);
      sameRevertTimer = setTimeout(
        revertToScan,
        Math.min(10 * 60_000, Math.max(120_000, hdr.purgeMinutes * 60_000)),
      );
      sameRevertTimer.unref?.();
    }
```

- [ ] **Step 5: Run the EOM test to verify it passes**

Run: `npm test -- sameEom`

Expected: all three tests **PASS**.

- [ ] **Step 6: Run the full suite and the build**

Run: `npm test && npm run build`

Expected: the whole vitest suite passes (no regressions in the existing break-in / dashboard-state tests), and `npm run build` (vite + tsc + helper copy) completes with no type errors. The TypeScript build proves the `switchMode`/`revertToScan` refactor still satisfies `strict` + `noUncheckedIndexedAccess`.

- [ ] **Step 7: Commit**

```bash
git add kiosk/src/backend/server.ts kiosk/test/sameEom.test.ts
git commit -m "$(cat <<'EOF'
feat(same): resume scanning on the EOM burst with an 8s grace window

The weather break-in reverted on a fixed timer keyed to the alert's purge
(validity) time, so the kiosk could camp on NWR for up to 10 minutes after a
~75s announcement ended. Detect the NNNN end-of-message burst and resume
scanning 8s later instead. A fresh covered header inside the window cancels
the pending resume so clustered alerts hold straight through; the purge-time
timer stays as a safety net for when no EOM is decoded.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-review

**Spec coverage:**
- Spec §1 "branch on the line already emitted" → Step 4 EOM branch (no new event type). ✓
- Spec §2 "grace-window resume" + shared `revertToScan()` + cancel-on-new-header → Steps 4, 4b. ✓
- Spec §2 "existing long timer stays as the hard cap" → Step 4b safety-net timer routed through `revertToScan`. ✓
- Spec §3 "banner stays decoupled" → no change to the `wsHub.broadcast({type:"alert",...})` / `holdSeconds` code; the EOM branch returns before it. ✓
- Spec §4 failure modes: EOM never decodes → Step 6 safety-net test (Task 1 test #3); stray NNNN ignored → `mode==="weather" && breakIn` guard; test alerts never break in → unchanged guard. ✓
- Spec §5 testing (lone, cluster, safety-net) → Task 1 test #1/#2/#3. ✓
- Spec "Open knob" `EOM_GRACE_MS = 8000` → Step 4. ✓

**Placeholder scan:** No TBD/TODO; every code step shows full code. ✓

**Type consistency:** `switchMode(cfg: ScanConfig)`, `revertToScan(): void`, `sameEomTimer: NodeJS.Timeout | null`, `EOM_GRACE_MS` used consistently across Steps 4/4b. `isEom` imported in Step 3 before use in Step 4. The EOM branch reads `ev.raw` (the raw line) — correct, because `parseSame` is not called for EOM lines. ✓

**Closure scope:** `revertToScan`/`switchMode` reference `engine`, `config`, `mode`, `breakIn`, `monitorChannel`, `toScanConfig` — all already in the `createServer` closure (the original inline timer used `config`/`mode`/`breakIn` the same way). Moving `switchMode` out of the handler is safe; it had no per-call dependencies. ✓
