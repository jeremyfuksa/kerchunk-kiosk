# Admin Redesign — PR 3 (Tune tab) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace admin-next's Tune placeholder with the real Tune tab: plain-language setting groups, sliders with named ends, and cost-aware save-as-you-go, with every write serialized through the single-flight Poller.

**Architecture:** Three pure, unit-tested modules carry the logic. `Poller.run()` adds a write lane shared with the polls. `tuneFields.ts` is the field table: every Tune setting with its control, default, read/write against `Config`, and save cost. `batcher.ts` is the per-group apply countdown with Undo. One DOM module, `tune.ts`, renders groups from the table and routes each change by cost: live → save now, scan → batched countdown, heavy → explicit Apply/Cancel, backend → save now with a restart note. The PR also does the items pinned for it: typed `lib/api.ts` routes with `r.ok`, and `slider`/`switchRow` builders in the ui kit.

**Tech Stack:** TypeScript ESM (`.js` import suffixes, `strict` + `noUncheckedIndexedAccess`), vanilla DOM, Vite, vitest (node env, `vi.useFakeTimers`, `vi.stubGlobal`), lucide-static.

**Spec:** `docs/superpowers/specs/2026-09-28-admin-redesign-design.md` (§4 Tune, §2 polling, §8 testing).
**Background:** `.superpowers/sdd/tune-facts.md` (fact sheet: classic Settings save paths, schema bounds, server restart diff). `.superpowers/sdd/2026-09-28-admin-redesign-pr1-pr2/progress.md` (Rulings 15–20 and deferred minors).

## Global Constraints

- All commands run from `kiosk/`; the branch lives in `/home/kiosk/kerchunk-kiosk`.
- Relative imports carry `.js` even from `.ts`; `tsconfig` is `strict` + `noUncheckedIndexedAccess`.
- **The appliance deadlocks on 2+ concurrent requests.** Every Tune read and write goes through the Poller: reads in a `poller.add` poll, writes in `poller.run()`. There is no `Promise.all` over requests.
- Cost of a save follows the server's PUT `/api/config` diff:
  - **scan:** anything in `toScanConfig` restarts the engine (`stop()`+`start()`, warm-up overlay, audio chop).
  - **live:** `autoDwell`/`priorityRevisit`, `alerts.*`, `closeCallSampleSeconds`/`closeCallSampleMaxMb` (read per use at `server.ts:733`) apply with no restart.
  - **backend:** helper watchdogs take effect at the next backend restart.
  - **heavy:** Record samples (`recordCloseCalls`) and Group shape (lanes/rate/window/flat) get explicit Apply/Cancel.
- `TUNE_APPLY_DELAY_MS = 3000` is the countdown knob (spec §4.2), exported from `admin-next/batcher.ts`.
- **CSS rules:**
  - Scope all admin-next CSS under `html[data-page="admin-next"]` or `kc-`-prefixed classes.
  - Use colours only from `--kc-*` tokens.
  - No `backdrop-filter`.
  - Controls are at least 40px tall, keys at least 44px.
  - Visible focus uses the existing ring.
  - Responsive at 390px (no horizontal scroll) and 1440px.
- **Markup rules:**
  - Icons from lucide-static via `ui/icons.ts` only.
  - Operator-supplied strings go through `esc` or are set via `textContent`.
- **Copy:** sentence case, plain language, and actions say what they do.
- **No backend or API changes.** `/api/status`, `/api/logs` and `/api/weather` are untouched.
- **Live system:**
  - Never restart `kerchunk-kiosk` during tasks.
  - Frontend verification is `npm run typecheck` + `npm run build:frontend` + `curl -s -X POST localhost:8080/api/kiosk/reload`.
  - The full `npm run build` (C++ helper, thermal cost) runs once, in Task 8.
  - Headless screenshots must write PNGs inside `$HOME` and use real-time `--timeout=20000`, not `--virtual-time-budget`.
  - Never press controls against the live radio.
- **Commits** end with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`. **PR body** ends with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
- **Definition of done:** `npm test`, `npm run test:native`, `npm run typecheck` and `npm run build` pass. The PR is opened from a branch. After merge: `gh pr merge <n> --merge --delete-branch`, `git checkout main && git pull --ff-only && git fetch --prune`, `git branch -d <branch>`.

## File map

| File | Change |
|---|---|
| `kiosk/src/frontend/admin-next/poller.ts` | **Modify:** `run<T>()` write lane; `POLL_MS.tune` |
| `kiosk/test/adminNext.poller.test.ts` | **Modify:** lane tests |
| `kiosk/src/frontend/lib/api.ts` | **Modify:** `getSystem`, `getStats`, `getHistory`; `skip`/`dismissAlert` throw on non-OK |
| `kiosk/test/api.test.ts` | **Create** |
| `kiosk/src/frontend/admin-next/verdict.ts` | **Modify:** `glance` treats a body without `health` as unknown |
| `kiosk/src/frontend/admin-next/index.ts`, `radio.ts` | **Modify:** use the new api routes; mount Tune |
| `kiosk/src/frontend/admin-next/ui/kit.ts` (+ css) | **Modify:** `slider()`, `switchRow()` |
| `kiosk/test/adminNext.kit.test.ts` | **Modify** |
| `kiosk/src/frontend/admin-next/tuneFields.ts` | **Create:** field table + pure read/write/cost/dependents |
| `kiosk/test/adminNext.tuneFields.test.ts` | **Create** |
| `kiosk/src/frontend/admin-next/batcher.ts` | **Create:** `ApplyBatcher`, `TUNE_APPLY_DELAY_MS` |
| `kiosk/test/adminNext.batcher.test.ts` | **Create** |
| `kiosk/src/frontend/admin-next/tune.ts` | **Create:** Tune DOM |
| `kiosk/src/frontend/admin-next/admin-next.css` | **Modify:** Tune styles |
| `kiosk/src/frontend/admin-next/placeholder.ts` | **Modify:** drop the tune entry |

---

### Task 1: Poller write lane

**Files:** Modify `kiosk/src/frontend/admin-next/poller.ts`, `kiosk/test/adminNext.poller.test.ts`

**Interfaces:**
- Produces: `Poller.run<T>(fn: () => Promise<T>): Promise<T>`. It runs `fn` exclusively, after any in-flight poll pass or earlier `run()`, and before the next pass starts. The caller gets `fn`'s value or rejection, and a rejection never blocks the lane. Also `POLL_MS.tune = 30_000`.

- [ ] **Step 1: Branch**

```bash
cd /home/kiosk/kerchunk-kiosk && git checkout main && git pull --ff-only && git checkout -b feat/admin-next-tune
```

- [ ] **Step 2: Failing tests.** Append to `kiosk/test/adminNext.poller.test.ts`:

```ts
describe("Poller.run (write lane)", () => {
  it("waits for an in-flight poll pass, and the next pass waits for it", async () => {
    const log: string[] = [];
    let release!: () => void;
    const p = new Poller({ now: () => 0, hidden: () => false });
    p.add({ name: "slow", everyMs: 0, run: () => new Promise<void>((r) => { log.push("poll:start"); release = () => { log.push("poll:end"); r(); }; }) });
    const pass = p.tick("radio");
    await Promise.resolve();
    const write = p.run(async () => { log.push("write"); return 7; });
    await Promise.resolve();
    expect(log).toEqual(["poll:start"]);
    release();
    await expect(write).resolves.toBe(7);
    await pass;
    expect(log).toEqual(["poll:start", "poll:end", "write"]);
  });
  it("a rejected run rejects its caller but not the lane", async () => {
    const p = new Poller({ now: () => 0, hidden: () => false });
    await expect(p.run(async () => { throw new Error("nope"); })).rejects.toThrow("nope");
    await expect(p.run(async () => "ok")).resolves.toBe("ok");
  });
  it("runs queued writes in order, one at a time", async () => {
    const p = new Poller({ now: () => 0, hidden: () => false });
    let inFlight = 0; let max = 0; const order: number[] = [];
    const w = (n: number) => p.run(async () => { inFlight++; max = Math.max(max, inFlight); await Promise.resolve(); order.push(n); inFlight--; });
    await Promise.all([w(1), w(2), w(3)]);
    expect(order).toEqual([1, 2, 3]);
    expect(max).toBe(1);
  });
});
```

- [ ] **Step 3: Run to fail.** `npx vitest run test/adminNext.poller.test.ts` → FAIL (`p.run is not a function`).

- [ ] **Step 4: Implement.** In `poller.ts` add `tune: 30_000,   // Tune: settings refresh (only untouched fields)` to `POLL_MS`. In `class Poller` add the lane field, a `run` method, and make `tick` run its pass through the lane:

```ts
  /** Serialises poll passes and run() writes: nothing overlaps on the wire. */
  private lane: Promise<unknown> = Promise.resolve();

  /** Run fn exclusively — after any in-flight poll pass or earlier run(), and
   *  before the next pass. The caller gets fn's result or rejection; a
   *  rejection never blocks the lane. Used for every admin-next write. */
  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.lane.then(() => fn());
    this.lane = result.catch(() => {});
    return result;
  }

  async tick(tab: Tab): Promise<void> {
    if (this.ticking || this.hidden()) return;
    this.ticking = true;
    const pass = this.lane.then(async () => {
      for (const p of this.polls) {
        if (this.hidden()) break;
        if (p.tabs && !p.tabs.includes(tab)) continue;
        if (p.when && !p.when()) continue;
        if (this.now() - p.lastAt < p.everyMs) continue;
        p.lastAt = this.now();
        // Sequential on purpose — see the header.
        await p.run().catch(() => {});
      }
    });
    this.lane = pass.catch(() => {});
    try { await pass; } finally { this.ticking = false; }
  }
```

(Replace the existing `tick` body with this one. The loop is unchanged; it now runs inside the lane.)

- [ ] **Step 5: Run to pass.** `npx vitest run test/adminNext.poller.test.ts` → all pass (existing + 3 new). Then `npm run typecheck`.

- [ ] **Step 6: Commit** — `feat(admin-next): Poller.run — single-flight write lane` + trailer.

### Task 2: Typed API routes with `r.ok`; tolerant verdict

**Files:** Modify `kiosk/src/frontend/lib/api.ts`, `kiosk/src/frontend/admin-next/verdict.ts`, `index.ts`, `radio.ts`; Create `kiosk/test/api.test.ts`; Modify `kiosk/test/adminNext.verdict.test.ts`

**Interfaces:**
- Produces:
  - `api.getSystem<T>(): Promise<T>`, `api.getStats<T>(sinceMs: number): Promise<T>`, `api.getHistory<T>(q: Record<string, string | number>): Promise<T>`. All reject with the server's message on non-OK, via the existing `j()`.
  - `api.skip` and `api.dismissAlert` now resolve `void` and reject on non-OK.
  - `glance(sys)` returns the unknown state when `sys` lacks a `health.verdict` string.

- [ ] **Step 1: Failing tests.** Create `kiosk/test/api.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { api } from "../src/frontend/lib/api.js";

const reply = (status: number, body: unknown) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));

afterEach(() => { vi.unstubAllGlobals(); });

describe("typed api routes", () => {
  it("getStats builds the query and returns the body", async () => {
    const f = reply(200, { totalHits: 3 });
    vi.stubGlobal("fetch", f);
    await expect(api.getStats<{ totalHits: number }>(1234)).resolves.toEqual({ totalHits: 3 });
    expect(f).toHaveBeenCalledWith("/api/stats?since=1234");
  });
  it("getHistory encodes its params", async () => {
    const f = reply(200, []);
    vi.stubGlobal("fetch", f);
    await api.getHistory({ kind: "alert", limit: 25 });
    expect(f).toHaveBeenCalledWith("/api/history?kind=alert&limit=25");
  });
  it("getSystem rejects on a non-OK answer", async () => {
    vi.stubGlobal("fetch", reply(503, { error: "busy" }));
    await expect(api.getSystem()).rejects.toThrow("busy");
  });
  it("skip and dismissAlert reject on non-OK and resolve on OK", async () => {
    vi.stubGlobal("fetch", reply(500, { error: "no engine" }));
    await expect(api.skip(1800)).rejects.toThrow("no engine");
    await expect(api.dismissAlert(4)).rejects.toThrow("no engine");
    vi.stubGlobal("fetch", reply(200, { ok: true }));
    await expect(api.skip()).resolves.toBeUndefined();
  });
});
```

Add to `kiosk/test/adminNext.verdict.test.ts` (inside the existing `glance` describe; match its import):

```ts
  it("a body without health reads unknown, never stale-healthy", () => {
    expect(glance({} as never).verdict).toBe("unknown");
    expect(glance({ health: {} } as never).verdict).toBe("unknown");
  });
```

- [ ] **Step 2: Run to fail.** `npx vitest run test/api.test.ts test/adminNext.verdict.test.ts` → FAIL.

- [ ] **Step 3: Implement `api.ts`.** Read the file first; keep `j()`, the config dedupe and ETag logic unchanged. Add a helper beside `j`:

```ts
/** Resolve on 2xx, else throw the server's message (same text rules as j). */
async function ok(res: Response): Promise<void> {
  if (!res.ok) await j<never>(res);
}
```

In the `api` object, change `skip` and `dismissAlert` to end in `.then(ok)`, keeping their existing URLs, methods and bodies. Add:

```ts
  getSystem: <T = unknown>() => fetch("/api/system").then(j<T>),
  getStats: <T = unknown>(sinceMs: number) => fetch(`/api/stats?since=${sinceMs}`).then(j<T>),
  getHistory: <T = unknown>(q: Record<string, string | number>) =>
    fetch(`/api/history?${new URLSearchParams(Object.entries(q).map(([k, v]) => [k, String(v)]))}`).then(j<T>),
```

- [ ] **Step 4: `verdict.ts`.** At the top of `glance`, treat a missing or malformed body as unreachable:

```ts
  if (!sys || typeof sys.health?.verdict !== "string") return <the same value glance(null) returns today>;
```

Keep whatever the existing null branch returns, and reuse it rather than duplicating it.

- [ ] **Step 5: Migrate callers.**
  - `index.ts` verdict poll: replace the raw `fetch("/api/system")` + `r.ok` block with `try { sys = await api.getSystem<SystemGlance>(); } catch { /* shown as unknown */ }`.
  - `radio.ts`: replace every raw `fetch("/api/stats?…")` with `api.getStats<Stats>(sinceMs)`, and `fetch("/api/history?kind=alert&limit=…")` with `api.getHistory<…>({ kind: "alert", limit: ALERT_COUNT })`. Keep the existing error/"unavailable" states; they now trigger on rejection.
  - The Pause handler: `try { await api.skip(PAUSE_S); dialogs.toast(<existing success text>); } catch (e) { dialogs.toast((e as Error).message); }`.
  - The alert dismiss: on rejection, `dialogs.toast` the message instead of swallowing it.
  - Grep: `grep -n "fetch(" src/frontend/admin-next/*.ts` must print nothing.

- [ ] **Step 6: Verify.** Run `npx vitest run test/api.test.ts test/adminNext.verdict.test.ts`, then `npm test`, then `npm run typecheck`.

- [ ] **Step 7: Commit** — `feat(api): typed system/stats/history routes; skip + dismiss report failures` + trailer.

### Task 3: `slider()` and `switchRow()` in the ui kit

**Files:** Modify `kiosk/src/frontend/admin-next/ui/kit.ts`, `admin-next.css`, `radio.ts`, `kiosk/test/adminNext.kit.test.ts`

**Interfaces:**
- Produces:
  - `slider(o: SliderOpts): string` with `interface SliderOpts { id: string; label: string; hint?: string; min: number; max: number; step: number; value: number; unit: string; ends: [string, string]; disabled?: boolean }`. The markup has a range input with `id=o.id` and a number input with `id=`${o.id}-num`` for typed entry.
  - `switchRow(o: { id: string; label: string; hint?: string; checked: boolean; disabled?: boolean }): string`, the same markup as Radio's remote-listening row.

- [ ] **Step 1: Failing test.** Append to `kiosk/test/adminNext.kit.test.ts` (extend its import with `slider, switchRow`):

```ts
describe("slider / switchRow", () => {
  it("slider pairs a range and a typed-entry box with named ends", () => {
    const h = slider({ id: "kAgcTarget", label: "Target <loud>", hint: "Where it lands", min: -40, max: -3, step: 1, value: -18, unit: "dBFS", ends: ["Quieter", "Louder"] });
    expect(h).toContain('id="kAgcTarget" type="range" min="-40" max="-3" step="1" value="-18"');
    expect(h).toContain('id="kAgcTarget-num" type="number"');
    expect(h).toContain('<label for="kAgcTarget">Target &lt;loud&gt;</label>');
    expect(h).toContain(">Quieter<");
    expect(h).toContain(">Louder<");
    expect(h).not.toContain(" disabled");
  });
  it("slider and switchRow honour disabled", () => {
    expect(slider({ id: "a", label: "A", min: 0, max: 1, step: 1, value: 0, unit: "", ends: ["x", "y"], disabled: true })).toContain(" disabled");
    const s = switchRow({ id: "kcRemote", label: "Remote listening", hint: "Stream it", checked: true, disabled: true });
    expect(s).toContain('<input id="kcRemote" type="checkbox" role="switch" checked disabled');
    expect(s).toContain('class="kc-switchRow"');
  });
});
```

- [ ] **Step 2: Run to fail.**

- [ ] **Step 3: Implement** in `ui/kit.ts`:

