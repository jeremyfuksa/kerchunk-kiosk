# Native DSP engine (`kerchunk-dsp`) — design

Status: approved in brainstorm 2026-09-25, pending spec review.

## Why

The GNU Radio helper costs ~2.2–2.3 cores on the scanner (the dominant heat
source; the box runs ~7 °C under its 90 °C trip). Per-thread measurement
(2026-09-25) showed the 12 `freq_xlating_fir` channel filters are only ~36% of
that. The other ~64% is GNU Radio's thread-per-block structure: ~250–285
threads, each processing ~100-sample buffers, ~130k context switches/s. The
signal path also runs full NBFM demod, quieting, leveler and AM chains on all 12
lanes continuously, although 0–2 channels are active at once.

A decimate-the-meters experiment (branch `perf/decimate-meters`) bought only
~5%, confirming that per-block overhead, not arithmetic, is the problem.

**Goal:** same coverage as today (≤12 programmed channels per window, the
weather radio, Close Call, SAME), for as little CPU and heat as possible.
**Non-goal:** more coverage (every slot in the window), PFB channelizer, new
features.

Operator decisions: clean slate on the DSP (re-tuning by ear is acceptable),
whole stack behind `ScannerEngine` is in scope, approach = native C++.

## 1. Architecture

New process **`kerchunk-dsp`** (C++17, cmake, source in `kiosk/native/`)
replaces `wideband_helper.py` for both radios. The scanner and the weather radio
each run their own instance (weather still spawned under `nice -n 19`).

Exactly four threads:

1. **USB reader:** librtlsdr async reads, device chosen by EEPROM serial
   (`--rtl-serial`; `--rtl-index` fallback), into a lock-free SPSC ring of
   u8 IQ.
2. **DSP:** consumes 10 ms chunks (24,000 samples at 2.4 Msps) and does all
   signal work plus the squelch state machine (§2, §3).
3. **Audio:** writes the speaker feed (s16) to ALSA by name
   (`plughw:CARD=PCH,DEV=0`, exclusive) and to the fd-3 PCM tee.
4. **Control:** stdin JSON commands in, stdout JSON events out, multimon-ng
   pipe for SAME.

Dependencies (apt): `librtlsdr-dev`, `libasound2-dev`, `libfftw3-dev`
(present), `libvolk-dev` (present), `cmake`, `g++`. SoapySDR is not used.

**Node side (`WidebandEngine.ts`) is slimmed, not rewritten.** It keeps
grouping, dwell/hop, hold-through with the max-hold cap (PR #194), warm-up
milestones, break-in `retune()`, restart escalation and all `ScannerEngine`
events. Removed on the native path:

- **The lane plan and respawn-on-retune** (`lanePlan.ts`, `--lanes`,
  `--lane-modes`). The native engine lays out lanes per `tune`, so
  `retune()` never respawns.
- **`detectVia: "fft"`** (failed its bench). The schema still accepts the
  field and ignores it, so existing configs load.

The window stays ≤12 channels (`MAX_CHANNELS_PER_GROUP`). This is a CPU
budget knob now, not a topology limit.

**Selection:** `KERCHUNK_ENGINE=native`, next to `wideband` (GNU Radio), until
the operator's A/B is done. Rollback is one environment variable.

## 2. DSP pipeline (DSP thread, one pass per 10 ms chunk)

1. **Front end:** u8 → complex float via a 256-entry LUT. Channels and Close
   Call keep away from the DC spike as today (`CC_DC_FRAC`, group centering).
2. **Channelizer: fast convolution (overlap-save).** One shared FFT per chunk
   hop (`FFT_N = 6144`, 50% overlap, FFTW plan). Per assigned channel: take
   its 128 bins, multiply by one precomputed channel-filter frequency
   response, run a 128-point IFFT, which yields the channel at **50 kHz**
   (decimation 48). The filter is a windowed-sinc FIR ≤ `FFT_N/2` taps
   (cutoff `CHAN_CUTOFF_HZ = 8000`, transition `CHAN_TRANSITION_HZ = 4000`),
   at least as sharp as today's taps. The residual offset (channel freq minus
   nearest bin center, |Δ| ≤ ~195 Hz) is removed with a per-lane NCO at
   50 kHz. Channels need not sit on a raster.
   **Rate rule:** the lane rate is fixed at 50 kHz, so the SDR rate must be a
   multiple of 50 kHz. D = rate / 50 000, and `FFT_N` = 128·D. The scanner at
   2.4 Msps gives D = 48, N = 6144. The weather radio moves from 240 kHz to
   **250 kHz** (D = 5, N = 640), a one-line change to its `sampleRateHz`
   in the engine wiring. Other rates are rejected at startup with a clear
   error.
