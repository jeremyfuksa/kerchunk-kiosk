# Visual Hold Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an open on a muted (`audible:false`) scan channel hold its window for up to `visualHold.maxMs` (and optionally credit `autoDwell`), so the map sees whole transmissions while the speaker stays silent.

**Architecture:** A third Node-side scheduling knob, `config.scan.visualHold`, beside `autoDwell`/`priorityRevisit`: defaults + resolver in `scanSchedule.ts`, carried by `toScanConfig`, stripped from the PUT restart diff and pushed live through `engine.updateScheduling`. `WidebandEngine`'s dwell tick gains a second hold branch (muted, capped, no lane clearing); `recordActivity` credits muted opens when enabled.

**Tech Stack:** TypeScript (Node ≥24, ESM, `.js` import extensions), zod, vitest with the fake wideband helper (`test/fakes/fake-wideband-helper.sh`).

**Spec:** `docs/superpowers/specs/2026-10-03-visual-hold-design.md`

## Global Constraints

- All commands run from `kiosk/`. ESM: relative imports carry `.js`.
- `strict` + `noUncheckedIndexedAccess`.
- Defaults: `enabled: true`, `maxMs: 15000`, `creditDwell: true`. Schema range for `maxMs`: 1000–180000 (int).
- Audible hold behaviour, `maxHoldMs` (180 s) and its stuck-lane path (log + clear `openIds`) stay exactly as today.
- A visual-hold cap breach falls through to the normal advance: **no `openIds` clear, no log**.
- `visualHold` changes apply live: no `engine.stop()/start()`, no tune, no helper respawn.
- `enabled:false` must reproduce today's behaviour exactly (muted never holds, never credits).
- Background (SAME) channels and Close Call (`cc_*`) lanes keep their current rules.
- Definition of done (CLAUDE.md): `npm test`, `npm run test:native`, `npm run typecheck`, `npm run build`, proven on the appliance.

## Review Focus

1. A muted carrier that never closes: the window must hop at `maxMs` every visit, with no journal line per visit and the lane not force-closed. → Task 3, test "visual hold releases at maxMs …".
2. A hold that starts visual and turns audible must get the 180 s audible cap, not be cut at 15 s. → Task 3, test "an audible open during a visual hold keeps holding past maxMs".
3. The SAME/background lane reading open must not visually hold (break-in path depends on retune, not hold). → Task 3, test "a background channel open does not visually hold".
4. Toggling `visualHold.enabled` off by PUT mid-hold must release on the next tick with no respawn. → Task 3, test "updateScheduling({ visualHold: { enabled: false } }) releases a visual hold live".
5. Existing regression tests that encode "muted never holds / never credits" must keep their intent under `enabled:false`, not be deleted. → Tasks 3 and 4 edit them to pass `visualHold: { enabled: false }`.

---

### Task 1: `resolveVisualHold` in scanSchedule.ts

**Files:**
- Modify: `kiosk/src/backend/engine/scanSchedule.ts` (append after `resolvePriorityRevisit`)
- Test: `kiosk/test/scanSchedule.test.ts`

**Interfaces:**
- Produces: `interface VisualHoldConfig { enabled?: boolean; maxMs?: number; creditDwell?: boolean }`, `VISUAL_HOLD_DEFAULTS` (`{ enabled: true, maxMs: 15000, creditDwell: true } as const`), `resolveVisualHold(c: VisualHoldConfig | undefined): Required<VisualHoldConfig>`.

- [ ] **Step 1: Write the failing test** — add to `test/scanSchedule.test.ts` (extend the import list with `resolveVisualHold, VISUAL_HOLD_DEFAULTS`):

```ts
describe("visual hold helpers", () => {
  it("defaults: enabled, 15 s cap, credits dwell", () => {
    expect(VISUAL_HOLD_DEFAULTS).toEqual({ enabled: true, maxMs: 15000, creditDwell: true });
    expect(resolveVisualHold(undefined)).toEqual(VISUAL_HOLD_DEFAULTS);
  });

  it("fills only the missing fields", () => {
    expect(resolveVisualHold({ maxMs: 8000 })).toEqual({ ...VISUAL_HOLD_DEFAULTS, maxMs: 8000 });
    expect(resolveVisualHold({ enabled: false, creditDwell: false }))
      .toEqual({ enabled: false, maxMs: 15000, creditDwell: false });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/scanSchedule.test.ts`
Expected: FAIL — `resolveVisualHold` / `VISUAL_HOLD_DEFAULTS` not exported.

