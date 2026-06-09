# Host Health Verdict Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reframe the admin System health panel from raw gauges to a mission-capability verdict (Healthy/Stressed/Trouble) that answers "is the radio working?" at a glance.

**Architecture:** A pure `classifyHealth()` in `systemStats.ts` derives the verdict from signals that already exist (engine state, warmed, safetyMode, throttle, helper liveness, a server-side tally of engine `error` events). The server adds `health` to the `/api/system` payload. The admin panel leads with the verdict and collapses the gauges behind a Details disclosure, fixing the DSP-helper `%` legibility ("N / M cores") and removing the apologetic Load cell.

**Tech Stack:** TypeScript (ESM `.js` imports, strict + noUncheckedIndexedAccess), vitest, framework-free admin frontend. All commands from `kiosk/`.

---

## Background the engineer needs

- **Read [`CLAUDE.md`](../../../CLAUDE.md).** ESM `.js` import extensions even from `.ts`; `noUncheckedIndexedAccess`; run from `kiosk/`.
- **Spec:** [`docs/superpowers/specs/2026-06-09-host-health-verdict-design.md`](../specs/2026-06-09-host-health-verdict-design.md). Binding.
- **`SystemSample`** (`src/backend/systemStats.ts`): `{ ts, cpuPct, helperCpuPct: number|null, helperRssMb: number|null, load1, memUsedPct, backendRssMb, tempC: number|null, throttled: boolean|null, diskFreeMb: number|null, openCount }`. `helperCpuPct` is the `top` convention (100% = one core).
- **`classifySystemAlerts(now, recent)`** is the pure-classifier precedent to mirror; **do not change it**. Its tests in [`test/systemStats.test.ts`](../../../kiosk/test/systemStats.test.ts) use a `base: SystemSample` spread — copy that fixture style.
- **`snapshot()`** returns `{ now, ring, alerts }`. The server's `GET /api/system` handler (`src/backend/server.ts:779`) returns `{ ...sysStats.snapshot(), safetyMode }`. We add `health` there.
- **Server signals already tracked:** `warmed` (a `let`, set from engine `warmup` phase events via `engine.on(...)` at `server.ts:224-228`), `safetyMode` (`let` at ~388), `engine.state` (getter, `stopped|starting|running|error`). The engine emits `{ type:"error", code, message, ts }` on helper-spawn escalation — the server subscribes via `engine.on((ev)=>...)`.
- **`EngineState`** = `"stopped" | "starting" | "running" | "error"` (`ScannerEngine.ts:49`).
- **Admin panel:** `renderSystem()` at `admin.ts:602`; the section markup at `admin.ts:137-140` (`#sysBody` inside `.sysHealth`); the existing `#healthBanner` (alerts) at `admin.ts:109` stays untouched. `os.cpus().length` gives core count server-side.

## File structure

- **Modify** `src/backend/systemStats.ts` — add pure `classifyHealth()` + a `HealthVerdict` type + `HealthInput` type. (No change to `classifySystemAlerts`.)
- **Modify** `test/systemStats.test.ts` — `classifyHealth` unit tests.
- **Modify** `src/backend/server.ts` — track `startedAt` + a trailing tally of engine `error` events; pass them + existing signals into `classifyHealth`; add `health` + `coreCount` to `/api/system`.
- **Modify** `test/api.test.ts` — assert `/api/system` includes `health`.
- **Modify** `src/frontend/admin/admin.ts` — verdict headline + Details disclosure + "N / M cores" + remove Load cell.
- **Modify** `src/frontend/admin/admin.css` — verdict band + disclosure styles.

---

## Task 1: `classifyHealth` pure function

**Files:**
- Modify: `kiosk/src/backend/systemStats.ts`
- Test: `kiosk/test/systemStats.test.ts`

- [ ] **Step 1: Write the failing tests** (append to `test/systemStats.test.ts`)

