# FFT-Detect for Power (keep per-lane demod) — Design

**Date:** 2026-06-08
**Status:** Approved (pending spec review)

## Goal

Cut the wideband DSP helper's steady-state CPU (and the heat it drives on the
2014 MacBook Pro chassis) by moving **power detection** off the 12 per-lane
probes and onto the single window-wide FFT that already runs for Close Call —
while keeping every per-lane FM demod alive so the crown-jewel **FM-quieting
squelch is untouched**. Target ~2.7 → ~2.0–2.4 cores (≈15–25%), apt-only, no new
build toolchain. Ship behind an off-by-default flag; flip the default only after
an on-bench false-open A/B proves no detection regression.

## Why this approach (and not the others)

A 13-agent architecture study with on-box GNU Radio micro-benchmarks ruled out
every alternative for *this* config (68 channels, irregular offsets, ≤12/window):

- **Pure PFB / WOLA channelizer**: regression to ~3.2–3.5 cores — a uniform
  filterbank is the wrong tool for sparse irregular channels (channels ≤ lanes;
  no channels≫M regime). Off-grid fine-tune + resampler add cost.
- **Demod-on-demand / warm pool**: measured ~1.6–2.2 (not the hoped 0.6–1.0).
  FM-quieting needs a demodulated stream, so every power candidate must hold a
  lane ~100 ms to confirm/reject; ~600 ms cold-lane latency loses kerchunks;
  caps simultaneous opens; spurs thrash the pool.
- **Hybrid coarse-fine PFB**: ~1.7–2.0 but the clean 4-band split is a
  non-integer 12.5:1 decimation that breaks the 48 kHz quad rate everything is
  calibrated to.
- **C++/liquid-dsp rewrite**: ~2.0–2.4 cores but weeks of work re-validating the
  squelch; its real win is 304→~3 threads (loadavg), not cores.
- **Two-stage decimation / drop AM path / kill fast moving-average**: measured
  ~free or net-negative; the decimating FIR is already VOLK-cheap.

Measured cost decomposition (12 lanes, throttled 2.4 MS/s), FULL ≈ 2.97 cores:
- 12× `freq_xlating_fir` ≈ **1.4 cores** — STAYS (the demod lanes need it for
  quieting); not recovered by this change.
- per-lane **power probes** (`mag²` + 2× `moving_average` + probe) ≈ **0.7–0.9
  cores** — this is what FFT-detect removes.
- nbfm demod ≈ 0.075 core/lane (kept); AM chain ≈ 0; quieting probe ≈ 0.05.

The window FFT (`cc_fft` + `mag²`) **already runs** for Close Call (sunk cost);
the only NEW cost is one `moving_average_ff` over its 2048-bin vector ≈
**0.15–0.25 core**. So the net recovery is ≈ 0.7–0.9 (probes removed) − 0.15–0.25
(integration added) ≈ **0.5–0.7 cores**, landing at the ~2.0–2.4 target. (A
standalone FFT-detect chain measured 0.33–0.37 cores and is flat in FFT size and
channel count — but most of that is already paid here.)

## Hard constraints (must not regress)

- **FM-quieting squelch** is measured from the demodulated discriminator's HF
  (>8 kHz) noise band; it CANNOT come from FFT/channel magnitude and must run on
  every detectable channel concurrently (detection precedes audibility,
  first-active-wins). Therefore all 12 `freq_xlating_fir → nbfm_rx` lanes and
  their quieting probes stay exactly as today.
- AM channels (14 of 68) use envelope detection (no quieting) — power-only gate,
  same as today.
- Per-channel loudness leveling, ~30 ms gated fades, hard limiter, first-active
  speaker hold, priority preempt, SAME/EAS demod tap, remote-listening PCM tee,
  Close Call discovery + image rejection, group-hop retune, SKIP, monitor/weather
  mode — all preserved with their exact inputs.

## Architecture

Detection's *power input* is swapped behind a flag; everything downstream of the
power scalar is unchanged.

- **Today (lane power):** per lane `freq_xlating_fir → complex_to_mag_squared →
  moving_average ×2 → probe_signal`. 24 probe blocks across 12 lanes ≈ the
  2.1–2.3 cores.
- **New (fft power):** reuse the existing window FFT
  (`cc_s2v → cc_fft(2048, blackmanharris) → cc_mag`), add **one**
  `moving_average_ff` over the 2048-bin vector (~100–200 ms integration) →
  `probe_signal_vf`. The poll loop sums each channel's bin range off that
  integrated vector. When the flag is `fft`, the per-lane power probes are not
  built/connected — that is where the cores are recovered.