- [ ] **Step 3: Implement** — append to `src/backend/engine/scanSchedule.ts`:

```ts
/** config.scan.visualHold — muted channels earn scan time for the map
 *  (spec 2026-10-03 visual hold). A muted open holds its window for up to
 *  maxMs of continuous hold; the speaker stays silent. */
export interface VisualHoldConfig {
  enabled?: boolean;
  /** Ceiling on ONE continuous visual hold, ms. Audible holds keep maxHoldMs. */
  maxMs?: number;
  /** Muted opens also count toward autoDwell activity. */
  creditDwell?: boolean;
}

export const VISUAL_HOLD_DEFAULTS = {
  enabled: true,
  maxMs: 15_000, // a typical rail / business / WOF transmission is 9-12 s
  creditDwell: true,
} as const;

export function resolveVisualHold(c: VisualHoldConfig | undefined): Required<VisualHoldConfig> {
  return {
    enabled: c?.enabled ?? VISUAL_HOLD_DEFAULTS.enabled,
    maxMs: c?.maxMs ?? VISUAL_HOLD_DEFAULTS.maxMs,
    creditDwell: c?.creditDwell ?? VISUAL_HOLD_DEFAULTS.creditDwell,
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/scanSchedule.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/backend/engine/scanSchedule.ts test/scanSchedule.test.ts
git commit -m "feat(scan): visualHold knob defaults + resolver"
```

---

### Task 2: Config plumbing — schema, ScanConfig, live push

**Files:**
- Modify: `kiosk/src/backend/config/schema.ts` (in `scan`, right after the `priorityRevisit` object)
- Modify: `kiosk/src/backend/engine/ScannerEngine.ts:43-49` (ScanConfig field) and `:189` (`updateScheduling` Pick)
- Modify: `kiosk/src/backend/engine/FakeEngine.ts:74` (Pick)
- Modify: `kiosk/src/backend/engine/WidebandEngine.ts:379-384` (`updateScheduling`)
- Modify: `kiosk/src/backend/server.ts:133-134` (toScanConfig), `:881-895` (strip + live push)
- Test: `kiosk/test/api.test.ts` (next to the priorityRevisit PUT tests, ~line 959)

**Interfaces:**
- Consumes: `VisualHoldConfig` from Task 1.
- Produces: `ScanConfig.visualHold?: VisualHoldConfig`; `updateScheduling(s: Pick<ScanConfig, "autoDwell" | "priorityRevisit" | "visualHold">)`.

- [ ] **Step 1: Write the failing tests** — in `test/api.test.ts` after "PUT /api/config rejects out-of-range priorityRevisit":

```ts
  it("PUT /api/config with only visualHold changes applies it live (no restart)", async () => {
    const { server, engine } = makeApp();
    let starts = 0;
    const realStart = engine.start.bind(engine);
    engine.start = async (sc) => { starts++; return realStart(sc); };
    const cfg = (await request(server).get("/api/config")).body;
    cfg.scan.visualHold = { maxMs: 8000, creditDwell: false };
    const res = await request(server).put("/api/config").send(cfg);
    expect(res.status).toBe(200);
    expect(starts).toBe(0);
    const updates = (engine as { schedulingUpdates?: Array<Record<string, unknown>> }).schedulingUpdates ?? [];
    expect(updates.at(-1)?.visualHold).toEqual({ maxMs: 8000, creditDwell: false });
  });

  it("PUT /api/config rejects out-of-range visualHold", async () => {
    const { server } = makeApp();
    const cfg = (await request(server).get("/api/config")).body;
    cfg.scan.visualHold = { maxMs: 500 };
    const res = await request(server).put("/api/config").send(cfg);
    expect(res.status).toBe(400);
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/api.test.ts -t visualHold`
Expected: FAIL — first: `starts` is 1 (unknown field stripped → or restart path) / no `visualHold` in updates; second: 200 instead of 400.

- [ ] **Step 3: Implement**

`schema.ts`, after the `priorityRevisit: z.object({...}).optional(),` entry:

```ts
    // Visual hold (spec 2026-10-03): an open on a MUTED scan channel holds
    // its window for up to maxMs so the map sees the whole transmission; the
    // speaker stays silent and audible opens keep first claim (maxHoldMs).
    // creditDwell lets muted opens count toward autoDwell. Live like
    // autoDwell. Omitted = enabled, 15000, true.
    visualHold: z.object({
      enabled: z.boolean().optional(),
      maxMs: z.number().int().min(1000).max(180_000).optional(),
      creditDwell: z.boolean().optional(),
    }).optional(),
```