```ts
export interface SliderOpts {
  id: string; label: string; hint?: string;
  min: number; max: number; step: number; value: number; unit: string;
  /** What the low and high ends mean, in plain words ("Quieter", "Louder"). */
  ends: [string, string];
  disabled?: boolean;
}

/** A setting slider: label + typed-entry box on one line, hint, the range,
 *  then the named ends. The range carries o.id; the box `${o.id}-num`. */
export function slider(o: SliderOpts): string {
  const dis = o.disabled ? " disabled" : "";
  const bounds = `min="${o.min}" max="${o.max}" step="${o.step}" value="${o.value}"`;
  return `<div class="kc-slider" data-slider="${o.id}">
    <div class="kc-slider__head">
      <label for="${o.id}">${esc(o.label)}</label>
      <span class="kc-slider__val"><input id="${o.id}-num" type="number" inputmode="decimal" ${bounds} aria-label="${esc(o.label)}, exact value"${dis} />${o.unit ? `<b>${esc(o.unit)}</b>` : ""}</span>
    </div>
    ${o.hint ? `<p class="kc-slider__hint">${esc(o.hint)}</p>` : ""}
    <input id="${o.id}" type="range" ${bounds}${dis} />
    <div class="kc-slider__ends" aria-hidden="true"><span>${esc(o.ends[0])}</span><span>${esc(o.ends[1])}</span></div>
  </div>`;
}

/** A labelled on/off switch row (checkbox with role="switch"). */
export function switchRow(o: { id: string; label: string; hint?: string; checked: boolean; disabled?: boolean }): string {
  return `<label class="kc-switchRow"><span>${esc(o.label)}${o.hint ? ` <small>${esc(o.hint)}</small>` : ""}</span>`
    + `<input id="${o.id}" type="checkbox" role="switch"${o.checked ? " checked" : ""}${o.disabled ? " disabled" : ""} /></label>`;
}
```

- [ ] **Step 4: Radio uses `switchRow`.** In `radio.ts`, replace the hand-written remote-listening `<label class="kc-switchRow">…</label>` with `${switchRow({ id: "kcRemote", label: "Remote listening", hint: "Stream the speaker to this browser — restarts scanning", checked: false })}` (paint() sets the real state). Behaviour is unchanged.

- [ ] **Step 5: CSS.** Append to `admin-next.css`:

```css
/* ── slider (settings) ── */
.kc-slider { padding: 10px 16px 12px; border-top: 1px solid var(--kc-line); }
.kc-slider:first-of-type { border-top: 0; }
.kc-slider__head { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
.kc-slider__head label { font-size: var(--kc-t-row); font-weight: 500; }
.kc-slider__val { display: inline-flex; align-items: center; gap: 6px; color: var(--kc-dim); font-size: var(--kc-t-small); }
.kc-slider__val input { width: 5.5em; min-height: 36px; padding: 4px 8px; border: 0; border-radius: var(--kc-r-key); background: var(--kc-key); color: var(--kc-glass); font: 600 var(--kc-t-body) var(--kc-font); text-align: right; font-variant-numeric: tabular-nums; }
.kc-slider__hint { margin: 2px 0 8px; color: var(--kc-mute); font-size: var(--kc-t-small); }
.kc-slider input[type="range"] { width: 100%; accent-color: var(--kc-glass); min-height: 28px; }
.kc-slider__ends { display: flex; justify-content: space-between; color: var(--kc-mute); font-size: var(--kc-t-meta); }
.kc-slider input:disabled { opacity: 0.45; cursor: not-allowed; }
```

- [ ] **Step 6: Verify.** `npx vitest run test/adminNext.kit.test.ts`, then `npm test`, then `npm run typecheck`.

- [ ] **Step 7: Commit** — `feat(admin-next): slider + switchRow in the ui kit` + trailer.

### Task 4: Tune field table (pure)

**Files:** Create `kiosk/src/frontend/admin-next/tuneFields.ts`, `kiosk/test/adminNext.tuneFields.test.ts`

**Interfaces:**
- Consumes (from `../admin/engineKnobs.js`): `KNOB_FIELDS`, `KNOB_BY_ID`, `BAND_COST`, `readKnob`, `applyKnobs`, `type Band`, `type KnobField`. Also `DEFAULT_GROUP_DWELL_MS` from `../../backend/config/engineDefaults.js`, and `type Config`.
- Produces:
  - Types: `TuneGroup`, `TuneCost`, `TuneValue`, `TuneValues`, `TuneControl`, `TuneField`.
  - Constants: `GROUP_TITLES`, `TUNE_FIELDS`, `FIELD_BY_ID`.
  - Functions: `readTune(cfg): TuneValues`, `applyTune(cfg, ids, values): Config`, `disabledIds(values): Set<string>`, `snapValue(f, n): number`, `isDefault(f, v): boolean`, `parseSweep(raw)`, `sweepText(ranges)`.

- [ ] **Step 1: Check one assumption.** Read `readKnob` in `kiosk/src/frontend/admin/engineKnobs.ts`. For a number knob with no stored value it must return `""`, and for a stored value its display string. Also confirm that `applyKnobs(cfg, [k], { [k.id]: "" }, {})` deletes the key. If either differs, adapt `fromKnob` below so that `read` returns `""` for unset and `write(cfg, "")` resets to default, and note it in the report.

- [ ] **Step 2: Failing tests.** Create `kiosk/test/adminNext.tuneFields.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import type { Config } from "../src/backend/config/schema.js";
import { KNOB_FIELDS } from "../src/frontend/admin/engineKnobs.js";
import {
  TUNE_FIELDS, FIELD_BY_ID, readTune, applyTune, disabledIds, snapValue, isDefault, parseSweep,
} from "../src/frontend/admin-next/tuneFields.js";

const base = (): Config => ({
  version: 1,
  scan: { dwellMs: 2000 },
  audio: { sink: "plughw:CARD=PCH,DEV=0", volume: 50, muted: false, remoteListening: false },
  channels: [],
} as unknown as Config);

const set = (cfg: Config, id: string, v: string | boolean) => applyTune(cfg, [id], { [id]: v });

describe("tune field table", () => {
  it("carries every engine knob exactly once, plus the Settings fields", () => {
    for (const k of KNOB_FIELDS) expect(TUNE_FIELDS.filter((f) => f.id === k.id)).toHaveLength(1);
    for (const id of ["tOpenDb", "tQuietDb", "tGroupDwell", "tHang", "tSweep", "tCloseCall", "tCloseCallDb", "tCcRecord", "tCcSampleSec", "tCcSampleMb", "tAlertCool", "tAlertHold", "tAlertNtfy", "tSameFips", "tSameTests"]) {
      expect(FIELD_BY_ID[id], id).toBeDefined();
    }
  });
  it("sound knobs are sliders with named ends", () => {
    for (const f of TUNE_FIELDS.filter((x) => x.group === "sound")) {
      expect(f.control.kind, f.id).toBe("slider");
      if (f.control.kind === "slider") expect(f.control.ends[0].length).toBeGreaterThan(0);
    }
  });
  it("costs follow the server's restart diff", () => {
    const cost = (id: string) => FIELD_BY_ID[id]!.cost;
    expect(cost("tOpenDb")).toBe("scan");
    expect(cost("kAgcTarget")).toBe("scan");
    expect(cost("tCcRecord")).toBe("heavy");
    expect(cost("kLanes")).toBe("heavy");
    expect(cost("kAutoDwell")).toBe("live");
    expect(cost("tCcSampleSec")).toBe("live");
    expect(cost("tAlertCool")).toBe("live");
    expect(cost("kReadyTo")).toBe("backend");
  });
});

describe("read / write", () => {
  it("reads unset numbers as blank and switches as their defaults", () => {
    const v = readTune(base());
    expect(v.tOpenDb).toBe("");
    expect(v.tHang).toBe("2000");
    expect(v.tCloseCall).toBe(true);   // engine default: ON
    expect(v.tCcRecord).toBe(false);
    expect(v.tSweep).toBe("");
    expect(v.kAgcTarget).toBe("");
  });
  it("writes numbers and resets blanks to default", () => {
    const cfg = set(base(), "tOpenDb", "12");
    expect(cfg.scan.openAboveFloorDb).toBe(12);
    set(cfg, "tOpenDb", "");
    expect("openAboveFloorDb" in cfg.scan).toBe(false);
    expect(set(base(), "tHang", "").scan.dwellMs).toBe(2000);
    expect(set(base(), "kAgcTarget", "-20").audio.agcTargetDb).toBe(-20);
  });
  it("rejects out-of-range numbers with the field's name", () => {
    expect(() => set(base(), "tOpenDb", "0")).toThrow(/Squelch open/);
    expect(() => set(base(), "tCcSampleSec", "500")).toThrow(/Sample length/);
  });
  it("parses sweep ranges", () => {
    expect(parseSweep("450-470, 150-162")).toEqual([{ loHz: 450_000_000, hiHz: 470_000_000 }, { loHz: 150_000_000, hiHz: 162_000_000 }]);
    const cfg = set(base(), "tSweep", "450-470");
    expect(cfg.scan.sweepRanges).toHaveLength(1);
    set(cfg, "tSweep", "");
    expect(cfg.scan.sweepRanges).toBeUndefined();
    expect(() => parseSweep("bad")).toThrow(/Sweep ranges/);
    expect(() => parseSweep("470-450")).toThrow(/Sweep ranges/);
  });
  it("alerts: per-field writes, empty block removed", () => {
    const cfg = set(base(), "tAlertCool", "20");
    expect(cfg.alerts).toEqual({ cooldownMinutes: 20 });
    set(cfg, "tSameTests", true);
    expect(cfg.alerts).toEqual({ cooldownMinutes: 20, sameTests: true });
    set(cfg, "tAlertCool", ""); set(cfg, "tSameTests", false);
    expect(cfg.alerts).toBeUndefined();
    expect(() => set(base(), "tAlertNtfy", "not a url")).toThrow(/Push notification URL/);
    expect(set(base(), "tAlertNtfy", "https://ntfy.sh/kc").alerts?.ntfyUrl).toBe("https://ntfy.sh/kc");
    expect(set(base(), "tSameFips", "029047, 29095").alerts?.sameFips).toEqual(["029047", "29095"]);
    expect(() => set(base(), "tSameFips", "12ab")).toThrow(/SAME county codes/);
  });
});

describe("helpers", () => {
  it("disables Close Call dependents", () => {
    const v = readTune(base());
    expect([...disabledIds({ ...v, tCloseCall: false })].sort()).toEqual(["tCcRecord", "tCcSampleMb", "tCcSampleSec", "tCloseCallDb"]);
    expect([...disabledIds({ ...v, tCloseCall: true, tCcRecord: false })].sort()).toEqual(["tCcSampleMb", "tCcSampleSec"]);
    expect(disabledIds({ ...v, tCloseCall: true, tCcRecord: true }).size).toBe(0);
  });
  it("snaps the hum filter's dead zone to off or its minimum", () => {
    const hum = FIELD_BY_ID.kHpf!;
    expect(snapValue(hum, 20)).toBe(0);
    expect(snapValue(hum, 30)).toBe(50);
    expect(snapValue(hum, 300)).toBe(300);
    expect(snapValue(FIELD_BY_ID.kAgcTarget!, -20)).toBe(-20);
  });
  it("isDefault", () => {
    expect(isDefault(FIELD_BY_ID.tOpenDb!, "")).toBe(true);
    expect(isDefault(FIELD_BY_ID.tCloseCall!, true)).toBe(true);
    expect(isDefault(FIELD_BY_ID.tCloseCall!, false)).toBe(false);
    expect(isDefault(FIELD_BY_ID.tGroupDwell!, "3000")).toBe(true);
  });
});
```

