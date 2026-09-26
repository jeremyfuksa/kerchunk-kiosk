# Native DSP P2 — Node Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `KERCHUNK_ENGINE=native` run both radios on `kerchunk-dsp`, with no change to the default (`wideband` = GNU Radio). That covers the helper command and args, a native-scale quieting knob, the weather radio at 250 kHz, forwarding helper `log` events, liveness watchdogs, building the binary into `dist/`, and docs. After P2 merges, the operator flips the systemd env for the P3 by-ear A/B.

**Architecture:** `WidebandEngine` gains `native?: boolean`. Native mode:
- spawns `dist/backend/engine/kerchunk-dsp`
- forwards `--quiet-db` only from the new `scan.nativeQuietDb` (never from the GNU Radio-scale `noiseQuietDb`)
- omits the GR-only `--detect-via`, `--lanes` and `--lane-modes`
- never respawns for a lane-topology change, because native has fixed 12 slots
- arms a `ready` watchdog and an output-silence watchdog

`ev:"log"` forwarding is added for both engines. `index.ts` maps `KERCHUNK_ENGINE=native` onto it, and gives the weather radio 250 kHz, since the native lane rate needs a multiple of 50 kHz; GR keeps 240 kHz.

**Tech Stack:** TypeScript (Node ≥24, ESM, `.js` import extensions, `strict` + `noUncheckedIndexedAccess`), zod, vitest, bash fake helper, npm scripts, CMake (already present).

**Spec:** `docs/superpowers/specs/2026-09-25-native-dsp-engine-design.md` §1 and §5 (P2). Requirements come from the P1c final review, recorded in memory `native-dsp-engine.md` and in `kiosk/bench/RESULTS-2026-09-26-native-p1c.md`.

## Global Constraints

- **Default behaviour is unchanged.** `KERCHUNK_ENGINE` unset or `wideband` must behave exactly as today. The one exception is `ev:"log"` forwarding, which is additive and applies to both engines. The GR helper's args, respawn logic and weather rate are unchanged.
- **Native quieting (decision C).** Native never receives `noiseQuietDb` (GR scale, about −86). `--quiet-db` is sent only when `scan.nativeQuietDb` is set; otherwise the helper's `QUIET_DB_DEFAULT` (−6.0) applies. The per-channel `quietDb` in `tune` is still sent; native ignores it.
- **Native rate rule.** The SDR rate must be a multiple of 50 kHz. Weather is 250 kHz when native and 240 kHz when GR.
- **Watchdogs are native only.**
  - If no `ready` arrives within `readyTimeoutMs` (default 10 000) of spawn, the helper is treated as exited.
  - After `ready`, if no stdout line arrives for `silenceTimeoutMs` (default 5 000), it is treated as exited. The native helper emits `power` every 200 ms once tuned.
  - Both go through the existing `handleUnexpectedExit` path (quit, 500 ms SIGKILL, backoff).