`ScannerEngine.ts` — extend the scanSchedule import with `type VisualHoldConfig`, add after `priorityRevisit?: PriorityRevisitConfig;`:

```ts
  // Visual hold (config.scan.visualHold, see scanSchedule.ts) — same live
  // path as autoDwell.
  visualHold?: VisualHoldConfig;
```

and change line 189 to:

```ts
  updateScheduling?(s: Pick<ScanConfig, "autoDwell" | "priorityRevisit" | "visualHold">): void;
```

`FakeEngine.ts:74`:

```ts
  updateScheduling(s: Pick<ScanConfig, "autoDwell" | "priorityRevisit" | "visualHold">): void { this.schedulingUpdates.push(s); }
```

(also widen the `schedulingUpdates` array's element type the same way if it is declared with the two-key Pick).

`WidebandEngine.ts` — extend the scanSchedule import with `resolveVisualHold, type VisualHoldConfig`; replace `updateScheduling`:

```ts
  updateScheduling(s: { autoDwell?: AutoDwellConfig; priorityRevisit?: PriorityRevisitConfig; visualHold?: VisualHoldConfig }): void {
    if (!this.config) return;
    this.config = { ...this.config, autoDwell: s.autoDwell, priorityRevisit: s.priorityRevisit, visualHold: s.visualHold };
```

(rest of the method unchanged; update its doc comment to name visualHold). Add a private accessor next to `autoDwell()`:

```ts
  private visualHold(): Required<VisualHoldConfig> {
    return resolveVisualHold(this.config?.visualHold);
  }
```

`server.ts` toScanConfig, after `priorityRevisit: cfg.scan.priorityRevisit,`:

```ts
    visualHold: cfg.scan.visualHold,
```

`server.ts` PUT handler — the strip and the live push:

```ts
      const strip = (s: ScanConfig) => ({ ...s, knownHz: [], lockoutHz: [], autoDwell: undefined, priorityRevisit: undefined, visualHold: undefined });
```

```ts
        if (JSON.stringify([before.autoDwell, before.priorityRevisit, before.visualHold])
          !== JSON.stringify([after.autoDwell, after.priorityRevisit, after.visualHold])) {
          engine.updateScheduling?.({ autoDwell: after.autoDwell, priorityRevisit: after.priorityRevisit, visualHold: after.visualHold });
        }
```

Update the comment above `strip` to read "Scheduling knobs (autoDwell, priorityRevisit, visualHold)".

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run test/api.test.ts && npm run typecheck`
Expected: PASS; typecheck clean (both tsconfigs).

- [ ] **Step 5: Commit**

```bash
git add src/backend/config/schema.ts src/backend/engine/ScannerEngine.ts src/backend/engine/FakeEngine.ts src/backend/engine/WidebandEngine.ts src/backend/server.ts test/api.test.ts
git commit -m "feat(scan): scan.visualHold config, applied live via updateScheduling"
```

---

### Task 3: The visual hold in the dwell tick

**Files:**
- Modify: `kiosk/src/backend/engine/WidebandEngine.ts` — dwell tick (`startDwellTimer`, the `if (this.hasAudibleOpen()) { … } else { … }` block ~line 903) and a new `hasVisualOpen()` beside `hasAudibleOpen()` (~line 731)
- Test: `kiosk/test/WidebandEngine.test.ts`

**Interfaces:**
- Consumes: `this.visualHold()` (Task 2), `ScanConfig.visualHold`.
- Produces: `private hasVisualOpen(): boolean`.

- [ ] **Step 1: Keep the old regression tests' intent** — in `test/WidebandEngine.test.ts`:
  - "an open on an INAUDIBLE channel does not hold the rotation" (~line 185): rename to `"visualHold disabled: an open on an INAUDIBLE channel does not hold the rotation"` and change its start to
    `await engine.start(cfg([muted, VHF_B, UHF], { visualHold: { enabled: false } }));`

- [ ] **Step 2: Write the failing tests** — add after "max-hold cap: forces a hop past a lane stuck open past maxHoldMs":

```ts
  describe("visual hold (scan.visualHold)", () => {
    const muted = ch(146_790_000, { audible: false });

    it("a muted open holds past the plain dwell", async () => {
      const tunes = tmpFile("tunes");
      const { engine, events } = makeEngine({
        FAKE_WB_TUNES_FILE: tunes,
        FAKE_WB_SCRIPT: `{"ev":"open","id":"${muted.id}","db":-10}`, // never closes
      }, { groupDwellMs: 1000 });
      await engine.start(cfg([muted, VHF_B, UHF], { visualHold: { maxMs: 60_000 } }));
      expect(await waitFor(() => events.some((e) => e.type === "active" && e.channel.id === muted.id), 1000)).toBe(true);
      const tunesAtOpen = lines(tunes).length;
      await new Promise((r) => setTimeout(r, 1800)); // well past the 1 s dwell
      await engine.stop();
      expect(lines(tunes)).toHaveLength(tunesAtOpen);
    });

    it("visual hold releases at maxMs: hops, no max-hold log, lane not force-closed", async () => {
      const tunes = tmpFile("tunes");
      const logs: string[] = [];
      const { engine, events } = makeEngine({
        FAKE_WB_TUNES_FILE: tunes,
        FAKE_WB_SCRIPT: `{"ev":"open","id":"${muted.id}","db":-10}`,
      }, { groupDwellMs: 1000, log: (m: string) => logs.push(m) });
      await engine.start(cfg([muted, VHF_B, UHF], { visualHold: { maxMs: 300 } }));
      expect(await waitFor(() => events.some((e) => e.type === "active" && e.channel.id === muted.id), 1000)).toBe(true);
      const tunesAtOpen = lines(tunes).length;
      // Cap 300 ms, then the plain 1 s dwell → hop well inside 2.5 s.
      expect(await waitFor(() => lines(tunes).length > tunesAtOpen, 2500)).toBe(true);
      await engine.stop();
      expect(logs.some((m) => m.includes("max-hold"))).toBe(false);
    });

    it("an audible open during a visual hold keeps holding past maxMs", async () => {
      const tunes = tmpFile("tunes");
      const { engine, events } = makeEngine({
        FAKE_WB_TUNES_FILE: tunes,
        FAKE_WB_SCRIPT: [
          `{"ev":"open","id":"${muted.id}","db":-10}`,
          `{"ev":"open","id":"${VHF_B.id}","db":-10}`,
        ].join("\n"),
      });
      await engine.start(cfg([muted, VHF_B, UHF], { visualHold: { maxMs: 200 } }));
      expect(await waitFor(() => events.filter((e) => e.type === "signal").length >= 2, 1000)).toBe(true);
      const tunesAtHold = lines(tunes).length;
      await new Promise((r) => setTimeout(r, 600)); // 3x the visual cap
      await engine.stop();
      expect(lines(tunes)).toHaveLength(tunesAtHold);
    });

    it("a background channel open does not visually hold", async () => {
      const tunes = tmpFile("tunes");
      const bg = { ...ch(146_790_000), audible: false, background: true };
      const { engine, events } = makeEngine({
        FAKE_WB_TUNES_FILE: tunes,
        FAKE_WB_SCRIPT: `{"ev":"open","id":"${bg.id}","db":-10}`,
      }, { groupDwellMs: 1000 });
      await engine.start(cfg([bg, VHF_B, UHF], { visualHold: { maxMs: 60_000 } }));
      expect(await waitFor(() => events.some((e) => e.type === "active" && e.channel.id === bg.id), 1000)).toBe(true);
      const tunesAtOpen = lines(tunes).length;
      expect(await waitFor(() => lines(tunes).length > tunesAtOpen, 2500)).toBe(true);
      await engine.stop();
    });

    it("updateScheduling({ visualHold: { enabled: false } }) releases a visual hold live", async () => {
      const tunes = tmpFile("tunes");
      const args = tmpFile("args");
      const { engine, events } = makeEngine({
        FAKE_WB_TUNES_FILE: tunes, FAKE_WB_ARGS_FILE: args,
        FAKE_WB_SCRIPT: `{"ev":"open","id":"${muted.id}","db":-10}`,
      }, { groupDwellMs: 300 });
      await engine.start(cfg([muted, VHF_B, UHF], { visualHold: { maxMs: 60_000 } }));
      expect(await waitFor(() => events.some((e) => e.type === "active" && e.channel.id === muted.id), 1000)).toBe(true);
      const tunesAtOpen = lines(tunes).length;
      await new Promise((r) => setTimeout(r, 700)); // held past the 300 ms dwell
      expect(lines(tunes)).toHaveLength(tunesAtOpen);
      engine.updateScheduling({ visualHold: { enabled: false } });
      expect(await waitFor(() => lines(tunes).length > tunesAtOpen, 1500)).toBe(true);
      await engine.stop();
      expect(lines(args)).toHaveLength(1); // no respawn
    });
  });
```

- [ ] **Step 3: Run to verify they fail**

Run: `npx vitest run test/WidebandEngine.test.ts -t "visual hold"`
Expected: "a muted open holds past the plain dwell", "updateScheduling … releases …" FAIL (muted never holds today). The other three may already pass — they pin the edges.

- [ ] **Step 4: Implement** — add beside `hasAudibleOpen()`:

```ts
  // Is a muted, configured, non-background channel of the CURRENT group open?
  // Visual hold (spec 2026-10-03): the map should see its transmission whole.
  // Close Call lanes never reach here — hasAudibleOpen() already counts them.
  private hasVisualOpen(): boolean {
    const group = this.groups[this.groupIndex];
    if (!group) return false;
    for (const id of this.openIds) {
      const channel = group.channels.find((c) => c.id === id);
      if (channel && channel.audible === false && !channel.background) return true;
    }
    return false;
  }
```

In the dwell tick, replace the `else { … }` of `if (this.hasAudibleOpen()) { … }` with:

```ts
      } else if (this.visualHold().enabled && this.hasVisualOpen()) {
        // Visual hold: a MUTED open keeps the window so the map sees the whole
        // transmission. Its own, shorter cap; on breach fall through to the
        // plain advance — no openIds clear and no log: a long muted
        // transmission is not a stuck lane, and a continuously keyed muted
        // carrier would otherwise log every rotation.
        if (this.holdStartedAt === 0) this.holdStartedAt = this.now();
        if (this.now() - this.holdStartedAt < this.visualHold().maxMs) {
          this.groupStartedAt = this.now();
          return;
        }
      } else {
        // Nothing holds: the window gets its plain dwell, no hold.
        this.holdStartedAt = 0;
      }