- [ ] **Step 3: Run to fail.**

- [ ] **Step 4: Implement `tuneFields.ts`:**

```ts
// Tune's field table: every setting on the Tune tab, in display order, with
// how it reads from / writes to config and what saving it costs (spec §4).
// Pure — no DOM. Engine knobs come from engineKnobs.ts (the one source of
// truth for their ranges and defaults); the rest use the ranges the classic
// Settings page used. Values are UI strings ("" = unset → engine default) or
// booleans for switches — the same shape as engineKnobs' KnobValues.
import type { Config } from "../../backend/config/schema.js";
import { DEFAULT_GROUP_DWELL_MS } from "../../backend/config/engineDefaults.js";
import { BAND_COST, KNOB_BY_ID, KNOB_FIELDS, applyKnobs, readKnob, type Band, type KnobField } from "../admin/engineKnobs.js";

export type TuneGroup = "sound" | "scanning" | "discovery" | "alerts" | Exclude<Band, "sound">;
/** live = saved on change; scan = batched countdown (engine restart);
 *  heavy = explicit Apply (engine restart, rarely wanted by accident);
 *  backend = saved now, used after the next radio restart. */
export type TuneCost = "live" | "scan" | "heavy" | "backend";
export type TuneValue = string | boolean;
export type TuneValues = Record<string, TuneValue>;
export type TuneControl =
  | { kind: "slider"; min: number; max: number; step: number; unit: string; ends: [string, string] }
  | { kind: "number"; min?: number; max?: number; step: number; unit: string }
  | { kind: "switch" }
  | { kind: "text"; placeholder: string };

export interface TuneField {
  id: string;
  group: TuneGroup;
  label: string;
  hint: string;
  cost: TuneCost;
  control: TuneControl;
  /** Default in UI units — shown when the value is blank. */
  def: TuneValue;
  /** "" = unset for numbers/text; a boolean for switches. */
  read(cfg: Config): TuneValue;
  /** Write a UI value into cfg ("" resets to default). Throws a readable Error. */
  write(cfg: Config, v: TuneValue): void;
}

export const GROUP_TITLES: Record<TuneGroup, string> = {
  sound: "Sound", scanning: "Scanning", discovery: "Discovery", alerts: "Alerts",
  loudness: "Loudness detail", shape: "Group shape", schedule: "Scheduling", watchdog: "Helper watchdogs",
};

// ---- helpers ---------------------------------------------------------------
const blank = (n: number | undefined | null): string => (n == null ? "" : String(n));
const str = (v: TuneValue): string => (typeof v === "string" ? v.trim() : "");

function num(label: string, v: TuneValue, o: { min?: number; max?: number; int?: boolean }): number | undefined {
  const t = str(v);
  if (t === "") return undefined;
  const n = Number(t);
  const range = o.max != null ? `${o.min ?? "any"}–${o.max}` : `${o.min} or more`;
  if (!Number.isFinite(n) || (o.min != null && n < o.min) || (o.max != null && n > o.max) || (o.int && !Number.isInteger(n))) {
    throw new Error(`${label}: enter ${range}`);
  }
  return n;
}

type Scan = Config["scan"];
function setScan<K extends keyof Scan>(cfg: Config, k: K, v: Scan[K] | undefined): void {
  if (v === undefined) delete cfg.scan[k]; else cfg.scan[k] = v;
}
type Alerts = NonNullable<Config["alerts"]>;
function setAlert<K extends keyof Alerts>(cfg: Config, k: K, v: Alerts[K] | undefined): void {
  const a: Alerts = { ...(cfg.alerts ?? {}) };
  if (v === undefined) delete a[k]; else a[k] = v;
  if (Object.keys(a).length) cfg.alerts = a; else delete cfg.alerts;
}

export function parseSweep(raw: string): Array<{ loHz: number; hiHz: number }> {
  return raw.split(",").map((x) => x.trim()).filter(Boolean).map((x) => {
    const m = /^([\d.]+)\s*-\s*([\d.]+)$/.exec(x);
    if (!m) throw new Error(`Sweep ranges: "${x}" must be low-high in MHz, e.g. 450-470`);
    const loHz = Math.round(Number(m[1]) * 1e6);
    const hiHz = Math.round(Number(m[2]) * 1e6);
    if (!(loHz > 0 && hiHz > loHz)) throw new Error(`Sweep ranges: in "${x}" the second number must be higher`);
    return { loHz, hiHz };
  });
}
export const sweepText = (r: ReadonlyArray<{ loHz: number; hiHz: number }>): string =>
  r.map((x) => `${x.loHz / 1e6}-${x.hiHz / 1e6}`).join(", ");

// ---- engine knobs → fields --------------------------------------------------
const SOUND_ENDS: Record<string, [string, string]> = {
  kAgcTarget: ["Quieter", "Louder"],
  kAgcMax: ["Less lift", "More lift"],
  kLpf: ["Less hiss", "Brighter"],
  kHpf: ["Off", "Stronger"],
  kAmGain: ["Quieter AM", "Louder AM"],
};

function fromKnob(k: KnobField): TuneField {
  const ends = SOUND_ENDS[k.id];
  const lo = k.allowZero ? 0 : k.min;
  const control: TuneControl = k.kind === "switch" ? { kind: "switch" }
    : ends ? { kind: "slider", min: lo, max: k.max, step: k.step, unit: k.unit, ends }
    : { kind: "number", min: lo, max: k.max, step: k.step, unit: k.unit };
  return {
    id: k.id, group: k.band, label: k.label, hint: k.hint, control, def: k.def,
    cost: k.band === "shape" ? "heavy" : BAND_COST[k.band],
    read: (cfg) => readKnob(cfg, k),
    write: (cfg, v) => { applyKnobs(cfg, [k], { [k.id]: v }, {}); },
  };
}
const knob = (id: string): TuneField => fromKnob(KNOB_BY_ID[id]!);

// ---- the table ---------------------------------------------------------------
const HANG_DEFAULT_MS = 2000;

const SCANNING: TuneField[] = [
  {
    id: "tOpenDb", group: "scanning", label: "Squelch open", hint: "How strong a signal must be to open", cost: "scan",
    control: { kind: "slider", min: 1, max: 30, step: 0.5, unit: "dB", ends: ["Hear more", "Hear less"] }, def: "9",
    read: (c) => blank(c.scan.openAboveFloorDb),
    write: (c, v) => setScan(c, "openAboveFloorDb", num("Squelch open", v, { min: 1, max: 30 })),
  },
  {
    id: "tQuietDb", group: "scanning", label: "Quieting", hint: "How clean a signal must sound to stay open", cost: "scan",
    control: { kind: "slider", min: -30, max: 0, step: 0.5, unit: "dB", ends: ["Hear less", "Hear more"] }, def: "-7",
    read: (c) => blank(c.scan.nativeQuietDb),
    write: (c, v) => setScan(c, "nativeQuietDb", num("Quieting", v, { min: -30, max: 0 })),
  },
  {
    id: "tGroupDwell", group: "scanning", label: "Group dwell", hint: "Time spent on each frequency group", cost: "scan",
    control: { kind: "slider", min: 500, max: 10_000, step: 100, unit: "ms", ends: ["Faster cycle", "Longer listen"] },
    def: String(DEFAULT_GROUP_DWELL_MS),
    read: (c) => blank(c.scan.groupDwellMs),
    write: (c, v) => setScan(c, "groupDwellMs", num("Group dwell", v, { min: 500, max: 10_000, int: true })),
  },
  {
    id: "tHang", group: "scanning", label: "Hang time", hint: "Wait after a transmission ends", cost: "scan",
    control: { kind: "slider", min: 100, max: 10_000, step: 100, unit: "ms", ends: ["Shorter", "Longer"] },
    def: String(HANG_DEFAULT_MS),
    read: (c) => String(c.scan.dwellMs),
    // dwellMs is required in the schema: blank means the default, not "unset".
    write: (c, v) => { c.scan.dwellMs = num("Hang time", v, { min: 100, max: 10_000, int: true }) ?? HANG_DEFAULT_MS; },
  },
  {
    id: "tSweep", group: "scanning", label: "Sweep ranges", hint: "MHz ranges to hunt for activity; empty turns sweeping off", cost: "scan",
    control: { kind: "text", placeholder: "450-470, 150-162" }, def: "",
    read: (c) => sweepText(c.scan.sweepRanges ?? []),
    write: (c, v) => { const r = parseSweep(str(v)); setScan(c, "sweepRanges", r.length ? r : undefined); },
  },
];

const DISCOVERY: TuneField[] = [
  {
    id: "tCloseCall", group: "discovery", label: "Close Call", hint: "Find strong nearby signals outside your channel list", cost: "scan",
    control: { kind: "switch" }, def: true,
    read: (c) => c.scan.closeCall ?? true,
    write: (c, v) => setScan(c, "closeCall", v === true),
  },
  {
    id: "tCloseCallDb", group: "discovery", label: "Close Call threshold", hint: "Higher finds fewer false signals", cost: "scan",
    control: { kind: "slider", min: 5, max: 40, step: 1, unit: "dB", ends: ["Find more", "Fewer false finds"] }, def: "15",
    read: (c) => blank(c.scan.closeCallDb),
    write: (c, v) => setScan(c, "closeCallDb", num("Close Call threshold", v, { min: 5, max: 40 })),
  },
  {
    id: "tCcRecord", group: "discovery", label: "Record samples", hint: "Keep a clip of each discovery so you can judge it by ear", cost: "heavy",
    control: { kind: "switch" }, def: false,
    read: (c) => c.scan.recordCloseCalls === true,
    write: (c, v) => setScan(c, "recordCloseCalls", v === true ? true : undefined),
  },
  {
    id: "tCcSampleSec", group: "discovery", label: "Sample length", hint: "Longest clip kept, including 2 s before the hit", cost: "live",
    control: { kind: "slider", min: 3, max: 120, step: 1, unit: "s", ends: ["Shorter clips", "Longer clips"] }, def: "20",
    read: (c) => blank(c.scan.closeCallSampleSeconds),
    write: (c, v) => setScan(c, "closeCallSampleSeconds", num("Sample length", v, { min: 3, max: 120 })),
  },
  {
    id: "tCcSampleMb", group: "discovery", label: "Sample storage", hint: "Space for clips; the oldest go first", cost: "live",
    control: { kind: "number", min: 1, max: 2000, step: 1, unit: "MB" }, def: "50",
    read: (c) => blank(c.scan.closeCallSampleMaxMb),
    write: (c, v) => setScan(c, "closeCallSampleMaxMb", num("Sample storage", v, { min: 1, max: 2000 })),
  },
];

const ALERTS: TuneField[] = [
  {
    id: "tAlertCool", group: "alerts", label: "Alert cooldown", hint: "Minimum time before repeating an alert", cost: "live",
    control: { kind: "number", min: 1, step: 1, unit: "min" }, def: "15",
    read: (c) => blank(c.alerts?.cooldownMinutes),
    write: (c, v) => setAlert(c, "cooldownMinutes", num("Alert cooldown", v, { min: 1 })),
  },
  {
    id: "tAlertHold", group: "alerts", label: "Alert hold", hint: "How long an alert stays on screen", cost: "live",
    control: { kind: "number", min: 5, step: 5, unit: "s" }, def: "30",
    read: (c) => blank(c.alerts?.holdSeconds),
    write: (c, v) => setAlert(c, "holdSeconds", num("Alert hold", v, { min: 5 })),
  },
  {
    id: "tAlertNtfy", group: "alerts", label: "Push notification URL", hint: "Optional ntfy topic", cost: "live",
    control: { kind: "text", placeholder: "https://ntfy.sh/your-topic" }, def: "",
    read: (c) => c.alerts?.ntfyUrl ?? "",
    write: (c, v) => {
      const t = str(v);
      if (t) {
        let ok = false;
        try { ok = /^https?:$/.test(new URL(t).protocol); } catch { ok = false; }
        if (!ok) throw new Error("Push notification URL: enter a full http(s) address");
      }
      setAlert(c, "ntfyUrl", t || undefined);
    },
  },
  {
    id: "tSameFips", group: "alerts", label: "SAME county codes", hint: "Comma-separated FIPS codes; empty allows all", cost: "live",
    control: { kind: "text", placeholder: "029047, 029095" }, def: "",
    read: (c) => (c.alerts?.sameFips ?? []).join(", "),
    write: (c, v) => {
      const codes = str(v).split(",").map((x) => x.trim()).filter(Boolean);
      const bad = codes.find((x) => !/^\d{5,6}$/.test(x));
      if (bad) throw new Error(`SAME county codes: "${bad}" must be 5 or 6 digits`);
      setAlert(c, "sameFips", codes.length ? codes : undefined);
    },
  },
  {
    id: "tSameTests", group: "alerts", label: "Show SAME tests", hint: "Include weekly and monthly test banners", cost: "live",
    control: { kind: "switch" }, def: false,
    read: (c) => c.alerts?.sameTests === true,
    write: (c, v) => setAlert(c, "sameTests", v === true ? true : undefined),
  },
];

/** Display order: Sound, Scanning, Discovery, Alerts, then the Advanced bands. */
export const TUNE_FIELDS: readonly TuneField[] = [
  ...KNOB_FIELDS.filter((k) => k.band === "sound").map((k) => knob(k.id)),
  ...SCANNING,
  ...DISCOVERY,
  ...ALERTS,
  ...KNOB_FIELDS.filter((k) => k.band !== "sound").map((k) => knob(k.id)),
];

export const FIELD_BY_ID: Record<string, TuneField> = Object.fromEntries(TUNE_FIELDS.map((f) => [f.id, f]));

export function readTune(cfg: Config): TuneValues {
  return Object.fromEntries(TUNE_FIELDS.map((f) => [f.id, f.read(cfg)]));
}

/** Write the given fields' values into cfg (mutates and returns it). */
export function applyTune(cfg: Config, ids: readonly string[], values: TuneValues): Config {
  for (const id of ids) {
    const f = FIELD_BY_ID[id];
    if (f) f.write(cfg, values[id] ?? "");
  }
  return cfg;
}

/** Close Call off greys out its settings; recording off greys out the clip settings. */
export function disabledIds(v: TuneValues): Set<string> {
  const off = new Set<string>();
  if (v.tCloseCall === false) for (const id of ["tCloseCallDb", "tCcRecord", "tCcSampleSec", "tCcSampleMb"]) off.add(id);
  else if (v.tCcRecord !== true) for (const id of ["tCcSampleSec", "tCcSampleMb"]) off.add(id);
  return off;
}

/** Fields whose 0 means "off" (hum filter) have a dead zone below their
 *  minimum: the lower half snaps to off, the upper half to the minimum. */
export function snapValue(f: TuneField, n: number): number {
  const k = KNOB_BY_ID[f.id];
  if (!k?.allowZero || n <= 0 || n >= k.min) return n;
  return n < k.min / 2 ? 0 : k.min;
}

export function isDefault(f: TuneField, v: TuneValue): boolean {
  if (typeof v === "boolean" || typeof f.def === "boolean") return v === f.def;
  return v.trim() === "" || Number(v) === Number(f.def);
}
```