```ts
import { classifyHealth, type HealthInput } from "../src/backend/systemStats.js";

describe("classifyHealth", () => {
  const sample = (over: Partial<SystemSample> = {}): SystemSample => ({
    ts: 1, cpuPct: 40, helperCpuPct: 250, helperRssMb: 200, load1: 8,
    memUsedPct: 50, backendRssMb: 120, tempC: 83, throttled: false,
    diskFreeMb: 10_000, openCount: 3, ...over,
  });
  const input = (over: Partial<HealthInput> = {}): HealthInput => ({
    now: sample(), engineState: "running", warmed: true, safetyMode: false,
    helperRestartsRecent: 0, msSinceStart: 120_000, ...over,
  });

  it("a hot, busy, scanning box is HEALTHY (hot by design)", () => {
    const h = classifyHealth(input({ now: sample({ tempC: 83, helperCpuPct: 300 }) }));
    expect(h.verdict).toBe("healthy");
  });
  it("engine error is TROUBLE", () => {
    expect(classifyHealth(input({ engineState: "error" })).verdict).toBe("trouble");
  });
  it("engine stopped is TROUBLE", () => {
    expect(classifyHealth(input({ engineState: "stopped" })).verdict).toBe("trouble");
  });
  it("helper crash-loop (>=2 recent restarts) is TROUBLE", () => {
    expect(classifyHealth(input({ helperRestartsRecent: 2 })).verdict).toBe("trouble");
  });
  it("not warmed past the grace window is TROUBLE", () => {
    expect(classifyHealth(input({ warmed: false, msSinceStart: 120_000 })).verdict).toBe("trouble");
  });
  it("not warmed but still within the grace window is STRESSED (warming up)", () => {
    const h = classifyHealth(input({ warmed: false, msSinceStart: 5_000 }));
    expect(h.verdict).toBe("stressed");
    expect(h.reason.toLowerCase()).toContain("warm");
  });
  it("safetyMode active is STRESSED", () => {
    expect(classifyHealth(input({ safetyMode: true })).verdict).toBe("stressed");
  });
  it("a single recent (recovered) helper restart is STRESSED", () => {
    expect(classifyHealth(input({ helperRestartsRecent: 1 })).verdict).toBe("stressed");
  });
  it("sustained throttling is STRESSED", () => {
    expect(classifyHealth(input({ now: sample({ throttled: true }) })).verdict).toBe("stressed");
  });
  it("worst-first precedence: error wins over a stressed signal", () => {
    expect(classifyHealth(input({ engineState: "error", safetyMode: true })).verdict).toBe("trouble");
  });
  it("every verdict carries a non-empty plain reason", () => {
    for (const h of [
      classifyHealth(input()),
      classifyHealth(input({ safetyMode: true })),
      classifyHealth(input({ engineState: "stopped" })),
    ]) expect(h.reason.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd kiosk && npx vitest run test/systemStats.test.ts -t "classifyHealth"`
Expected: FAIL — `classifyHealth` not exported.

- [ ] **Step 3: Implement** (add to `src/backend/systemStats.ts`, after `classifySystemAlerts`; reuse the existing `TEMP_*` consts and `EngineState` import)

First add the import near the top (with the other backend imports):

```ts
import type { EngineState } from "./engine/ScannerEngine.js";
```

Then append:

```ts
// Grace period after engine start before "not warmed" counts as broken rather
// than merely starting up — a normal cold boot reads STRESSED, not TROUBLE.
const WARMUP_GRACE_MS = 60_000;

export interface HealthInput {
  now: SystemSample;
  engineState: EngineState;
  warmed: boolean;
  safetyMode: boolean;
  /** Engine `error` events in the recent trailing window (server-tallied). */
  helperRestartsRecent: number;
  /** Wall-clock ms since the engine last (re)started. */
  msSinceStart: number;
}

export interface HealthVerdict {
  verdict: "healthy" | "stressed" | "trouble";
  reason: string;
}

/**
 * Mission-capability verdict: "is the radio working?" — not "how much CPU is
 * free." Worst-first; first match wins. Pure. See the 2026-06-09 spec.
 */
export function classifyHealth(i: HealthInput): HealthVerdict {
  // TROUBLE — the radio is not doing its job.
  if (i.engineState === "error") return { verdict: "trouble", reason: "Scanner engine error." };
  if (i.engineState === "stopped") return { verdict: "trouble", reason: "Scanner engine stopped." };
  if (i.helperRestartsRecent >= 2) return { verdict: "trouble", reason: "DSP helper keeps crashing." };
  if (!i.warmed && i.msSinceStart >= WARMUP_GRACE_MS) {
    return { verdict: "trouble", reason: "Scanner never finished warming up." };
  }

  // STRESSED — working, but under duress.
  if (!i.warmed) return { verdict: "stressed", reason: "Warming up…" };
  if (i.safetyMode) return { verdict: "stressed", reason: "Running hot — Close Call paused to cool down." };
  if (i.now.throttled === true) return { verdict: "stressed", reason: "CPU thermal-throttling." };
  if (i.helperRestartsRecent >= 1) return { verdict: "stressed", reason: "DSP helper restarted recently." };

  // HEALTHY — running, warmed, coping. Hot-by-design lands here.
  return { verdict: "healthy", reason: "Scanning normally." };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd kiosk && npx vitest run test/systemStats.test.ts`