```

Note: `holdStartedAt` is shared, so a visual hold that turns audible keeps its start and the audible branch then measures it against `maxHoldMs` (180 s) — audible always wins. After a visual-cap breach `holdStartedAt` stays set only until the hop: `sendTune()` already zeroes it (`WidebandEngine.ts:790`), so a return visit starts a fresh hold. No change needed there.

- [ ] **Step 5: Run to verify they pass**

Run: `npx vitest run test/WidebandEngine.test.ts`
Expected: PASS (whole file, including the renamed regression test and the existing audible-hold / max-hold tests).

- [ ] **Step 6: Commit**

```bash
git add src/backend/engine/WidebandEngine.ts test/WidebandEngine.test.ts
git commit -m "feat(scan): visual hold — muted opens hold the window up to visualHold.maxMs"
```

---

### Task 4: `creditDwell` — muted opens count toward autoDwell

**Files:**
- Modify: `kiosk/src/backend/engine/WidebandEngine.ts` — `recordActivity` (~line 391)
- Test: `kiosk/test/WidebandEngine.test.ts` — `describe("activity-weighted dwell (scan.autoDwell)")`

**Interfaces:**
- Consumes: `this.visualHold()` (Task 2).

- [ ] **Step 1: Keep the old test's intent** — the test "opens on muted or Close Call lanes don't count as the group's traffic" (~line 1188): rename to `"visualHold disabled: opens on muted or Close Call lanes don't count as the group's traffic"` and start with
  `await engine.start(cfg([muted, VHF_B, MID, UHF], { visualHold: { enabled: false } }));`

- [ ] **Step 2: Write the failing tests** — append inside the same describe:

```ts
  it("creditDwell: muted opens count as the group's traffic (Close Call still doesn't)", async () => {
    const tunes = tmpFile("tunes");
    const muted = { ...VHF_A, audible: false };
    const { engine, events } = clockEngine({
      FAKE_WB_TUNES_FILE: tunes,
      FAKE_WB_SCRIPT: [opens(muted.id, 3), opens("cc_146900000", 2)].join("\n"),
    });
    await engine.start(cfg([muted, VHF_B, MID, UHF]));
    expect(await waitFor(() => closes(events) >= 5, 1000)).toBe(true);
    // Same shape as the audible case: a = [3,0,0] → [6000, 1500, 1500].
    expect(engine.groupDwellPlan()).toEqual([6000, 1500, 1500]);
    await engine.stop();
  });

  it("creditDwell:false keeps muted opens out of the activity count", async () => {
    const tunes = tmpFile("tunes");
    const muted = { ...VHF_A, audible: false };
    const { engine, events } = clockEngine({
      FAKE_WB_TUNES_FILE: tunes, FAKE_WB_SCRIPT: opens(muted.id, 3),
    });
    await engine.start(cfg([muted, VHF_B, MID, UHF], { visualHold: { creditDwell: false } }));
    expect(await waitFor(() => closes(events) >= 3, 1000)).toBe(true);
    expect(engine.groupDwellPlan()).toEqual([3000, 3000, 3000]);
    await engine.stop();
  });