- [ ] **Step 5: Run to pass.** `npx vitest run test/adminNext.tuneFields.test.ts`. If the `readKnob` check in Step 1 changed `fromKnob`, the knob assertions (`kAgcTarget` blank/write) are the proof. Then `npm test` and `npm run typecheck`.

- [ ] **Step 6: Commit** — `feat(admin-next): Tune field table — read/write/cost per setting` + trailer.

### Task 5: The apply batcher (pure)

**Files:** Create `kiosk/src/frontend/admin-next/batcher.ts`, `kiosk/test/adminNext.batcher.test.ts`

**Interfaces:**
- Produces:
  - `const TUNE_APPLY_DELAY_MS = 3000`.
  - `type BatchState = { kind: "idle" } | { kind: "pending"; ids: string[]; dueAt: number } | { kind: "saving"; ids: string[] } | { kind: "saved" } | { kind: "error"; message: string; ids: string[] }`.
  - `class ApplyBatcher { constructor(save: (ids: string[]) => Promise<void>, onState: (s: BatchState) => void, delayMs?: number); state: BatchState; change(id: string): void; undo(): string[]; flush(): Promise<void> }`.

- [ ] **Step 1: Failing tests.** Create `kiosk/test/adminNext.batcher.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ApplyBatcher, TUNE_APPLY_DELAY_MS, type BatchState } from "../src/frontend/admin-next/batcher.js";

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

function make(save: (ids: string[]) => Promise<void> = async () => {}) {
  const states: BatchState["kind"][] = [];
  const saves: string[][] = [];
  const b = new ApplyBatcher(async (ids) => { saves.push(ids); await save(ids); }, (s) => states.push(s.kind));
  return { b, states, saves };
}

describe("ApplyBatcher", () => {
  it("batches changes into one save after the delay", async () => {
    const { b, saves, states } = make();
    b.change("a"); b.change("b");
    await vi.advanceTimersByTimeAsync(TUNE_APPLY_DELAY_MS - 1);
    expect(saves).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(saves).toEqual([["a", "b"]]);
    expect(states.slice(-2)).toEqual(["saving", "saved"]);
  });
  it("a new change restarts the countdown", async () => {
    const { b, saves } = make();
    b.change("a");
    await vi.advanceTimersByTimeAsync(2000);
    b.change("b");
    await vi.advanceTimersByTimeAsync(2000);
    expect(saves).toEqual([]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(saves).toEqual([["a", "b"]]);
  });
  it("undo cancels and hands back the ids", async () => {
    const { b, saves } = make();
    b.change("a");
    expect(b.undo()).toEqual(["a"]);
    expect(b.state.kind).toBe("idle");
    await vi.advanceTimersByTimeAsync(TUNE_APPLY_DELAY_MS * 2);
    expect(saves).toEqual([]);
  });
  it("a failed save keeps its ids for the next change", async () => {
    let fail = true;
    const { b, saves } = make(async () => { if (fail) throw new Error("409"); });
    b.change("a");
    await vi.advanceTimersByTimeAsync(TUNE_APPLY_DELAY_MS);
    expect(b.state).toEqual({ kind: "error", message: "409", ids: ["a"] });
    fail = false;
    b.change("b");
    await vi.advanceTimersByTimeAsync(TUNE_APPLY_DELAY_MS);
    expect(saves).toEqual([["a"], ["a", "b"]]);
    expect(b.state.kind).toBe("saved");
  });
  it("never saves concurrently: a change during a save waits for it", async () => {
    let release!: () => void;
    let inFlight = 0; let max = 0;
    const { b, saves } = make(() => { inFlight++; max = Math.max(max, inFlight); return new Promise<void>((r) => { release = () => { inFlight--; r(); }; }); });
    b.change("a");
    await vi.advanceTimersByTimeAsync(TUNE_APPLY_DELAY_MS);
    b.change("b");
    await vi.advanceTimersByTimeAsync(TUNE_APPLY_DELAY_MS);
    expect(saves).toEqual([["a"]]);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(saves).toEqual([["a"], ["b"]]);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(max).toBe(1);
  });
});
```

