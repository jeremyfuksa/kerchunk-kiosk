# Idle feature-tap gating — don't run disabled-feature DSP blocks (design)

> Status: design, approved 2026-06-09. Realizes item #3 of the DSP-efficiency
> hardening backlog (`docs/PROCESSOR-EFFICIENCY-REVIEW-2026-06-06.md`, ROADMAP)
> and absorbs the residual of item #2. **Off-server caveat:** Part A (PCM tee
> gate) is pure TypeScript — the helper already conditionalizes the tee, so no
> flowgraph change is needed and it is fully off-server-buildable/testable. Part B
> (SAME decoder gate) touches the field-calibrated `wideband_helper.py`; a wrong
> gate silently kills weather alerts, so its correctness can only be PROVEN on the
> kiosk (SAME still decodes in the real config; absent when no weather channel).
> Design + plan off-server; build Part B + verify on hardware.

## Intent

After lane-fit (item #1, PRs #122–#125), the helper builds only the lanes and
demod paths the config needs. But three feature taps still ran unconditionally;
lane-fit already fixed one (the Close Call FFT is build-gated on `--close-call`).
Two remain, each running 24/7 even when its feature is inactive:

1. **The PCM streaming tee.** `WidebandEngine` hardcodes `--audio-fd 3`
   (`WidebandEngine.ts`), so the helper always builds a post-limiter
   `float_to_short` + `file_descriptor_sink` (`wideband_helper.py`,
   `if args.audio_fd >= 0`) and writes ~94 KB/s of s16 PCM down an fd
   continuously — even though that audio is only *consumed* when a
   `/api/stream.wav` remote-listening client is connected, which is rare. The
   conversion + fd-write cost is paid on **every** deployment, all the time.

2. **The SAME/`multimon-ng` decoder.** The helper spawns `multimon-ng -a EAS`
   and starts a reader thread whenever the binary exists
   (`wideband_helper.py`, `if shutil.which("multimon-ng")`), with a permanent
   decoder tap on the last lane — regardless of whether this helper carries NWR
   at all. With no weather channel configured, the decoder runs forever decoding
   noise to nothing.

### Item #2 is subsumed, not separate

The review's item #2 ("give the dedicated weather radio a one-lane, decode-only
flowgraph") was written before lane-fit. Lane-fit already collapsed the weather
helper to a **1-lane FM pipeline**: its lone NWR channel yields `laneCount = 1`,
`closeCall: false` removes the FFT, and the FM-only mask prunes the AM path. The
"weather radio runs a second full 12-lane helper" premise is stale. Its only
remaining waste is exactly the two taps above — so item #2 is **closed as
subsumed by lane-fit**, and its residual is folded into this work rather than
pursued as a divergent `--role weather` helper branch (which would re-implement
what lane-fit already gives us and risk two drifting DSP code paths).

**Goal:** the helper builds the PCM tee only when remote listening is enabled,
and spawns the SAME decoder only on a helper that actually carries NWR — without
changing any load-bearing DSP behavior.

## Architecture

### Part A — PCM streaming tee gate (off-server, no helper code change)

The helper *already* builds the tee only when `audio_fd >= 0`. The only change is
to stop `WidebandEngine` from always asking for it.

- **Schema:** add `audio.remoteListening: boolean` (zod `.default(false)`).
  Remote listening becomes **opt-in** — the operator's chosen default, banking the
  idle-CPU win on every box out of the box.
- **`ScanConfig`:** add `remoteListening?: boolean`. `toScanConfig` sets it from
  `cfg.audio.remoteListening`.
- **`WidebandEngine.helperArgs()`:** push `--audio-fd 3` only when
  `cfg.remoteListening` is true; otherwise omit it (the helper's `--audio-fd`
  default is `-1` → no tee built). The fd-3 stdio pipe wiring in `spawnHelper`
  stays as-is (harmless when the child never writes it); only the arg is gated.
- **`/api/stream.wav`:** return `404 { error: "remote listening disabled" }` when
  `config.audio.remoteListening` is false, before touching `onAudio`. (Today the
  route only 404s when the engine lacks an `onAudio` tee.)
- **Admin Audio page:** a toggle bound to `audio.remoteListening`. Flipping it
  flows through the existing config-diff restart path (the `ScanConfig` value
  changed → the engine respawns → the tee appears/disappears). The brief audio
  gap of a respawn is acceptable for a deliberate settings change.

Because the tee's *construction* is already conditional in the helper, Part A is
pure TypeScript: no `wideband_helper.py` change, and the behavior
(`--audio-fd` present iff the flag is on; the 404 branch) is fully unit-testable
off-server. The CPU drop is confirmed on the kiosk but carries no DSP-correctness
risk.

### Part B — SAME decoder gate (helper change, hardware-gated)

The gate must run the decoder **exactly when this helper carries NWR** — never
removing the operator's current SAME coverage. `toScanConfig` already encodes
precisely this: it injects the `wx_same` background channel into the main scan
only when there is no dedicated weather radio (`server.ts`, the
`!cfg.radios?.some((r) => r.role === "weather")` branch). So the gate is a
**derived** signal, not a new operator setting:

- **`ScanConfig`:** add `sameEnable?: boolean`, derived in `toScanConfig` as
  ```
  sameEnable = !!cfg.weatherChannel && channels.some(c => c.freq === cfg.weatherChannel.freq)
  ```
  The dedicated weather engine (`index.ts`, which builds its `ScanConfig` inline)
  sets `sameEnable: true` explicitly.

  This resolves to true exactly when the helper demodulates NWR:
  | situation | `sameEnable` | why |
  |---|---|---|
  | main scan, no dedicated weather radio (today) | **true** | NWR injected → visiting-slot SAME preserved |
  | main scan, dedicated weather radio present | false | NWR not in main scan → drop the now-redundant decoder |
  | dedicated weather helper | **true** | set explicitly; it owns SAME |
  | weather / monitor mode on the NWR channel | **true** | channel freq matches → keep decoding while listening |
  | no `weatherChannel` configured | false | nothing to decode → the pure-waste win |

- **Helper:** add `--same-enable` (argparse `action="store_true"`). Gate BOTH the
  `multimon-ng` spawn + reader-thread block AND the last-lane `same_fd` tap on
  `args.same_enable`. When disabled, `multimon-ng` is never spawned and the last
  lane builds no decoder tap.
- **`WidebandEngine.helperArgs()`:** push `--same-enable` when `cfg.sameEnable`.

A wrong gate silently kills weather alerts, so Part B is hardware-gated: prove on
the kiosk that SAME still decodes in the operator's real (visiting-slot) config,
and that `multimon-ng` is absent when no weather channel is configured — A/B both.

### Phase boundary (the lane-fit lesson)

`argparse` rejects unknown args, so the helper must learn `--same-enable` in the
same change that starts passing it. Therefore:

- **Phase 1 — off-server, ships alone:** Part A in full (schema flag, `ScanConfig`
  field, `toScanConfig`, gated `--audio-fd`, the `/api/stream.wav` 404, the admin
  toggle), **plus** computing and unit-testing `ScanConfig.sameEnable` in
  `toScanConfig`. Phase 1 does NOT pass `--same-enable` to the helper (it doesn't
  know the arg yet). Pure TS, fully unit-tested, real CPU win, no DSP risk.
- **Phase 2 — on the kiosk:** the `wideband_helper.py` `--same-enable` acceptance
  + gating, and `helperArgs()` starting to pass `--same-enable`, landed together
  and proven against real signals.

## What is off-server vs. hardware

- **Off-server (build + unit-test now):** the `audio.remoteListening` schema flag;
  `ScanConfig.remoteListening` / `sameEnable`; the `toScanConfig` derivations;
  `helperArgs()` emitting/omitting `--audio-fd` (and later `--same-enable`); the
  `/api/stream.wav` 404 branch; the admin toggle. All TypeScript, covered by
  vitest with `FakeEngine`.
- **Hardware (build + prove on the kiosk):** the `wideband_helper.py`
  `--same-enable` gating (Part B). Correctness — SAME still decodes when NWR is
  carried, decoder absent otherwise — is provable only against real signals.

## Out of scope

- The `art.ts` idle-suspend regression (`requestAnimationFrame` with no
  idle-suspend) — a separate frontend/item-#4 concern; "Day's Map" is not the
  default kiosk view today. Recorded in ROADMAP as a watch-item, not fixed here.
- Any `--role weather` / bespoke one-lane helper branch (item #2 is closed as
  subsumed, per Intent).
- The polyphase-channelizer rewrite (parked).
- Dynamic, no-respawn gating of the PCM tee (a runtime valve) — considered and
  declined in favor of the simpler config flag (operator decision); the tee
  appears/disappears on the config-diff respawn.
- Changing `MAX_CHANS`, the Close Call FFT gate (already shipped in lane-fit), or
  any squelch/quieting/speaker behavior.

## Success criteria

- With `audio.remoteListening` false (the default), the helper builds no PCM tee,
  `/api/stream.wav` returns 404, and the helper's steady-state CPU drops measurably
  on the kiosk (host-health "N / M cores"). With it true, remote listening works
  exactly as before.
- The SAME decoder spawns only on a helper that carries NWR: it still decodes in
  the operator's current visiting-slot config (proof-of-life still fires), and
  `multimon-ng` does not run when no weather channel is configured.
- A dedicated-weather-radio config runs SAME only on the weather helper (no
  redundant decoder on the main helper).
- No change to demod, squelch, speaker ownership, or any active channel's audio.
- The TypeScript gating + derivations are covered by off-server unit tests; the
  `wideband_helper.py` SAME gate is proven on hardware before its PR.
- ROADMAP updated: item #2 marked subsumed by lane-fit, item #3 done by this work,
  and the `art.ts` idle-render regression recorded as a watch-item.
