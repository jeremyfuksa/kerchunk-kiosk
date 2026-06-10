# Idle Feature-Tap Gating Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the wideband helper from running two always-on feature taps when their features are inactive — the PCM streaming tee (remote listening) and the SAME/`multimon-ng` decoder — so neither costs idle CPU on a box that isn't using it.

**Architecture:** Two independent gates. (A) The PCM tee is already conditional in the helper (`if args.audio_fd >= 0`); we just stop `WidebandEngine` from always asking for it, behind a new opt-in `audio.remoteListening` flag — pure TypeScript, no flowgraph change. (B) The SAME decoder spawn + last-lane tap become gated on a *derived* `sameEnable` signal (true exactly when this helper carries NWR), which `toScanConfig` already has the information to compute — a small `wideband_helper.py` change, proven on the kiosk.

**Tech Stack:** TypeScript (ESM `.js` imports, strict + `noUncheckedIndexedAccess`), vitest + supertest; Python 3 + GNU Radio (`wideband_helper.py`, system python). All commands run from `kiosk/`.

---

## CRITICAL: two phases, do not blur them

- **Phase 1 (Tasks 1–6): off-server.** The `audio.remoteListening` gate (needs no helper code — the tee is already conditional on `--audio-fd`) plus the *derivation* of `ScanConfig.sameEnable` (pure data, not yet sent to the helper). Fully buildable and unit-testable here; ships as its own PR with a real CPU win and zero DSP-correctness risk.
- **Phase 2 (Tasks 7–8): hardware-gated.** The `wideband_helper.py` `--same-enable` acceptance + gating, AND `helperArgs()` starting to pass `--same-enable`. These land **together** (argparse rejects unknown args — see the lane-fit lesson) and the correctness (SAME still decodes when NWR is carried, decoder absent otherwise) is a signal-processing property `FakeEngine`/vitest CANNOT assert. **Build on the kiosk, prove against real signals, then PR.**

Spec: [`docs/superpowers/specs/2026-06-09-feature-tap-gating-design.md`](../specs/2026-06-09-feature-tap-gating-design.md).

## Background the engineer needs

- **Read [`CLAUDE.md`](../../../CLAUDE.md).** ESM `.js` import extensions even from `.ts`; `tsconfig` is `strict` + `noUncheckedIndexedAccess` (indexed access is `T | undefined`); `npm run build` (not bare `tsc`) — `build:backend` also copies `wideband_helper.py` into `dist/`; GNU Radio needs `/usr/bin/python3`.
- **Every change ships through a PR off `main`.** Phase 1 is one PR; Phase 2 is a second PR, built and proven on the kiosk first.
- **The `detectVia` feature is the exact precedent** for this whole shape — a `scan.*`/`audio.*` config field → a `ScanConfig` field → a `helperArgs()` arg. Read [`test/detectVia.test.ts`](../../../kiosk/test/detectVia.test.ts); the new tests mirror it closely (schema default, `helperArgs()` presence via the `argsFor` helper, `toScanConfig` passthrough).
- **Key files & line anchors (verify before editing — line numbers drift):**
  - [`src/backend/config/schema.ts`](../../../kiosk/src/backend/config/schema.ts): `audio` object at ~`100`, `defaultConfig()` audio literal at ~`259`.
  - [`src/backend/engine/ScannerEngine.ts`](../../../kiosk/src/backend/engine/ScannerEngine.ts): `interface ScanConfig` at `16`, `detectVia?` at `46`.
  - [`src/backend/server.ts`](../../../kiosk/src/backend/server.ts): `toScanConfig` at `50` (NWR injection at ~`79`, return object at ~`87`); `GET /api/stream.wav` at ~`832`; `PUT /api/config` restart-on-change at ~`639`.
  - [`src/backend/engine/WidebandEngine.ts`](../../../kiosk/src/backend/engine/WidebandEngine.ts): `helperArgs()` at `288` (`--audio-fd "3"` hardcoded at `293`, `--close-call` gate at `309`).
  - [`src/backend/index.ts`](../../../kiosk/src/backend/index.ts): dedicated weather engine `start({...})` inline `ScanConfig` at ~`98`.
  - [`src/backend/engine/wideband_helper.py`](../../../kiosk/src/backend/engine/wideband_helper.py): PCM tee at ~`425`; SAME spawn at ~`440`; the chain loop assigns `same_fd` to the last lane at ~`473`; `argparse` block at ~`886` (`--audio-fd` already exists at ~`939`).
  - [`src/frontend/admin/admin.ts`](../../../kiosk/src/frontend/admin/admin.ts): audio controls HTML at ~`117`, `streamBtn` wiring at ~`1478`, `syncAudioControls` + audio listeners at ~`1527`.
  - [`src/frontend/lib/api.ts`](../../../kiosk/src/frontend/lib/api.ts): `getConfig`/`putConfig` at ~`18`.

