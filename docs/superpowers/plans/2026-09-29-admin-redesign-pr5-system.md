# Admin Redesign — PR 5 (System tab) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace admin-next's last placeholder with the real System tab:
- the verdict card, with alerts and uptime
- four vitals with sparklines, plus secondary lines
- the kiosk screen actions
- Connections: the Google Maps key / Map ID, and the locked-out frequencies with Remove
- Power (Restart radio / Reboot / Shut down), behind confirms, with the existing "going down… / back" watcher

**Architecture:**
- The logic lives in a pure, unit-tested module, `systemModel.ts`: vitals and thresholds, sparkline points, uptime text, action copy, the test-alert cycle, and the Maps / lockout helpers.
- Two DOM modules:
  - `system.ts` — verdict, vitals, kiosk screen, power
  - `systemConnections.ts` — the Maps and lockouts sheets, reusing `ui/sheet.ts`
- Two small plumbing changes:
  - `Poller.setPaused()` — the admin stops polling while a restart or reboot is in flight, so the action watcher's own `/api/status` probes are the only requests on the wire.
  - `LiveState.startedAt` from the existing status poll — this gives uptime and the watcher's baseline with no new request.

**Tech Stack:**
- TypeScript ESM (`.js` import suffixes, `strict` + `noUncheckedIndexedAccess`)
- vanilla DOM, Vite
- vitest (node env — no DOM in tests)
- lucide-static

**Spec:** `docs/superpowers/specs/2026-09-28-admin-redesign-design.md` — §6 System, §2 shell/polling, §4 ("Integrations (Google Maps key / Map ID) move to System → Connections"), §8 testing. Mockup: `.superpowers/brainstorm/564019-1790643021/content/library-system.html` (the "System" frame).

**Background:** the classic implementation lives in `kiosk/src/frontend/admin/admin.ts`:
- `spark` + `renderSystem`: lines 1024–1130
- kiosk reload / test alert: lines 2316–2366
- system actions + copy + watcher: lines 2367–2508
- Maps save (`#igSave`): lines 2756–2780
- lockouts (`renderLockouts`): lines 2145–2162

`kiosk/src/frontend/lib/systemActionWatcher.ts` is reused as is.

## Global Constraints

- All commands run from `kiosk/`; the branch is `feat/admin-next-system` in `/home/kiosk/kerchunk-kiosk`.
- Relative imports carry `.js` even from `.ts`; `tsconfig` is `strict` + `noUncheckedIndexedAccess`.
- **The appliance deadlocks on 2+ concurrent requests.**
  - Every System read is a `poller.add` poll. Every write sits inside `ctx.poller.run(...)`. `test/adminNext.lane.test.ts` fails the build on a bare write.
  - A poll's `run` must never call `.run(`.
  - The **one** sanctioned exception is the `SystemActionWatcher` probes, which call `api.getStatus` on their own timers. They are safe only because polling is paused (`poller.setPaused(true)`) from just before the action is sent until the watcher reports `back` or `unchanged`.
- **Write cost:**
  - Maps key / Map ID live in `config.display`, which `toScanConfig` never reads, so saving is live (no restart). The wall's map reads the key at page load, so the status says to refresh the kiosk screen.
  - Removing a lockout (`unlockFreqIn`) re-enables channels at that frequency, which changes the channel set, so it **restarts scanning briefly**. Its confirm says so.
  - Restart radio restarts the backend. Reboot and Shut down go through `/api/system/power`.
- **Emphasis budget** (spec §1.1): coral only for Power and destructive actions, hay for attention, ok-green for healthy. Sea-glass only for the one primary action (there is none on System, so no sea-glass keys) and for sparklines.
- **CSS rules:**
  - System CSS lives in `admin-next/system.css` (imported by `system.ts`).
  - `kc-` classes only; `--kc-*` token colours only.
  - No `backdrop-filter`; no borders on surfaces.
  - Controls are at least 40px tall, keys at least 44px. `.kc-key` is content-box: a container that needs 44px keys sets `box-sizing: border-box; min-height: 44px; padding: 8px 14px` (as `library.css` does).
  - Responsive at 390px (no horizontal scroll) and 1440px.
- **Markup rules:** icons from lucide-static via `ui/icons.ts` only. Server text (alert titles/messages/help, health reason, error messages) and the Maps values go through `esc` or `textContent`.
- **Copy:** sentence case, plain language, and actions say what they do. Carry over the classic system-action copy, renamed as listed in Task 2.
- **No backend or API changes.** `/api/status`, `/api/logs` and `/api/weather` are untouched.
- **Live system:**
  - Never restart `kerchunk-kiosk` during tasks.
  - Frontend verification is `npm run typecheck` + `npm run build:frontend` + `curl -s -X POST localhost:8080/api/kiosk/reload`.
  - The full `npm run build` (C++ helper, thermal cost) runs once, in Task 5.
  - Headless screenshots: PNGs inside `$HOME`, real-time `--timeout=30000`.
  - **Never press Power, kiosk or Remove controls against the live appliance.** The operator does the by-hand checks.
  - Don't start other backends.
- **Commits** end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. **PR body** ends with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
- **Definition of done:** `npm test`, `npm run test:native`, `npm run typecheck` and `npm run build` pass; the PR is opened from the branch. After merge: `gh pr merge <n> --merge --delete-branch`, `git checkout main && git pull --ff-only && git fetch --prune`, `git branch -d feat/admin-next-system`.

## Review Focus

- **The backend goes away mid-action.** After Restart radio, the page must never hang on "Restarting…". The keys come back on `back` or `unchanged`, polling resumes in both cases, and a failed send re-enables everything at once and resumes polling. Pinned by the `Poller.setPaused` tests (Task 1) and the by-hand checklist.
- **`/api/system` answers with `now: null`, or omits fields** (fresh boot, no thermal sensor → `tempC: null`, `diskFreeMb: null`, `helperCpuPct: null` when the helper is down). The vitals show "—" / "n/a" and never throw or print "null%". Pinned by the `vitals` tests (Task 2).
- **Safety mode or severe alerts.** The verdict card shows the worse of health and alerts (`worseVerdict`), and it lists each alert with its help line. The protection note appears only when `safetyMode` is true. Pinned by the `alertsView` tests (Task 2).
- **Maps fields cleared.** An emptied key or Map ID deletes that config key, as classic does. A config with no `display` block says "Set a weather location first" and saves nothing. Pinned by the `withMaps` tests (Task 2).
- **Removing a lockout, then Undo.** Undo restores exactly the prior lockout list and each channel's prior `enabled` flag, never a default. Pinned by the `unlockSnapshot` tests (Task 2).

---

## File map

