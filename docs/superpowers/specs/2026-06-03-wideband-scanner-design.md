# Wideband Multi-Channel Scanner — Design Spec

**Date:** 2026-06-03
**Status:** Draft for review (future implementation session)

> **Gate before implementing:** This spec has **feasibility risks** that must be
> de-risked with a spike BEFORE writing an implementation plan — specifically
> (1) does `csdr` build on this aarch64 Pi and express the per-group
> channelizer + N FM demods + RMS, and (2) does the 2GB Pi 4 have the CPU
> headroom for it at 2.4 MS/s. See "Open questions". Do not go straight to
> writing-plans from this spec; run the spike first and fold results back in.

## Problem this solves

The current scanner (`RtlFmEngine`) runs **one `rtl_fm` per channel at a time** and
hops by **killing and respawning `rtl_fm`** on a timer. Each respawn **re-opens the
USB SDR**. At the old 400ms hop default this re-opened the dongle ~2.5×/second,
which **wedged it off the USB bus** (`rtlsdr_write_reg failed with -7`, `error
-71`, disconnect/re-enumerate loop) — multi-channel scanning produced **no audio
at all**, while a single channel (no hopping) worked. A hotfix raised the default
hop interval to 2000ms (commit `dc52816`), cutting device churn ~5×, but the
architecture still re-opens the device on every hop and still **misses any
transmission on a channel it isn't currently parked on**.

This redesign removes per-hop device re-opens **and** monitors multiple channels
**simultaneously**, by sampling a wide I/Q window once and demodulating several
channels from it in software.

## Decisions (settled in brainstorming)

| Question | Decision |
|---|---|
| Core approach | **Wideband I/Q + software demod** (not per-channel `rtl_fm`) |
| Where DSP runs | **A separate DSP helper process** (not in Node, not per-channel `rtl_fm`) |
| DSP implementation | **Glue existing DSP CLI tools** (compose proven blocks; avoid writing a demodulator from scratch) |
| Multi-band handling | **Group-hop**: auto-cluster channels into ≤2.4 MHz groups; wideband-demod all channels *within* a group simultaneously; retune the front-end *between* groups |
| Audio conflict (2 channels active in one group) | **First-active wins, hold until idle**, then switch to any other still-active channel |
| Dashboard | **Unchanged** ("now playing" = the single audible channel). Engine still emits per-channel active state, so a richer UI is a later option. |

## Key RF facts (verified on-device)

- Dongle: **RTL2832U + Rafael Micro R820T** (`rtl_test`). Instantaneous bandwidth
  ~2.4 MHz reliable on a Pi; tuning range ~24–1766 MHz.
- The operator's 6 channels form **3 groups** that each fit in 2.4 MHz:
  - **VHF**: 146.79, 147.33 (span 0.54 MHz)
  - **UHF-444**: 444.275 (single)
  - **UHF-464**: 464.175, 464.275, 464.425 (span 0.25 MHz)
- VHF and UHF are ~300 MHz apart → **one I/Q window cannot cover both**; the
  front-end must retune between groups. Group-hop reduces device retunes from
  6/cycle (per-channel) to 3/cycle (per-group), and within a group nothing is
  missed.

## Tooling reality (verified on the Pi — IMPORTANT constraints)

The Pi has the full **rtl-sdr suite** (`rtl_sdr`, `rtl_fm`, `rtl_power`,
`rtl_tcp`, `rtl_test`) and `gcc/g++/make/git`. It does **NOT** have: `csdr`,
`sox`, GNU Radio, `cmake`, or `librtlsdr-dev` headers. Arch is `aarch64`.

Consequences for "glue existing DSP tools":
- `csdr` (the natural channelizer/FM-demod toolkit) is **not installed and not in
  apt** → it must be **built from source** (needs `cmake` + `librtlsdr-dev`,
  both currently absent). This is a real prerequisite, not a given.
- The implementation plan MUST add the build/runtime prerequisites to
  `kiosk/scripts/setup-kiosk-pi.sh` (e.g. `cmake`, `librtlsdr-dev`, and the csdr
  build), and account for the deploy model: `deploy.sh` only syncs
  `dist/node_modules` to `/opt`, so a compiled helper / installed tool is
  **setup-kiosk-pi.sh territory**, not the deploy pipeline.

## Architecture

```
                 ┌────────────────────── DSP helper (one persistent process) ──────────────────────┐
rtl_sdr ──I/Q──► │ tune center = group center                                                      │
(one device,     │ channelize 2.4 MS/s → N narrowband streams (one per channel in the group)        │
 stays open)     │ FM-demod each → per-channel audio + per-channel RMS/squelch                      │
                 │ pick audible channel (first-active-wins) → one PCM stream to the sink            │
                 │ emit per-channel active/idle + which-is-audible as structured events to Node      │
                 └─────────────────────────────────────────────────────────────────────────────────┘
                        ▲ group retune command (Node → helper)         │ events + audio
                        │                                              ▼
                 ┌──────────────── Node (WidebandEngine, implements ScannerEngine) ─────────────────┐
                 │ owns the group list (auto-clustered from enabled channels)                        │
                 │ group-hop timer: dwell on a group; retune to next group unless a channel is held  │
                 │ translates helper events → EngineEvent (active/idle/signal/status/error)          │
                 │ same ScannerEngine interface → server.ts / WS / dashboard unchanged               │
                 └─────────────────────────────────────────────────────────────────────────────────┘
```