3. **Power, every assigned lane, always.** Σ|x|² per 10 ms chunk. Fast
   meter = the latest chunk (10 ms, audio gate). Slow meter = the mean of the
   last 10 chunks (100 ms, detection and floor).
4. **Demod on demand.** A lane runs the FM discriminator (VOLK fast atan2 of
   the conjugate product) or the AM envelope with carrier normalization,
   plus the quieting noise meter (HPF above `NOISE_HPF_HZ = 8000`, mean
   square) and the speech meter for the leveler, **only** when it is:
   (a) within `DEMOD_ARM_DB = 6` of its open threshold on the slow meter,
   (b) open or in hang,
   (c) background (SAME), or
   (d) the monitor lane.
   Arming primes the quieting meter from the first demod chunk, and opening
   still needs `OPEN_MS` of quieted carrier after arming, so opening isn't
   delayed in practice.
5. **Speaker path (audible lane only).** De-emphasis (75 µs, FM only), audio
   low-pass, 50 → 48 kHz polyphase resample (24/25), leveler gain, gate fade
   (6 steps over ~6 ms), rail ±0.8, s16 out.
6. **SAME.** The background lane is always demodulated, resampled
   50 kHz → 22.05 kHz (441/1000 polyphase), s16 to `multimon-ng -t raw -a EAS -`.
7. **Close Call.** A separate Blackman-Harris 2048-point FFT at
   `CC_FRAMES_PER_S = 20`, averaged over each 200 ms check. The detection
   logic ports as-is: median floor, edge/DC mask, guard around known and
   assigned freqs, image rejection, 12.5 kHz raster, confirm ×2,
   per-frequency cooldown. It's built only with `--close-call`.

**Budget target:** scanner instance ≤ 1 core (vs ~2.2–2.3 today).

## 3. Control logic and protocol

**Threading of decisions.** The squelch state machine runs on the DSP thread
at each chunk boundary (100 Hz). Commands reach it through a lock-free queue,
applied at the next boundary. Events leave through a queue that the control
thread serializes to stdout.

**Protocol with Node.**

- Events keep today's names and shapes: `ready`, `tuned{centerHz}`,
  `open{id,db}`, `close{id}`, `audible{id|null}`, `power{levels}` (every
  200 ms, plus `drops` when nonzero), `level{id,db}`, `rf{id,db,n}`,
  `same{raw}`, `closecall{freqHz}`, `log{msg}`. `handleHelperEvent` doesn't
  change.
- Commands: `tune{centerHz, channels[], monitor, closeCall, closeCallDb,
  knownHz}`, `known{knownHz}`, `skip{holdoffS}`,
  `alert_unmute{id, holdS}`, `quit`. The channel fields are as today (`id`,
  `freqHz`, `priority`, `levelDb`, `mode`, `audible`, `openDb`, `quietDb`,
  `hangMs`, `background`).
- Invariant kept: a `tune` emits `close` for every still-open channel
  **before** its `tuned` ack (the wedge fix).
- Background channels take the last lane. Groups over the lane budget are
  truncated with a `log` event (defensive; grouping prevents it).

**Squelch rules (port of today, units in ms).**

- **Floor:** per-lane floor learned from the slow meter (α up 0.02 / down
  0.2), frozen while open. First reading after `WARMUP_MS = 500` seeds it.
  Group floor = the minimum across assigned lanes.
- **Open:** slow power > floor + `openDb`, **and** quieted, **and** not in
  skip holdoff, for `OPEN_MS = 100`.
- **Close:** slow power < floor + `openDb` − 3 dB for `hangMs`. On close:
  median `rf` event, audible handoff, `cc_*` lanes park.
- **Fast gate (audible lane):** open while carrier (fast meter vs gate
  threshold, ±0.5 dB) **and** quieted (noise vs `quietDb`, ±1 dB). Fade on
  silence edges only.
- **Leveler:** as today (`LEVEL_*` constants), updated per chunk while voiced.
  `level` event on ≥0.5 dB movement.
- **Speaker ownership:** first open wins. Priority takes the speaker from
  non-priority. See-only lanes never speak. `alert_unmute` sets `allow_audio`
  until expiry, then restores the configured value and hands off.
  `next_open_chain` = open priority first, else first open.