| File | Change |
|---|---|
| `kiosk/src/frontend/admin-next/poller.ts` | **Modify:** `setPaused(p)`, `paused` getter; `POLL_MS.system` |
| `kiosk/test/adminNext.poller.test.ts` | **Modify** |
| `kiosk/src/frontend/admin-next/live.ts` | **Modify:** `LiveState.startedAt`, set by `withStatus` |
| `kiosk/test/adminNext.live.test.ts` | **Modify** |
| `kiosk/src/frontend/admin-next/systemModel.ts` | **Create:** pure System logic |
| `kiosk/test/adminNext.systemModel.test.ts` | **Create** |
| `kiosk/src/frontend/admin-next/system.ts` | **Create:** verdict, vitals, kiosk screen, power |
| `kiosk/src/frontend/admin-next/systemConnections.ts` | **Create:** Maps + lockouts rows and sheets |
| `kiosk/src/frontend/admin-next/system.css` | **Create** |
| `kiosk/src/frontend/admin-next/ui/icons.ts` | **Modify:** `power`, `refresh`, `bell`, `map` |
| `kiosk/src/frontend/admin-next/index.ts` | **Modify:** mount System; drop the placeholder |
| `kiosk/src/frontend/admin-next/placeholder.ts` | **Delete** (no tab left to hold) |
| `kiosk/test/adminNext.lane.test.ts` | **Modify:** expect `system.ts`, `systemConnections.ts` |

---

### Task 1: Plumbing — `Poller.setPaused`, `POLL_MS.system`, `LiveState.startedAt`

**Files:**
- Modify: `kiosk/src/frontend/admin-next/poller.ts`, `kiosk/src/frontend/admin-next/live.ts`
- Test: `kiosk/test/adminNext.poller.test.ts`, `kiosk/test/adminNext.live.test.ts`

**Interfaces:**
- Produces:
  - `Poller.setPaused(p: boolean): void` — while paused, `tick()` does nothing. When unpaused, every poll is made due, so the screen catches up at once.
  - `Poller.paused: boolean` (getter).
  - `POLL_MS.system = 5_000`.
  - `LiveState.startedAt: number | null` (initial `null`). `withStatus` takes an optional `startedAt?: number` and keeps the previous value when the status omits it.

- [ ] **Step 1: Write the failing tests**

Append to `kiosk/test/adminNext.poller.test.ts`:

```ts
describe("Poller.setPaused", () => {
  it("skips passes while paused and makes everything due on resume", async () => {
    let t = 1_000;
    const p = new Poller({ now: () => t, hidden: () => false });
    const ran: string[] = [];
    p.add({ name: "a", everyMs: 60_000, run: async () => { ran.push("a"); } });
    await p.tick("system");
    expect(ran).toEqual(["a"]);
    p.setPaused(true);
    expect(p.paused).toBe(true);
    t += 120_000;
    await p.tick("system");
    expect(ran).toEqual(["a"]); // paused: nothing runs even though it's due
    p.setPaused(false);
    await p.tick("system");
    expect(ran).toEqual(["a", "a"]);
    t += 1_000;
    p.setPaused(true);
    p.setPaused(false); // resume makes it due again right away
    await p.tick("system");
    expect(ran).toEqual(["a", "a", "a"]);
  });
  it("run() still works while paused (the send itself goes through the lane)", async () => {
    const p = new Poller({ now: () => 0, hidden: () => false });
    p.setPaused(true);
    await expect(p.run(async () => 7)).resolves.toBe(7);
  });
});
```

Append to `kiosk/test/adminNext.live.test.ts`, inside an existing `describe` or a new one (the file imports `initialLive`, `withStatus`):

```ts
describe("startedAt", () => {
  it("is null until a status carries it, then kept when a status omits it", () => {
    expect(initialLive.startedAt).toBeNull();
    const a = withStatus(initialLive, { mode: "scan", monitor: null, startedAt: 111 });
    expect(a.startedAt).toBe(111);
    expect(withStatus(a, { mode: "scan", monitor: null }).startedAt).toBe(111);
    expect(withStatus(a, { mode: "scan", monitor: null, startedAt: 222 }).startedAt).toBe(222);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/adminNext.poller.test.ts test/adminNext.live.test.ts`
Expected: FAIL — `p.setPaused is not a function`; `startedAt` undefined.

- [ ] **Step 3: Implement**

`poller.ts`. Add to `POLL_MS` after `analytics`:

```ts
  system: 5_000,      // System: /api/system (verdict card, vitals + sparklines)
```

In the class, add after `private started = false;`:

```ts
  private isPaused = false;
  get paused(): boolean { return this.isPaused; }

  /** Stop polling (e.g. while a restart/reboot is in flight — the action
   *  watcher's probes must be the only requests on the wire). Resuming makes
   *  every poll due so the screen catches up at once. run() is unaffected. */
  setPaused(p: boolean): void {
    this.isPaused = p;
    if (!p) for (const q of this.polls) q.lastAt = -Infinity;
  }
```

and change the first line of `tick` to:

```ts
    if (this.ticking || this.hidden() || this.isPaused) return;
```

`live.ts`:
- add `startedAt: number | null;` to `LiveState` (comment: `// backend process start (from /api/status) — uptime, and the system-action watcher's baseline`)
- add `startedAt: null` to `initialLive`
- change `withStatus`'s parameter type to `{ mode: LiveState["mode"]; monitor: Channel | null; breakIn?: boolean; startedAt?: number }`
- add `startedAt: typeof st.startedAt === "number" ? st.startedAt : s.startedAt,` to its returned object

`liveStore.syncStatus` already passes the whole `api.getStatus()` result, whose type includes `startedAt?: number`, so nothing else changes there.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/adminNext.poller.test.ts test/adminNext.live.test.ts && npm run typecheck`
Expected: PASS; typecheck clean. If other tests build a `LiveState` literal, add `startedAt: null` there.

- [ ] **Step 5: Commit**

```bash
git add kiosk/src/frontend/admin-next/poller.ts kiosk/src/frontend/admin-next/live.ts kiosk/test/adminNext.poller.test.ts kiosk/test/adminNext.live.test.ts
git commit -m "feat(admin-next): Poller.setPaused, POLL_MS.system, LiveState.startedAt

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: `systemModel.ts` — the System tab's pure logic

**Files:**
- Create: `kiosk/src/frontend/admin-next/systemModel.ts`
- Test: `kiosk/test/adminNext.systemModel.test.ts`

**Interfaces:**
- Consumes: `worseVerdict`, `SystemAlert`, `Verdict` from `./verdict.js`; `unlockFreqIn`, `lockoutFreqIn` are NOT needed here (see `unlockSnapshot`); `Config` type.
- Produces (all exported):
  - Types: `SystemSnapshot`, `Vital`, `ActionCopy`, `SystemAction`.
  - Thresholds: `CPU_WARN_PCT = 85`, `HELPER_WARN_PCT_PER_CORE = 80`, `TEMP_WARN_C = 87`, `RAM_WARN_PCT = 90`, `DISK_LOW_MB = 2048`.
  - Functions:
    - `sparkPoints(values: Array<number | null>, max: number, W?: number, H?: number): string`
    - `vitals(sys: SystemSnapshot): { main: Vital[]; secondary: string[] } | null`
    - `uptimeText(startedAt: number | null, now?: number): string`
    - `verdictView(sys: SystemSnapshot | null): { verdict: Verdict | "unknown"; label: string; reason: string }`
    - `alertsView(sys: SystemSnapshot): { protection: boolean; alerts: SystemAlert[] }`
    - `withMaps(cfg: Config, key: string, mapId: string): Config`
    - `mapsState(cfg: Config): "connected" | "not set"`
    - `unlockSnapshot(cfg: Config, freq: number): { enabled: Map<string, boolean> }`
  - Constants: `SYSTEM_ACTION_COPY: Record<SystemAction, ActionCopy>`, `TEST_ALERTS: readonly string[]`.