- **Log forwarding.** `ev:"log"` goes to `this.log('[helper] <msg>')`, rate-limited to `HELPER_LOG_BURST` (10) lines per `HELPER_LOG_WINDOW_MS` (60 000). A window that dropped lines ends with `[helper] N more log lines suppressed`.
- **Build.** `npm run build` also builds the native binary and copies it to `dist/backend/engine/kerchunk-dsp`. `build:backend`, which CI's JS job runs, must NOT need cmake.
- **No deploy or restart in P2.** Code, tests and docs only. P3 (the operator's switch) is where the build gets deployed with `KERCHUNK_ENGINE=native`.
- **Conventions.**
  - Relative imports carry `.js`.
  - `npm run typecheck` (both tsconfigs) and `npm test` must pass.
  - `docs/API.md` is unchanged (the HTTP/WS surface is identical).
  - Every commit message ends with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.

## File Structure

- `kiosk/src/backend/config/schema.ts`: `scan.nativeQuietDb`.
- `kiosk/src/backend/engine/ScannerEngine.ts`: `ScanConfig.nativeQuietDb`.
- `kiosk/src/backend/server.ts`: `toScanConfig` maps it.
- `kiosk/src/backend/engine/WidebandEngine.ts`: native mode, log forwarding, watchdogs.
- `kiosk/test/fakes/fake-wideband-helper.sh`: `noready` and `silent` modes.
- `kiosk/test/WidebandEngine.test.ts`: native-mode tests.
- `kiosk/test/schema.test.ts`: the knob parses.
- `kiosk/src/backend/index.ts`: `KERCHUNK_ENGINE=native` wiring and weather rate.
- `kiosk/package.json`: `build` includes `build:native:dist`.
- `CLAUDE.md`, `docs/DEPLOY.md`: native engine, dependencies, switch and rollback.

---

### Task 1: `scan.nativeQuietDb` knob through config → ScanConfig

**Files:** Modify `kiosk/src/backend/config/schema.ts`, `kiosk/src/backend/engine/ScannerEngine.ts`, `kiosk/src/backend/server.ts`; test `kiosk/test/schema.test.ts`.

**Interfaces (produces):** `config.scan.nativeQuietDb?: number` and `ScanConfig.nativeQuietDb?: number`.

- [ ] **Step 1: Failing test.** Append to `kiosk/test/schema.test.ts`. Match the file's existing import and fixture style; read its first 40 lines first and reuse its minimal-valid-config helper if there is one. The test must assert:
  - a config whose `scan` includes `nativeQuietDb: -6` parses and keeps `-6`
  - `nativeQuietDb: 3.5` also parses (the native scale may be positive)
  - a non-number (`"x"`) is rejected

Run: `cd /home/kiosk/kerchunk-kiosk/kiosk && npx vitest run test/schema.test.ts`. Expected: FAIL (the key is stripped or unknown).

- [ ] **Step 2: Implement.**

In `schema.ts`, right after the `scan` block's `noiseQuietDb` line (the one at about line 95, NOT the per-bank one at about line 181):

```ts
    // Quieting threshold for the NATIVE engine (KERCHUNK_ENGINE=native), on
    // kerchunk-dsp's own scale: dB of discriminator HF-noise power, lower =
    // more quieted; dead channels read ~-2, steady carriers ~-30. NOT the GR
    // scale of noiseQuietDb above (~90 dB apart) -- that value is never sent
    // to the native helper. Omitted = the helper's QUIET_DB_DEFAULT (-6).
    nativeQuietDb: z.number().optional(),
```

In `ScannerEngine.ts` `ScanConfig`, next to `noiseQuietDb?`:

```ts
  // Native engine only: quieting threshold on kerchunk-dsp's scale (see schema).
  nativeQuietDb?: number;
```

In `server.ts` `toScanConfig`, next to `noiseQuietDb: cfg.scan.noiseQuietDb,`:

```ts
    nativeQuietDb: cfg.scan.nativeQuietDb,
```

- [ ] **Step 3:** Run `npx vitest run test/schema.test.ts` and then `npm run typecheck`. Expected: pass, clean. Commit: `feat(config): scan.nativeQuietDb — native-scale quieting knob (never mixed with GR noiseQuietDb)`.

---

### Task 2: `WidebandEngine` native mode, log forwarding, watchdogs

**Files:** Modify `kiosk/src/backend/engine/WidebandEngine.ts`, `kiosk/test/fakes/fake-wideband-helper.sh`, `kiosk/test/WidebandEngine.test.ts`.

**Interfaces:**
- Consumes: `ScanConfig.nativeQuietDb` (Task 1).
- Produces: `WidebandEngineOptions.native?: boolean`, `readyTimeoutMs?: number`, `silenceTimeoutMs?: number`.

- [ ] **Step 1: Fake helper modes.** In `test/fakes/fake-wideband-helper.sh`, after the `nodevice` block and before `echo '{"ev":"ready"}'`, add:

```bash
if [ "${FAKE_WB_MODE:-}" = "noready" ]; then
  # Never says ready (native helper wedged before device/ALSA open).
  cat > /dev/null
  exit 0
fi
```

Right after the `echo '{"ev":"ready"}'` line, add:

```bash
if [ "${FAKE_WB_MODE:-}" = "silent" ]; then
  # Says ready, then emits nothing ever again (hung DSP thread).
  cat > /dev/null
  exit 0
fi
```

Also add both modes to the header comment's `FAKE_WB_MODE` list.

- [ ] **Step 2: Failing tests.** Append inside the top-level `describe("WidebandEngine", ...)` in `test/WidebandEngine.test.ts`. The file already has the `makeEngine`, `cfg`, `ch`, `tmpFile`, `lines` and `waitFor` helpers.

```ts
  describe("native mode", () => {
    it("never forwards the GR-scale noiseQuietDb; forwards nativeQuietDb; omits GR-only args", async () => {
      const args = tmpFile("args");
      const { engine } = makeEngine({ FAKE_WB_ARGS_FILE: args }, { native: true });
      await engine.start(cfg([VHF_A, VHF_B], { noiseQuietDb: -86, nativeQuietDb: -7.5, detectVia: "lane" }));
      await waitFor(() => lines(args).length >= 1, 1000);
      await engine.stop();
      const a = lines(args)[0] ?? "";
      expect(a).toContain("--quiet-db -7.5");
      expect(a).not.toContain("-86");
      expect(a).not.toContain("--detect-via");
      expect(a).not.toContain("--lanes");
      expect(a).not.toContain("--lane-modes");
    });

    it("omits --quiet-db entirely when nativeQuietDb is unset (helper default applies)", async () => {
      const args = tmpFile("args");
      const { engine } = makeEngine({ FAKE_WB_ARGS_FILE: args }, { native: true });
      await engine.start(cfg([VHF_A], { noiseQuietDb: -86 }));
      await waitFor(() => lines(args).length >= 1, 1000);
      await engine.stop();
      expect(lines(args)[0] ?? "").not.toContain("--quiet-db");
    });

    it("GR mode is unchanged: still forwards noiseQuietDb and lane args", async () => {
      const args = tmpFile("args");
      const { engine } = makeEngine({ FAKE_WB_ARGS_FILE: args });
      await engine.start(cfg([VHF_A], { noiseQuietDb: -86, nativeQuietDb: -7.5 }));
      await waitFor(() => lines(args).length >= 1, 1000);
      await engine.stop();
      const a = lines(args)[0] ?? "";
      expect(a).toContain("--quiet-db -86");
      expect(a).toContain("--lanes");
    });

    it("retune never respawns for a topology change (fixed 12 slots)", async () => {
      const args = tmpFile("args");
      const tunes = tmpFile("tunes");
      const { engine } = makeEngine({ FAKE_WB_ARGS_FILE: args, FAKE_WB_TUNES_FILE: tunes }, { native: true, groupDwellMs: 60_000 });
      await engine.start(cfg([VHF_A]));
      await waitFor(() => lines(tunes).length >= 1, 1000);
      // More channels + an AM lane: GR would need a bigger/different channelizer and respawn.
      const many = Array.from({ length: 10 }, (_, i) => ch(146_000_000 + i * 25_000, i === 3 ? { mode: "am" } : {}));
      await engine.retune(cfg(many));
      await waitFor(() => lines(tunes).length >= 2, 1000);
      await engine.stop();
      expect(lines(args)).toHaveLength(1);
      expect(lines(tunes).length).toBeGreaterThanOrEqual(2);
    });

    it("respawns when the helper never says ready (ready watchdog)", async () => {
      const args = tmpFile("args");
      const { engine } = makeEngine({ FAKE_WB_ARGS_FILE: args, FAKE_WB_MODE: "noready" }, { native: true, readyTimeoutMs: 200 });
      await engine.start(cfg([VHF_A]));
      const respawned = await waitFor(() => lines(args).length >= 2, 3000);
      await engine.stop();
      expect(respawned).toBe(true);
    });

    it("respawns when the helper goes silent after ready (silence watchdog)", async () => {
      const args = tmpFile("args");
      const logs: string[] = [];
      const { engine } = makeEngine({ FAKE_WB_ARGS_FILE: args, FAKE_WB_MODE: "silent" },
        { native: true, silenceTimeoutMs: 200, log: (m: string) => logs.push(m) });
      await engine.start(cfg([VHF_A]));
      const respawned = await waitFor(() => lines(args).length >= 2, 3000);
      await engine.stop();
      expect(respawned).toBe(true);
    });

    it("GR mode arms no watchdogs (a silent GR helper is left alone)", async () => {
      const args = tmpFile("args");
      const { engine } = makeEngine({ FAKE_WB_ARGS_FILE: args, FAKE_WB_MODE: "silent" }, { readyTimeoutMs: 100, silenceTimeoutMs: 100 });
      await engine.start(cfg([VHF_A]));
      await new Promise((r) => setTimeout(r, 600));
      await engine.stop();
      expect(lines(args)).toHaveLength(1);
    });
  });

  it("forwards helper log events, rate-limited (both engines)", async () => {
    const logs: string[] = [];
    const script = Array.from({ length: 15 }, (_, i) => `{"ev":"log","msg":"m${i}"}`).join("\n");
    const { engine } = makeEngine({ FAKE_WB_SCRIPT: script }, { log: (m: string) => logs.push(m), groupDwellMs: 60_000 });
    await engine.start(cfg([VHF_A]));
    await waitFor(() => logs.filter((l) => l.startsWith("[helper] m")).length >= 10, 2000);
    await new Promise((r) => setTimeout(r, 200));
    await engine.stop();
    const helperLines = logs.filter((l) => l.startsWith("[helper] m"));
    expect(helperLines).toHaveLength(10);                 // burst cap
    expect(helperLines[0]).toBe("[helper] m0");
  });
```

Run: `npx vitest run test/WidebandEngine.test.ts`. Expected: FAIL. `native`, `readyTimeoutMs` and `silenceTimeoutMs` are unknown options (typecheck/vitest), and log lines aren't forwarded yet.

- [ ] **Step 3: Implement** in `WidebandEngine.ts`.

(a) Options, added to `WidebandEngineOptions`:

```ts
  /** Spawn the native C++ helper (kerchunk-dsp, KERCHUNK_ENGINE=native)
   *  instead of the GNU Radio one. Native: fixed 12 lane slots (no lane-plan
   *  respawns), --quiet-db only from nativeQuietDb, liveness watchdogs. */
  native?: boolean;
  /** Native only: treat the helper as dead if it hasn't said "ready" this long
   *  after spawn (device/ALSA wedged before ready). Default 10 s. */
  readyTimeoutMs?: number;
  /** Native only: treat the helper as dead if it prints nothing for this long
   *  after "ready" (it emits power every 200 ms once tuned). Default 5 s. */
  silenceTimeoutMs?: number;
```

(b) Constants, next to `QUIT_GRACE_MS`:

```ts
// Helper log forwarding: at most HELPER_LOG_BURST lines per window, so a
// flapping condition can't flood the journal; the overflow is summarized.
const HELPER_LOG_BURST = 10;
const HELPER_LOG_WINDOW_MS = 60_000;
const DEFAULT_READY_TIMEOUT_MS = 10_000;
const DEFAULT_SILENCE_TIMEOUT_MS = 5_000;
```

(c) `defaultHelperCmd(native: boolean)`:

```ts
function defaultHelperCmd(native: boolean): string[] {
  if (native) return [fileURLToPath(new URL("./kerchunk-dsp", import.meta.url))];   // built by build:native:dist
  return ["/usr/bin/python3", fileURLToPath(new URL("./wideband_helper.py", import.meta.url))];
}
```

Update the comment above it to mention both. In the constructor use `this.helperCmd = opts.helperCmd ?? defaultHelperCmd(this.native);`, having first set `this.native = opts.native ?? false;`, `this.readyTimeoutMs = opts.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;` and `this.silenceTimeoutMs = opts.silenceTimeoutMs ?? DEFAULT_SILENCE_TIMEOUT_MS;`. Declare these as `private readonly` fields next to the other options.

(d) `helperArgs()`:
- `--detect-via` only when `!this.native`.
- Quieting:

```ts
    // Quieting squelch threshold. Native (decision C, 2026-09-25): kerchunk-dsp
    // has its own dB scale (~90 dB from GR's), so it gets ONLY nativeQuietDb --
    // never the GR-scale noiseQuietDb, which would stop anything from opening.
    if (this.native) {
      if (cfg.nativeQuietDb !== undefined) args.push("--quiet-db", String(cfg.nativeQuietDb));
    } else if (cfg.noiseQuietDb !== undefined) {
      args.push("--quiet-db", String(cfg.noiseQuietDb));
    }
```

  This replaces the existing `if (cfg.noiseQuietDb !== undefined) ...` line.
- Lane plan: keep computing `plan` and `this.spawnedPlan = plan`, but push `...lanePlanArgs(plan)` only when `!this.native` (native has fixed 12 slots and ignores them).

(e) `retune()`: replace the respawn condition with:

```ts
    // GR sizes its channelizer at spawn, so a new topology needs a respawn.
    // Native has fixed 12 slots: only an emptied channel set (release the SDR)
    // takes the full start() path.
    const mustRespawn = this.native
      ? newGroups.length === 0
      : !this.spawnedPlan || !planFits(this.spawnedPlan, newGroups, MAX_CHANNELS_PER_GROUP);
    if (mustRespawn) return this.start(config);
```

  First read `planFits` in `lanePlan.ts` to confirm how it treats empty groups for GR, and keep GR's behaviour identical.

(f) Log forwarding: add fields `private logWindowStart = 0; private logCount = 0; private logSuppressed = 0;` and:

```ts
  private forwardHelperLog(msg: string): void {
    const t = this.now();
    if (t - this.logWindowStart >= HELPER_LOG_WINDOW_MS) {
      if (this.logSuppressed > 0) this.log(`[helper] ${this.logSuppressed} more log lines suppressed`);
      this.logWindowStart = t;
      this.logCount = 0;
      this.logSuppressed = 0;
    }
    if (this.logCount < HELPER_LOG_BURST) {
      this.logCount++;
      this.log(`[helper] ${msg}`);
    } else {
      this.logSuppressed++;
    }
  }
```

  In `handleHelperEvent`, add `case "log": if (typeof ev.msg === "string") this.forwardHelperLog(ev.msg); break;` and change the `default:` comment to `// tuned is informational`.

(g) Watchdogs, native only. Fields: `private readyTimer: NodeJS.Timeout | null = null; private silenceTimer: NodeJS.Timeout | null = null;`. Helpers:

```ts
  private clearWatchdogs(): void {
    if (this.readyTimer) { clearTimeout(this.readyTimer); this.readyTimer = null; }
    if (this.silenceTimer) { clearTimeout(this.silenceTimer); this.silenceTimer = null; }
  }

  // A wedged native helper (ALSA/USB stuck before "ready", or a hung DSP
  // thread afterwards) stays alive and silent -- no exit, so the normal
  // escalation never fires. These timers turn that into an exit.
  private watchdogFire(child: ChildProcess, why: string): void {
    if (this.child !== child || this.stopping) return;
    this.lastStderrLine = why;
    this.handleUnexpectedExit(null);
  }

  private armSilence(child: ChildProcess): void {
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    this.silenceTimer = setTimeout(
      () => this.watchdogFire(child, `helper silent for ${this.silenceTimeoutMs} ms`), this.silenceTimeoutMs);
  }
```

  Wiring:
  - In `spawnHelper()`, right after `this.child = child;`, add `if (this.native) this.readyTimer = setTimeout(() => this.watchdogFire(child, `no "ready" within ${this.readyTimeoutMs} ms`), this.readyTimeoutMs);`.
  - In the stdout `line` handler, after the stale-child guard, add `if (this.native && this.silenceTimer) this.armSilence(child);` so every line re-arms it.
  - In `handleHelperEvent` `case "ready":`, before `sendTune()`, add `if (this.native) { if (this.readyTimer) { clearTimeout(this.readyTimer); this.readyTimer = null; } if (this.child) this.armSilence(this.child); }`.
  - Call `this.clearWatchdogs()` at the top of `killChild()`.

  `handleUnexpectedExit` calls `killChild` (quit plus the 500 ms SIGKILL), emits status or error, and applies backoff. That is exactly the respawn path wanted.

- [ ] **Step 4: Run tests and typecheck.** Run `npx vitest run test/WidebandEngine.test.ts`, then `npm test` and `npm run typecheck`. Expected: all pass and clean. If an existing GR test breaks, the GR path changed: fix the code, not the test. Commit: `feat(engine): WidebandEngine native mode — kerchunk-dsp helper, native quieting knob, no lane-plan respawns, liveness watchdogs; forward helper log events`.

---

### Task 3: `KERCHUNK_ENGINE=native` wiring, weather rate, build, docs

**Files:** Modify `kiosk/src/backend/index.ts`, `kiosk/package.json`, `CLAUDE.md`, `docs/DEPLOY.md`.

- [ ] **Step 1: `index.ts`.**
  - Update the engine-selection comment: `KERCHUNK_ENGINE=wideband|native|rtlfm|fake`. `native` = kerchunk-dsp (C++), the GR replacement under A/B.
  - Add `const nativeEngine = engineKind === "native";` and a `const widebandFamily = engineKind === "wideband" || nativeEngine;`.
  - Scanner: `: widebandFamily ? new WidebandEngine({ ...(nativeEngine ? { native: true } : {}), ...deviceOpts(scanRadio), ...restartBackoffOpts, ...maxHold })`.
  - Weather: `const WEATHER_RATE_HZ = nativeEngine ? 250_000 : 240_000;`, with a comment that native lanes need a multiple of 50 kHz and GR's quad rate a multiple of 48 kHz. `WEATHER_CENTER_OFFSET_HZ` stays 60 000, which is inside native's ±100 kHz lane limit at 250 kHz. The weather engine condition becomes `widebandFamily && weatherRadio && config.weatherChannel`, and its options gain `...(nativeEngine ? { native: true } : {})`.
  - The `windowBandwidthHz: WEATHER_RATE_HZ` in `startWeatherLane` already follows the constant.
  - Grep `src/backend` for other `engineKind === "wideband"` or `"wideband"` checks, and treat `native` the same wherever the check means "the multi-channel helper engine" (for example system health or helper pid). List each one in the report.

- [ ] **Step 2: Build.** In `kiosk/package.json` `scripts`:
  - `"build": "npm run build:frontend && npm run build:backend && npm run build:native:dist",`
  - Add `"build:native:dist": "npm run build:native && cp native/build/kerchunk-dsp dist/backend/engine/",`
  - Leave `build:backend` unchanged (CI's JS job runs it without cmake).

- [ ] **Step 3: Docs.**
  - **`CLAUDE.md`, Architecture notes, engine abstraction.** Four implementations now: `WidebandEngine` in GR mode (default) or native mode (`KERCHUNK_ENGINE=native`, `kerchunk-dsp`), plus `RtlFmEngine` and `FakeEngine`. Native mode differs in three ways: fixed 12 slots with no lane-plan respawns; `--quiet-db` taken only from `scan.nativeQuietDb` (native scale, default −6, never GR's `noiseQuietDb`); and liveness watchdogs.
  - **`CLAUDE.md`, Commands.** Add `npm run test:native`, and note that `npm run build` now builds the native binary. On the appliance that is a cmake/C++ compile at `--parallel 2`: a thermal cost like any build.
  - **`CLAUDE.md`, Other/env.** `KERCHUNK_ENGINE=wideband|native|rtlfm|fake`.
  - **`docs/DEPLOY.md`, new section "Native engine (kerchunk-dsp)":**
    - apt deps: `cmake libfftw3-dev nlohmann-json3-dev libasound2-dev librtlsdr-dev`
    - `npm run build` builds and copies the binary
    - **switch:** `sudo systemctl edit kerchunk-kiosk` → `[Service]` `Environment=KERCHUNK_ENGINE=native`, then `sudo systemctl restart kerchunk-kiosk`
    - **rollback:** remove the drop-in (or set `wideband`) and restart
    - **before switching, snapshot the per-channel trims**, because each engine persists levels the other loads: `sudo cp /var/lib/kerchunk-kiosk/config.json /var/lib/kerchunk-kiosk/config.pre-native.json` with `kerchunk-kiosk` stopped, per the hand-edit rule
    - the weather radio runs at 250 kHz under native
    - `scan.nativeQuietDb` is the tuning knob

- [ ] **Step 4: Verify (no deploy, no restart).**
  - Run `npm run typecheck`, `npm test` and `npm run build`. The full build now includes native.
  - Confirm `ls -l dist/backend/engine/kerchunk-dsp` exists and `dist/backend/engine/kerchunk-dsp --bogus; echo $?` prints 2.
  - Do NOT restart `kerchunk-kiosk` or run the live path.
  - The `dist/` change is harmless while the service runs the GR helper: the running process has already loaded its code, and `dist/` is only read at startup.
  - Commit: `feat(engine): KERCHUNK_ENGINE=native — both radios on kerchunk-dsp (weather 250 kHz); build ships the binary; docs`.

---

## After P2 (not in this plan)

**P3: the operator's A/B.**
1. Snapshot the config.
2. Deploy and switch with a systemd drop-in to `KERCHUNK_ENGINE=native`.
3. Re-time SIGTERM exit on hardware (<500 ms).
4. Listen by ear against the checklist in `RESULTS-2026-09-25-native-p1b.md` (squelch and mute tail, leveler, AM/airband, SAME, Close Call sensitivity).
5. Measure temperature and CPU over hours, and run `sudo perf stat` on the 38 % vs 15 % question.
6. Tune `scan.nativeQuietDb` as needed.
7. Rollback is one env var.

**P4: remove the GR path** once the operator signs off.
