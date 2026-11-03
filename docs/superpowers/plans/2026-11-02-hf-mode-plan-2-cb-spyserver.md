# HF mode Plan 2: CB over SpyServer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** CB mode listens through the Airspy HF+ on SpyServer, with audio that survives Wi-Fi and SAME break-ins that keep working, built from `main` so the kiosk can leave its FernSDR deploy branch.

**Architecture:** The existing CB mode keeps its channels, wall and history. `toScanConfig` adds a `spyserver` block for `mode === "cb"`. `WidebandEngine` treats the source as spawn-time state, so crossing between SpyServer and KIOSK01 is a quiet respawn with no warm-up events. A new speaker buffer in the helper absorbs bursty network IQ.

**Tech Stack:** C++ helper (`kiosk/native`), TypeScript backend, vitest, the native `check.hpp` tests.

**Spec:** `docs/superpowers/specs/2026-11-02-hf-mode-design.md`

**Later plans, not this one:** the shortwave sweep, CB-versus-sweep switching, the rename to HF, mode persistence, the reception log, schedules, the wall stage.

## Global Constraints

- Operator decisions, 2026-11-02: respawn is approved for SAME audio. The link stays on Wi-Fi.
- SAME: up to about 2 s of silence, no warm-up overlay, banner kept, `breakIn` guard kept.
- Map mode behaviour must not change. With no `config.spyserver`, CB must behave exactly as it does today.
- Do not change `/api/status`, `/api/logs` or `/api/weather` shapes.
- ESM `.js` imports, `strict` + `noUncheckedIndexedAccess`, vanilla TS, knobs in config.
- `kerchunk-dsp` flags already exist: `--spyserver host:port`, `--spyserver-gain` (0–32), `--spyserver-digital-gain` (0–32). `--spyserver` forces 750 kHz and rejects any RTL selector.
- Every change ships by PR, proven on the kiosk first. Attribution lines per the session's instructions.

## Review Focus

1. SpyServer unreachable when the operator enters CB: the wall shows the engine error through the existing `cbView` error state, and switching back to scan starts KIOSK01 at once.
2. A break-in while the SpyServer helper is in restart backoff: the RTL helper starts now, with no overlay and no leftover restart timer.
3. Quick `cb → scan → cb` switches: exactly one live child, and its source matches the last request.
4. Another client holds the radio (`CanControl` false, helper exits): the reason reaches the error message.
5. No `config.spyserver`: CB mode's helper arguments are identical to today's.

---

### Task 1: Speaker jitter buffer (PR A)

**Files:**
- Modify: `kiosk/native/src/outputs.hpp`, `outputs.cpp`, `constants.hpp`, `cli.hpp`, `cli.cpp`, `kiosk/native/app/main.cpp`
- Test: the existing native test files covering `AlsaPolicy`, `JitterPolicy` and the CLI

**Interfaces:**
- Produces: helper flag `--audio-buffer-ms N`, integer 0–3000, default 0. 0 is today's behaviour exactly.

Values: at N > 0, target = N ms of samples at the audio rate, trim threshold = target + 1 s, ring capacity = trim threshold + `AUDIO_RING`, and after an underrun playback resumes only once the target is queued. At N = 0 the target stays `AUDIO_TARGET_LAT`, the threshold `AUDIO_MAX_LAT`, the ring `AUDIO_RING` and the resume level `2 * ALSA_PERIOD`.

- [ ] **Step 1: Write failing tests:** `jitter_buffer_zero_matches_todays_limits`, `jitter_buffer_trims_only_above_target_plus_one_second`, `alsa_policy_resumes_only_at_target_after_underrun`, `cli_audio_buffer_ms_range` (3001 and -1 rejected).
- [ ] **Step 2: Run `npm run test:native` on the kiosk.** Expected: FAIL to compile, the new parameters don't exist.
- [ ] **Step 3: Implement.** `AlsaPolicy::decide` gains a `resume_at` parameter. `JitterPolicy::drop_for` gains target and threshold parameters. `AlsaSink` takes `buffer_ms` in its constructor and sizes its ring from it.
- [ ] **Step 4: Run `npm run test:native`.** Expected: all pass.
- [ ] **Step 5: Bench on real IQ.** Run the helper against SpyServer on a station-bearing window for 10 minutes each at 0, 500 and 1000 ms, reading the `speaker output` log lines. Record underrun and drift-trim per minute in `docs/bench/2026-11-hf-proofs.md`. Pass: drift-trim is 0 and underrun after the first minute is near 0 at the chosen value. Choose the smallest value that passes; it becomes the default in Task 2.
- [ ] **Step 6: Run the full definition of done, commit, PR, merge.** `git commit -m "feat(dsp): speaker jitter buffer for network IQ"`.

### Task 2: `config.spyserver` reaches the helper in CB mode (PR B)

**Files:**
- Modify: `kiosk/src/backend/config/schema.ts`, `kiosk/src/backend/server.ts` (`toScanConfig`), `kiosk/src/backend/engine/ScannerEngine.ts`, `kiosk/src/backend/engine/WidebandEngine.ts`
- Test: `kiosk/test/` server and wideband engine suites