- [ ] **Step 2: Run to fail.**

- [ ] **Step 3: Implement `batcher.ts`:**

```ts
// Per-group apply countdown for settings whose save restarts the scanner
// (spec §4.2): changes collect for TUNE_APPLY_DELAY_MS after the last one,
// then save together — one engine restart per batch, not per nudge. Undo
// cancels a pending batch. Saves never overlap.

/** How long a batch of scanner-restarting changes waits after the last edit. */
export const TUNE_APPLY_DELAY_MS = 3000;

export type BatchState =
  | { kind: "idle" }
  | { kind: "pending"; ids: string[]; dueAt: number }
  | { kind: "saving"; ids: string[] }
  | { kind: "saved" }
  | { kind: "error"; message: string; ids: string[] };

export class ApplyBatcher {
  state: BatchState = { kind: "idle" };
  private readonly ids = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private saving: Promise<void> | null = null;

  constructor(
    private readonly save: (ids: string[]) => Promise<void>,
    private readonly onState: (s: BatchState) => void,
    private readonly delayMs = TUNE_APPLY_DELAY_MS,
  ) {}

  change(id: string): void {
    this.ids.add(id);
    this.clearTimer();
    this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, this.delayMs);
    this.set({ kind: "pending", ids: [...this.ids], dueAt: Date.now() + this.delayMs });
  }

  /** Cancel the pending batch; returns the ids so the caller can revert them. */
  undo(): string[] {
    this.clearTimer();
    const ids = [...this.ids];
    this.ids.clear();
    this.set({ kind: "idle" });
    return ids;
  }

  /** Save what's collected now (waits for an in-flight save first). */
  async flush(): Promise<void> {
    this.clearTimer();
    while (this.saving) await this.saving;
    const ids = [...this.ids];
    if (!ids.length) return;
    this.ids.clear();
    this.set({ kind: "saving", ids });
    this.saving = this.save(ids).then(
      () => { if (this.ids.size === 0) this.set({ kind: "saved" }); },
      (e: unknown) => {
        for (const id of ids) this.ids.add(id);
        this.set({ kind: "error", message: e instanceof Error ? e.message : String(e), ids });
      },
    ).finally(() => { this.saving = null; });
    await this.saving;
  }

  private clearTimer(): void {
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; }
  }

  private set(s: BatchState): void { this.state = s; this.onState(s); }
}
```

Note: when a change arrives during a save, `change()` sets `pending`; on save success the `ids.size === 0` guard keeps that pending state instead of overwriting it with `saved`.

- [ ] **Step 4: Run to pass.** `npx vitest run test/adminNext.batcher.test.ts`, then `npm test` and `npm run typecheck`.

- [ ] **Step 5: Commit** — `feat(admin-next): apply batcher — one restart per batch, with Undo` + trailer.

### Task 6: The Tune tab (main groups + weather)

**Files:** Create `kiosk/src/frontend/admin-next/tune.ts`; Modify `index.ts`, `placeholder.ts`, `admin-next.css`

**Interfaces:**
- Consumes:
  - From Tasks 1–5: `Ctx` (`ctx.ts`), `Poller.run`, `POLL_MS.tune`, `api.getConfig/putConfig/getWeatherChannel/setWeatherChannel`, `slider`, `switchRow`, `group`, `key`, `TUNE_FIELDS` and helpers, `ApplyBatcher`.
  - From `../admin/engineKnobs.js`: `curveSvg`, `loudnessCurve`, `knobUi`, `type KnobValues`.
  - `NOAA_CHANNELS` from `../../backend/config/noaa.js`.
- Produces: `mountTune(ctx: Ctx): void` and `export const SAVED_SHOW_MS = 3000`.

Read `radio.ts` first; it is the house style for this DOM glue: build once, patch in place, delegated listeners, `setText`/`setDisabled` helpers. Advanced (Task 7) lives in the same module and reuses the same engine, so write `tune.ts` so that Task 7 only adds markup plus the shape preview.

- [ ] **Step 1: Markup builders.** In `tune.ts`:
  - `controlHtml(f, v)` renders by `f.control.kind`:
    - `slider`: `slider({ id, label, hint, min, max, step, unit, ends, value: v === "" ? Number(f.def) : Number(v) })`.
    - `switch`: `switchRow({ id, label, hint, checked: v === true })`.
    - `number` and `text`: `<label class="kc-field" for="${id}"><span class="kc-field__label">${esc(label)}<small>${esc(hint)}</small></span><span class="kc-field__input"><input id="${id}" type="number|text" … placeholder="${esc(def or control.placeholder)}" value="${esc(v)}" />${unit ? `<b>${esc(unit)}</b>` : ""}</span></label>`.
  - `rowHtml(f, v)` wraps the control: `<div class="kc-tuneRow" data-row="${f.id}">${control}<button type="button" class="kc-link kc-reset" data-reset="${f.id}" hidden>Use default</button></div>`.
  - `groupHtml(g, fields, values, extra = "")` returns `group(GROUP_TITLES[g], body, { id: `kcTune-${g}` })`. The body is `extra`, then the rows, then a heavy bar and a status line:
    - Heavy bar: `<div class="kc-heavy" data-heavy="${g}" hidden><p class="kc-heavy__text"></p><div class="kc-heavy__keys">${key({ id: `kcApply-${g}`, label: "Apply", variant: "primary" })}${key({ id: `kcCancel-${g}`, label: "Cancel" })}</div></div>`.
    - Status line: `<p class="kc-status" data-status="${g}" role="status" aria-live="polite"></p>`.
  - **Sound** gets a loudness-curve figure as `extra`: `<figure class="kc-curve"><svg id="kcCurve" viewBox="0 0 300 150" role="img" aria-label="Speaker level: input against output, steady state"></svg><figcaption id="kcCurveSay"></figcaption></figure>`.
  - **Weather channel** group (id `kcTune-weather`, title "Weather channel") contains:
    - `<select id="kcWxFreq">` of NOAA_CHANNELS options `${c.label} — ${c.mhz} MHz`, value `c.mhz`.
    - A text input `kcWxTag` with placeholder "NOAA WX".
    - A mode `<select id="kcWxMode">` with options nfm/fm/am, labelled NFM/FM/AM.
    - Each control is wrapped in `kc-field` markup, followed by `<p class="kc-status" data-status="weather" role="status" aria-live="polite"></p>`.
  - **Page:** `<div class="kc-tune"><header class="kc-tune__head"><h1>Tune</h1><p>Changes apply as you go.</p></header><div class="kc-tune__grid">…groups…</div></div>`, in the order Sound, Scanning, Discovery, Alerts, Weather channel. Until the first load it shows `<p class="kc-empty">Loading…</p>`.