- [ ] **Step 1: Write the failing test**

Create `kiosk/test/adminNext.systemModel.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import type { Config } from "../src/backend/config/schema.js";
import {
  sparkPoints, vitals, uptimeText, verdictView, alertsView, withMaps, mapsState, unlockSnapshot,
  SYSTEM_ACTION_COPY, TEST_ALERTS, TEMP_WARN_C, type SystemSnapshot,
} from "../src/frontend/admin-next/systemModel.js";

const now = {
  ts: 1, cpuPct: 34, helperCpuPct: 20, helperRssMb: 60, load1: 1, memUsedPct: 41, backendRssMb: 90,
  tempC: 58, throttled: false, diskFreeMb: 194_560, openCount: 3,
};
const snap = (o: Partial<SystemSnapshot> = {}): SystemSnapshot => ({
  now, ring: [{ ...now, cpuPct: 30, tempC: 57 }, now], alerts: [], safetyMode: false,
  health: { verdict: "healthy", reason: "Scanning normally." }, coreCount: 8, ...o,
});

describe("sparkPoints", () => {
  it("scales values into W×H, nulls sit on the floor, one value spans the width", () => {
    expect(sparkPoints([0, 50, 100], 100, 100, 20)).toBe("0.0,20.0 50.0,10.0 100.0,0.0");
    expect(sparkPoints([null, 200], 100, 100, 20)).toBe("0.0,20.0 100.0,0.0");
    expect(sparkPoints([], 100)).toBe("");
  });
});

describe("vitals", () => {
  it("formats the four main vitals and the secondary lines", () => {
    const v = vitals(snap())!;
    expect(v.main.map((m) => [m.id, m.label, m.value, m.hot])).toEqual([
      ["temp", "Temperature", "58°C", false],
      ["cpu", "CPU", "34%", false],
      ["helper", "DSP helper", "0.2 of 8 cores", false],
      ["disk", "Disk free", "190 GB", false],
    ]);
    expect(v.main[0]!.spark).toBe(sparkPoints([57, 58], 100));
    expect(v.main[3]!.spark).toBeNull();
    expect(v.secondary).toEqual(["RAM 41% · backend 90 MB", "3 channels open"]);
  });
  it("marks hot vitals and says 'throttled'", () => {
    const hot = { ...now, tempC: TEMP_WARN_C, throttled: true, cpuPct: 90, helperCpuPct: 700, diskFreeMb: 1024, memUsedPct: 95, openCount: 1 };
    const v = vitals(snap({ now: hot }))!;
    expect(v.main.map((m) => m.hot)).toEqual([true, true, true, true]);
    expect(v.main[0]!.value).toBe(`${TEMP_WARN_C}°C · throttled`);
    expect(v.main[3]!.value).toBe("1.0 GB");
    expect(v.secondary[0]).toBe("RAM 95% · backend 90 MB — high");
    expect(v.secondary[1]).toBe("1 channel open");
  });
  it("degrades missing readings to dashes, and returns null with no sample", () => {
    const bare = { ...now, tempC: null, helperCpuPct: null, helperRssMb: null, diskFreeMb: null, throttled: null };
    const v = vitals(snap({ now: bare }))!;
    expect(v.main.map((m) => m.value)).toEqual(["—", "34%", "Not running", "—"]);
    expect(v.main.some((m) => m.hot)).toBe(false);
    expect(vitals(snap({ now: null }))).toBeNull();
  });
});

describe("uptimeText", () => {
  it("reads days/hours/minutes", () => {
    const t = 10_000_000_000;
    expect(uptimeText(null, t)).toBe("");
    expect(uptimeText(t - 30_000, t)).toBe("up less than a minute");
    expect(uptimeText(t - 5 * 60_000, t)).toBe("up 5 min");
    expect(uptimeText(t - (3 * 3600 + 20 * 60) * 1000, t)).toBe("up 3 h 20 min");
    expect(uptimeText(t - (3 * 86400 + 4 * 3600) * 1000, t)).toBe("up 3 d 4 h");
  });
});

describe("verdictView and alertsView", () => {
  it("labels the verdict, worse of health and alerts, or unknown", () => {
    expect(verdictView(snap())).toEqual({ verdict: "healthy", label: "Healthy", reason: "Scanning normally." });
    const severe = { id: "t", severity: "severe" as const, title: "Overheating", message: "m", help: "h" };
    expect(verdictView(snap({ alerts: [severe] }))).toEqual({ verdict: "trouble", label: "Trouble", reason: "Overheating" });
    expect(verdictView(snap({ health: { verdict: "stressed", reason: "Busy." } }))).toMatchObject({ label: "Degraded" });
    expect(verdictView(null)).toEqual({ verdict: "unknown", label: "Unknown", reason: "Can't reach the radio" });
  });
  it("lists alerts, severe first, and flags protection only in safety mode", () => {
    const a = { id: "a", severity: "attention" as const, title: "A", message: "", help: "" };
    const s = { id: "s", severity: "severe" as const, title: "S", message: "", help: "" };
    expect(alertsView(snap({ alerts: [a, s] })).alerts.map((x) => x.id)).toEqual(["s", "a"]);
    expect(alertsView(snap()).protection).toBe(false);
    expect(alertsView(snap({ safetyMode: true })).protection).toBe(true);
  });
});

describe("maps", () => {
  const base = { display: { weatherLat: 39, weatherLon: -94, googleMapsApiKey: "AIzaOLD" } } as unknown as Config;
  it("sets, trims and clears the key and Map ID", () => {
    expect(withMaps(base, " AIzaNEW ", "").display).toEqual({ weatherLat: 39, weatherLon: -94, googleMapsApiKey: "AIzaNEW" });
    expect(withMaps(base, "", " vec1 ").display).toEqual({ weatherLat: 39, weatherLon: -94, googleMapsMapId: "vec1" });
    expect(base.display!.googleMapsApiKey).toBe("AIzaOLD"); // input not mutated
  });
  it("refuses without a display block", () => {
    expect(() => withMaps({} as Config, "k", "")).toThrow("Set a weather location first — the map needs coordinates.");
    expect(withMaps({} as Config, "", "")).toEqual({});
  });
  it("says whether a key is set", () => {
    expect(mapsState(base)).toBe("connected");
    expect(mapsState({} as Config)).toBe("not set");
  });
});

describe("unlockSnapshot", () => {
  it("records each channel's enabled flag at the frequency", () => {
    const cfg = { channels: [
      { id: "a", freq: 5, enabled: false }, { id: "b", freq: 5, enabled: true }, { id: "c", freq: 6, enabled: false },
    ] } as unknown as Config;
    expect([...unlockSnapshot(cfg, 5).enabled.entries()]).toEqual([["a", false], ["b", true]]);
  });
});

describe("copy", () => {
  it("names the three power actions and warns about scanning", () => {
    expect(Object.keys(SYSTEM_ACTION_COPY)).toEqual(["restart", "reboot", "poweroff"]);
    expect(SYSTEM_ACTION_COPY.restart.confirmLabel).toBe("Restart radio");
    expect(SYSTEM_ACTION_COPY.poweroff.message).toContain("power button");
    expect(TEST_ALERTS[0]).toBe("TORNADO WARNING");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/adminNext.systemModel.test.ts`