```

- [ ] **Step 3: Run to verify the first fails**

Run: `npx vitest run test/WidebandEngine.test.ts -t "creditDwell"`
Expected: "creditDwell: muted opens count …" FAIL (plan is `[3000, 3000, 3000]`); the `creditDwell:false` one passes.

- [ ] **Step 4: Implement** — in `recordActivity`, replace

```ts
    if (!group || !channel || channel.audible === false || channel.background) return;
```

with

```ts
    if (!group || !channel || channel.background) return;
    // A muted carrier counts only when visual hold credits it (spec
    // 2026-10-03): the map wants a busy muted window (rail) visited more.
    const vh = this.visualHold();
    if (channel.audible === false && !(vh.enabled && vh.creditDwell)) return;
```

and update the comment above `recordActivity` ("a muted carrier would inflate it") to: "a muted carrier counts only with visualHold.creditDwell".

- [ ] **Step 5: Run to verify they pass**

Run: `npx vitest run test/WidebandEngine.test.ts`
Expected: PASS (whole file).

- [ ] **Step 6: Commit**

```bash
git add src/backend/engine/WidebandEngine.ts test/WidebandEngine.test.ts
git commit -m "feat(scan): visualHold.creditDwell — muted opens earn autoDwell"
```

---

### Task 5: Docs, full checks, prove on the appliance, PR

**Files:**
- Modify: `CLAUDE.md` ("Conventions that bite" knob paragraph — after the speaker AGC sentence)

- [ ] **Step 1: Document the knob** — append to the `kerchunk-dsp` knob bullet in CLAUDE.md:

```markdown
  Scan scheduling is Node-side and live (no respawn): `config.scan.autoDwell`,
  `priorityRevisit`, and `visualHold` (`enabled` true / `maxMs` 15000 /
  `creditDwell` true) — a MUTED channel's open holds its window up to `maxMs`
  so the map sees the whole transmission; audible holds keep `maxHoldMs`.