## File structure

- **Modify** `src/backend/config/schema.ts` — add `audio.remoteListening` (default false); add it to the `defaultConfig()` literal.
- **Modify** `src/backend/engine/ScannerEngine.ts` — add `remoteListening?` and `sameEnable?` to `ScanConfig`.
- **Modify** `src/backend/server.ts` — `toScanConfig` emits `remoteListening` + derives `sameEnable`; `GET /api/stream.wav` 404s when remote listening is off.
- **Modify** `src/backend/engine/WidebandEngine.ts` — `helperArgs()` gates `--audio-fd` on `remoteListening` (Phase 1) and adds `--same-enable` on `sameEnable` (Phase 2).
- **Modify** `src/backend/index.ts` — the weather engine's inline `ScanConfig` sets `sameEnable: true` (Phase 2).
- **Modify** `src/backend/engine/wideband_helper.py` — `--same-enable` arg gates the `multimon-ng` spawn + the last-lane tap (Phase 2).
- **Modify** `src/frontend/admin/admin.ts` — a "Remote listening" toggle (whole-config PUT) + disable `streamBtn` when off.
- **Tests** — extend `test/detectVia.test.ts` (helperArgs + toScanConfig + schema) and `test/api.test.ts` (stream.wav 404). A new `test/featureTapGating.test.ts` is also acceptable if you prefer isolation; this plan extends the existing files to stay close to the precedent.

---

## PHASE 1 — off-server (ships as its own PR)

> **Before Task 1:** branch off `main` —
> `cd /home/kiosk/kerchunk-kiosk && git checkout main && git pull && git checkout -b feat/feature-tap-gating-phase1`.
> Tasks 1–5 commit to this branch; Task 6 pushes it and opens the PR.

## Task 1: Schema flag + `ScanConfig` fields

**Files:**
- Modify: `kiosk/src/backend/config/schema.ts`
- Modify: `kiosk/src/backend/engine/ScannerEngine.ts`
- Test: `kiosk/test/detectVia.test.ts`

- [ ] **Step 1: Write the failing schema test**

Append to `kiosk/test/detectVia.test.ts`:

```ts
import { defaultConfig } from "../src/backend/config/schema.js";

describe("audio.remoteListening", () => {
  it("defaults to false and is parseable as a boolean", () => {
    const base = { sink: "default", volume: 70, muted: false };
    expect(configSchema.shape.audio.parse({ ...base }).remoteListening).toBe(false);
    expect(configSchema.shape.audio.parse({ ...base, remoteListening: true }).remoteListening).toBe(true);
  });
  it("is present and false in defaultConfig()", () => {
    expect(defaultConfig().audio.remoteListening).toBe(false);
  });
});
```

(`configSchema` is already imported at the top of `detectVia.test.ts`; add `defaultConfig` to that existing import line rather than a duplicate import if your linter prefers — both compile.)

- [ ] **Step 2: Run to verify it fails**

Run: `cd kiosk && npx vitest run test/detectVia.test.ts -t "audio.remoteListening"`
Expected: FAIL — `remoteListening` is `undefined`.

- [ ] **Step 3: Add the schema field**

In `schema.ts`, inside the `audio: z.object({ ... })` block, immediately after `muted: z.boolean(),`:

```ts
    // Remote listening (/api/stream.wav, ROADMAP stretch): when OFF (default)
    // the helper builds no PCM tee — the post-limiter float->s16 conversion and
    // fd-write are skipped, saving idle CPU on every box. Opt-in because the
    // feed is rarely listened to. Toggling it respawns the helper (the tee is a
    // flowgraph block, built at spawn).
    remoteListening: z.boolean().default(false),
```