Expected: FAIL — cannot resolve `systemModel.js`.

- [ ] **Step 3: Implement**

Create `kiosk/src/frontend/admin-next/systemModel.ts`:

```ts
// System tab logic, pure (no DOM, no fetch): vitals and their warn lines,
// sparklines, uptime, the verdict card, power-action copy, the Maps and
// lockout helpers. system.ts / systemConnections.ts only render these.
import type { Config } from "../../backend/config/schema.js";
import { worseVerdict, UNREACHABLE_TEXT, type SystemAlert, type Verdict } from "./verdict.js";

/** One /api/system reading (SystemSample in backend/systemStats.ts). */
export interface SystemNow {
  ts: number; cpuPct: number; helperCpuPct: number | null; helperRssMb: number | null; load1: number;
  memUsedPct: number; backendRssMb: number; tempC: number | null; throttled: boolean | null;
  diskFreeMb: number | null; openCount: number;
}
export interface SystemSnapshot {
  now: SystemNow | null;
  ring: SystemNow[];
  alerts: SystemAlert[];
  safetyMode: boolean;
  health: { verdict: Verdict; reason: string };
  coreCount: number;
}

// Warn lines — calibrated to this appliance (classic renderSystem): it idles
// ~82-83 °C, so "hot" starts at the backend's own "running hot" line.
export const CPU_WARN_PCT = 85;
export const HELPER_WARN_PCT_PER_CORE = 80;
export const TEMP_WARN_C = 87;
export const RAM_WARN_PCT = 90;
export const DISK_LOW_MB = 2048;

export interface Vital { id: "temp" | "cpu" | "helper" | "disk"; label: string; value: string; hot: boolean; spark: string | null }

/** Polyline points for a sparkline: values scaled 0..max into W×H (y down),
 *  nulls on the floor, clamped. */
export function sparkPoints(values: Array<number | null>, max: number, W = 120, H = 28): string {
  if (!values.length) return "";
  return values.map((v, i) => {
    const x = values.length === 1 ? W / 2 : (i / (values.length - 1)) * W;
    const y = H - Math.min(1, Math.max(0, (v ?? 0) / max)) * H;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
}

export function vitals(sys: SystemSnapshot): { main: Vital[]; secondary: string[] } | null {
  const n = sys.now;
  if (!n) return null;
  const series = (k: keyof SystemNow): Array<number | null> =>
    sys.ring.map((r) => (typeof r[k] === "number" ? (r[k] as number) : null));
  const cores = Math.max(1, sys.coreCount);
  const t = n.tempC;
  const main: Vital[] = [
    {
      id: "temp", label: "Temperature",
      value: t === null ? "—" : `${t}°C${n.throttled ? " · throttled" : ""}`,
      hot: t !== null && t >= TEMP_WARN_C, spark: sparkPoints(series("tempC"), 100),
    },
    { id: "cpu", label: "CPU", value: `${n.cpuPct}%`, hot: n.cpuPct >= CPU_WARN_PCT, spark: sparkPoints(series("cpuPct"), 100) },
    {
      id: "helper", label: "DSP helper",
      value: n.helperCpuPct === null ? "Not running" : `${(n.helperCpuPct / 100).toFixed(1)} of ${cores} cores`,
      hot: n.helperCpuPct !== null && n.helperCpuPct >= HELPER_WARN_PCT_PER_CORE * cores,
      spark: sparkPoints(series("helperCpuPct"), 100 * cores),
    },
    {
      id: "disk", label: "Disk free",
      value: n.diskFreeMb === null ? "—" : n.diskFreeMb >= 10 * 1024 ? `${Math.round(n.diskFreeMb / 1024)} GB` : `${(n.diskFreeMb / 1024).toFixed(1)} GB`,
      hot: n.diskFreeMb !== null && n.diskFreeMb < DISK_LOW_MB, spark: null,
    },
  ];
  const secondary = [
    `RAM ${n.memUsedPct}% · backend ${n.backendRssMb} MB${n.memUsedPct >= RAM_WARN_PCT ? " — high" : ""}`,
    `${n.openCount} channel${n.openCount === 1 ? "" : "s"} open`,
  ];
  return { main, secondary };
}

/** "up 3 d 4 h" from the backend's start time, or "" when unknown. */
export function uptimeText(startedAt: number | null, now: number = Date.now()): string {
  if (startedAt === null) return "";
  const m = Math.floor(Math.max(0, now - startedAt) / 60_000);
  if (m < 1) return "up less than a minute";
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  const min = m % 60;
  if (d > 0) return `up ${d} d${h ? ` ${h} h` : ""}`;
  if (h > 0) return `up ${h} h${min ? ` ${min} min` : ""}`;
  return `up ${min} min`;
}

const LABEL: Record<Verdict | "unknown", string> = { healthy: "Healthy", stressed: "Degraded", trouble: "Trouble", unknown: "Unknown" };

export function verdictView(sys: SystemSnapshot | null): { verdict: Verdict | "unknown"; label: string; reason: string } {
  if (!sys || typeof sys.health?.verdict !== "string") return { verdict: "unknown", label: LABEL.unknown, reason: UNREACHABLE_TEXT };
  const v = worseVerdict(sys.health, sys.alerts ?? []);
  return { verdict: v.verdict, label: LABEL[v.verdict], reason: v.text };
}

/** Alerts to list under the verdict (severe first) and whether the thermal
 *  protection note shows. */
export function alertsView(sys: SystemSnapshot): { protection: boolean; alerts: SystemAlert[] } {
  const rank = (a: SystemAlert): number => (a.severity === "severe" ? 0 : 1);
  return { protection: sys.safetyMode === true, alerts: [...(sys.alerts ?? [])].sort((a, b) => rank(a) - rank(b)) };
}

/** The config with the Maps key / Map ID set (trimmed) or cleared (empty).
 *  No display block = no coordinates = no map: refuse a non-empty value. */
export function withMaps(cfg: Config, key: string, mapId: string): Config {
  const k = key.trim();
  const id = mapId.trim();
  if (!cfg.display) {
    if (k || id) throw new Error("Set a weather location first — the map needs coordinates.");
    return cfg;
  }
  const { googleMapsApiKey: _k, googleMapsMapId: _m, ...rest } = cfg.display;
  return {
    ...cfg,
    display: { ...rest, ...(k ? { googleMapsApiKey: k } : {}), ...(id ? { googleMapsMapId: id } : {}) },
  };
}

export function mapsState(cfg: Config): "connected" | "not set" {
  return cfg.display?.googleMapsApiKey ? "connected" : "not set";
}

/** What removing a lockout will change, so Undo restores exactly that: each
 *  channel's enabled flag at the frequency (unlockFreqIn re-enables them). */
export function unlockSnapshot(cfg: Config, freq: number): { enabled: Map<string, boolean> } {
  const enabled = new Map<string, boolean>();
  for (const c of cfg.channels ?? []) if (c.freq === freq) enabled.set(c.id, c.enabled);
  return { enabled };
}

export type SystemAction = "restart" | "reboot" | "poweroff";
export interface ActionCopy {
  title: string; message: string; confirmLabel: string;
  pending: string; down: string; back: string; unchanged: string;
}

/** Power-action copy (classic SYSTEM_ACTION_COPY; "backend" is "radio" here). */
export const SYSTEM_ACTION_COPY: Record<SystemAction, ActionCopy> = {
  restart: {
    title: "Restart the radio?",
    message: "Audio and scanning stop briefly while the radio and its helpers restart.",
    confirmLabel: "Restart radio",
    pending: "Restarting the radio…",
    down: "The radio is down — waiting for it to come back…",
    back: "The radio is back.",
    unchanged: "The radio didn't restart. Try again.",
  },
  reboot: {
    title: "Reboot the appliance?",
    message: "The whole machine restarts. Radio, audio and the kiosk screen go down for about a minute.",
    confirmLabel: "Reboot",
    pending: "Rebooting the appliance…",
    down: "The appliance is rebooting — waiting for it to come back…",
    back: "The appliance is back online.",
    unchanged: "The reboot didn't start. Try again.",
  },
  poweroff: {
    title: "Shut down the appliance?",
    message: "The machine powers off. It won't come back until someone presses the power button on the laptop.",
    confirmLabel: "Shut down",
    pending: "Shutting down…",
    down: "The appliance is off — press its power button to start it again.",
    back: "The appliance is back online.",
    unchanged: "The shut down didn't start. Try again.",
  },
};

/** Test weather alerts, cycled one per press (each themed banner in turn). */
export const TEST_ALERTS: readonly string[] = [
  "TORNADO WARNING", "SEVERE THUNDERSTORM WARNING", "FLASH FLOOD WARNING", "TORNADO WATCH", "WINTER STORM WARNING",
];
```

