# Wideband Multi-Channel Scanner — Design Spec

**Date:** 2026-06-03
**Status:** Draft for review (future implementation session)

> **Target hardware (decided):** an **Intel MacBook Pro running Fedora, 16GB,
> x86_64**, run closed-lid with HDMI out to the monitor. This replaces the 2GB
> Pi 4 as the appliance for the wideband engine. RAM/CPU are no longer the
> constraint (16GB + a real Intel CPU comfortably handle GNU Radio + Chromium +
> Node), and x86 has the best SDR-software support. The remaining feasibility
> work is **porting** (Fedora packaging + closed-lid HDMI + PipeWire audio),
> not raw capacity — see "Hardware feasibility / target platform".
>
> **Gate before implementing:** still run a spike first — but now it's a *port +
> prove* spike on the Fedora laptop: (1) GNU Radio + SoapySDR + rtl-sdr install
> via `dnf` and a flowgraph streams audio + per-channel detection; (2) the kiosk
> display + audio work closed-lid over HDMI. Fold results into the plan.

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
| DSP implementation | **GNU Radio flowgraph in a helper process** (revised — see "Prior art"). Originally "glue csdr CLI tools"; studying `rtl-sdr-scanner-cpp` showed real multi-channel scanning needs a proper DSP framework, not shell-pipe glue. |
| Detection method | **FFT / power-spectral-density across the whole window + adaptive noise floor** (revised — was per-channel RMS). Detects any transmission in the window, including simultaneous ones. |
| Multi-band handling | **Group-hop**: auto-cluster channels into ≤2.4 MHz groups; wideband-demod all channels *within* a group simultaneously; retune the front-end *between* groups |
| Audio conflict (2 channels active in one group) | **First-active wins, hold until idle**, then switch to any other still-active channel |
| Dashboard | **Unchanged** ("now playing" = the single audible channel). Engine still emits per-channel active state, so a richer UI is a later option. |

## Prior art: `rtl-sdr-scanner-cpp` (shajen) — what we learned

Studied https://github.com/shajen/rtl-sdr-scanner-cpp, a mature C++ multi-channel
SDR scanner solving nearly this exact problem. Confirmed from its source
(`sources/radio/`, `CMakeLists.txt`, `Dockerfile`):

- **Same core model as ours (validation):** it "scans/records multiple
  frequencies in the same time by switching quickly between bandwidth" and
  "records multiple transmissions simultaneously if on the same band." That is
  exactly group-hop wideband — sample a window, demod everything in it, hop
  between windows. Our architecture is sound.
- **DSP = GNU Radio flowgraph**, not custom DSP and not CLI glue. Its `blocks/`
  are GNU Radio `sync_block`s: `psd` (FFT power spectral density), `transmission`
  (detection), `decimator`, `noise_learner`, `spectrogram`, `sdr_source`.
- **Detection = FFT/PSD + adaptive noise floor**, not per-channel RMS: it
  computes the power spectrum across the whole sampled window, learns the noise
  floor (`noise_learner`), and flags bins above threshold. More robust and
  genuinely catches simultaneous transmissions. **We adopt this concept.**
- **Device I/O = SoapySDR** (via `gnuradio-soapy`) → device-agnostic.
- **`scheduler.cpp`** does the window/group scheduling + merges overlapping
  transmissions — the same job as our grouping/group-hop control.
- **Heavy dependency stack:** GNU Radio, SoapySDR, Boost, FFTW, liquid-dsp,
  spdlog, nlohmann/json, Paho MQTT, CLI11; distributed as a multi-GB **Docker**
  image. Output: file recordings + MQTT notifications + libsndfile.

**Implications adopted into this spec:**
1. Use a **GNU Radio flowgraph** as the DSP helper (not csdr CLI glue).
2. Use **FFT/PSD detection with an adaptive noise floor** (not per-channel RMS).
3. Treat **Pi feasibility as the dominant risk** — this is a heavy stack on a 2GB
   Pi 4. The spike (below) must prove GNU Radio + SoapySDR runs with acceptable
   CPU/RAM before any implementation plan.
4. We do **NOT** adopt their recording/MQTT/Docker surface — our need is live
   audio to the existing ALSA sink + the existing dashboard, behind our existing
   `ScannerEngine` interface. We borrow the DSP approach, not the app.

**Alternative not chosen (noted for the record):** run/fork
`rtl-sdr-scanner-cpp` itself as the backend with our kiosk as a UI over its MQTT
output. Rejected for now: large dependency + integration surface and a
recording-oriented design that doesn't match the kiosk's live-listen purpose.
Revisit if building the GNU Radio flowgraph ourselves proves too costly.

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

The Pi (`aarch64`, 2GB Pi 4) has the **rtl-sdr suite** (`rtl_sdr`, `rtl_fm`,
`rtl_power`, `rtl_tcp`, `rtl_test`) and `gcc/g++/make/git`. It does **NOT** have:
GNU Radio, SoapySDR, `cmake`, or `librtlsdr-dev` headers.