In the same file, add it to the `defaultConfig()` audio literal:

```ts
    audio: { sink: "hdmi:CARD=vc4hdmi0", volume: 70, muted: false, remoteListening: false },
```

- [ ] **Step 4: Add the `ScanConfig` fields**

In `ScannerEngine.ts`, inside `interface ScanConfig`, after the `detectVia?` line:

```ts
  // Remote listening: when true the wideband helper builds the PCM streaming
  // tee (--audio-fd) that /api/stream.wav drains. Off => no tee, no idle cost.
  remoteListening?: boolean;
  // SAME decode wanted on THIS helper: true exactly when it carries NWR
  // (derived in toScanConfig / set by the dedicated weather engine). Gates the
  // multimon-ng spawn + the last-lane decoder tap (used by helperArgs in P2).
  sameEnable?: boolean;
```

- [ ] **Step 5: Run to verify pass**

Run: `cd kiosk && npx vitest run test/detectVia.test.ts -t "audio.remoteListening"`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
cd kiosk
git add src/backend/config/schema.ts src/backend/engine/ScannerEngine.ts test/detectVia.test.ts
git commit -m "feat(config): audio.remoteListening flag + ScanConfig tap-gate fields"
```

---

## Task 2: `toScanConfig` — pass `remoteListening`, derive `sameEnable`

**Files:**
- Modify: `kiosk/src/backend/server.ts`
- Test: `kiosk/test/detectVia.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `kiosk/test/detectVia.test.ts`:

```ts
describe("toScanConfig feature-tap gates", () => {
  it("passes audio.remoteListening through to ScanConfig.remoteListening", () => {
    const cfg = defaultConfig();
    expect(toScanConfig(cfg, "scan").remoteListening).toBe(false);
    cfg.audio.remoteListening = true;
    expect(toScanConfig(cfg, "scan").remoteListening).toBe(true);
  });

  it("sameEnable is false with no weather channel", () => {
    expect(toScanConfig(defaultConfig(), "scan").sameEnable).toBe(false);
  });

  it("sameEnable is true when the main scan carries NWR (no dedicated radio)", () => {
    const cfg = defaultConfig();
    cfg.weatherChannel = { id: "wx", freq: 162_550_000, alphaTag: "NWR", mode: "nfm", enabled: true };
    // No radios[] => NWR is injected into the main scan (visiting-slot tier).
    expect(toScanConfig(cfg, "scan").sameEnable).toBe(true);
  });

  it("sameEnable is false on the main scan when a dedicated weather radio exists", () => {
    const cfg = defaultConfig();
    cfg.weatherChannel = { id: "wx", freq: 162_550_000, alphaTag: "NWR", mode: "nfm", enabled: true };
    cfg.radios = [
      { serial: "KIOSK01", role: "scan" },
      { serial: "KIOSK03", role: "weather" },
    ];
    // Dedicated radio owns SAME => NWR is NOT injected into the main scan.
    expect(toScanConfig(cfg, "scan").sameEnable).toBe(false);
  });

  it("sameEnable is true in weather mode (listening to NWR)", () => {
    const cfg = defaultConfig();
    cfg.weatherChannel = { id: "wx", freq: 162_550_000, alphaTag: "NWR", mode: "nfm", enabled: true };
    expect(toScanConfig(cfg, "weather").sameEnable).toBe(true);
  });
});
```

(The `radios[]` element shape is `{ serial?, port?, role: "scan"|"weather"|"adsb", label? }` with a refine requiring `serial` or `port` — no `id` field. `defaultConfig()` has no `radios`, so assigning the array is what flips the dedicated-radio branch; the test only needs the `role: "weather"` entry to exist.)

- [ ] **Step 2: Run to verify it fails**

Run: `cd kiosk && npx vitest run test/detectVia.test.ts -t "feature-tap gates"`
Expected: FAIL — `remoteListening`/`sameEnable` are `undefined`.

- [ ] **Step 3: Implement in `toScanConfig`**

In `server.ts`, in the object returned by `toScanConfig` (the `return { channels, ... }`), add these two fields (next to `closeCall: cfg.scan.closeCall,`):

