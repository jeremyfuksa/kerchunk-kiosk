# Deploying Kerchunk Kiosk

## CI

`.github/workflows/ci.yml` runs typecheck + tests + build on every pull
request and every push to `main`, on GitHub-hosted Linux. It never touches the
appliance.

## Deploy on the appliance (the real flow)

The appliance runs the backend straight from this repo checkout, so a deploy
is a pull + build + service restart:

```sh
git pull && (cd kiosk && npm run build) && sudo systemctl restart kerchunk-kiosk
```

**Only restart the service for backend changes** — the DSP helper restarts
cheaply, but every restart still interrupts live audio and replays the
warm-up overlay on the wall. For a frontend-only change:

```sh
cd kiosk
npm run build                     # vite does NOT typecheck; the full build does
curl -X POST localhost:8080/api/kiosk/reload
```

Two services: `kerchunk-kiosk` (backend) and `kerchunk-display` (the chromium
wall session). A wedged/stale wall page is fixed with
`sudo systemctl restart kerchunk-display` — don't bounce the backend for it.

## Engine (kerchunk-dsp)

The scanner and weather radios both run `WidebandEngine`, which spawns
`kerchunk-dsp` — a standalone C++ DSP helper (`kiosk/native/`) built with
cmake. It owns its SDR for the process lifetime and hops by `tune` commands,
never by re-opening the device. Selected by `KERCHUNK_ENGINE=wideband` (the
default); `native` is accepted as an alias, which is what the appliance's
systemd drop-in (`systemctl edit kerchunk-kiosk`) sets.

**Build deps** (apt, installed by `setup-kiosk-ubuntu.sh`): `cmake pkg-config
libfftw3-dev nlohmann-json3-dev libasound2-dev librtlsdr-dev`, plus
`multimon-ng` at runtime for SAME decoding.

`npm run build` builds `kerchunk-dsp` (cmake, `--parallel 2`) and installs it
to `dist/backend/engine/` via a temp file + `mv`, so rebuilding under a
running helper is safe. It's a real C++ compile, not just `tsc`/`vite`: a
thermal cost like any other build. `npm run test:native` builds and runs the
C++ unit tests.

**Verify:**

```sh
ls -l kiosk/dist/backend/engine/kerchunk-dsp     # rebuilt? (mtime)
journalctl -u kerchunk-kiosk -b | grep 'engine:' # wideband (or native alias)
# scanner + weather helpers, both kerchunk-dsp; weather shows the 250 kHz
# rate + SAME flags:
pgrep -a kerchunk-dsp
# scanner helper at normal priority, weather helper niced down (19):
ps -o pid,ni,cmd -C kerchunk-dsp
# watch a minute or two for watchdog/backoff noise — none of these should
# appear during ordinary operation:
journalctl -u kerchunk-kiosk -f   # grep -E 'respawn|no "ready" within|helper silent for|NO_DEVICE'
```

A channel edit or bank toggle through the admin UI should re-point the live
helper (`retune`), not respawn it — confirm the scanner `kerchunk-dsp` PID
from `pgrep -a kerchunk-dsp` is unchanged after making one.

Notes:

- The weather radio runs its narrow front-end at 250 kHz with 2 lane slots
  (`WEATHER_RATE_HZ` / `WEATHER_LANES` in `kiosk/src/backend/index.ts`) —
  kerchunk-dsp lanes must land on a multiple of 50 kHz.