- [ ] **Step 2: State and engine.** In `mountTune(ctx)`:
  - **State:** `values`, `loaded`, `cfgCache: Config | null`, a `heavy: Map<TuneGroup, Set<string>>`, a `batchers: Map<TuneGroup, ApplyBatcher>`, and `ready = false`.
  - **`paintControl(id)`** writes `values[id]` into the DOM, never while that element is focused:
    - Slider: range and `-num` show `values[id] || def`.
    - Switch: `checked`.
    - Input: `value`.
  - **`paintRow(id)`** sets the Reset button's `hidden = isDefault(f, values[id])`.
  - **`paintDependents()`** reads `disabledIds(values)`, sets `disabled` on each field's input(s) and toggles `.is-off` on its `.kc-tuneRow`.
  - **`paintCurve()`** — `p = { targetDb: knobUi(values as KnobValues, "kAgcTarget"), maxGainDb: …"kAgcMax", minGainDb: …"kAgcMin", holdBelowDb: …"kAgcHold", limiterCeiling: …"kLimCeil" }`. Then `svg.innerHTML = curveSvg(p)` and the caption text is `loudnessCurve(p).caption`.
  - **`saveIds(ids)`** does every write through the lane:
    ```ts
    const saved = await ctx.poller.run(async () => {
      const cfg = await api.getConfig();
      applyTune(cfg, ids, values);
      return api.putConfig(cfg);
    });
    ```
    Confirm `api.putConfig` resolves the saved `Config`. The classic `saveKnobs` uses it that way; if it doesn't, re-read with `api.getConfig()` inside the same `run`. Afterwards set `cfgCache = saved`, compute `fresh = readTune(saved)`, and for each id set `loaded[id] = fresh[id]`. Also set `values[id] = fresh[id]` and repaint, unless the field is focused or has a newer pending change.
  - **`commit(id)`** runs after every user change:
    1. Call `paintRow`, `paintDependents`, `paintCurve` (sound/loudness), and `paintPreview` (shape, Task 7).
    2. Route by `f.cost`:
       - `live`/`backend` → `saveNow(f.group, [id])`.
       - `scan` → `batcher(f.group).change(id)`.
       - `heavy` → add to `heavy.get(g)` and show the heavy bar.
  - **`saveNow(g, ids)`** sets status "Saving…", awaits `saveIds`, then shows "Saved" (for `backend` fields: "Saved — used after the next radio restart"), cleared after `SAVED_SHOW_MS`. On error it shows the message with `data-kind="error"`.
  - **`batcher(g)`** lazily creates `new ApplyBatcher((ids) => saveIds(ids), (s) => paintStatus(g, s))`.
  - **`paintStatus(g, s)`** by state:
    - pending: "Applying in N s — restarts scanning briefly" plus `<button type="button" class="kc-link" data-undo="${g}">Undo</button>`. `N = ceil((dueAt − now)/1000)`, refreshed by a 250 ms interval that runs only while some batcher is pending.
    - saving: "Saving…".
    - saved: "Saved", auto-clear after `SAVED_SHOW_MS`.
    - error: the message, with `data-kind="error"`.
    - idle: empty.
  - **Heavy bar:**
    - Text: discovery "Recording samples restarts the scanner."; shape "Changing the group shape restarts the scanner." (plus the preview, Task 7).
    - `kcApply-${g}` takes the set's ids, clears it, hides the bar and calls `saveNow(g, ids)`.
    - `kcCancel-${g}` reverts those ids (`values[id] = loaded[id]`, repaint), clears and hides.
  - **Undo** (`[data-undo]`): `ids = batcher(g).undo()`, revert each id to `loaded`, then repaint rows, dependents and curve.
  - **Reset** (`[data-reset]`): `values[id] = ""` for number/text/slider fields, or `f.def` for switches; `paintControl(id)`; `commit(id)`.

- [ ] **Step 3: Input wiring.** Use delegated listeners on the grid:
  - range `input` → sync `-num`; `values[id] = String(snapValue(f, Number(range.value)))`; `paintCurve` when sound/loudness. There is no save on `input`, because sliders commit on release.
  - range `change` → `commit(id)`.
  - `-num` `change` → clamp to the field's min/max, snap with `snapValue`, set the range, `values[id] = String(n)` (empty stays `""`), `commit(id)`.
  - number/text `change` → `values[id] = input.value.trim()`; `commit(id)`. `Enter` in a text input blurs it so `change` fires.
  - checkbox `change` → `values[id] = input.checked`; `commit(id)`.
  - **Weather:** `change` on any of the three controls → `saveWeather()`. It runs `await ctx.poller.run(() => api.setWeatherChannel({ freq: Math.round(Number(freqSel.value) * 1e6), alphaTag: tag.value.trim() || "NOAA WX", mode: modeSel.value as Channel["mode"], enabled: true }))`, then `ctx.live.set({ weatherChannel: { freq, alphaTag, mode } })`. Status reads "Saved — the radio re-tunes briefly", or the error.

- [ ] **Step 4: Load and refresh via the poller.**

```ts
ctx.poller.add({
  name: "tune", tabs: ["tune"], everyMs: POLL_MS.tune,
  run: async () => {
    const cfg = await api.getConfig();
    cfgCache = cfg;
    const fresh = readTune(cfg);
    if (!ready) { values = { ...fresh }; loaded = { ...fresh }; render(); ready = true; }
    else for (const f of TUNE_FIELDS) {
      // Only untouched fields follow the server: never clobber an edit in progress.
      if (same(values[f.id], loaded[f.id]) && !busy(f) && !focused(f.id)) {
        values[f.id] = loaded[f.id] = fresh[f.id]!;
        paintControl(f.id); paintRow(f.id);
      }
    }
    paintDependents();
    const { weatherChannel } = await api.getWeatherChannel();   // sequential, same poll
    paintWeather(weatherChannel);                                  // skips focused controls
  },
});
```

  - **Helpers:** `busy(f)` is true when `f`'s id is in a pending batch or in a heavy set. `same(a, b)` is `a === b`.
  - **`render()`** builds the page, then calls `paintDependents`, `paintCurve` and each `paintRow`.
  - **Loading and errors:** until the first load resolves, "Loading…" shows. If the first load rejects, show "Couldn't load settings — retrying" (the poll retries in 30 s, and sooner on tab entry via `makeDue`).

- [ ] **Step 5: Mount.**
  - `index.ts`: replace `renderPlaceholder(shell.panel("tune"), "tune")` with `mountTune(ctx)`, importing from `./tune.js`.
  - `placeholder.ts`: remove the `tune` entry and narrow the type to `Exclude<Tab, "radio" | "tune">`.

- [ ] **Step 6: CSS.** Append to `admin-next.css` (tokens only):

```css
/* ── Tune ── */
.kc-tune__head h1 { margin: 8px 0 2px; font-size: var(--kc-t-title); font-weight: 700; }
.kc-tune__head p { margin: 0 0 6px; color: var(--kc-dim); }
.kc-tune__grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 380px), 1fr)); gap: 0 18px; align-items: start; }
.kc-tuneRow { position: relative; }
.kc-tuneRow.is-off { opacity: 0.5; }
.kc-reset { position: absolute; right: 16px; bottom: 2px; font-size: var(--kc-t-meta); }
.kc-tuneRow .kc-slider { padding-bottom: 18px; }
.kc-field { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 10px 16px 18px; border-top: 1px solid var(--kc-line); }
.kc-field__label { font-size: var(--kc-t-row); font-weight: 500; min-width: 0; }
.kc-field__label small { display: block; color: var(--kc-mute); font-size: var(--kc-t-small); font-weight: 400; }
.kc-field__input { display: inline-flex; align-items: center; gap: 6px; color: var(--kc-dim); font-size: var(--kc-t-small); }
.kc-field input, .kc-field select {
  min-height: 40px; padding: 6px 10px; border: 0; border-radius: var(--kc-r-key);
  background: var(--kc-key); color: var(--kc-ink); font: 400 var(--kc-t-body) var(--kc-font);
}
.kc-field input[type="number"] { width: 6em; text-align: right; font-variant-numeric: tabular-nums; }
.kc-field input[type="text"] { width: min(16em, 48vw); }
.kc-status { min-height: 1.2em; margin: 0; padding: 4px 16px 10px; color: var(--kc-dim); font-size: var(--kc-t-small); }
.kc-status[data-kind="error"] { color: var(--kc-coral); }
.kc-heavy { margin: 4px 16px 8px; padding: 10px 12px; border-radius: var(--kc-r-key); background: color-mix(in srgb, var(--kc-hay) 12%, var(--kc-raised)); }
.kc-heavy[hidden] { display: none; }
.kc-heavy__text { margin: 0 0 8px; color: var(--kc-hay); }
.kc-heavy__keys { display: flex; gap: 8px; }
.kc-curve { margin: 4px 16px 6px; }
.kc-curve svg { width: 100%; height: auto; display: block; }
.kc-curve figcaption { color: var(--kc-mute); font-size: var(--kc-t-small); }
.kc-curve .lc-hold { fill: var(--kc-ink); opacity: 0.04; }
.kc-curve .lc-unity { stroke: var(--kc-mute); stroke-dasharray: 3 4; }
.kc-curve .lc-target { stroke: var(--kc-glass); stroke-opacity: 0.35; }
.kc-curve .lc-ceil { stroke: var(--kc-hay); stroke-opacity: 0.5; stroke-dasharray: 2 3; }
.kc-curve .lc-curve { fill: none; stroke: var(--kc-glass); stroke-width: 2.25; stroke-linejoin: round; }
.kc-curve .lc-axis { stroke: var(--kc-line); }
.kc-curve text { fill: var(--kc-mute); font: 10px var(--kc-font); }
```