```

- [ ] **Step 2: Definition-of-done checks** (from `kiosk/`)

Run: `npm test && npm run test:native && npm run typecheck && npm run build`
Expected: all pass.

- [ ] **Step 3: Deploy** — backend change:

```bash
sudo systemctl restart kerchunk-kiosk
sleep 12; curl -s localhost:8080/api/status
```

Expected: `"state":"running"`, `"warmed":true`. (Live config has no `scan.visualHold` → defaults apply: enabled.)

- [ ] **Step 4: Prove on hardware** — after ≥2 h of traffic, copy `history.db` and check the rail window (160.5–161.55 MHz) is no longer censored at 1.385 s:

```bash
S=$(mktemp -d) && sudo cp /var/lib/kerchunk-kiosk/history.db* $S/ && sudo chown $USER $S/history.db* && \
node -e 'const {DatabaseSync}=require("node:sqlite");const db=new DatabaseSync(process.argv[1]);
console.log(db.prepare("select count(*) n, max(durationMs) mx, sum(case when durationMs>1385 then 1 else 0 end) longer from events where kind=\x27active\x27 and freq between 160500000 and 161550000 and ts > ?").get(Date.now()-2*3600e3))' $S/history.db
```

Expected: `longer > 0` and `mx` well above 1385. Also listen: repeaters still sound right; journal has no new `max-hold` spam (`journalctl -u kerchunk-kiosk --since "-2h" | grep -c max-hold`).

- [ ] **Step 5: Commit, PR, merge, clean up**

```bash
git add CLAUDE.md && git commit -m "docs: scan.visualHold knob"
git push -u origin feat/visual-hold
gh pr create --title "feat(scan): visual hold — muted channels earn scan time for the map" --body "<summary, spec link, test + hardware results, 🤖 footer>"
# after CI green:
gh pr merge <n> --merge --delete-branch && git checkout main && git pull --ff-only && git fetch --prune
```

Out of scope (separate PRs, per the spec): admin Faceplate knob fields for visualHold, 462/464 merge, airband dwellWeight, archive-recommender row cap.