### Floor calibration — self-solving for the relative gate

The open test is `power ≥ adaptive_floor + open_db`, i.e. **relative to a floor
learned from the same measurement**. Feeding the floor-learner FFT-derived power
makes the absolute-scale difference (FFT-bin-sum dB vs post-FIR channel dB) wash
out; `open_db` (dB-over-floor) carries over unchanged. The only absolute
threshold, `quiet_db`, belongs to FM-quieting, which stays on the demod path.
No threshold re-derivation is required for the open gate. (A fixed
FFT→channel-power calibration offset was considered as belt-and-suspenders and
deemed unnecessary; the bench A/B will confirm.)

### Bin mapping

`channel_bins(freqHz, centerHz, binHz, fftSize) → [lo, hi]` where
`binHz = sampleRate / fftSize` (2.4e6/2048 ≈ 1171.875 Hz); a 12.5–25 kHz channel
spans ~11–21 bins. Recomputed for every channel on each group-hop `tune()` from
the new center. Sum the **central** bins (optionally Hann-weighted) to limit
adjacent-channel bleed (channels can be only ~12 bins apart in the dense
12-channel windows).

## Components changed

| File | Change |
|---|---|
| `kiosk/src/backend/config/schema.ts` | Add optional `scan.detectVia: "lane" \| "fft"`, default `"lane"`. |
| `kiosk/src/backend/engine/WidebandEngine.ts` | Pass `--detect-via <mode>` to the helper spawn. No logic change. |
| `kiosk/src/backend/engine/wideband_helper.py` | Add the FFT integration block + `probe_signal_vf`; add `channel_bins()` mapper recomputed on `tune()`; in `poll()`, branch the power source on `detect_via`; build/connect the per-lane power probes only in `"lane"` mode. Everything downstream of the power scalar unchanged. |

Both paths coexist; `"lane"` (fixed-12) remains the fully-intact fallback.

### Data flow (fft mode)

`src → cc_fft → mag² → moving_average(vec) → probe_signal_vf` → poll loop sums
per-channel bins → existing floor-learn + open/close state machine → on
candidate-open, the channel's demod-lane **quieting probe** confirms → speaker
hold / leveler / gate / limiter as today.

## Testing

Unit (CI, no hardware):
- `channel_bins()` pure-function tests: in-window, window edges, irregular
  offsets, adjacent-channel spacing (~12 bins apart), out-of-window guard.
- `schema.ts` round-trip for `detectVia`; `WidebandEngine` arg construction
  (`--detect-via` present when set, absent/`lane` by default).
- Floor/open-close state machine fed FFT-sourced power values asserts identical
  open/close decisions to lane-sourced power for a given input series (the state
  machine itself is unchanged).

### GO/NO-GO bench A/B (gate before flipping the default — cool, stable box)

Run both paths against the same live RF over a sustained window, lane path as
ground truth:
- **False-open rate** (FFT opens where lane stays closed — adjacent-bleed risk).
- **Missed-open rate** (FFT misses a real open).
- **Open-latency delta** from the 100–200 ms integration.

PASS = false-open ≤ current AND no missed real transmissions AND latency within
the existing budget. Only then flip the default to `fft`.

## Risks (ranked)

1. **Adjacent-channel bleed** in the dense 12-channel windows — mitigate with
   central/Hann-weighted bin sum; quantified by the bench A/B. *Highest.*
2. **Integration latency** vs the ~30 ms gate feel — tune the window; bench
   measures.
3. **Background/SAME lane** must stay always-demodulated regardless of detection
   path — already true; verify the flag does not disturb it.
4. **Thermal** — implementation + build are off-box; only the bench A/B and
   deploy touch the appliance, done deliberately when cool.

## Out of scope

- Demod-on-demand / warm pool (rejected; latency + simultaneous-open cap).
- Relaxing `MAX_CHANNELS_PER_GROUP` (FFT detection could allow it later; not now).
- The C++/liquid-dsp runtime rewrite and VOLK/thermal-oscillation work (separate
  efforts).
- Flipping the default to `fft` (deferred to a follow-up after the bench A/B).

## Rollout

1. Implement behind `detectVia` (default `lane`); unit tests green; build clean.
   No deploy, no default change.
2. Later, on a cool stable box: run the bench A/B. If PASS, flip default to
   `fft` and deploy; keep `lane` as a documented fallback flag.