Check `curveSvg`'s output for any other classes or `<text>` and style them with tokens.

- [ ] **Step 7: Verify.**
  - Run `npm test`, `npm run typecheck`, `npm run build:frontend`, then `curl -s -X POST localhost:8080/api/kiosk/reload`.
  - Take real-time captures: `timeout 60 chromium --headless --disable-gpu --hide-scrollbars --window-size=1440,1000 --timeout=20000 --screenshot=$HOME/shots/tune-1440.png "http://localhost:8080/admin#/next/tune"` and the same at `390,844`, plus a tall `390,2400` capture to see every group.
  - Read them and confirm: groups populated with the current values; sliders show named ends; the curve is drawn; the hum filter reads "Off" at 0; no horizontal scroll at 390; Close Call dependents greyed if it's off.
  - Do not change any setting against the live radio.

- [ ] **Step 8: Commit** — `feat(admin-next): Tune tab — groups, sliders, cost-aware save` + trailer.

### Task 7: Advanced engine settings

**Files:** Modify `kiosk/src/frontend/admin-next/tune.ts`, `admin-next.css`

**Interfaces:**
- Consumes: Task 6's engine (`commit`, heavy bar, batchers, `saveNow`). From `../admin/engineKnobs.js`: `ADVANCED_BANDS`, `COST_LABEL`, `BAND_COST`, `previewGroups`, `previewText`, `revisitHint`. Also `DEFAULT_GROUP_DWELL_MS`.
- Produces: the Advanced disclosure inside the Tune page.

- [ ] **Step 1: Markup.** After the grid, add a disclosure matching Radio's `kc-disclosure` markup (read `radio.ts` for the exact summary and chevron structure):
  - `<details class="kc-group kc-disclosure" id="kcAdvanced">`, closed by default, with the summary "Advanced engine settings" and the lucide chevron.
  - Then `<p class="kc-empty">Tuned for this appliance. Leave a field blank for its default.</p>`.
  - Then, for each band in `ADVANCED_BANDS`, a `<section class="kc-band" aria-labelledby="kcBand-${band}">` containing:
    - `<h3 id="kcBand-${band}">${title} <small class="kc-cost">${costLabel}</small></h3>`, where the cost label is `COST_LABEL[BAND_COST[band]]`, except shape, which reads "Restarts scanning · Apply to confirm".
    - `<p class="kc-band__purpose">${purpose}</p>`.
    - For shape only: `<p class="kc-preview" id="kcPreview" role="status" aria-live="polite"></p>`.
    - The band's rows via `rowHtml` (number and switch controls from `TUNE_FIELDS` with `group === band`), then the band's heavy bar and status line, same markup as Task 6.
  - Watchdog band: the saved status text for backend fields adds `<a href="${hrefFor({ tab: "system" })}">Restart radio</a>`.

- [ ] **Step 2: Preview.** `paintPreview()`:
  - Return if `!cfgCache`.
  - `pv = previewGroups({ channels: cfgCache.channels, banks: cfgCache.banks ?? [], lanes: knobUi(v, "kLanes"), rateHz: knobUi(v, "kRate") * 1e6, windowHz: knobUi(v, "kWindow") * 1e6, flatHz: knobUi(v, "kFlat") * 1e6, groupDwellMs: Number(values.tGroupDwell || DEFAULT_GROUP_DWELL_MS), sweeping: (cfgCache.scan.sweepRanges?.length ?? 0) > 0 })`, with `v = values as KnobValues`.
  - Set `#kcPreview` text to `previewText(pv)` and toggle its `data-kind="error"` when `!pv.ok`.
  - Disable `#kcApply-shape` when `!pv.ok`.
  - Set the text of `[data-row="kRevisit"] small` to `revisitHint(pv)`.
  - Call it from `commit` for shape fields and after every load or refresh.

- [ ] **Step 3: Refresh on open.** On the disclosure's `toggle` to open, call `ctx.poller.makeDue("tune")` and `void ctx.poller.tick("tune")`, so the preview uses a fresh channel list. That goes through the poller, never a direct fetch.

- [ ] **Step 4: CSS.** Append:

```css
.kc-band { padding: 6px 0 4px; border-top: 1px solid var(--kc-line); }
.kc-band h3 { margin: 10px 16px 2px; font-size: var(--kc-t-row); font-weight: 600; }
.kc-cost { margin-left: 6px; padding: 1px 8px; border-radius: var(--kc-r-pill); background: var(--kc-key); color: var(--kc-dim); font-size: var(--kc-t-meta); font-weight: 600; }
.kc-band__purpose { margin: 0 16px 6px; color: var(--kc-mute); font-size: var(--kc-t-small); }
.kc-preview { margin: 0 16px 8px; color: var(--kc-dim); font-size: var(--kc-t-small); }
.kc-preview[data-kind="error"] { color: var(--kc-coral); }
```

- [ ] **Step 5: Verify.** Run `npm test`, `npm run typecheck`, `npm run build:frontend`, and the reload. The disclosure is closed by default, so a static capture can't show it open. Instead, verify the markup by adding one unit test that pure-renders a band: export a pure `bandHtml(band, values)` from tune.ts and assert it contains the band title, cost label and every field id for that band. Then take the 1440 capture and confirm the closed disclosure renders under the grid.

- [ ] **Step 6: Commit** — `feat(admin-next): Tune advanced engine settings with group-shape preview` + trailer.

### Task 8: Prove, and open the PR

- [ ] **Step 1: Full definition of done, once.** `npm test`, `npm run test:native`, `npm run typecheck`, `npm run build` (native compile, thermal cost, run once), then `curl -s -X POST localhost:8080/api/kiosk/reload`. No service restart.

- [ ] **Step 2: Captures.** Real-time captures of `/admin#/next/tune` at 390 and 1440 (and 390 tall). Confirm the values match `curl -s localhost:8080/api/config` for a few fields: `scan.dwellMs`, `scan.closeCall`, `audio.agcTargetDb` (blank shows the default).

- [ ] **Step 3: Request discipline.** Confirm by code review:
  - `grep -n "fetch(" src/frontend/admin-next/*.ts` prints nothing.
  - Every `api.putConfig` / `api.setWeatherChannel` call in `tune.ts` sits inside `ctx.poller.run(...)`.
  - Every Tune read sits inside the `"tune"` poll.

  Also confirm the page caused no engine restart just by loading: `journalctl -u kerchunk-kiosk --since "-5 min" | grep -ci "engine start"` should be 0 across the capture window.

- [ ] **Step 4: PR.** Push `feat/admin-next-tune`, then open the PR:
  - Body: summary, knobs (`TUNE_APPLY_DELAY_MS`, `SAVED_SHOW_MS`, `POLL_MS.tune`), verification results, and the pinned items delivered (write lane, typed api, kit slider/switch).
  - Include an operator checklist to run from the phone:
    - [ ] Nudge a Sound slider: a countdown appears, and one scanner restart happens after 3 s (wall shows warm-up once). A second nudge within 3 s restarts the countdown.
    - [ ] Undo during the countdown restores the old value, with no restart.
    - [ ] Toggle Record samples: the Apply/Cancel bar appears; Cancel reverts with no restart.
    - [ ] Change the alert cooldown: "Saved" appears, with no restart.
    - [ ] Advanced → Group shape: change lanes and the preview updates; Cancel.
    - [ ] Weather channel: the name change saves.
    - [ ] Reset ("Use default") clears an explicit value.
  - End with the attribution line.

- [ ] **Step 5: After operator OK and green CI:** `gh pr merge <n> --merge --delete-branch`, `git checkout main && git pull --ff-only && git fetch --prune`, `git branch -d feat/admin-next-tune`.