- **Skip:** force-close the audible lane. A regular channel gets
  `skip_until`; a CC lane gets a cooldown and parks.
- **Monitor mode:** lane 0 is held open and audible with no squelch.
  `power` keeps flowing.

**Intentional behavior changes:** decisions at 100 Hz (was 50 Hz), so the
mute can land up to ~10 ms sooner. Filter shape and demod implementation
differ, so the operator re-checks `openDb` / `quietDb` by ear.
`quietDb`'s absolute scale will differ from GNU Radio's; the native default is
calibrated at P3 and the per-bank overrides are re-checked.

**Knobs:** `kiosk/native/src/constants.hpp` (FFT size, chunk length, filter
cutoff and transition, `DEMOD_ARM_DB`, `OPEN_MS`, `WARMUP_MS`, leveler, fade,
rail, CC). The runtime knobs (`--open-db`, `--quiet-db`, `--hang-ms`,
`--gain`, `--rate`) stay CLI flags, so config drives them as today.

## 4. Failure handling

- **SDR loss** (async read error, or no samples for 2 s): stderr reason,
  exit non-zero. Node's existing restart and escalation path recovers.
- **Device busy at start** (the previous instance still releasing): retry
  open for up to 3 s, then exit.
- **ALSA xrun or suspend:** `snd_pcm_recover`. If recovery keeps failing,
  log once and keep detecting with silent audio (the tee still gets data).
- **DSP overrun** (ring full): drop the oldest chunks, count them, and report
  in `power.drops` plus a rate-limited `log`.
- **fd-3 tee:** non-blocking. If Node isn't reading, frames are dropped and
  never stall audio.
- **multimon-ng exit:** log `multimon-ng exited: SAME decoding stopped`,
  respawn once, log again on a repeat.
- **Shutdown:** stdin EOF, `quit` or SIGTERM exits within 500 ms
  (`QUIT_GRACE_MS`).

## 5. Testing and rollout

**Replay mode:** `kerchunk-dsp --iq-file <file.cu8> [--realtime]
--sink none` runs the full pipeline off a capture, with deterministic
events.

**Tests:**

- `npm run test:native`: C++ unit tests (vendored single-header framework)
  on synthetic IQ:
  - power accuracy at arbitrary offsets
  - adjacent rejection at ±12.5 and ±25 kHz
  - FM demod SNR
  - quieting separating carrier from noise
  - squelch timing (open ≈100 ms, gate mute < 20 ms, close after hang)
  - speaker arbitration (first-wins, priority, alert hold, skip holdoff)
  - CC image rejection
- A replay test on a short recorded capture checks a clean run, sane events,
  and CPU-seconds per IQ-second.
- vitest: the existing fake-helper suites, plus native-path protocol tests
  (no lane plan, `retune` never respawns, `detectVia` ignored).
- CI (`ci.yml`): apt deps + cmake build + `test:native`. `npm run build`
  builds the native binary into `dist/`.

**Phases (one PR each):**

- **P0, bench go/no-go.** Stop `kerchunk-kiosk` for ~60 s to record ~30 s of
  2.4 Msps IQ from KIOSK01 (audio outage, announced). Build a throwaway core
  (channelizer + power ×12, demod ×1) and measure. **Go if the projected
  scanner instance ≤ 1 core.**
- **P1, native engine.** Full `kerchunk-dsp` + unit/replay tests. Not wired in.
- **P2, Node integration.** `KERCHUNK_ENGINE=native`, native path without
  lane plan/respawn, CI, and docs (`CLAUDE.md`, `docs/DEPLOY.md`,
  architecture notes; `docs/API.md` is unchanged because the HTTP/WS surface
  is identical).
- **P3, live A/B.** ≥1 h each engine: helper CPU, context switches, package
  temp vs the GNU Radio baseline. The operator checks by ear: squelch, mute
  tail, leveler, AM, SAME (`POST /api/test/alert` flow unaffected), Close
  Call. Calibrate the native `quietDb` default.
- **P4, cleanup.** After operator sign-off, delete `wideband_helper.py`,
  `wideband_dsp_math.py`, `lanePlan.ts`, fft-detect, and the GNU Radio deps
  from docs.

**Do-not-undo invariants carried over:**

- boot via `toScanConfig`
- SAME break-in = `retune()`
- the `breakIn` guard
- the weather instance niced to 19
- the fd-3 tee always drained
- the max-hold cap
- ALSA by name, SDR by serial

**Superseded:** branch `perf/decimate-meters` (−5%) is closed unmerged. It
touches code the native engine replaces.