Expected: PASS (existing tests + the new classifyHealth block).

- [ ] **Step 5: Commit**

```bash
cd kiosk
git add src/backend/systemStats.ts test/systemStats.test.ts
git commit -m "feat(health): classifyHealth mission-capability verdict"
```

---

## Task 2: Server — tally restarts, track start time, add `health` to /api/system

**Files:**
- Modify: `kiosk/src/backend/server.ts`
- Test: `kiosk/test/api.test.ts`

- [ ] **Step 1: Write the failing test** (append inside `describe("HTTP API", …)` in `test/api.test.ts`)

```ts
  it("GET /api/system includes a health verdict and core count", async () => {
    const { server } = makeApp();
    const res = await request(server).get("/api/system");
    expect(res.status).toBe(200);
    expect(res.body.health).toBeDefined();
    expect(["healthy", "stressed", "trouble"]).toContain(res.body.health.verdict);
    expect(typeof res.body.health.reason).toBe("string");
    expect(typeof res.body.coreCount).toBe("number");
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd kiosk && npx vitest run test/api.test.ts -t "health verdict"`
Expected: FAIL — `health` undefined.

- [ ] **Step 3: Implement in `src/backend/server.ts`**

Add the imports (with the other systemStats/os imports — check what's already imported; `os` may need adding):

```ts
import os from "node:os";
import { classifyHealth } from "./systemStats.js";
```

(If `classifyHealth` can be added to an existing `from "./systemStats.js"` import line, do that instead of a second import. If `os` is already imported, don't duplicate.)

Add restart-tally + start-time state near the other engine-tracking `let`s (e.g. beside `let warmed = false;` ~line 224). Read the existing `engine.on((ev) => {...})` blocks first and ADD a new subscription (don't shoehorn into an unrelated one):

```ts
  // Mission-health inputs (spec 2026-06-09). The engine emits `error` on helper-
  // spawn escalation; tally a trailing window so a crash-loop reads as TROUBLE
  // while a single recovered restart is only STRESSED. startedAt feeds the
  // warm-up grace so a cold boot reads "warming up", not "broken".
  let engineStartedAt = Date.now();
  const recentErrors: number[] = [];
  const ERROR_WINDOW_MS = 120_000;
  engine.on((ev) => {
    if (ev.type === "warmup" && ev.phase === "booting") engineStartedAt = Date.now();
    if (ev.type === "error") recentErrors.push(ev.ts);
  });
  function helperRestartsRecent(nowMs: number): number {
    while (recentErrors.length > 0 && nowMs - recentErrors[0]! > ERROR_WINDOW_MS) recentErrors.shift();
    return recentErrors.length;
  }
```

Then change the `GET /api/system` handler (`server.ts:779`). It currently is:

```ts
      return json(res, 200, { ...sysStats.snapshot(), safetyMode });
```

Replace with:

```ts
      const snap = sysStats.snapshot();
      const nowMs = Date.now();
      const health = snap.now
        ? classifyHealth({
            now: snap.now,
            engineState: engine.state,
            warmed,
            safetyMode,
            helperRestartsRecent: helperRestartsRecent(nowMs),
            msSinceStart: nowMs - engineStartedAt,
          })
        : { verdict: "trouble" as const, reason: "No telemetry yet." };
      return json(res, 200, { ...snap, safetyMode, health, coreCount: os.cpus().length });
```

- [ ] **Step 4: Run to verify pass**

Run: `cd kiosk && npx vitest run test/api.test.ts && npm run build`
Expected: the new test passes (FakeEngine reports `state` and no errors → a defined verdict); build succeeds.

- [ ] **Step 5: Commit**

```bash
cd kiosk
git add src/backend/server.ts test/api.test.ts
git commit -m "feat(api): add health verdict + coreCount to /api/system"
```

---

## Task 3: Admin panel — verdict headline, Details disclosure, core-legible helper, drop Load

**Files:**
- Modify: `kiosk/src/frontend/admin/admin.ts`
- Modify: `kiosk/src/frontend/admin/admin.css`

No unit test (DOM glue; logic tested in Tasks 1-2). Verify via `npm run build` + full suite.

- [ ] **Step 1: READ `renderSystem()` (admin.ts ~602-636) and the `#sysBody` section markup (~137-140) first.** Confirm: how `now/ring/alerts/safetyMode` are destructured from the `/api/system` fetch, the `cell(...)` helper, the `spark(...)` helper, and the `num(k)` helper. The verdict + coreCount are now on the payload.

- [ ] **Step 2: Destructure the new fields.** In `renderSystem()`, where the payload is read (currently `const { now, ring, alerts, safetyMode } = await fetch("/api/system").then((r) => r.json()) as {...}`), extend the destructure and the inline type to include:

```ts
      health: { verdict: "healthy" | "stressed" | "trouble"; reason: string };
      coreCount: number;
```

So: `const { now, ring, alerts, safetyMode, health, coreCount } = ...`.

- [ ] **Step 3: Render the verdict headline + wrap gauges in a disclosure.** Replace the `sysBody.innerHTML = cell("CPU"...) + ...` assignment so the verdict leads and the cells live in a `<details>` that is `open` unless healthy. Build it as:

```ts
    const verdictClass = health.verdict; // "healthy" | "stressed" | "trouble"
    const verdictLabel = health.verdict.toUpperCase();
    const num = (k: string) => ring.map((r) => (typeof r[k] === "number" ? r[k] as number : null));
    const cell = (label: string, value: string, sparkHtml: string, hot = false) =>
      `<div class="sysCell${hot ? " hot" : ""}"><div class="sysLabel">${label}</div>
        <div class="sysValue">${value}</div>${sparkHtml}</div>`;
    const t = now.tempC as number | null;
    // DSP helper as core-equivalents over machine cores — legible without top(1) knowledge.
    const helperCores = now.helperCpuPct === null
      ? "—"
      : `${((now.helperCpuPct as number) / 100).toFixed(1)} / ${coreCount} cores · ${now.helperRssMb} MB`;
    const cells =
      cell("CPU", `${now.cpuPct}%`, spark(num("cpuPct"), 100, 85), (now.cpuPct as number) >= 85)
      + cell("DSP helper", helperCores,
          spark(num("helperCpuPct"), 100 * coreCount, 80 * coreCount),
          (now.helperCpuPct as number | null ?? 0) >= 80 * coreCount)
      + cell("Temp", t === null ? "n/a" : `${t}°C${now.throttled ? " · THROTTLED" : ""}`,
          spark(num("tempC"), 100, 87), (t ?? 0) >= 87)
      + cell("RAM", `${now.memUsedPct}% · node ${now.backendRssMb} MB`, spark(num("memUsedPct"), 100, 90), (now.memUsedPct as number) >= 90)
      + cell("Open channels", String(now.openCount), spark(num("openCount"), 12, 11))
      + cell("Disk free", now.diskFreeMb === null ? "n/a" : `${((now.diskFreeMb as number) / 1024).toFixed(1)} GB`,
          "", (now.diskFreeMb as number | null ?? 1e9) < 2048);
    sysBody.innerHTML =
      `<div class="healthVerdict ${verdictClass}">
         <span class="verdictDot"></span>
         <span class="verdictLabel">${verdictLabel}</span>
         <span class="verdictReason">${esc(health.reason)}</span>
       </div>
       <details class="sysDetails"${health.verdict === "healthy" ? "" : " open"}>
         <summary>Details</summary>
         <div class="sysGrid">${cells}</div>
       </details>`;
```

Notes:
- The **Load cell is removed** (it was the trailing `+ \`<div class="sysCell">…Load…\``). Do not include it.
- The DSP-helper spark is rescaled to the machine's capacity: `100*coreCount` max, "hot" at `80*coreCount` (≈80% of all cores), replacing the old fixed `400`/`320`. This keeps the spark meaningful on any core count.
- `esc` is already imported in `admin.ts` (from `../lib/format.js`) — confirm and use it for `health.reason`.
- Keep the existing `#healthBanner` (alerts) rendering above this **unchanged** — the verdict is additive, the alert banner still fires.

- [ ] **Step 4: Wrap the cells in a grid container if needed.** If the old cells relied on `.sysBody` itself being the flex/grid container, add a `.sysGrid` rule mirroring whatever `.sysBody` did (see CSS step). The cells now live inside `<details><div class="sysGrid">`.

- [ ] **Step 5: Add CSS** to `src/frontend/admin/admin.css`. FIRST read the existing `.sysBody`/`.sysCell` rules to mirror the grid layout into `.sysGrid`, and confirm the Campfire token names (`--sage`/`--green`, `--golden-amber`/`--caution`, `--red`, `--bg-subtle`) by grepping `var(--` — use the ones that actually exist (the dedup panel used `--golden-amber`, `--green`, `--caution`, `--red`). Append:

```css
/* Mission-health verdict (spec 2026-06-09). */
.healthVerdict { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-radius: 8px; margin: 0 0 10px; font-size: 14px; }
.healthVerdict .verdictDot { width: 12px; height: 12px; border-radius: 50%; flex: 0 0 auto; }
.healthVerdict .verdictLabel { font-weight: 700; letter-spacing: 0.04em; }
.healthVerdict .verdictReason { color: var(--text-subtle, #9aa7b8); }
.healthVerdict.healthy { background: color-mix(in srgb, var(--green) 9%, var(--bg-subtle)); }
.healthVerdict.healthy .verdictDot { background: var(--green); }
.healthVerdict.stressed { background: color-mix(in srgb, var(--golden-amber) 9%, var(--bg-subtle)); }
.healthVerdict.stressed .verdictDot { background: var(--golden-amber); }
.healthVerdict.trouble { background: color-mix(in srgb, var(--red) 9%, var(--bg-subtle)); }
.healthVerdict.trouble .verdictDot { background: var(--red); }
.sysDetails > summary { cursor: pointer; font-size: 12px; color: var(--text-subtle, #9aa7b8); margin-bottom: 6px; }
/* .sysGrid mirrors the prior .sysBody cell layout — copy the actual grid/flex
   declarations from the existing .sysBody rule (read it before writing this). */
```

Replace the `.sysGrid` comment with the real layout copied from `.sysBody`. If `.sysBody` itself laid out the cells, leave `.sysBody` as-is (it now wraps the verdict + details) and put the cell layout on `.sysGrid`.

- [ ] **Step 6: Build + full suite**

Run: `cd kiosk && npm run build && npx vitest run`
Expected: build succeeds; all tests pass (no frontend unit test added; no regression).

- [ ] **Step 7: Commit**

```bash
cd kiosk
git add src/frontend/admin/admin.ts src/frontend/admin/admin.css
git commit -m "feat(admin): health verdict headline; gauges in Details; legible DSP cores; drop Load"
```

---

## Task 4: Manual verification (dev, no hardware)

**Files:** none.

- [ ] **Step 1:** `USE_FAKE_ENGINE=1 KERCHUNK_CONFIG=/tmp/kc.json npm run dev:backend` + `npm run dev:frontend`. Open `/admin`, the System health section.
- [ ] **Step 2:** Confirm the verdict band shows (FakeEngine running+warmed → **HEALTHY** "Scanning normally"), gauges are collapsed under Details, the DSP-helper cell reads "N / M cores", and there is no Load cell.
- [ ] **Step 3:** Confirm the existing alert `#healthBanner` still renders above the verdict (it's unchanged).
- [ ] **Step 4 (hardware, deferred — per CLAUDE.md off-machine exception):** on the kiosk, confirm a normally-hot box reads HEALTHY (not reddened), and that the verdict matches reality across a real boot (warming-up → healthy) and a forced engine stop (trouble). Then open the PR.

---

## Out of scope (this plan)
- Any new engine instrumentation / real audio-underrun metric (the spec's honest limitation stands).
- Changes to `classifySystemAlerts` or `#healthBanner` — additive only.
- The kiosk HDMI dashboard — admin panel only.

## Success criteria (from the spec)
- The panel answers "is the radio working?" with one word + plain reason before any number is read.
- A hot, busy, scanning box reads HEALTHY (not a wall of red).
- Engine error/stop, helper crash-loop, or load-shedding → the verdict says so and the gauges auto-expand.
- DSP helper is legible as "N / M cores"; the Load cell and its apology are gone.
- `classifyHealth` covered by off-server unit tests; build + suite green; no engine changes.