Check before moving on: if `SystemAlert` / `Verdict` / `UNREACHABLE_TEXT` are not all exported from `verdict.ts`, export them there (they are in the current file). Don't change their shapes.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/adminNext.systemModel.test.ts && npm run typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add kiosk/src/frontend/admin-next/systemModel.ts kiosk/test/adminNext.systemModel.test.ts
git commit -m "feat(admin-next): systemModel — vitals, sparklines, uptime, verdict, power copy, maps/lockout helpers

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: System tab — verdict, vitals, kiosk screen, power

**Files:**
- Create: `kiosk/src/frontend/admin-next/system.ts`, `kiosk/src/frontend/admin-next/system.css`
- Modify: `kiosk/src/frontend/admin-next/ui/icons.ts`, `kiosk/src/frontend/admin-next/index.ts`, `kiosk/test/adminNext.lane.test.ts`
- Delete: `kiosk/src/frontend/admin-next/placeholder.ts`

**Interfaces:**
- Consumes: Task 1 (`poller.setPaused`, `POLL_MS.system`, `live.state.startedAt`, `live.state.breakIn`), Task 2 (everything), `SystemActionWatcher` (`lib/systemActionWatcher.ts`), `api.getSystem`, `api.getStatus`, `api.restartBackend`, `api.powerAction`, `api.reloadKiosk`, `api.testAlert`, the ui kit (`group`, `key`, `emptyState`), `ctx.dialogs`.
- Produces: `mountSystem(ctx: Ctx): void`. It renders a `<div id="kcSysConnections"></div>` host that Task 4 fills via `mountConnections(ctx, host)`. **In this task, create `systemConnections.ts` as a stub** exporting `mountConnections(ctx: Ctx, host: HTMLElement): void` that renders `emptyState("Loading connections…")`. Task 4 replaces it.

- [ ] **Step 1: Add icons**

In `ui/icons.ts`, add `power` (`lucide-static/icons/power.svg`), `refresh` (`refresh-cw.svg`), `bell` (`bell-ring.svg`), `map` (`map.svg`) to the imports and the `ICONS` map.

- [ ] **Step 2: Implement `system.ts`**

```ts
// System — the verdict, four vitals, kiosk screen actions, connections and
// power (spec §6). /api/system is one poll (System tab only); uptime and the
// break-in flag come from the live store's status poll, so no extra request.
//
// Power actions take the backend away. The routes answer 202 and then exit,
// so SystemActionWatcher probes /api/status until a different process
// answers (or clearly nothing happened). While it watches, the Poller is
// PAUSED: the watcher's probes are then the only requests on the wire (this
// box deadlocks on concurrent requests). Every other write rides poller.run
// (test/adminNext.lane.test.ts enforces it).
import "./system.css";
import { api } from "../lib/api.js";
import { esc } from "../lib/format.js";
import { SystemActionWatcher } from "../lib/systemActionWatcher.js";
import { emptyState, group } from "./ui/kit.js";
import { ico } from "./ui/icons.js";
import { POLL_MS } from "./poller.js";
import { hrefFor } from "./route.js";
import {
  alertsView, SYSTEM_ACTION_COPY, TEST_ALERTS, uptimeText, verdictView, vitals,
  type SystemAction, type SystemSnapshot,
} from "./systemModel.js";
import { mountConnections } from "./systemConnections.js";
import type { Ctx } from "./ctx.js";

// Knobs: how patiently the page waits out a power action.
export const WATCH_POLL_MS = 2000;          // while the backend still answers
export const WATCH_DOWN_POLL_MS = 5000;     // once it's gone (a reboot ≈ a minute)
export const WATCH_TIMEOUT_MS = 20_000;     // same process still up ⇒ the action never took
export const WATCH_PROBE_TIMEOUT_MS = 4000; // a rebooting host swallows connections
export const BACK_MESSAGE_MS = 8000;        // how long "…is back" stays
export const KIOSK_STATUS_MS = 6000;        // how long a kiosk-action result stays
```

(Vitals come with their sparkline points already computed by `vitals()`.)

**Markup** (build once in `mountSystem`):

```ts
  const el = ctx.shell.panel("system");
  el.innerHTML = `<div class="kc-sys">
    <header class="kc-sys__head"><h1>System</h1></header>
    <section class="kc-group kc-verdictCard" aria-label="Health">
      <div class="kc-verdictCard__line" role="status" aria-live="polite">
        <i class="kc-verdictCard__dot" aria-hidden="true"></i><b id="kcSysLabel">Checking…</b><span id="kcSysReason"></span>
      </div>
      <p class="kc-verdictCard__up" id="kcSysUp"></p>
      <div id="kcSysAlerts"></div>
    </section>
    <div class="kc-vitals" id="kcSysVitals">${emptyState("Loading readings…")}</div>
    <p class="kc-vitals__more" id="kcSysMore"></p>
    ${group("Kiosk screen", `
      <button type="button" class="kc-row kc-row--btn" data-kiosk="reload">${ico("refresh")}<span>Refresh kiosk screen</span></button>
      <button type="button" class="kc-row kc-row--btn" data-kiosk="alert">${ico("bell")}<span>Show a test weather alert</span></button>
      <button type="button" class="kc-row kc-row--btn" data-kiosk="clear">${ico("close")}<span>Clear the test alert</span></button>
      <p class="kc-status" id="kcKioskStatus" role="status" aria-live="polite"></p>`)}
    <div id="kcSysConnections"></div>
    ${group("Power", `
      <button type="button" class="kc-row kc-row--btn kc-row--danger" data-power="restart">${ico("power")}<span>Restart radio</span></button>
      <button type="button" class="kc-row kc-row--btn kc-row--danger" data-power="reboot">${ico("power")}<span>Reboot appliance</span></button>
      <button type="button" class="kc-row kc-row--btn kc-row--danger" data-power="poweroff">${ico("power")}<span>Shut down</span></button>
      <p class="kc-status" id="kcPowerStatus" role="status" aria-live="polite"></p>`)}
  </div>`;
  mountConnections(ctx, el.querySelector<HTMLElement>("#kcSysConnections")!);
```