**The engine still implements the existing `ScannerEngine` interface** (`start`,
`stop`, `setVolume`, `setMuted`, `state`, `on`/`off`, same `EngineEvent` union),
so `server.ts`, the WS hub, and the dashboard need **no changes**. This is a
drop-in engine swap behind the existing interface — the same boundary
`FakeEngine` and `RtlFmEngine` already implement.

## Components

### 1. Channel grouping (`grouping.ts`, pure, unit-tested)
- Input: enabled channels. Output: ordered groups, each with a center frequency
  and the channels it contains, such that every channel is within ±(window/2) of
  its group center and each group spans ≤ the usable bandwidth (configurable,
  default ~2.0 MHz to leave guard band under the 2.4 MHz ceiling).
- Greedy interval clustering by frequency; deterministic; no device interaction.
- Pure function → fully testable without hardware.

### 2. DSP helper invocation + protocol (`WidebandEngine`)
- Spawns ONE `rtl_sdr` (raw I/Q at the group center) feeding the DSP chain
  (csdr-composed channelizer + per-channel FM demod + RMS), built from the
  group's channel offsets relative to center.
- The helper (or the Node-side glue around the CLI chain) reports, per channel:
  squelch open/close + RMS, and which channel is currently audible.
- Node consumes that, applies **first-active-wins hold**, routes the audible
  channel's audio to the existing ALSA sink, and emits `EngineEvent`s.
- **Group retune** = tear down the I/Q chain for the current group and start the
  next group's chain. NOTE: this still re-opens the device per *group* (3×/cycle,
  every few seconds) — acceptable and far below the thrashing threshold — UNLESS
  a single `rtl_sdr` can be retuned without restart (to be confirmed during
  implementation; if so, prefer retune over restart).

### 3. Group-hop control (in `WidebandEngine`)
- Dwell on a group for `groupDwellMs`; if any channel in the group is held
  (squelch open), **do not retune away** until it idles (hold-through).
- Retune to the next group on dwell expiry. Single group → no hopping at all
  (degenerate case = today's "1 channel works" but for a whole cluster).

### 4. Config additions (`config/schema.ts`)
- `scan.windowBandwidthHz` (default e.g. 2_000_000) — usable I/Q window for
  grouping.
- `scan.groupDwellMs` (default e.g. 3000) — per-group dwell.
- Existing `squelchLevel` becomes the per-channel RMS open threshold (same
  meaning, now applied per software-demodulated channel).
- `sampleRate` for I/Q (e.g. 2_400_000) distinct from the per-channel audio rate.

### 5. Engine selection (`index.ts`)
- Pick `WidebandEngine` vs `RtlFmEngine` vs `FakeEngine` (env/config flag), so the
  new engine can be rolled out behind a switch and the proven `RtlFmEngine`
  remains a fallback.

## Data flow (happy path)
1. `start(config)` → group the enabled channels → tune group 0 → spawn I/Q+DSP chain.
2. Helper streams per-channel squelch/RMS + audio; Node emits `signal`/`active`.
3. A channel opens squelch → first-active-wins → its audio plays, `active` emitted,
   group-hop paused (hold-through).
4. Channel idles → `idle` emitted → resume group dwell → eventually retune to next group.

## Error handling
- DSP chain / `rtl_sdr` exits unexpectedly → treat like the current
  `handleUnexpectedExit`: emit `error` (`RTL_EXITED`/`NO_DEVICE` by stderr), back
  off `restartDelayMs`, restart the current group's chain (NOT a tight loop —
  the lesson from the thrashing bug: restart delay must be ≥ ~1s).
- Grouping with zero enabled channels → engine `running` with no chain (parity
  with today).
- Tool missing at runtime (csdr not built) → fail loudly at start with a clear
  error event, and document the setup prerequisite.

## Testing
- **grouping.ts**: pure unit tests — VHF/UHF clusters split correctly; a channel
  beyond the window starts a new group; single channel = single group; empty = none.
- **WidebandEngine**: use a **fake DSP chain** (a shell script emitting canned
  per-channel events + PCM, mirroring the existing `test/fakes/fake-rtl_fm-*.sh`
  pattern) so the engine's group-hop, hold-through, first-active-wins, and event
  translation are tested **without hardware** — exactly how `RtlFmEngine` is
  tested today against fake rtl_fm scripts.
- **Conflict logic**: two channels active in one group → assert first-active wins
  and audio holds until it idles, then switches.
- **No device thrashing**: assert the engine does not restart the I/Q chain on a
  per-channel basis — only on group retune or genuine exit.

## Out of scope (explicit)
- Covering VHF + UHF *simultaneously* (physically impossible with one dongle).
- Richer dashboard (multi-active indicators) — engine emits the data; UI is later.
- Trunking / digital modes (P25/DMR) — analog NFM only, as today.
- Replacing the hotfix: the 2000ms `RtlFmEngine` stays as the fallback engine.

## Open questions to resolve during implementation
1. **csdr vs. a tiny custom helper:** confirm csdr builds cleanly on aarch64 with
   the added deps and can express the per-group channelizer + N FM demods + RMS in
   one chain. If csdr proves awkward, a small C helper using `librtlsdr-dev`
   directly is the fallback (more code, fewer moving parts) — but that contradicts
   the "glue existing tools" decision, so revisit with the user before switching.
2. **Retune-without-restart:** determine whether the I/Q source can change center
   frequency without a process restart (ideal: zero device re-open even between
   groups). If not, per-group restart at ≥1s spacing is acceptable.
3. **Pi CPU headroom:** measure csdr channelizer + 3–4 FM demods at 2.4 MS/s on the
   2GB Pi 4. If it can't keep up, reduce window bandwidth / decimate harder, or cap
   channels-per-group.