- **Scanner group shape** — three `config.scan` knobs decide how many groups
  the scan cycle hops through (fewer groups = a shorter cycle = fewer missed
  transmissions). Omitted = today's defaults:

  | `config.scan` | helper flag | default | range |
  | --- | --- | --- | --- |
  | `lanesPerGroup` | `--lanes` | 32 | 1…64 (kerchunk-dsp `MAX_LANES`) |
  | `sampleRateHz` | `--rate` | 2 500 000 | 950 000…3 200 000, multiple of 50 000 (above ~2 560 000 RTL dongles tend to drop samples) |
  | `windowBandwidthHz` | (grouping only) | 2 400 000 (RTL edge roll-off: floor −1.4 dB at ±1.0 MHz, −4.8 dB at ±1.2 MHz; 2 200 000 keeps edges within ~3.5 dB) | ≤ `sampleRateHz` − 50 000 |

  `lanesPerGroup` caps channels per group; `windowBandwidthHz` caps a group's
  span. The schema rejects a window wider than the rate minus one 50 kHz lane
  (edge channels can't be placed), using the defaults for omitted fields — so
  raising the window past 2.35 MHz needs a higher rate too. Changing
  `lanesPerGroup` or `sampleRateHz` via `PUT /api/config` respawns only the
  scanner helper (both are spawn args); the weather helper pins its own.
- The quieting knob is `scan.nativeQuietDb` (the helper's own dB scale,
  default −6; lower = stricter), exposed in the admin as "Quieting
  threshold". Legacy configs may still hold the retired GNU-Radio-scale
  `noiseQuietDb` / `detectVia`; the schema strips them on load.
- `scan.nativeAmGainDb` (dB, −30…+20, default 0) balances airband/AM loudness
  against FM by ear; passed to the helper as `--am-gain-db`. Changing either
  knob via `PUT /api/config` restarts only the (cheap) helper.
- `scan.fmAudioLpfHz` (Hz, 1000…24000, default 2700 — GNU Radio `nbfm_rx`
  parity) is the FM speaker low-pass: the weak-signal hiss knob. Lower = less
  hiss, duller voice; passed as `--audio-lpf-hz`. Same helper-only restart.
- `scan.fmAudioHpfHz` (Hz, 0 = off or 50…1000, default 300) is the FM speaker
  high-pass: a 6th-order Butterworth that strips the sub-audible CTCSS tone
  (67–254 Hz hum) from the speaker. Passed as `--audio-hpf-hz`.
- **Speaker loudness** is a feed-forward AGC/compressor on the demodulated
  audio (every transmission starts at 0 dB and is steered to a target; pauses
  below a hold level freeze it so gaps never pump the gain up) followed by a
  peak limiter ahead of the 0.8 hard rail. It replaced the per-channel
  `levelTrimDb` learner — configs still carrying that field parse fine (the
  schema strips it). Knobs, all optional under `config.audio` (omitted = the
  helper default in `kiosk/native/src/constants.hpp`):

  | `config.audio` | helper flag | default | range |
  | --- | --- | --- | --- |
  | `agcTargetDb` | `--agc-target-db` | −18 dBFS (mean square) | −40…−3 |
  | `agcMaxGainDb` | `--agc-max-gain-db` | 15 dB | 0…30 |
  | `agcMinGainDb` | `--agc-min-gain-db` | −20 dB | −40…0 |
  | `agcAttackMs` | `--agc-attack-ms` | 10 ms | 1…200 |
  | `agcReleaseMs` | `--agc-release-ms` | 400 ms | 20…5000 |
  | `agcHoldBelowDb` | `--agc-hold-below-db` | −50 dBFS | −90…−20 |
  | `limiterCeiling` | `--limiter-ceiling` | 0.7 (linear FS) | >0…0.8 |
  | `limiterReleaseMs` | `--limiter-release-ms` | 50 ms | 5…1000 |

  They reach the scanner helper only (the weather helper has no speaker).
  Changing any of them via `PUT /api/config` respawns only the scanner helper,
  like `audio.remoteListening`; volume/mute stay live with no respawn.
  Setting `agcMaxGainDb` and `agcMinGainDb` both to 0 pins the AGC at unity
  (effectively off). `scan.nativeAmGainDb` remains the AM pre-gain into it.
- The two liveness watchdogs (no `"ready"` within `readyTimeoutMs`, and no
  helper event other than a log line within `silenceTimeoutMs`) live as
  `DEFAULT_READY_TIMEOUT_MS`/`DEFAULT_SILENCE_TIMEOUT_MS` in
  `kiosk/src/backend/engine/WidebandEngine.ts` (10 s / 5 s). Operator knobs:
  `scan.helperReadyTimeoutMs` / `scan.helperSilenceTimeoutMs` (ms, 1000…120000),
  applied to both helpers at engine construction — a backend restart, not a
  config PUT, picks them up.
- **Squelch-calibration log** — `txstats.jsonl`, next to `config.json`
  (`/var/lib/kerchunk-kiosk/txstats.jsonl` on the appliance; scanner helper
  only). One JSON line per carrier episode: a lane's power crossed the open
  threshold, and the line records whether the quieting check let it open, how
  long it lasted (`polls`, 10 ms each), its quieting p10/p50/p90 and power
  above floor. Rejected carriers shorter than 100 ms aren't logged. It's the
  data for setting `scan.nativeQuietDb` from real traffic; analyse it with
  `/usr/bin/python3 kiosk/bench/squelch_calibrate.py
  /var/lib/kerchunk-kiosk/txstats.jsonl`. Rotates to `txstats.jsonl.1` past
  20 MB (`TXSTATS_MAX_BYTES`, `kiosk/src/backend/engine/txStats.ts`).
  Instrumentation only — it changes no squelch or audio behavior.

## Legacy: remote Pi deploy

`kiosk/scripts/deploy.sh` and the `.githooks/post-merge` auto-deploy hook are
from the earlier remote-Pi era: they SSH to a Pi (`KERCHUNK_PI_HOST`, default
`admin@192.168.1.54`), reset its clone to `origin/main`, build, install to
`/opt/kerchunk-kiosk`, and restart the services. `scripts/setup-pi.sh` at the
repo root is the matching Pi-era bench bootstrap. None of these are active on
the appliance (`core.hooksPath` is unset), and no Pi target currently exists —
they're kept for a possible future Pi-class install.