**Verdict + vitals poll** (System tab only):

```ts
  let lastAlertSig = "";
  let lastVitals = "";
  ctx.poller.add({
    name: "system", everyMs: POLL_MS.system, tabs: ["system"],
    run: async () => {
      let sys: SystemSnapshot | null = null;
      try { sys = await api.getSystem<SystemSnapshot>(); } catch { /* shown as unknown */ }
      paintVerdict(sys);
      paintVitals(sys);
    },
  });
```

`paintVerdict(sys)`:
- Take `verdictView(sys)`. Set `.kc-verdictCard`'s `dataset.verdict` and the label and reason via `textContent`, touching them only when the text changed (the line is a polite live region).
- Build the alerts list from `alertsView(sys)` only when `sys` is non-null. Rewrite `#kcSysAlerts` only when the signature changes, with the signature being `${protection}|${alerts.map(a => a.id + ":" + a.severity).join(",")}`. The block:
  - a hay note when `protection`: "Protection is on: the box is above its thermal limit. Close Call and sweep ranges stay off until it cools."
  - then one `.kc-alert[data-severity]` per alert: `<b>${esc(title)}</b><span>${esc(message)}</span><small>${esc(help)}</small>`
  - an alert whose id starts with `cpu-` or `memory-` gets a `kc-link` to `hrefFor({ tab: "tune" })` reading "Open Tune"
- `paintUptime()` sets `#kcSysUp` to `uptimeText(ctx.live.state.startedAt)`. Call it from `paintVerdict` and from `ctx.live.subscribe` (only when the text changed).

`paintVitals(sys)`:
- Take `v = sys ? vitals(sys) : null`. With `v` null: if nothing has rendered yet, show `emptyState(sys ? "No readings yet — they appear within a minute." : "Readings are unavailable right now.")`; otherwise leave the last good vitals on screen.
- Otherwise build:

  ```ts
  v.main.map((m) => `<div class="kc-vital${m.hot ? " kc-vital--hot" : ""}" data-vital="${m.id}">
      <span class="kc-vital__label">${m.label}</span>
      <b class="kc-vital__value">${esc(m.value)}</b>
      ${m.spark !== null ? `<svg class="kc-spark2" viewBox="0 0 120 28" preserveAspectRatio="none" aria-hidden="true"><polyline points="${m.spark}"/></svg>` : ""}
    </div>`).join("")
  ```

  Write it only when the string differs from `lastVitals`. Set `#kcSysMore` to `v.secondary.join(" · ")` via `textContent`.

**Kiosk screen** (delegated click on the kiosk group):
- `reload` → `ctx.poller.run(() => api.reloadKiosk())`. The status goes "Refreshing the kiosk screen…" → "Refresh sent." (or the error message).
- `alert`:
  - `const tag = TEST_ALERTS[i++ % TEST_ALERTS.length]!`
  - `ctx.poller.run(() => api.testAlert({ alphaTag: tag }))`
  - status "Showing “${tag}” on the kiosk — press again for the next type."
- `clear` → `ctx.poller.run(() => api.testAlert({ clear: true }))`. Status "Test alert cleared."

The button is disabled while its request is in flight. The status is set via `textContent` and clears after `KIOSK_STATUS_MS`.

**Power** (delegated click on the power group; `data-power` is a `SystemAction`):

```ts
  const powerBtns = [...el.querySelectorAll<HTMLButtonElement>("[data-power]")];
  let watcher: SystemActionWatcher | undefined;
  let powerTimer: ReturnType<typeof setTimeout> | undefined;
  function powerStatus(text: string, clearMs?: number): void {
    if (powerTimer !== undefined) clearTimeout(powerTimer);
    powerTimer = undefined;
    powerStatusEl.textContent = text;
    if (clearMs !== undefined) powerTimer = setTimeout(() => { powerStatusEl.textContent = ""; }, clearMs);
  }
  function settle(): void {
    for (const b of powerBtns) b.disabled = false;
    ctx.poller.setPaused(false);
  }
  async function runAction(action: SystemAction): Promise<void> {
    const copy = SYSTEM_ACTION_COPY[action];
    const ok = await ctx.dialogs.confirm({
      title: copy.title,
      message: ctx.live.state.breakIn ? `A weather alert is on air right now. ${copy.message}` : copy.message,
      confirmLabel: copy.confirmLabel, danger: true,
    });
    if (!ok) return;
    const baseline = ctx.live.state.startedAt ?? undefined;
    for (const b of powerBtns) b.disabled = true;
    powerStatus(copy.pending);
    try {
      await ctx.poller.run(() => (action === "restart" ? api.restartBackend() : api.powerAction(action)));
    } catch (e) {
      // The send failed, so nothing is going down: recover now.
      powerStatus(e instanceof Error ? e.message : String(e));
      for (const b of powerBtns) b.disabled = false;
      return;
    }
    // From here the watcher's probes are the only requests: pause the polls.
    ctx.poller.setPaused(true);
    watcher?.stop();
    watcher = new SystemActionWatcher({
      probe: (signal) => api.getStatus(signal),
      baselineStartedAt: baseline,
      pollMs: WATCH_POLL_MS, downPollMs: WATCH_DOWN_POLL_MS,
      timeoutMs: WATCH_TIMEOUT_MS, probeTimeoutMs: WATCH_PROBE_TIMEOUT_MS,
      onPhase: (phase) => {
        switch (phase) {
          case "pending": powerStatus(copy.pending); break;
          case "down": powerStatus(copy.down); break;
          case "back": powerStatus(copy.back, BACK_MESSAGE_MS); settle(); ctx.live.requestResync(); break;
          case "unchanged": powerStatus(copy.unchanged); settle(); break;
        }
      },
    });
    watcher.start();
  }
```

Check `ctx.live.requestResync` exists (`liveStore.ts` — `onSocketOpen` calls `this.requestResync()`). If it is private, make it public, since a fresh process needs a status resync.

`api.getStatus` (a read) inside the watcher is outside `.run(` by design (see Global Constraints). The lane test only checks writes, so it passes.

**Wire-in:**
- `index.ts`:
  - replace `renderPlaceholder(shell.panel("system"), "system");` with `mountSystem(ctx);` (after `mountLibrary(ctx)`)
  - delete the `renderPlaceholder` import
  - delete `placeholder.ts` (`git rm`)
  - check nothing else imports it: `grep -rn placeholder kiosk/src kiosk/test`
- `test/adminNext.lane.test.ts`: in "finds the admin-next sources" add `expect(files).toContain("system.ts"); expect(files).toContain("systemConnections.ts");`.

- [ ] **Step 3: Implement `system.css`**