Consequences for the GNU Radio approach:
- **GNU Radio + SoapySDR** must be installed (`gnuradio`, `gnuradio-dev`,
  `libsoapysdr-dev`, `soapysdr-module-rtlsdr`), plus a build toolchain if the
  flowgraph helper is compiled C++ (or `python3-gnuradio` if the helper is a
  GNU Radio **Python** flowgraph — simpler to write, likely fast enough since
  the heavy DSP runs in GNU Radio's C++ blocks, not Python).
- These are **large** packages — disk and the dependency footprint matter on a
  kiosk SD card. The spike must confirm install size is acceptable.
- The implementation plan MUST add these prerequisites to
  `kiosk/scripts/setup-kiosk-pi.sh`. The deploy model is unchanged: `deploy.sh`
  only syncs `dist/node_modules` to `/opt`, so the DSP helper + GNU Radio
  install are **setup-kiosk-pi.sh territory**, not the deploy pipeline.
- **Helper language leaning:** a **GNU Radio Python flowgraph** (gnuradio's
  Python API) keeps the helper readable and avoids a C++ build step, while the
  actual signal processing still executes in GNU Radio's compiled blocks. Decide
  Python-vs-C++ flowgraph during the spike based on measured overhead.

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
- Spawns ONE **GNU Radio flowgraph** helper, tuned (via SoapySDR) to the group
  center, configured with the group's channel offsets. The flowgraph:
  SoapySDR source → FFT/PSD detection + adaptive noise floor (catch any
  transmission in the window) → per-active-channel FM demod → one audio stream.
- The helper reports, per channel: detected open/close + power, and which
  channel is currently audible. Protocol: line-delimited JSON on stdout (cheap
  for Node to parse), audio on a separate fd / via the ALSA sink directly.
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

## Hardware feasibility / target platform

**Decided target: Intel MacBook Pro running Fedora, 16GB RAM, x86_64**, operated
**closed-lid with HDMI out** to the monitor. This replaces the Pi 4 for the
wideband engine.

Why it's a strong fit:
- **RAM/CPU are no longer the constraint.** 16GB and a real Intel CPU comfortably
  run GNU Radio (FFT/PSD + multi-channel demod) + Chromium kiosk + Node together.
  The Intel CPU is far faster than any Pi for the real-time DSP.
- **x86_64** has the best SDR-software support (GNU Radio, SoapySDR, rtl-sdr all
  first-class in Fedora repos — no source builds, unlike the Pi where GNU Radio
  needed compiling).
- **Real USB3 + properly powered ports** → removes the USB-wedge failure class we
  hit on the Pi entirely.
- **Built-in battery = a UPS** that rides through power blips.

For-the-record comparison (why not stay on a Pi):

| Hardware | RAM | Verdict for wideband + kiosk |
|---|---|---|
| Pi 4, 2GB (old appliance) | 2GB | Under-spec for wideband; fine for the lean rtl_fm engine only. |
| Pi 5, 8GB | 8GB | Workable alternative if a Pi form factor were required. |
| **Fedora MacBook Pro, 16GB (chosen)** | 16GB | **Ample.** Best CPU + USB of the options; free (already owned). |

### Porting work this implies (Fedora + laptop appliance)
The current stack is Debian/RPi-OS + ALSA + cage. Fedora is also systemd-based,
so the architecture transfers, but the implementation plan must cover:
- **Packaging:** a Fedora path (`dnf`) alongside / replacing the Debian
  `setup-kiosk-pi.sh` — install `gnuradio`, `soapysdr`, `rtl-sdr`, `cage`/kiosk
  compositor, `chromium` via `dnf`.
- **systemd units:** the existing units (`kerchunk-kiosk.service`, display unit,
  `kerchunk-cursor-park.service`) port with minor tweaks (paths, user, display
  target).
- **Closed-lid operation:** set `HandleLidSwitch=ignore` (and
  `HandleLidSwitchExternalPower=ignore`) in `logind.conf` so it stays running
  with the lid shut; ensure the kiosk compositor targets the **HDMI** output, not
  the internal panel.
- **Audio:** Fedora ships **PipeWire** (ALSA-compatible). The `kerchunk` ALSA
  sink config needs adapting to the PipeWire/CoreAudio-free Linux audio stack;
  the engine still emits S16_LE PCM, but the sink device string changes.
- **Deploy model:** revisit how code reaches the laptop (the Pi used
  `deploy.sh` over SSH to `/opt`; same pattern works — just a new host/paths).

**Key point unchanged:** the lean hotfix engine (per-channel `rtl_fm`, 2000ms
hop) already works on the old 2GB Pi 4. Migrating to the Fedora laptop is about
enabling the **wideband** engine (simultaneous multi-channel monitoring) on
hardware that can actually run it.

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