```ts
    // PCM tee gate: the helper builds --audio-fd only when remote listening is on.
    remoteListening: cfg.audio.remoteListening,
    // SAME gate: decode only on a helper that actually carries NWR. toScanConfig
    // injects the wx_same background channel into the main scan only when there
    // is no dedicated weather radio (above); weather/monitor modes set channels
    // to the weather channel directly. So "this helper's channels include the
    // weather frequency" is exactly "this helper demodulates NWR".
    sameEnable: !!cfg.weatherChannel
      && channels.some((c) => c.freq === cfg.weatherChannel!.freq),
```

- [ ] **Step 4: Run to verify pass**

Run: `cd kiosk && npx vitest run test/detectVia.test.ts -t "feature-tap gates"`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
cd kiosk
git add src/backend/server.ts test/detectVia.test.ts
git commit -m "feat(engine): toScanConfig emits remoteListening + derives sameEnable"
```

---

## Task 3: `helperArgs()` gates `--audio-fd` on `remoteListening`

**Files:**
- Modify: `kiosk/src/backend/engine/WidebandEngine.ts`
- Test: `kiosk/test/detectVia.test.ts`

- [ ] **Step 1: Write the failing test**

Append to the `describe("WidebandEngine --detect-via", ...)` block in `detectVia.test.ts` (it already has the `argsFor(cfg)` helper and `base`):

```ts
  it("includes --audio-fd only when remoteListening is true", () => {
    expect(argsFor(base)).not.toContain("--audio-fd");                       // absent -> off
    expect(argsFor({ ...base, remoteListening: false })).not.toContain("--audio-fd");
    const on = argsFor({ ...base, remoteListening: true });
    expect(on).toContain("--audio-fd");
    expect(on[on.indexOf("--audio-fd") + 1]).toBe("3");
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd kiosk && npx vitest run test/detectVia.test.ts -t "audio-fd"`
Expected: FAIL — `--audio-fd` is currently always present (hardcoded).

- [ ] **Step 3: Implement**

In `WidebandEngine.ts` `helperArgs()`, **remove** the hardcoded line in the initial `args` array:

```ts
      "--audio-fd", "3",
```

Then, after the array is built (alongside the other conditional `args.push(...)` calls, e.g. near the `--close-call` push), add:

```ts
    // Remote-listening PCM tee: only ask the helper to build it when the
    // feature is on. Off => the helper's --audio-fd default (-1) builds no tee,
    // skipping the continuous float->s16 + fd-write. A change respawns the
    // helper (toScanConfig diff), so the tee appears/disappears in lockstep.
    if (cfg.remoteListening) args.push("--audio-fd", "3");
```

- [ ] **Step 4: Run to verify pass**

Run: `cd kiosk && npx vitest run test/detectVia.test.ts`
Expected: PASS (all, including the existing `--detect-via`/`--close-call`/serial/rate tests).

- [ ] **Step 5: Commit**

```bash
cd kiosk
git add src/backend/engine/WidebandEngine.ts test/detectVia.test.ts
git commit -m "feat(engine): build the PCM tee only when remoteListening is on"
```

---

## Task 4: `GET /api/stream.wav` 404s when remote listening is off

**Files:**
- Modify: `kiosk/src/backend/server.ts`
- Test: `kiosk/test/api.test.ts`

- [ ] **Step 1: Write the failing tests**

Append inside the `describe("HTTP API", ...)` block in `api.test.ts`:

```ts
  it("GET /api/stream.wav 404s 'remote listening disabled' by default", async () => {
    const { server } = makeApp();
    const res = await request(server).get("/api/stream.wav");
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("remote listening disabled");
  });

  it("GET /api/stream.wav passes the flag gate once enabled", async () => {
    const { server } = makeApp();
    const cfg = (await request(server).get("/api/config")).body;
    await request(server).put("/api/config").send({ ...cfg, audio: { ...cfg.audio, remoteListening: true } });
    const res = await request(server).get("/api/stream.wav");
    // FakeEngine has no onAudio tee, so the route now falls through to the
    // engine-capability 404 — proving the remote-listening gate was passed.
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("engine has no audio tee");
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd kiosk && npx vitest run test/api.test.ts -t "stream.wav"`
Expected: FAIL — today the route returns the `"engine has no audio tee"` 404 in both cases (no flag check yet).

- [ ] **Step 3: Implement**

In `server.ts`, at the top of the `GET /api/stream.wav` handler (before `const onAudio = ...`):

```ts
      if (!config.audio.remoteListening) {
        return json(res, 404, { error: "remote listening disabled" });
      }
```

- [ ] **Step 4: Run to verify pass**

Run: `cd kiosk && npx vitest run test/api.test.ts -t "stream.wav"`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
cd kiosk
git add src/backend/server.ts test/api.test.ts
git commit -m "feat(api): /api/stream.wav 404s when remote listening is disabled"
```

---

## Task 5: Admin "Remote listening" toggle + `streamBtn` guard

**Files:**
- Modify: `kiosk/src/frontend/admin/admin.ts`

No unit test (DOM wiring; the repo verifies admin interactively). Verify by build + the manual check in Step 4.

- [ ] **Step 1: Add the checkbox to the audio controls HTML**

In `admin.ts`, in the `audioControls` group (right after the Mute `<label>` at ~line 120):

```ts
            <label class="checkLabel"><input id="remoteListen" type="checkbox" /> Remote listening</label>
```

- [ ] **Step 2: Wire it (whole-config PUT) and gate `streamBtn`**

Near the existing audio wiring (the `syncAudioControls` function + `mute`/`vol` listeners at ~line 1527), grab the element and extend the sync + add the listener:

```ts
  const remoteListen = root.querySelector<HTMLInputElement>("#remoteListen")!;
  const streamBtnEl = root.querySelector<HTMLButtonElement>("#streamBtn")!;

  function syncRemoteListening(on: boolean): void {
    if (document.activeElement !== remoteListen) remoteListen.checked = on;
    // The in-browser "Listen here" button streams /api/stream.wav, which 404s
    // when remote listening is off — disable it so it never silently fails.
    streamBtnEl.disabled = !on;
    streamBtnEl.title = on
      ? "Listen to the live speaker feed in this browser"
      : "Enable remote listening to stream the feed";
  }

  remoteListen.addEventListener("change", async () => {
    const cfg = await api.getConfig();
    await api.putConfig({ ...cfg, audio: { ...cfg.audio, remoteListening: remoteListen.checked } });
    syncRemoteListening(remoteListen.checked);
  });
```

Then extend the existing `syncAudioControls(cfg)` body (which already reads `cfg.audio`) to also call `syncRemoteListening(cfg.audio.remoteListening ?? false);`, and widen its parameter type to include `remoteListening?: boolean` on `cfg.audio`. The initial `api.getConfig().then(syncAudioControls)` call (~line 1531) then primes the toggle + button state on load.

- [ ] **Step 3: Build**

Run: `cd kiosk && npm run build`
Expected: succeeds (frontend + backend compile).

- [ ] **Step 4: Manual verification (dev server)**

```sh
cd kiosk && USE_FAKE_ENGINE=1 KERCHUNK_CONFIG=/tmp/kc.json npm run dev:backend
```
In another shell run `npm run dev:frontend`, open the admin, and confirm: the "Remote listening" checkbox starts unchecked; "Listen here" is disabled; checking the box persists (reload keeps it checked) and enables "Listen here"; `curl -s localhost:8080/api/stream.wav` returns the `"remote listening disabled"` 404 when off and streams when on.

- [ ] **Step 5: Commit**

```bash
cd kiosk
git add src/frontend/admin/admin.ts
git commit -m "feat(admin): remote-listening toggle; disable Listen-here when off"
```

---

## Task 6: Phase 1 verification + PR

**Files:** none.

- [ ] **Step 1: Full suite + build**

```sh
cd kiosk && npm test && npm run build
```
Expected: all tests green; build succeeds.

- [ ] **Step 2: Open the Phase 1 PR**

```bash
cd /home/kiosk/kerchunk-kiosk
git push -u origin feat/feature-tap-gating-phase1
gh pr create --base main --title "feat: gate the PCM streaming tee behind audio.remoteListening (DSP-efficiency item #3, phase 1)" --body "Part A of the idle feature-tap gating spec. Remote listening is now opt-in (audio.remoteListening, default off); the helper builds no PCM tee when it's off — skipping the continuous float->s16 + fd-write on every box. Also derives ScanConfig.sameEnable (unused until phase 2). Pure TS, fully unit-tested. Spec: docs/superpowers/specs/2026-06-09-feature-tap-gating-design.md"
```

> **Phase 1 is independently shippable.** It changes no DSP/flowgraph code (the tee was already conditional on `--audio-fd`), so there is no hardware-correctness risk; the CPU drop is a measurement, confirmed on the kiosk after merge.

---

## PHASE 2 — hardware-gated (build + prove on the kiosk, then its own PR)

> **Before Task 7:** after Phase 1 merges, branch off the updated `main` ON THE KIOSK —
> `cd /home/kiosk/kerchunk-kiosk && git checkout main && git pull && git checkout -b feat/feature-tap-gating-phase2`.
> Tasks 7–8 commit to this branch; build and prove on the kiosk before the PR.

## Task 7: Helper `--same-enable` gate + `helperArgs()` passes it (land together)

**Files:**
- Modify: `kiosk/src/backend/engine/wideband_helper.py`
- Modify: `kiosk/src/backend/engine/WidebandEngine.ts`
- Modify: `kiosk/src/backend/index.ts`
- Test: `kiosk/test/detectVia.test.ts`

> **Why together:** `argparse` rejects unknown args, so the moment `helperArgs()` emits `--same-enable`, the helper must already accept it — otherwise the running helper crashes on spawn (the exact lane-fit Phase-boundary lesson).

- [ ] **Step 1: Add the helper arg** to the `argparse` block (~line 886, near the existing `--audio-fd`):

```python
    ap.add_argument("--same-enable", action="store_true",
                    help="spawn the SAME/multimon-ng decoder and tap it onto the "
                         "last lane; off => no decoder process and no tap")
```

- [ ] **Step 2: Gate the `multimon-ng` spawn** on the flag. Wrap the existing spawn block (~line 438–451) so it only runs when enabled:

```python
        self.same_proc = None
        same_fd = None
        if args.same_enable and shutil.which("multimon-ng"):
            rfd, wfd = os.pipe()
            os.set_inheritable(rfd, True)
            self.same_proc = subprocess.Popen(
                ["multimon-ng", "-t", "raw", "-a", "EAS", "-"],
                stdin=rfd, stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL, close_fds=False, text=True)
            os.close(rfd)
            same_fd = wfd
            threading.Thread(target=self._same_reader, daemon=True).start()
        elif args.same_enable:
            emit({"ev": "log", "msg": "multimon-ng not found: SAME decoding disabled"})
```

(When `--same-enable` is absent, `same_fd` stays `None`, so the chain loop at ~line 473 passes `same_fd=None` to the last lane and builds no decoder tap — no further change needed there. Confirm the last-lane assignment is the only consumer of `same_fd`.)

- [ ] **Step 3: Emit `--same-enable` from `helperArgs()`**

In `WidebandEngine.ts` `helperArgs()`, alongside the other conditional pushes:

```ts
    // SAME decoder: spawn it only on a helper that carries NWR (derived in
    // toScanConfig; set true on the dedicated weather engine). Off => no
    // multimon-ng process and no last-lane tap.
    if (cfg.sameEnable) args.push("--same-enable");
```

- [ ] **Step 4: Set `sameEnable: true` on the dedicated weather engine**

In `index.ts`, in the weather engine's `start({ ... })` inline `ScanConfig` (~line 98–113), add:

```ts
      sameEnable: true,
```

(The weather engine is the always-on NWR decoder; it builds its config inline, not via `toScanConfig`, so it sets the flag explicitly. It also leaves `remoteListening` unset → no PCM tee on the null-sink weather helper, a free bonus.)

- [ ] **Step 5: Add the off-server `helperArgs()` test**

Append to the `describe("WidebandEngine --detect-via", ...)` block in `detectVia.test.ts`:

```ts
  it("includes --same-enable only when sameEnable is true", () => {
    expect(argsFor(base)).not.toContain("--same-enable");
    expect(argsFor({ ...base, sameEnable: false })).not.toContain("--same-enable");
    expect(argsFor({ ...base, sameEnable: true })).toContain("--same-enable");
  });
```

- [ ] **Step 6: Off-server checks**

Run: `cd kiosk && npx vitest run test/detectVia.test.ts && npm run build`
Expected: PASS; build succeeds (it copies the edited `wideband_helper.py` into `dist/`).

- [ ] **Step 7: Build + prove ON THE KIOSK**

```sh
cd kiosk && npm run build && sudo systemctl restart kerchunk-kiosk
```
Then verify against real signals — this is the hardware gate:
  - **SAME still decodes in the operator's real config** (no dedicated weather antenna today → visiting-slot tier): the main helper carries NWR (`wx_same` injected), so `--same-enable` is passed, `multimon-ng` runs, and the next KEAX weekly test still lands in the alert feed (or force a known SAME source). **A wrong gate silently kills weather alerts — this check is mandatory.**
  - **No weather channel → no decoder:** temporarily clear `weatherChannel` (or test a config without it), restart, and confirm `multimon-ng` is NOT in the process tree (`pgrep -a multimon-ng` empty) and the helper still scans normally.
  - **CPU:** confirm the helper's host-health "N / M cores" does not regress; the PCM-tee/SAME idle cost is gone on a no-weather, remote-listening-off config.
  - No audible regression on any active channel; group-hop still just retunes.

- [ ] **Step 8: Commit (on the kiosk, only after SAME is proven)**

```bash
cd kiosk
git add src/backend/engine/wideband_helper.py src/backend/engine/WidebandEngine.ts \
        src/backend/index.ts test/detectVia.test.ts
git commit -m "feat(dsp): spawn the SAME decoder only on a helper that carries NWR"
```

---

## Task 8: Phase 2 PR + roadmap bookkeeping

**Files:**
- Modify: `docs/ROADMAP.md`

- [ ] **Step 1: Update the DSP-efficiency hardening backlog** in `ROADMAP.md` (the "Hardening backlog — DSP efficiency" list, ~line 961). Mark item #2 **subsumed by lane-fit** (the weather helper is now a 1-lane FM pipeline — no separate `--role weather` branch), and item #3 **done** by this work (FFT already gated by lane-fit; PCM tee now opt-in; SAME decoder gated to NWR-carrying helpers). Add a watch-item recording the `art.ts` idle-suspend regression (`requestAnimationFrame` at ~`art.ts:89` with no idle-suspend) to be fixed if/when "Day's Map" becomes the default kiosk screen.

- [ ] **Step 2: Commit the roadmap update**

```bash
cd /home/kiosk/kerchunk-kiosk
git add docs/ROADMAP.md
git commit -m "docs(roadmap): close DSP-efficiency items #2 (subsumed) and #3 (done)"
```

- [ ] **Step 3: Push + open the Phase 2 PR** with the measured before/after helper-CPU figure and an explicit note that SAME decode was proven on hardware (visiting-slot still fires; decoder absent with no weather channel).

```bash
cd /home/kiosk/kerchunk-kiosk
git push -u origin feat/feature-tap-gating-phase2
gh pr create --base main --title "feat: gate the SAME decoder to NWR-carrying helpers (DSP-efficiency item #3, phase 2)" --body "Part B + bookkeeping. multimon-ng now spawns only when this helper carries NWR (derived sameEnable). Proven on the kiosk: visiting-slot SAME still decodes; no decoder when no weather channel. Closes item #2 (subsumed by lane-fit) and item #3. Spec: docs/superpowers/specs/2026-06-09-feature-tap-gating-design.md"
```

---

## Out of scope
- The `art.ts` idle-suspend fix (recorded as a watch-item only; "Day's Map" is not the default view).
- Any `--role weather` / bespoke one-lane helper branch (item #2 closed as subsumed).
- Dynamic, no-respawn (valve) gating of the PCM tee — declined in favor of the config flag.
- The polyphase channelizer; `MAX_CHANS`; the Close Call FFT gate (already shipped in lane-fit); any squelch/quieting/speaker behavior.

## Success criteria (from the spec)
- With `audio.remoteListening` false (default): no PCM tee built, `/api/stream.wav` 404s, helper idle CPU drops (kiosk). With it true: remote listening works as before.
- SAME decoder spawns only on a helper carrying NWR: still decodes in the operator's visiting-slot config; `multimon-ng` absent when no weather channel; no redundant decoder on the main helper when a dedicated weather radio exists.
- No change to demod, squelch, speaker ownership, or any active channel's audio.
- TS gates/derivations covered by off-server unit tests; the `wideband_helper.py` SAME gate proven on hardware before its PR.
- ROADMAP updated: item #2 subsumed, item #3 done, `art.ts` regression recorded.