```css
/* System — verdict card, vitals, action rows. Faceplate language: tone
   separation, --kc-line between rows only; coral for power, hay for attention. */
.kc-sys__head h1 { margin: 8px 0 2px; font-size: var(--kc-t-title); font-weight: 700; }
.kc-verdictCard { padding: 14px 16px; }
.kc-verdictCard__line { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; font-size: var(--kc-t-lead); }
.kc-verdictCard__dot { width: 10px; height: 10px; border-radius: 50%; background: var(--kc-mute); align-self: center; flex: none; }
.kc-verdictCard[data-verdict="healthy"] .kc-verdictCard__dot { background: var(--kc-ok); }
.kc-verdictCard[data-verdict="stressed"] .kc-verdictCard__dot { background: var(--kc-hay); }
.kc-verdictCard[data-verdict="trouble"] .kc-verdictCard__dot { background: var(--kc-coral); }
.kc-verdictCard__line span { color: var(--kc-dim); font-size: var(--kc-t-body); }
.kc-verdictCard__up { margin: 4px 0 0 20px; color: var(--kc-mute); font-size: var(--kc-t-small); min-height: 1.2em; }
.kc-verdictCard__up:empty { display: none; }
.kc-protect { margin: 12px 0 0; padding: 10px 12px; border-radius: var(--kc-r-key); background: color-mix(in srgb, var(--kc-hay) 12%, var(--kc-ground)); color: var(--kc-hay); font-size: var(--kc-t-small); }
.kc-alert { display: grid; gap: 2px; margin-top: 10px; padding: 10px 12px; border-radius: var(--kc-r-key); background: var(--kc-key); font-size: var(--kc-t-small); }
.kc-alert[data-severity="severe"] b { color: var(--kc-coral); }
.kc-alert[data-severity="attention"] b { color: var(--kc-hay); }
.kc-alert span { color: var(--kc-ink); }
.kc-alert small { color: var(--kc-mute); }
.kc-vitals { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; margin-top: 14px; }
@media (min-width: 900px) { .kc-vitals { grid-template-columns: repeat(4, minmax(0, 1fr)); } }
.kc-vital { background: var(--kc-raised); border-radius: var(--kc-r-group); padding: 12px 14px; min-width: 0; }
.kc-vital__label { display: block; color: var(--kc-dim); font-size: var(--kc-t-small); font-weight: 600; }
.kc-vital__value { display: block; font-size: var(--kc-t-lead); font-weight: 700; font-variant-numeric: tabular-nums; margin: 2px 0 6px; overflow-wrap: anywhere; }
.kc-vital--hot .kc-vital__value { color: var(--kc-coral); }
.kc-spark2 { width: 100%; height: 28px; display: block; }
.kc-spark2 polyline { fill: none; stroke: var(--kc-glass); stroke-width: 1.5; vector-effect: non-scaling-stroke; }
.kc-vital--hot .kc-spark2 polyline { stroke: var(--kc-coral); }
.kc-vitals__more { margin: 8px 4px 0; color: var(--kc-mute); font-size: var(--kc-t-small); min-height: 1.2em; }
.kc-row--btn { width: 100%; box-sizing: border-box; min-height: 48px; background: none; border: 0; border-top: 1px solid var(--kc-line); color: var(--kc-ink); font: inherit; text-align: left; justify-content: flex-start; gap: 12px; cursor: pointer; }
.kc-group__title + .kc-row--btn { border-top: 0; }
.kc-row--btn:hover { background: color-mix(in srgb, var(--kc-ink) 4%, transparent); }
.kc-row--btn:disabled { opacity: 0.5; cursor: progress; }
.kc-row--danger { color: var(--kc-coral); }
.kc-row__end { margin-left: auto; color: var(--kc-mute); font-size: var(--kc-t-small); display: inline-flex; align-items: center; gap: 4px; }
```

If a token used above doesn't exist in `tokens.css`, use the nearest existing `--kc-*` token and record the substitution. Never use a raw colour.

- [ ] **Step 4: Verify**

Run: `npx vitest run && npm run typecheck && npm run build:frontend && curl -s -X POST localhost:8080/api/kiosk/reload`
Expected: all PASS (the lane test includes `system.ts`); clean; OK.

Capture `#/next/system` at 1440×1000 and 390×844 (real time, `--timeout=30000`, PNGs in `~/kc-shots/`). Read them and check:
- the verdict matches `curl -s localhost:8080/api/system | jq .health`
- the temperature and CPU match that reading within one poll
- uptime is present
- the Power rows are coral
- there is no horizontal scroll at 390

**Do not press any key.**

- [ ] **Step 5: Commit**

```bash
git add -A kiosk/src/frontend/admin-next kiosk/test/adminNext.lane.test.ts
git commit -m "feat(admin-next): System tab — verdict, vitals, kiosk screen, power with a paused watcher

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Connections — Google Maps and locked-out frequencies

**Files:**
- Modify (replace stub): `kiosk/src/frontend/admin-next/systemConnections.ts`
- Modify: `kiosk/src/frontend/admin-next/system.css`

**Interfaces:**
- Consumes: `mountSheet` (`ui/sheet.ts` — call **once per sheet**), `field`, `group`, `key`, `emptyState` (`ui/kit.ts`), `withMaps`, `mapsState`, `unlockSnapshot` (Task 2), `unlockFreqIn` (`lib/lockout.ts`), `fmtFreq`, `esc`, `api.getConfig`/`putConfig`, `ctx.poller`, `ctx.dialogs`, `ctx.shell.route()`.
- Produces: `mountConnections(ctx: Ctx, host: HTMLElement): void`.

- [ ] **Step 1: Implement**

**Rows** (a `group("Connections", …)` in `host`):
- a `button.kc-row.kc-row--btn` with `data-conn="maps"`: `${ico("map")}<span>Google Maps</span><span class="kc-row__end" id="kcMapsState">…${ico("chevron")}</span>`
- a `button.kc-row.kc-row--btn` with `data-conn="lockouts"`: `${ico("lockout")}<span>Locked-out frequencies</span><span class="kc-row__end" id="kcLockCount">…${ico("chevron")}</span>`

**Poll** (System tab only, `everyMs: POLL_MS.audio` — reuse the existing 15 s knob rather than a new one):

```ts
  let cfg: Config | null = null;
  ctx.poller.add({
    name: "connections", everyMs: POLL_MS.audio, tabs: ["system"],
    run: async () => { try { cfg = await api.getConfig(); paint(); } catch { /* keep last */ } },
  });
