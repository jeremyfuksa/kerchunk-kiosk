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
  | `flatBandwidthHz` | (grouping only) | 2 000 000 | the RTL's flat passband: grouping keeps channels inside ±flat/2 of the tune center and ≥ 25 kHz off the DC spike wherever it costs no extra group |

  `lanesPerGroup` caps channels per group; `windowBandwidthHz` caps a group's
  span. The schema rejects a window wider than the rate minus one 50 kHz lane
  (edge channels can't be placed), using the defaults for omitted fields — so
  raising the window past 2.35 MHz needs a higher rate too. Changing
  `lanesPerGroup` or `sampleRateHz` via `PUT /api/config` respawns only the
  scanner helper (both are spawn args); the weather helper pins its own.
- **Scan scheduling** — Node-side hop timing (`WidebandEngine`'s dwell timer,
  math in `kiosk/src/backend/engine/scanSchedule.ts`). A `PUT /api/config`
  applies these live: no helper respawn, no tune.

  | `config.scan` | default | range | effect |
  | --- | --- | --- | --- |
  | `autoDwell.enabled` | `true` | bool | scale each group's quiet dwell by its recent traffic; `false` = plain `groupDwellMs` × bank `dwellWeight` |
  | `autoDwell.halfLifeMin` | 30 | 1…1440 | half-life (minutes) of the per-group decayed open count |
  | `autoDwell.minFactor` | 0.5 | 0.2…1 | floor for an idle group (never below 1 s absolute) |
  | `autoDwell.maxFactor` | 2.0 | 1…5 | ceiling for a busy group |
  | `priorityRevisit.enabled` | `true` | bool | peek at groups holding a `priority: true` channel between normal dwells |
  | `priorityRevisit.everyMs` | 8000 | 1000…60000 | quiet non-priority dwell between two peeks |
  | `priorityRevisit.lookMs` | 700 | 300…5000 | length of one peek — must cover the ~0.64 s post-hop warm-up (settle + 500 ms + one 100 ms open poll) |

  factor = clamp((a + 1) / (mean + 1), minFactor, maxFactor), where `a` is the
  group's decayed open count and `mean` the average over all groups — a cold
  start (or a restart; counts live in memory) is 1.0 everywhere. Hold-through
  and `maxHoldMs` are unchanged: dwell only governs quiet windows.

  Priority revisit: after `everyMs` of quiet dwell on non-priority groups the
  radio hops to the next priority group (round-robin across groups) for
  `lookMs`, then returns to the interrupted group with its remaining dwell. An
  open during the look holds like any open (then `lookMs` more after it
  closes). Never while holding an open, on a sweep stop, in monitor mode
  (weather break-in / direct tune), or while the current group is itself a
  priority group. Peeks don't feed `autoDwell`. Cost at defaults: ~15 % of
  scan time on peeks (0.7 / 4.7 s), and each return re-warms the interrupted
  group (~0.6 s deaf) — roughly a quarter of non-priority listening time.
- **Admin:** every knob above (group shape, scheduling, quieting, AM gain, FM
  filters, speaker AGC/limiter, watchdogs) is editable under Settings → **Sound**
  and **Advanced (engine)**. Each band says what a save costs; blank = default.
- The quieting knob is `scan.nativeQuietDb` (the helper's own dB scale,
  default −7; lower = stricter), exposed in the admin as "Quieting
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
- **Sub-audible squelch** is per channel, set in the admin channel drawer's
  Tone select: a CTCSS tone (`ctcssHz`) or a DCS code (`dcsCode`, e.g.
  `023N`/`023I`), never both. The helper decodes both on every open FM lane
  and reports what it hears (the drawer's "Heard:" hint); a squelched channel
  opens only on its tone/code and mutes once it has been gone
  `CTCSS_LOSS_MS` / `DCS_LOSS_MS` (300 / 400 ms). Detector knobs (`CTCSS_*`,
  `DCS_*`, `SUBAUDIO_*`) live in `kiosk/native/src/constants.hpp`. An
  inverted DCS code is identical on air to another normal code (023I = 047N),
  so a heard code always reads in its N form.
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

## Audio mixer

Volume and mute drive an ALSA control via `amixer` on `audio.mixerCard`.
`audio.mixerControl` omitted or `"auto"` targets the live output: `Headphone`
while the card's "Headphone Jack" reads plugged, otherwise `Master` (also the
fallback on cards without jack sense). On the appliance's CS4208 the audio
leaves the headphone jack. Master is the codec's virtual master: it doesn't
switch the jack, but its gain adds to Headphone's (the HP DAC gain is
Headphone + Master). So whenever Headphone carries the volume, the backend pins
Master at 0 dB unmuted, or a leftover Master cut would stack on it. The backend polls the
jack every `JACK_POLL_MS` (5 s, `kiosk/src/backend/audio.ts`) and re-applies the
saved volume/mute when the output moves. An explicit control name disables both.

## Legacy: remote Pi deploy

`kiosk/scripts/deploy.sh` and the `.githooks/post-merge` auto-deploy hook are
from the earlier remote-Pi era: they SSH to a Pi (`KERCHUNK_PI_HOST`, default
`admin@192.168.1.54`), reset its clone to `origin/main`, build, install to
`/opt/kerchunk-kiosk`, and restart the services. `scripts/setup-pi.sh` at the
repo root is the matching Pi-era bench bootstrap. None of these are active on
the appliance (`core.hooksPath` is unset), and no Pi target currently exists —
they're kept for a possible future Pi-class install.