**Interfaces:**
- Produces: `config.spyserver?: { host: string; port: number (default 5555); gain?: number (0–32); digitalGain?: number (0–32); audioBufferMs: number (0–3000, default from Task 1) }`
- Produces: `ScanConfig.spyserver?: same shape`. Set only when `mode === "cb"` and `config.spyserver` exists.

In that case `toScanConfig` also sets `windowBandwidthHz` and `flatBandwidthHz` to 600 000 (inside SpyServer's 660 kHz). `rateFor` returns 750 000 when `config.spyserver` is set. `helperArgs` then emits `--spyserver host:port`, the two gain flags when set, and `--audio-buffer-ms`, and omits the RTL selector, `--rate`, `--gain` and `--ppm`.

- [ ] **Step 1: Write failing tests:** `toScanConfig_cb_carries_spyserver_and_narrow_window`; `toScanConfig_scan_and_weather_never_carry_spyserver`; `toScanConfig_cb_without_spyserver_is_unchanged`; `cb_channels_group_into_one_window_over_spyserver` (32 channels, lanes 32, one group, no channel on the center); `wideband_args_over_spyserver_have_no_rtl_rate_gain_or_ppm`; `wideband_args_cb_without_spyserver_are_unchanged`; `put_config_spyserver_change_in_cb_mode_respawns`.
- [ ] **Step 2: Run `npm test`.** Expected: the new tests FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `npm test` and `npm run typecheck`.** Expected: pass.
- [ ] **Step 5: Commit.** `git commit -m "feat(cb): config.spyserver points CB mode at the Airspy HF+"`.

### Task 3: Quiet respawn across sources (PR B)

**Files:**
- Modify: `kiosk/src/backend/engine/WidebandEngine.ts`
- Test: wideband engine and server break-in suites

**Interfaces:**
- Consumes: `ScanConfig.spyserver`.
- Produces: `retune()` crosses sources silently. `spawnedShape` gains `source: string` (`host:port`, or `""` for RTL).

When the source differs, whether or not a child is live, `retune` must: clear the restart timer, kill the child, clear hold and open state, reset `exitFailures`, set the new config and groups, and spawn. It must not emit `warmup`, must not set state to `stopped`, and must not reset the warm-up flags. This is the narrow exception the spec allows for CB and HF only. A same-source retune and map-mode break-ins remain plain retunes.

- [ ] **Step 1: Write failing tests:** `retune_across_sources_emits_no_warmup_or_stopped`; `retune_across_sources_replaces_the_child_with_the_new_source`; `retune_across_sources_during_backoff_spawns_now_and_clears_the_timer`; `quick_cb_scan_cb_leaves_one_child_on_the_last_source`; `spyserver_exit_reason_reaches_the_error_event`; `same_source_retune_still_does_not_respawn`; server: `break_in_from_cb_drops_spyserver_then_restores_it`; `break_in_from_cb_keeps_breakIn_guard_and_warmed`.
- [ ] **Step 2: Run `npm test`.** Expected: the new tests FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `npm test`.** Expected: pass.
- [ ] **Step 5: Commit.** `git commit -m "feat(engine): cross-source retune respawns the helper without a warm-up"`.

### Task 4: Docs, deploy and prove (PR B)

**Files:**
- Modify: `CLAUDE.md` (knobs; narrow break-in exception), `docs/API.md` if config docs live there, `docs/superpowers/specs/2026-11-02-hf-mode-design.md` (constraints 1 and 5 decided), `docs/bench/2026-11-hf-proofs.md`

- [ ] **Step 1: Deploy the branch to the kiosk** from `main` plus this branch, retiring `deploy/cb-fernsdr-hf`. Set `config.spyserver.host` to `airspy.local` through `PUT /api/config`.
- [ ] **Step 2: Prove through Node, recording results in the bench notes:**
  - `POST /api/mode` `cb → weather → cb` five times: time to first speaker audio each way (bar: 2 s). Confirm `warmed` stays true and a banner from `POST /api/test/alert` survives. A real SAME header can't be produced on demand, so the actual break-in path is covered by the Task 3 server tests and flagged as such.
  - Point `config.spyserver.host` at a dead address: the wall shows the error, and `scan` still starts at once. Restore it.
  - Screenshot the live CB wall.
  - 30 minutes in CB mode with the real wall: peak temperature and helper CPU against 30 minutes in map mode.
- [ ] **Step 3: Check CB squelch on the HF+.** RTL-tuned thresholds may not carry over. If noise opens lanes or real traffic doesn't, add the minimum config knob, with a test, and record the ruling. Hearing voices needs an active band, so this waits on the operator by ear if CB is quiet.
- [ ] **Step 4: Run the full definition of done, push, PR, CI, merge, clean up.**
- [ ] **Step 5: Move the kiosk to `main`, rebuild, restart, and verify again.** Update the deploy-branch memory. PR #300 is the operator's to close; ask.

## Not proven by this plan

- A real SAME alert end to end, including how much of the header and attention tone the respawn costs.
- CB audio quality when the band is dead; the operator judges it by ear when CB is active.