```

`paint()` updates the row ends via `textContent`: "Connected" / "Not set", and the lockout count (`cfg.scan.lockoutHz?.length ?? 0`). If a sheet is open, it re-renders that sheet's body, subject to the rule below.

**Maps sheet** (`mountSheet(host, { id: "kcMapsSheet", label: "Google Maps" })`):
- Body:
  - an intro `<p class="kc-empty">`: "The kiosk map and the admin's location tools use this key. Saved as you go — refresh the kiosk screen afterwards so the map picks it up."
  - `field({ id: "kcMapsKey", label: "API key", control: '<input id="kcMapsKey" type="text" autocomplete="off" spellcheck="false" placeholder="AIza…">' })`
  - `field({ id: "kcMapsId", label: "Map ID", control: '<input id="kcMapsId" type="text" autocomplete="off" spellcheck="false" placeholder="Optional vector map ID">', hint: "Leave empty for the standard map." })`
  - `<p class="kc-status" id="kcMapsStatus" role="status" aria-live="polite">`
- Fill the values from `cfg.display` when the sheet opens. **Never overwrite a focused or dirty input from a poll.** Mark an input dirty on `input`; clear it after its save settles when the value is unchanged.
- **Save** on each input's `change` (blur/Enter), live:

  ```ts
  await ctx.poller.run(async () => {
    const c = await api.getConfig();
    await api.putConfig(withMaps(c, keyEl.value, idEl.value));
  });
  ```

  - `withMaps` throws with no display block. Show that message in the status line and send nothing (it is thrown before `putConfig`).
  - Success: "Saved. Refresh the kiosk screen to use it." Also refresh `cfg` by `ctx.poller.request("connections")` + `void ctx.poller.tick("system")`.
  - Failure: the server message, and keep the typed value.

**Lockouts sheet** (`mountSheet(host, { id: "kcLockSheet", label: "Locked-out frequencies" })`):
- Body when empty: `emptyState("Nothing is locked out. Lock out a frequency from Radio or the Library.")`
- Otherwise:
  - an intro: "These are never scanned and Close Call never reports them. Removing one scans it again (restarts scanning briefly)."
  - one row per frequency, sorted ascending: `<div class="kc-row" data-hz="${f}"><span class="kc-row__name">${fmtFreq(f)} MHz${name ? ` · ${esc(name)}` : ""}</span><button type="button" class="kc-key" data-unlock="${f}">Remove</button></div>`
  - `name` is the first channel at that frequency's `alphaTag`, if any.
- **Remove** (confirm, then write, then Undo):

  ```ts
  const ok = await ctx.dialogs.confirm({
    title: `Scan ${fmtFreq(f)} MHz again?`,
    message: "It's removed from the lockout list and any archived channel on it is scanned again. Scanning restarts briefly.",
    confirmLabel: "Remove lockout",
  });
  if (!ok) return;
  let snap: ReturnType<typeof unlockSnapshot> | null = null;
  try {
    await ctx.poller.run(async () => {
      const c = await api.getConfig();
      snap = unlockSnapshot(c, f);
      await api.putConfig(unlockFreqIn(c, f));
    });
  } catch (e) { ctx.dialogs.toast(`Couldn't remove the lockout: ${e instanceof Error ? e.message : String(e)}`); return; }
  const s = snap!;
  ctx.dialogs.toast(`Removed the lockout on ${fmtFreq(f)} MHz.`, {
    undo: () => ctx.poller.run(async () => {
      const c = await api.getConfig();
      c.scan = { ...c.scan, lockoutHz: [...new Set([...(c.scan.lockoutHz ?? []), f])] };
      c.channels = c.channels.map((ch) => (s.enabled.has(ch.id) ? { ...ch, enabled: s.enabled.get(ch.id)! } : ch));
      await api.putConfig(c);
    }),
  });
  ctx.poller.request("connections");
  void ctx.poller.tick("system");
  ```

- Sheet body re-renders keep focus: note the focused `[data-unlock]` value, re-render, then refocus the same row's key, else the next row's key, else the sheet's close button. This is the Library sheets' pattern (`librarySheets.ts` `renderSuggestions`).
- Opening either sheet: `sheet.open({ title })` (modal — no `pane`). Row clicks open the matching sheet.

Add to `system.css`:

```css
.kc-sheet .kc-row .kc-key { box-sizing: border-box; min-height: 44px; padding: 8px 14px; }
.kc-conn__intro { margin: 4px 4px 12px; color: var(--kc-dim); font-size: var(--kc-t-small); }
```

Use `.kc-conn__intro` for the intro paragraphs instead of `kc-empty`.

- [ ] **Step 2: Verify**

Run: `npx vitest run && npm run typecheck && npm run build:frontend && curl -s -X POST localhost:8080/api/kiosk/reload`
Expected: all PASS; clean; OK.

Capture `#/next/system` at 390 and 1440. Check:
- Connections shows "Connected" iff `curl -s localhost:8080/api/config | jq .display.googleMapsApiKey` is set
- the lockout count equals `jq '.scan.lockoutHz | length'`

Sheets need clicks, so they are verified by hand. **Do not press Remove or edit the key.**

- [ ] **Step 3: Commit**

```bash
git add kiosk/src/frontend/admin-next/systemConnections.ts kiosk/src/frontend/admin-next/system.css
git commit -m "feat(admin-next): System connections — Google Maps key, locked-out frequencies

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Prove it and open the PR

- [ ] **Step 1: The full definition of done**

Run from `kiosk/`:

```bash
npm test && npm run test:native && npm run typecheck && npm run build
```

Expected: all PASS; record the test counts.

- [ ] **Step 2: Reload and capture (read-only)**

- `curl -s -X POST localhost:8080/api/kiosk/reload`.
- Capture headless at 1440×1000 and 390×844 (PNGs in `~/kc-shots/`, real time) for `#/next/system`, `#/next` (Radio: the health strip's "Open System" link is unchanged) and `#/next/tune` (the watchdog "Restart radio" link points at System).
- Read every PNG. Check that the values match `/api/system` and `/api/config`.
- `journalctl -u kerchunk-kiosk --since "-10 min" | grep -ci "warming\|engine start"` → 0.

- [ ] **Step 3: Push and open the PR**

```bash
git push -u origin feat/admin-next-system
gh pr create --title "feat(admin-next): System tab — health, vitals, kiosk screen, connections, power" --body-file <body>
```

The body follows the PR 4 shape:
- **What you get:**
  - the verdict card (with alerts, the protection note and uptime)
  - vitals with sparklines, plus RAM and open channels
  - the kiosk screen actions
  - Connections (Maps, lockouts)
  - Power
- **What each action costs:**
  - Maps save: live — refresh the kiosk screen to use it.
  - Removing a lockout: restarts scanning briefly.
  - Power actions: as named.
  - Polling pauses while a power action is watched.
- **Knobs:**
  - `POLL_MS.system` (5 s, `admin-next/poller.ts`)
  - the `WATCH_*`, `BACK_MESSAGE_MS` and `KIOSK_STATUS_MS` constants (`admin-next/system.ts`)
  - the warn lines `TEMP_WARN_C` etc. (`admin-next/systemModel.ts`)
- **Verified:** counts; captures; 0 engine restarts.
- **Needs your by-hand check on the phone** (`http://kiosk:8080/admin#/next/system`):
  - [ ] The verdict and vitals match what you expect; the temperature moves within a few seconds.
  - [ ] Refresh kiosk screen: the wall reloads.
  - [ ] Show a test weather alert: the banner appears; press again for the next type; Clear removes it.
  - [ ] Google Maps: open it, see the key; edit the Map ID and blur → "Saved…"; put it back.
  - [ ] Locked-out frequencies: open the list; Remove one → one scanning restart → Undo puts it back.
  - [ ] Restart radio: confirm → "Restarting…" → "The radio is back." and the keys come back (polling resumes: vitals update again).
- **Deferred** (from PRs 3–4, for the flip): pagehide flush, curve label overlap, the Library stale-data note, the `channelDetail.ts` split.

End with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

- [ ] **Step 4: Stop and wait for the operator's by-hand OK before merging.**
