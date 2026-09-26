# Native DSP P1b — Engine + Replay Binary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the P1a DSP core into the `kerchunk-dsp` engine: squelch and speaker logic, speaker and SAME audio paths, Close Call, and the JSON protocol. It ships as a binary that replays a `.cu8` file deterministically. Then it's proven on the real 2 m capture: events, audio you can listen to, and real-time CPU%.

**Architecture:** Everything runs on one DSP thread, driven by the input sample clock (`now = samples / rate`), so replay is deterministic.
- An `Engine` owns a `Channelizer` with 12 fixed lane slots (parked slots sit at offset 0), plus per-slot `ChunkPower` / `FmDiscriminator` / `QuietingMeter` (demod is always on; demod-on-demand was dropped per P1a's results).
- A `Scanner` is a port of `wideband_helper.py`'s `poll()` / `tune()` / `skip()` / `alert_unmute()`, re-timed to 10 ms polls.
- A `SpeakerPath` (audible lane → 48 kHz), a `SamePath` (background lane → 22.05 kHz s16), a `CloseCall` detector, and a `protocol` module using nlohmann-json.
- Live USB/ALSA/fd-3 I/O is **P1c**. Node wiring is **P2**.

**Tech Stack:** C++17, CMake, FFTW3f, nlohmann-json (apt `nlohmann-json3-dev`), pthreads, the in-repo test harness.

**Spec:** `docs/superpowers/specs/2026-09-25-native-dsp-engine-design.md` (§1–§4). Inputs: `kiosk/bench/RESULTS-2026-09-25-native-p1a.md`, and the P1b must-carry list in this plan's Global Constraints.

## Global Constraints

- **Protocol shapes are unchanged from `wideband_helper.py`**, because `WidebandEngine.ts` parses them.
  - Events: `{"ev":"ready"}`, `{"ev":"tuned","centerHz":N}`, `{"ev":"open","id":S,"db":X}` (X rounded to 0.1), `{"ev":"close","id":S}`, `{"ev":"audible","id":S|null}`, `{"ev":"power","levels":{id:dB},"noise":{id:dB}}` (every 200 ms, values rounded to 0.1), `{"ev":"level","id":S,"db":X}`, `{"ev":"rf","id":S,"db":X,"n":K}`, `{"ev":"same","raw":S}`, `{"ev":"closecall","freqHz":N}`, `{"ev":"log","msg":S}`.
  - Commands: `tune{centerHz, channels[{id,freqHz,priority,levelDb,mode,audible,background,openDb,quietDb,hangMs}], monitor, closeCall, closeCallDb, knownHz}`, `known{knownHz}`, `skip{holdoffS?}`, `alert_unmute{id, holdS}`, `quit`.
  - Replay mode adds `"t"` (seconds, 3 decimals) to every event. Node ignores unknown fields.
- **Operator decision C (2026-09-25):** the native engine ignores GNU Radio-era `quietDb` values (the per-channel `quietDb` field). It uses its own calibrated `QUIET_DB_DEFAULT`, overridable only by the native `--quiet-db` flag. The native scale is ~90 dB off GNU Radio's.
- **Invariant:** a `tune` emits `close` for every open lane, then `audible:null` if something was audible, then `tuned`, then the monitor `open`/`audible` if monitor mode.
- **Timing, re-timed from GNU Radio's 20 ms polls to 10 ms:**
  - Poll every 10 ms (one per lane chunk).
  - `OPEN_POLLS = 10` (100 ms), `WARMUP_MS = 500`.
  - Floor α up 0.01005 / down 0.1056 (GR's 0.02 / 0.2 per 20 ms).
  - Leveler: slew down 0.04, slew up 0.02 dB/poll, EMA α 0.01511.
  - RF max 6000 samples, min 50 (GR's 3000 / 25 at 50 Hz).
- **Unchanged dB constants:** `CLOSE_HYST_DB 3`, `GATE_HYST_DB 1`, `QUIET_HYST_DB 2`, `LEVEL_REF_DB −14`, `LEVEL_MIN_DB −40`, `LEVEL_MAX_DB 12`, `LEVEL_DEADBAND_DB 4`, `SKIP_HOLDOFF_S 10`, `AM_GAIN 0.7`, rail ±0.8.
- **Audio:** fade = 288 samples (6 ms at 48 kHz), and only on 0↔non-zero edges. s16 scales: speaker 32767, tee 28000, SAME 16384.
- **Close Call:** 2048-point Blackman-Harris at 20 fps paced start-to-start, averaged per 200 ms check. `CC_CONFIRM 2`, `CC_COOLDOWN_S 300`, `CC_RASTER_HZ 12500`, `CC_IMAGE_REJECT_DB 6`, `CC_GUARD_HZ 12500`, `CC_DC_FRAC 0.02`, `CC_EDGE_FRAC 0.10`. Built only when `--close-call` is given.
- `MAX_LANES = 12`. The background (SAME) channel always takes slot 11.
- **Must-carry items from P1a:**
  - `Channelizer::reset_stream()` on every tune.
  - Per-lane state resets as a unit.
  - `AmEnvelope::reset()` on gate open.
  - FIR/resampler reductions use 8 partial accumulators.
  - No per-hop heap allocation: templated sink, and the Resampler's pointer overload.
  - FTZ/DAZ is set on the DSP thread.
  - `-fcx-limited-range`.
- **Environment:**
  - Python only via `/usr/bin/python3`. The zsh `$VAR` gotcha applies: use arrays.
  - Never stop services or touch SDRs.
  - The real capture `/home/kiosk/kiosk-iq/2m-146033750-2400k.cu8` is read-only. Run each real-capture measurement exactly as many times as the step says.
  - Every commit message ends with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.

## File Structure

- `kiosk/native/src/constants.hpp`: add the engine constants (Task 1) and `QUIET_DB_DEFAULT` (Task 2).
- `kiosk/native/src/channelizer.hpp/.cpp`: templated push, `reset_stream()`, `set_lane_offset()`.
- `kiosk/native/src/fir.cpp`, `resampler.hpp/.cpp`: 8-accumulator reductions, pointer overload.
- `kiosk/native/src/rt.hpp`: `dsp_thread_init()` (FTZ/DAZ).
- `kiosk/native/src/protocol.hpp/.cpp`: command parsing and event helpers.
- `kiosk/native/src/scanner.hpp/.cpp`: squelch and speaker state machine.
- `kiosk/native/src/audio.hpp/.cpp`: `SpeakerPath`, `SamePath`, `to_s16`.
- `kiosk/native/src/closecall.hpp/.cpp`: Close Call detector.
- `kiosk/native/src/engine.hpp/.cpp`: the `Engine` wiring.
- `kiosk/native/app/main.cpp`: the `kerchunk-dsp` binary (replay mode).
- `kiosk/native/tools/quiet_survey.cpp` + `kiosk/bench/native_p1b/quiet_calibrate.py`: the real-RF quieting calibration.
- Tests: `kiosk/native/test/test_{hardening,protocol,scanner,audio,closecall,engine}.cpp`.
- `kiosk/bench/RESULTS-2026-09-25-native-p1b.md`: calibration + replay results.

---

### Task 1: Library hardening + engine constants

**Files:**
- Modify: `kiosk/native/src/channelizer.hpp`, `kiosk/native/src/channelizer.cpp`, `kiosk/native/src/fir.cpp`, `kiosk/native/src/resampler.hpp`, `kiosk/native/src/resampler.cpp`, `kiosk/native/src/constants.hpp`, `kiosk/native/CMakeLists.txt`
- Create: `kiosk/native/src/rt.hpp`
- Test: `kiosk/native/test/test_hardening.cpp`

**Interfaces:**
- Produces:
  - `template <class Sink> void Channelizer::push_u8(const uint8_t*, size_t, Sink&&)`, and the same for `push_cf`. Sink signature unchanged: `(const cf* lanes_out, int lanes, int per_lane, const cf* raw, int raw_n)`.
  - `void Channelizer::reset_stream()`: zero history, `fill_ = 0`, `block_ = 0`.
  - `void Channelizer::set_lane_offset(int i, double off)`: validates like `set_lanes` and resets only lane i. Throws `std::out_of_range` on a bad index.
  - `int Resampler::push(const float* x, int n, float* out, int cap)` and `int Resampler::max_out(int n) const`.
  - `void kc::dsp_thread_init()`.
  - Constants listed in Step 3.

- [ ] **Step 1: Write the failing tests**

`kiosk/native/test/test_hardening.cpp`:

```cpp
#include <algorithm>
#include <cmath>
#include <cstdio>
#include <thread>
#include <vector>

#include "channelizer.hpp"
#include "check.hpp"
#include "constants.hpp"
#include "demod.hpp"
#include "fir.hpp"
#include "meters.hpp"
#include "resampler.hpp"
#include "rt.hpp"
#include "signals.hpp"

TEST(channelizer_reset_stream_forgets_history) {
  constexpr int RATE = 250'000;
  kc::Channelizer ch(RATE);
  ch.set_lanes({50'000});
  auto loud = sig::tone(RATE, RATE / 2, 50'000, 0.5);
  ch.push_cf(loud.data(), loud.size(), [](const kc::cf*, int, int, const kc::cf*, int) {});
  ch.reset_stream();
  std::vector<kc::cf> silence(ch.hop() * 2, kc::cf(0, 0));
  double worst = 0;
  ch.push_cf(silence.data(), silence.size(), [&](const kc::cf* out, int, int per, const kc::cf*, int) {
    for (int d = 0; d < per; d++) worst = std::max(worst, (double)std::abs(out[d]));
  });
  CHECK(worst < 1e-6);   // no leftover tone from before the reset
}

TEST(channelizer_set_lane_offset_retunes_one_lane_only) {
  constexpr int RATE = 250'000;
  auto x = sig::tone(RATE, RATE, 50'000, 0.3);
  sig::add(x, sig::tone(RATE, RATE, -60'000, 0.3));
  kc::Channelizer ch(RATE);
  ch.set_lanes({50'000, 0});
  std::vector<kc::ChunkPower> m(2);
  size_t half = x.size() / 2;
  auto sink = [&](const kc::cf* out, int n_l, int per, const kc::cf*, int) {
    for (int l = 0; l < n_l; l++) m[l].push(out + l * per, per);
  };
  ch.push_cf(x.data(), half, sink);
  CHECK(m[1].slow_db() < -40);                 // lane 1 at DC sees nothing
  ch.set_lane_offset(1, -60'000);
  m[1].reset();
  ch.push_cf(x.data() + half, x.size() - half, sink);
  CHECK_NEAR(m[0].slow_db(), 10 * std::log10(0.09), 0.3);   // lane 0 undisturbed
  CHECK_NEAR(m[1].slow_db(), 10 * std::log10(0.09), 0.3);   // lane 1 now on its tone
  CHECK_THROWS(ch.set_lane_offset(2, 0));
  CHECK_THROWS(ch.set_lane_offset(0, 1e9));
}

TEST(resampler_pointer_overload_matches_vector) {
  kc::Resampler a(24, 25, kc::LANE_RATE, kc::SPEAKER_RS_CUTOFF_HZ, kc::SPEAKER_RS_TRANSITION_HZ);
  kc::Resampler b(24, 25, kc::LANE_RATE, kc::SPEAKER_RS_CUTOFF_HZ, kc::SPEAKER_RS_TRANSITION_HZ);
  std::vector<float> x(1000);
  for (size_t i = 0; i < x.size(); i++) x[i] = (float)std::sin(0.01 * i);
  std::vector<float> va;
  a.push(x.data(), (int)x.size(), va);
  std::vector<float> vb(b.max_out((int)x.size()));
  int nb = b.push(x.data(), (int)x.size(), vb.data(), (int)vb.size());
  CHECK(nb == (int)va.size());
  for (int i = 0; i < nb && i < (int)va.size(); i++) CHECK_NEAR(vb[i], va[i], 1e-6);
}

TEST(dsp_thread_init_flushes_denormals) {
  float out = -1;
  std::thread t([&] {
    kc::dsp_thread_init();
    volatile float tiny = 1e-40f;   // subnormal
    out = tiny * 1.0f;
  });
  t.join();
  CHECK(out == 0.0f);
}

// Quieting anchor through the real channel filter (the calibration starting point).
TEST(quieting_through_channelizer_separates_carrier_and_noise) {
  constexpr int RATE = 250'000;
  auto measure = [&](const std::vector<sig::cf>& x) {
    kc::Channelizer ch(RATE);
    ch.set_lanes({50'000});
    kc::FmDiscriminator d;
    kc::QuietingMeter q;
    ch.push_cf(x.data(), x.size(), [&](const kc::cf* out, int, int per, const kc::cf*, int) {
      for (int i = 0; i < per; i++) q.push(d.step(out[i]));
    });
    return q.db();
  };
  auto carrier = sig::fm_tone(RATE, RATE, 50'000, 3000, 1000, 0.2);
  sig::add(carrier, sig::noise(RATE, 0.01, 11));
  auto noise = sig::noise(RATE, 0.01, 12);
  double c = measure(carrier), n = measure(noise);
  std::printf("  quieting anchor: carrier %.2f dB, noise %.2f dB\n", c, n);
  CHECK(n - c > 20);
  // Hot deviation (5 kHz dev, 3 kHz tone) sits at the channel edge; it must still read as quieted.
  auto hot = sig::fm_tone(RATE, RATE, 50'000, 5000, 3000, 0.2);
  sig::add(hot, sig::noise(RATE, 0.01, 13));
  double h = measure(hot);
  std::printf("  hot-deviation carrier %.2f dB\n", h);
  CHECK(n - h > 15);
}

TEST(fir_partial_accumulators_match_reference) {
  std::vector<float> h = kc::design_lowpass(50'000, 3500, 1500);   // 111 taps: exercises the 8-wide body + tail
  kc::FirFilter f(h);
  std::vector<float> x(500);
  for (size_t i = 0; i < x.size(); i++) x[i] = (float)std::sin(0.37 * i) + 0.1f * (float)(i % 7);
  for (size_t t = 0; t < x.size(); t++) {
    double ref = 0;
    for (size_t k = 0; k < h.size() && k <= t; k++) ref += (double)h[k] * x[t - k];
    CHECK_NEAR(f.step(x[t]), ref, 1e-5);
  }
}
```

Run: `cd /home/kiosk/kerchunk-kiosk/kiosk && npm run test:native`
Expected: FAIL to compile (`rt.hpp` missing; `reset_stream`, `set_lane_offset` and the pointer `push` are undefined).

- [ ] **Step 2: CMake — threads + complex-limited-range**

In `kiosk/native/CMakeLists.txt`, after `add_compile_options(-Wall -Wextra -Wpedantic)` add:

```cmake
# Complex multiply without the C99 inf/NaN recovery path (__mulsc3): only changes results for
# inf/NaN operands, which the DSP never produces, and lets the lane loops vectorize.
add_compile_options(-fcx-limited-range)
find_package(Threads REQUIRED)
```

And change the tests' link line to:

```cmake
target_link_libraries(kerchunk-dsp-tests PRIVATE kcdsp Threads::Threads)
```

- [ ] **Step 3: Engine constants**

Append inside `namespace kc` in `kiosk/native/src/constants.hpp`, before the closing brace:

```cpp
// ---- Engine (P1b). GR ran 20 ms polls; the native engine decides every 10 ms chunk, so the
// per-poll rates below are GR's re-timed to the same wall-clock time constants.
inline constexpr int MAX_LANES = 12;               // fixed lane slots; background/SAME lane = last slot
inline constexpr int POLL_MS = 10;                 // one squelch decision per lane chunk
inline constexpr int OPEN_POLLS = 10;              // 100 ms sustained above threshold to open
inline constexpr double WARMUP_MS = 500;           // per-lane settle time after (re)assignment
inline constexpr int POWER_EVERY_POLLS = 20;       // power telemetry every 200 ms
inline constexpr int CC_EVERY_POLLS = 20;          // Close Call check every 200 ms
inline constexpr double CLOSE_HYST_DB = 3.0;
inline constexpr double GATE_HYST_DB = 1.0;
inline constexpr double QUIET_HYST_DB = 2.0;
inline constexpr double FLOOR_ALPHA_UP = 0.01005;  // GR 0.02 per 20 ms
inline constexpr double FLOOR_ALPHA_DOWN = 0.1056; // GR 0.2 per 20 ms
inline constexpr double LEVEL_REF_DB = -14;
inline constexpr double LEVEL_MIN_DB = -40;
inline constexpr double LEVEL_MAX_DB = 12;
inline constexpr double LEVEL_SLEW_DOWN = 0.04;    // dB per poll (~4 dB/s)
inline constexpr double LEVEL_SLEW_UP = 0.02;      // dB per poll (~2 dB/s)
inline constexpr double LEVEL_EMA_ALPHA = 0.01511; // GR 0.03 per 20 ms (~0.7 s)
inline constexpr double LEVEL_DEADBAND_DB = 4.0;
inline constexpr double LEVEL_EMIT_STEP_DB = 0.5;
inline constexpr double SKIP_HOLDOFF_S = 10.0;
inline constexpr int RF_MAX_SAMPLES = 6000;        // ~60 s of open-power samples
inline constexpr int RF_MIN_SAMPLES = 50;          // ~0.5 s before an rf estimate is emitted
inline constexpr int FADE_SAMPLES = 288;           // 6 ms at 48 kHz; only on silence edges
inline constexpr float RAIL = 0.8f;                // hard speaker guard
inline constexpr float AM_GAIN = 0.7f;
inline constexpr float SPEAKER_S16_SCALE = 32767.f;
inline constexpr float TEE_S16_SCALE = 28000.f;
inline constexpr float SAME_S16_SCALE = 16384.f;
inline constexpr int CC_FFT = 2048;
inline constexpr int CC_FPS = 20;
inline constexpr int CC_CONFIRM = 2;
inline constexpr double CC_COOLDOWN_S = 300;
inline constexpr double CC_RASTER_HZ = 12500;
inline constexpr double CC_IMAGE_REJECT_DB = 6.0;
inline constexpr double CC_GUARD_HZ = 12500;
inline constexpr double CC_DC_FRAC = 0.02;
inline constexpr double CC_EDGE_FRAC = 0.10;
inline constexpr double CC_DB_DEFAULT = 15.0;
```

- [ ] **Step 4: `rt.hpp`**

```cpp
// Real-time thread setup for the DSP thread.
#pragma once
#include <pmmintrin.h>
#include <xmmintrin.h>

namespace kc {
// Flush-to-zero + denormals-are-zero: IIR tails (de-emphasis, AM carrier) decay into subnormals
// on silence, and Haswell pays ~100x per subnormal op. Call once at the top of the DSP thread.
inline void dsp_thread_init() {
  _MM_SET_FLUSH_ZERO_MODE(_MM_FLUSH_ZERO_ON);
  _MM_SET_DENORMALS_ZERO_MODE(_MM_DENORMALS_ZERO_ON);
}
}  // namespace kc
```

- [ ] **Step 5: Channelizer — template sink, reset_stream, set_lane_offset**

In `channelizer.hpp`, replace the `HopSink` alias and the two `push_*` declarations with:

```cpp
  // lanes_out and raw point into the Channelizer's internal buffers and are valid only for the
  // duration of the callback — do not retain either pointer past the call. Templated on the sink so
  // a capturing lambda is called directly (a std::function would heap-allocate per call).
  // Sink: void(const cf* lanes_out, int lanes, int per_lane, const cf* raw, int raw_n)
  template <class Sink>
  void push_u8(const uint8_t* iq, size_t nsamples, Sink&& sink) {
    const int hop = n_ / 2;
    for (size_t i = 0; i < nsamples; i++) {
      fin_[hop + fill_][0] = lut_[iq[2 * i]];
      fin_[hop + fill_][1] = lut_[iq[2 * i + 1]];
      if (++fill_ == hop) finish_hop(sink);
    }
  }
  template <class Sink>
  void push_cf(const cf* x, size_t nsamples, Sink&& sink) {
    const int hop = n_ / 2;
    for (size_t i = 0; i < nsamples; i++) {
      fin_[hop + fill_][0] = x[i].real();
      fin_[hop + fill_][1] = x[i].imag();
      if (++fill_ == hop) finish_hop(sink);
    }
  }
  // Forget all input history (call after the SDR center frequency changes).
  void reset_stream();
  // Re-point one lane without disturbing the others (Close Call lane assignment).
  void set_lane_offset(int i, double offset_hz);
```

In the `private:` section, replace `void run_hop(const HopSink& sink);` with:

```cpp
  void run_hop();          // FFT + per-lane extract into out_, advances block_
  void advance_hop();      // slide history, fill_ = 0
  Lane make_lane(double offset_hz) const;   // validates and builds one lane
  template <class Sink>
  void finish_hop(Sink& sink) {
    run_hop();
    sink(out_.data(), (int)lanes_.size(), kLaneSamplesPerHop, reinterpret_cast<const cf*>(fin_.get() + n_ / 2), n_ / 2);
    advance_hop();
  }
```

Remove `#include <functional>` if nothing else needs it.

In `channelizer.cpp`:
- Delete the two out-of-line `push_u8`/`push_cf` definitions.
- Split `run_hop` into `run_hop()` (everything up to and including `block_++`) and `advance_hop()` (the memmove + `fill_ = 0`).
- Move the per-offset validation and lane construction from `set_lanes` into `make_lane`, and have `set_lanes` build its local vector with `make_lane` (keeping the validate-all-before-mutate order).
- Add:

```cpp
Channelizer::Lane Channelizer::make_lane(double off) const {
  const double binw = (double)rate_ / n_;
  const double limit = rate_ / 2.0 - LANE_RATE / 2.0;
  if (!std::isfinite(off))
    throw std::invalid_argument("Channelizer: offset " + std::to_string(off) + " Hz is not finite");
  if (std::fabs(off) > limit)
    throw std::invalid_argument("Channelizer: offset " + std::to_string(off) + " Hz exceeds the +-" +
                                std::to_string(limit) + " Hz limit (rate/2 - LANE_RATE/2) at rate " + std::to_string(rate_));
  Lane l;
  l.k0 = (int)std::lround(off / binw);
  double resid = off - l.k0 * binw;
  double w = -2 * M_PI * resid / LANE_RATE;
  l.nco_step = cf((float)std::cos(w), (float)std::sin(w));
  return l;
}

void Channelizer::set_lanes(const std::vector<double>& offsets_hz) {
  std::vector<Lane> lanes;
  lanes.reserve(offsets_hz.size());
  for (double off : offsets_hz) lanes.push_back(make_lane(off));   // throws before any mutation
  lanes_ = std::move(lanes);
  out_.assign(lanes_.size() * kLaneSamplesPerHop, cf(0, 0));
  block_ = 0;
}

void Channelizer::set_lane_offset(int i, double off) {
  if (i < 0 || i >= (int)lanes_.size()) throw std::out_of_range("Channelizer::set_lane_offset: bad lane index");
  lanes_[i] = make_lane(off);
}

void Channelizer::reset_stream() {
  std::memset(fin_.get(), 0, sizeof(fftwf_complex) * n_);
  fill_ = 0;
  block_ = 0;
}

void Channelizer::advance_hop() {
  const int hop = n_ / 2;
  std::memmove(fin_.get(), fin_.get() + hop, sizeof(fftwf_complex) * hop);
  fill_ = 0;
}
```

(`set_lane_offset` keeps the global `block_` parity. A new lane's constant phase offset is harmless.)

- [ ] **Step 6: 8-accumulator reductions and the Resampler pointer overload**

In `fir.cpp`, replace the body of `FirFilter::step` with:

```cpp
float FirFilter::step(float x) {
  buf_[pos_] = x;
  buf_[pos_ + n_] = x;
  const float* w = &buf_[pos_ + 1];
  // 8 independent partial sums: without -ffast-math the compiler may not reassociate a single
  // accumulator, so one sum is a serial add chain; 8 lanes vectorize into one ymm accumulator.
  float a[8] = {0, 0, 0, 0, 0, 0, 0, 0};
  int j = 0;
  for (; j + 8 <= n_; j += 8)
    for (int k = 0; k < 8; k++) a[k] += rev_[j + k] * w[j + k];
  float acc = ((a[0] + a[1]) + (a[2] + a[3])) + ((a[4] + a[5]) + (a[6] + a[7]));
  for (; j < n_; j++) acc += rev_[j] * w[j];
  pos_ = pos_ + 1 == n_ ? 0 : pos_ + 1;
  return acc;
}
```

In `resampler.hpp`, add to the public section:

```cpp
  // Allocation-free variant for the real-time path. Writes at most `cap` outputs to `out`
  // (size it with max_out(n)); returns the number written.
  int push(const float* x, int n, float* out, int cap);
  int max_out(int n) const { return (int)(((long long)n * up_) / down_) + 2; }
```

In `resampler.cpp`, rename the current `push(const float*, int, std::vector<float>&)` body into the pointer overload, replacing `out.push_back(acc)` with `if (emitted < cap) out[emitted] = acc;`. The count is still incremented only when written: `if (emitted < cap) out[emitted++] = acc;`. Also replace its dot product with the same 8-accumulator pattern over `tpp_`. Then re-implement the vector overload on top of it:

```cpp
int Resampler::push(const float* x, int n, std::vector<float>& out) {
  size_t old = out.size();
  out.resize(old + (size_t)max_out(n));
  int got = push(x, n, out.data() + old, max_out(n));
  out.resize(old + (size_t)got);
  return got;
}
```

- [ ] **Step 7: Run all tests, record the anchor, commit**

Run: `cd /home/kiosk/kerchunk-kiosk/kiosk && npm run test:native`
Expected: all tests (the 35 existing plus 6 new) `ok`, warning-free. Record the two `quieting anchor` lines printed by the test in your report; Task 2 uses them.

```bash
git add kiosk/native
git commit -m "feat(native): reset_stream/set_lane_offset, templated hop sink, 8-acc FIR/resampler, FTZ/DAZ, engine constants"
```

---

### Task 2: Quieting calibration on real RF → `QUIET_DB_DEFAULT`

**Files:**
- Create: `kiosk/native/tools/quiet_survey.cpp`, `kiosk/bench/native_p1b/quiet_calibrate.py`, `kiosk/bench/RESULTS-2026-09-25-native-p1b.md`
- Modify: `kiosk/native/CMakeLists.txt` (add the tool), `kiosk/native/src/constants.hpp` (add `QUIET_DB_DEFAULT`)

**Interfaces:**
- Consumes: Channelizer, ChunkPower, FmDiscriminator, QuietingMeter (Task 1 / P1a).
- Produces: `inline constexpr double kc::QUIET_DB_DEFAULT` (the measured value), which Scanner uses in Task 4.

- [ ] **Step 1: The survey tool**

`kiosk/native/tools/quiet_survey.cpp`:

```cpp
// Per-lane power + quieting survey of a .cu8 capture, one CSV row per 100 ms:
// t, then for each lane: slow_db, quiet_db. Feeds kiosk/bench/native_p1b/quiet_calibrate.py.
#include <cstdio>
#include <cstdlib>
#include <string>
#include <vector>

#include "channelizer.hpp"
#include "demod.hpp"
#include "meters.hpp"

int main(int argc, char** argv) {
  std::string file;
  int rate = 2'400'000;
  std::vector<double> chans;
  for (int i = 1; i + 1 < argc; i += 2) {
    std::string k = argv[i], v = argv[i + 1];
    if (k == "--file") file = v;
    else if (k == "--rate") rate = std::atoi(v.c_str());
    else if (k == "--chan") chans.push_back(std::atof(v.c_str()));
    else { std::fprintf(stderr, "unknown arg %s\n", k.c_str()); return 2; }
  }
  if (file.empty() || chans.empty()) { std::fprintf(stderr, "usage: --file F --chan OFF ... [--rate HZ]\n"); return 2; }
  FILE* f = std::fopen(file.c_str(), "rb");
  if (!f) { std::perror(file.c_str()); return 1; }
  kc::Channelizer ch(rate);
  ch.set_lanes(chans);
  const size_t L = chans.size();
  std::vector<kc::ChunkPower> pw(L);
  std::vector<kc::FmDiscriminator> disc(L);
  std::vector<kc::QuietingMeter> q(L);
  long long lane_samples = 0, next_row = kc::LANE_RATE / 10;
  std::printf("t");
  for (double c : chans) std::printf(",p%.0f,q%.0f", c, c);
  std::printf("\n");
  std::vector<uint8_t> buf((size_t)rate / 100 * 2);
  size_t got;
  while ((got = std::fread(buf.data(), 1, buf.size(), f)) >= 2) {
    ch.push_u8(buf.data(), got / 2, [&](const kc::cf* out, int n_l, int per, const kc::cf*, int) {
      for (int l = 0; l < n_l; l++) {
        const kc::cf* y = out + l * per;
        pw[l].push(y, per);
        for (int d = 0; d < per; d++) q[l].push(disc[l].step(y[d]));
      }
      lane_samples += per;
      if (lane_samples >= next_row) {
        next_row += kc::LANE_RATE / 10;
        std::printf("%.2f", (double)lane_samples / kc::LANE_RATE);
        for (size_t l = 0; l < L; l++) std::printf(",%.2f,%.2f", pw[l].slow_db(), q[l].db());
        std::printf("\n");
      }
    });
  }
  std::fclose(f);
  return 0;
}
```

Add to `CMakeLists.txt`, next to the cost-bench block:

```cmake
if(EXISTS ${CMAKE_CURRENT_SOURCE_DIR}/tools/quiet_survey.cpp)
  add_executable(kc-quiet-survey ${CMAKE_CURRENT_SOURCE_DIR}/tools/quiet_survey.cpp)
  target_link_libraries(kc-quiet-survey PRIVATE kcdsp)
endif()
```

- [ ] **Step 2: The calibration script**

`kiosk/bench/native_p1b/quiet_calibrate.py`:

```python
"""Pick the native quieting threshold from a quiet_survey CSV.
Per lane: floor = 10th percentile of slow power. Keyed windows: slow > floor + 9 dB.
Dead windows: slow < floor + 3 dB. Threshold = midpoint between keyed p95 and dead p5 of
quiet_db (lower quiet_db = quieter), if they separate. Run: /usr/bin/python3 quiet_calibrate.py survey.csv"""
import csv, sys
import numpy as np

rows = list(csv.reader(open(sys.argv[1])))
hdr, data = rows[0], np.array([[float(v) for v in r] for r in rows[1:]])
data = data[5:]                     # skip warm-up rows (first 0.5 s)
keyed, dead = [], []
for c in range(1, len(hdr), 2):
    p, q = data[:, c], data[:, c + 1]
    floor = np.percentile(p, 10)
    keyed += list(q[p > floor + 9])
    dead += list(q[p < floor + 3])
print(f"windows: keyed={len(keyed)} dead={len(dead)}")
if dead:
    print(f"dead quiet_db  p5={np.percentile(dead, 5):.2f} p50={np.percentile(dead, 50):.2f}")
if keyed:
    print(f"keyed quiet_db p50={np.percentile(keyed, 50):.2f} p95={np.percentile(keyed, 95):.2f}")
if len(keyed) >= 20 and dead:
    hi, lo = np.percentile(keyed, 95), np.percentile(dead, 5)
    if hi < lo:
        print(f"RECOMMEND QUIET_DB_DEFAULT={round((hi + lo) / 2 * 2) / 2:.1f} (keyed p95 {hi:.2f} < dead p5 {lo:.2f})")
    else:
        print(f"NO SEPARATION keyed p95 {hi:.2f} >= dead p5 {lo:.2f}")
else:
    print("INSUFFICIENT KEYED WINDOWS")
```

- [ ] **Step 3: Run the survey on the real capture (once)**

```bash
cd /home/kiosk/kerchunk-kiosk/kiosk && npm run build:native
CH=(--chan -903750 --chan -883750 --chan -723750 --chan -563750 --chan 486250 --chan 591250 --chan 603750 --chan 666250 --chan 728750 --chan 756250 --chan 903750)
native/build/kc-quiet-survey --file /home/kiosk/kiosk-iq/2m-146033750-2400k.cu8 "${CH[@]}" > /home/kiosk/kiosk-iq/2m-quiet-survey.csv
/usr/bin/python3 bench/native_p1b/quiet_calibrate.py /home/kiosk/kiosk-iq/2m-quiet-survey.csv
```

- [ ] **Step 4: Set `QUIET_DB_DEFAULT`**

Pick the value by this rule:
- If the script prints `RECOMMEND QUIET_DB_DEFAULT=X`, use X.
- Otherwise (`NO SEPARATION` or `INSUFFICIENT KEYED WINDOWS`), use the midpoint of Task 1's synthetic anchor (carrier dB and noise dB from the `quieting anchor` line), rounded to 0.5 dB, and say so in the results.

Append to `constants.hpp`, right after `QUIET_HYST_DB`:

```cpp
// Native quieting threshold (dB of discriminator HF-noise power; lower = more quieted). NOT the GR
// scale (~90 dB apart): GR measured after nbfm_rx's audio LPF. Calibrated 2026-09-25 from
// kiosk/bench/RESULTS-2026-09-25-native-p1b.md; re-checked by ear at the P3 A/B.
inline constexpr double QUIET_DB_DEFAULT = <X>;
```

Here `<X>` is the value you just derived, written as a number.

- [ ] **Step 5: Write the results file (calibration section)**

`kiosk/bench/RESULTS-2026-09-25-native-p1b.md`:

```markdown
# Native DSP P1b — results — 2026-09-25

## Quieting calibration (QUIET_DB_DEFAULT)

Capture: KIOSK01 2 m group, 146.03375 MHz, 2.4 Msps, 30 s. Tool: kc-quiet-survey, 11 lanes, 100 ms rows.
Script output:
<paste the quiet_calibrate.py output verbatim>

Synthetic anchor (test_hardening): carrier <c> dB, noise <n> dB, hot-deviation <h> dB.

Chosen: QUIET_DB_DEFAULT = <X> — <one sentence: from real RF separation, or synthetic midpoint because <reason>>.
The GR-era `noiseQuietDb` (-86 default, per-bank overrides) does not apply to the native engine (decision C).
```

Fill every `<…>` with the measured values.

- [ ] **Step 6: Build, test, commit**

Run: `npm run test:native`. Expected: all pass.

```bash
git add kiosk/native kiosk/bench/native_p1b kiosk/bench/RESULTS-2026-09-25-native-p1b.md
git commit -m "feat(native): calibrate native quieting threshold on real RF (QUIET_DB_DEFAULT)"
```

---

### Task 3: Protocol module (nlohmann-json)

**Files:**
- Create: `kiosk/native/src/protocol.hpp`, `kiosk/native/src/protocol.cpp`
- Modify: `kiosk/native/CMakeLists.txt`, `.github/workflows/ci.yml` (the apt list in the `native` job)
- Test: `kiosk/native/test/test_protocol.cpp`

**Interfaces:**
- Produces:

```cpp
namespace kc {
struct ChannelCmd { std::string id; double freq_hz = 0; bool priority = false; double level_db = 0;
                    std::string mode = "nfm"; bool audible = true; bool background = false;
                    std::optional<double> open_db, hang_ms; };   // quietDb parsed and ignored (decision C)
struct TuneCmd { double center_hz = 0; std::vector<ChannelCmd> channels; bool monitor = false;
                 bool close_call = false; double close_call_db = CC_DB_DEFAULT; std::vector<double> known_hz; };
struct KnownCmd { std::vector<double> known_hz; };
struct SkipCmd { double holdoff_s = SKIP_HOLDOFF_S; };
struct AlertUnmuteCmd { std::string id; double hold_s = 30.0; };
struct QuitCmd {};
using Command = std::variant<TuneCmd, KnownCmd, SkipCmd, AlertUnmuteCmd, QuitCmd>;
std::optional<Command> parse_command(const std::string& line, std::string& err);
nlohmann::json num(double v);       // integral values -> int64 JSON, else double
double round1(double v);            // round to 0.1
std::string to_line(const nlohmann::json& ev);   // compact dump + "\n"
}
```

- [ ] **Step 1: Install and link nlohmann-json**

Run: `sudo apt-get install -y nlohmann-json3-dev`.

In `CMakeLists.txt`, after `pkg_check_modules(...)`:

```cmake
find_package(nlohmann_json 3.2 REQUIRED)
```

and change the library link line to:

```cmake
target_link_libraries(kcdsp PUBLIC PkgConfig::FFTW3F nlohmann_json::nlohmann_json m)
```

In `.github/workflows/ci.yml`, in the `native` job's install step, add `nlohmann-json3-dev` to the `apt-get install` list.

- [ ] **Step 2: Failing tests**

`kiosk/native/test/test_protocol.cpp`:

```cpp
#include <variant>

#include "check.hpp"
#include "protocol.hpp"

TEST(protocol_parses_full_tune) {
  std::string err;
  auto c = kc::parse_command(
      R"({"cmd":"tune","centerHz":146033750,"channels":[{"id":"a","freqHz":146520000,"priority":true,)"
      R"("levelDb":-2.5,"mode":"am","audible":false,"openDb":12,"quietDb":-86,"hangMs":1500},)"
      R"({"id":"nwr","freqHz":162550000,"background":true}],"monitor":false,"closeCall":true,"closeCallDb":18,"knownHz":[1,2]})",
      err);
  CHECK(c.has_value());
  const auto& t = std::get<kc::TuneCmd>(*c);
  CHECK_NEAR(t.center_hz, 146033750, 0);
  CHECK(t.channels.size() == 2);
  CHECK(t.channels[0].id == "a" && t.channels[0].priority && t.channels[0].mode == "am" && !t.channels[0].audible);
  CHECK_NEAR(*t.channels[0].open_db, 12, 0);
  CHECK_NEAR(*t.channels[0].hang_ms, 1500, 0);
  CHECK_NEAR(t.channels[0].level_db, -2.5, 0);
  CHECK(t.channels[1].background && !t.channels[1].open_db);
  CHECK(t.close_call && t.known_hz.size() == 2);
  CHECK_NEAR(t.close_call_db, 18, 0);
}

TEST(protocol_parses_small_commands_and_defaults) {
  std::string err;
  CHECK(std::holds_alternative<kc::QuitCmd>(*kc::parse_command(R"({"cmd":"quit"})", err)));
  auto s = kc::parse_command(R"({"cmd":"skip"})", err);
  CHECK_NEAR(std::get<kc::SkipCmd>(*s).holdoff_s, kc::SKIP_HOLDOFF_S, 0);
  auto s2 = kc::parse_command(R"({"cmd":"skip","holdoffS":3600})", err);
  CHECK_NEAR(std::get<kc::SkipCmd>(*s2).holdoff_s, 3600, 0);
  auto a = kc::parse_command(R"({"cmd":"alert_unmute","id":"x","holdS":45})", err);
  CHECK(std::get<kc::AlertUnmuteCmd>(*a).id == "x");
  auto k = kc::parse_command(R"({"cmd":"known","knownHz":[5,6,7]})", err);
  CHECK(std::get<kc::KnownCmd>(*k).known_hz.size() == 3);
}

TEST(protocol_rejects_garbage_without_throwing) {
  std::string err;
  CHECK(!kc::parse_command("not json", err));
  CHECK(!err.empty());
  CHECK(!kc::parse_command(R"({"cmd":"launch"})", err));
  CHECK(!kc::parse_command(R"({"cmd":"tune","centerHz":"x"})", err));
  CHECK(!kc::parse_command(R"([1,2])", err));
}

TEST(protocol_event_formatting) {
  CHECK(kc::to_line({{"ev", "tuned"}, {"centerHz", kc::num(146033750.0)}}) == "{\"centerHz\":146033750,\"ev\":\"tuned\"}\n");
  CHECK(kc::to_line({{"ev", "audible"}, {"id", nullptr}}) == "{\"ev\":\"audible\",\"id\":null}\n");
  CHECK_NEAR(kc::round1(-42.349), -42.3, 1e-9);
  CHECK(kc::num(1.5).is_number_float());
}
```

Run `npm run test:native`. Expected: FAIL to compile (`protocol.hpp` missing).

- [ ] **Step 3: Implement**

`kiosk/native/src/protocol.hpp`:

```cpp
// stdin commands / stdout events between Node (WidebandEngine.ts) and kerchunk-dsp.
// Shapes match wideband_helper.py exactly.
#pragma once
#include <nlohmann/json.hpp>
#include <optional>
#include <string>
#include <variant>
#include <vector>

#include "constants.hpp"

namespace kc {
struct ChannelCmd {
  std::string id;
  double freq_hz = 0;
  bool priority = false;
  double level_db = 0;
  std::string mode = "nfm";
  bool audible = true;
  bool background = false;
  std::optional<double> open_db, hang_ms;   // quietDb is parsed and ignored (decision C: GR scale)
};
struct TuneCmd {
  double center_hz = 0;
  std::vector<ChannelCmd> channels;
  bool monitor = false;
  bool close_call = false;
  double close_call_db = CC_DB_DEFAULT;
  std::vector<double> known_hz;
};
struct KnownCmd { std::vector<double> known_hz; };
struct SkipCmd { double holdoff_s = SKIP_HOLDOFF_S; };
struct AlertUnmuteCmd { std::string id; double hold_s = 30.0; };
struct QuitCmd {};
using Command = std::variant<TuneCmd, KnownCmd, SkipCmd, AlertUnmuteCmd, QuitCmd>;

// nullopt + err on malformed JSON, unknown cmd, or wrong field types. Never throws.
std::optional<Command> parse_command(const std::string& line, std::string& err);
nlohmann::json num(double v);
double round1(double v);
std::string to_line(const nlohmann::json& ev);
}  // namespace kc
```

`kiosk/native/src/protocol.cpp`:

```cpp
#include "protocol.hpp"

#include <cmath>

namespace kc {
using nlohmann::json;

namespace {
template <class T>
T get_or(const json& j, const char* key, T dflt) {
  auto it = j.find(key);
  if (it == j.end() || it->is_null()) return dflt;
  return it->get<T>();
}
std::optional<double> opt_num(const json& j, const char* key) {
  auto it = j.find(key);
  if (it == j.end() || it->is_null()) return std::nullopt;
  return it->get<double>();
}
std::vector<double> num_list(const json& j, const char* key) {
  std::vector<double> out;
  auto it = j.find(key);
  if (it == j.end() || it->is_null()) return out;
  for (const auto& v : *it) out.push_back(v.get<double>());
  return out;
}
}  // namespace

std::optional<Command> parse_command(const std::string& line, std::string& err) {
  try {
    json j = json::parse(line);
    if (!j.is_object()) { err = "command is not an object"; return std::nullopt; }
    const std::string cmd = get_or<std::string>(j, "cmd", "");
    if (cmd == "quit") return Command{QuitCmd{}};
    if (cmd == "known") return Command{KnownCmd{num_list(j, "knownHz")}};
    if (cmd == "skip") return Command{SkipCmd{get_or<double>(j, "holdoffS", SKIP_HOLDOFF_S)}};
    if (cmd == "alert_unmute") return Command{AlertUnmuteCmd{j.at("id").get<std::string>(), get_or<double>(j, "holdS", 30.0)}};
    if (cmd == "tune") {
      TuneCmd t;
      t.center_hz = j.at("centerHz").get<double>();
      t.monitor = get_or<bool>(j, "monitor", false);
      t.close_call = get_or<bool>(j, "closeCall", false);
      t.close_call_db = get_or<double>(j, "closeCallDb", CC_DB_DEFAULT);
      t.known_hz = num_list(j, "knownHz");
      if (auto it = j.find("channels"); it != j.end() && !it->is_null()) {
        for (const auto& c : *it) {
          ChannelCmd ch;
          ch.id = c.at("id").get<std::string>();
          ch.freq_hz = c.at("freqHz").get<double>();
          ch.priority = get_or<bool>(c, "priority", false);
          ch.level_db = get_or<double>(c, "levelDb", 0.0);
          ch.mode = get_or<std::string>(c, "mode", "nfm");
          ch.audible = get_or<bool>(c, "audible", true);
          ch.background = get_or<bool>(c, "background", false);
          ch.open_db = opt_num(c, "openDb");
          ch.hang_ms = opt_num(c, "hangMs");
          t.channels.push_back(std::move(ch));
        }
      }
      return Command{std::move(t)};
    }
    err = "unknown cmd '" + cmd + "'";
    return std::nullopt;
  } catch (const std::exception& e) {
    err = e.what();
    return std::nullopt;
  }
}

json num(double v) {
  if (std::isfinite(v) && std::fabs(v) < 9e15 && v == std::floor(v)) return json((long long)v);
  return json(v);
}

double round1(double v) { return std::round(v * 10.0) / 10.0; }

std::string to_line(const json& ev) { return ev.dump() + "\n"; }
}  // namespace kc
```

- [ ] **Step 4: Run and commit**

Run `npm run test:native`. Expected: all pass, warning-free. Validate `ci.yml` with `/usr/bin/python3 -c "import yaml; yaml.safe_load(open('/home/kiosk/kerchunk-kiosk/.github/workflows/ci.yml'))"`.

```bash
git add kiosk/native .github/workflows/ci.yml
git commit -m "feat(native): JSON protocol (commands + event helpers) via nlohmann-json"
```

---

### Task 4: Scanner — squelch + speaker arbitration state machine

**Files:**
- Create: `kiosk/native/src/scanner.hpp`, `kiosk/native/src/scanner.cpp`
- Test: `kiosk/native/test/test_scanner.cpp`

**Interfaces:**
- Consumes: `ChannelCmd`, `num`, `round1` (Task 3); constants (Tasks 1–2).
- Produces:

```cpp
namespace kc {
struct LaneReading { float fast_db = -200, slow_db = -200, quiet_db = 200; bool quiet_ready = false; };
struct LaneState { std::string id; double freq_hz; bool priority, am, allow_audio, audible_cfg, background;
                   std::optional<double> open_db, hang_ms; /* + detection state */ bool open, carrier, quiet; bool parked() const; };
class Scanner {
 public:
  struct Params { double open_db = 9.0; double quiet_db = QUIET_DB_DEFAULT; double hang_ms = 2000.0; };
  using Emit = std::function<void(const nlohmann::json&)>;
  Scanner(Params p, Emit emit);
  void tune(double center_hz, std::vector<ChannelCmd> channels, bool monitor);
  void poll(double now, const std::vector<LaneReading>& r, float speech_db);   // r.size() == MAX_LANES
  long long skip(double holdoff_s, double now);     // returns the cc freq if a cc lane was skipped, else 0
  void alert_unmute(const std::string& id, double hold_s, double now);
  int assign_cc(long long freq_hz);                  // slot index or -1 (no free slot)
  int audible() const; float gate() const; bool monitor() const;
  const LaneState& lane(int i) const;
  std::vector<double> assigned_freqs() const;
  nlohmann::json power_levels(const std::vector<LaneReading>& r) const;
  nlohmann::json noise_levels(const std::vector<LaneReading>& r) const;
};
}
```

- [ ] **Step 1: Failing tests**

`kiosk/native/test/test_scanner.cpp`:

```cpp
#include <vector>

#include "check.hpp"
#include "constants.hpp"
#include "scanner.hpp"

namespace {
constexpr float FLOOR = -60, KEYED = -40;
const float QUIET = (float)kc::QUIET_DB_DEFAULT - 10, NOISY = (float)kc::QUIET_DB_DEFAULT + 10;

struct Sim {
  std::vector<nlohmann::json> ev;
  kc::Scanner s;
  std::vector<kc::LaneReading> r = std::vector<kc::LaneReading>(kc::MAX_LANES);
  double t = 0;
  float speech = -200;
  explicit Sim(kc::Scanner::Params p = {}) : s(p, [this](const nlohmann::json& e) { ev.push_back(e); }) {
    for (auto& x : r) x = {FLOOR, FLOOR, NOISY, true};
  }
  void set(int i, float db, bool quiet) { r[i] = {db, db, quiet ? QUIET : NOISY, true}; }
  void run(double seconds) {
    int n = (int)(seconds * 1000 / kc::POLL_MS + 0.5);
    for (int k = 0; k < n; k++) { t += kc::POLL_MS / 1000.0; s.poll(t, r, speech); }
  }
  std::vector<nlohmann::json> of(const std::string& type) const {
    std::vector<nlohmann::json> out;
    for (auto& e : ev) if (e["ev"] == type) out.push_back(e);
    return out;
  }
};

kc::ChannelCmd ch(const std::string& id, bool priority = false, bool audible = true) {
  kc::ChannelCmd c; c.id = id; c.freq_hz = 146e6; c.priority = priority; c.audible = audible; return c;
}
}  // namespace

TEST(scanner_tune_emits_tuned_and_slots) {
  Sim m;
  auto bg = ch("nwr"); bg.background = true;
  m.s.tune(146e6, {ch("a"), bg, ch("b")}, false);
  CHECK(m.of("tuned").size() == 1);
  CHECK(m.s.lane(0).id == "a" && m.s.lane(1).id == "b");
  CHECK(m.s.lane(kc::MAX_LANES - 1).id == "nwr");
  CHECK(m.s.lane(2).parked());
}

TEST(scanner_truncates_oversize_group) {
  Sim m;
  std::vector<kc::ChannelCmd> v;
  for (int i = 0; i < 14; i++) v.push_back(ch("c" + std::to_string(i)));
  m.s.tune(146e6, v, false);
  CHECK(m.of("log").size() == 1);
  CHECK(m.s.lane(kc::MAX_LANES - 1).id == "c11");
}

TEST(scanner_no_open_during_warmup_then_opens_after_100ms) {
  Sim m;
  m.s.tune(146e6, {ch("a")}, false);
  m.set(0, KEYED, true);
  m.run(0.45);
  CHECK(m.of("open").empty());                    // still warming up (500 ms)
  m.set(0, FLOOR, false);
  m.run(0.3);                                     // floor learned
  m.set(0, KEYED, true);
  m.run(0.09);
  CHECK(m.of("open").empty());                    // 9 polls: not yet
  m.run(0.02);
  CHECK(m.of("open").size() == 1);
  CHECK(m.of("audible").back()["id"] == "a");
  CHECK(m.s.gate() > 0.5f);
}

TEST(scanner_power_without_quieting_never_opens) {
  Sim m;
  m.s.tune(146e6, {ch("a")}, false);
  m.run(0.8);
  m.set(0, KEYED, false);
  m.run(1.0);
  CHECK(m.of("open").empty());
}

TEST(scanner_gate_follows_carrier_then_close_after_hang) {
  kc::Scanner::Params p; p.hang_ms = 500;
  Sim m(p);
  m.s.tune(146e6, {ch("a")}, false);
  m.run(0.8);
  m.set(0, KEYED, true);
  m.run(0.5);
  CHECK(m.s.gate() > 0);
  m.set(0, FLOOR, false);
  m.run(0.01);
  CHECK(m.s.gate() == 0.0f);                      // muted within one poll of carrier drop
  CHECK(m.of("close").empty());                   // still in hang
  m.run(0.6);
  CHECK(m.of("close").size() == 1);
  CHECK(m.of("audible").back()["id"].is_null());
}

TEST(scanner_priority_takes_speaker) {
  Sim m;
  m.s.tune(146e6, {ch("a"), ch("p", true)}, false);
  m.run(0.8);
  m.set(0, KEYED, true);
  m.run(0.2);
  CHECK(m.s.audible() == 0);
  m.set(1, KEYED, true);
  m.run(0.2);
  CHECK(m.s.audible() == 1);
}

TEST(scanner_see_only_and_alert_unmute) {
  Sim m;
  m.s.tune(146e6, {ch("s", false, false)}, false);
  m.run(0.8);
  m.set(0, KEYED, true);
  m.run(0.2);
  CHECK(m.of("open").size() == 1);
  CHECK(m.s.audible() == -1);                     // see-only: never speaks
  m.s.alert_unmute("s", 1.0, m.t);
  CHECK(m.s.audible() == 0);
  m.run(1.1);
  CHECK(m.s.audible() == -1);                     // hold expired: configured mute restored
}

TEST(scanner_skip_holdoff_and_cc_park) {
  Sim m;
  m.s.tune(146e6, {ch("a")}, false);
  m.run(0.8);
  m.set(0, KEYED, true);
  m.run(0.2);
  CHECK(m.s.skip(10, m.t) == 0);
  CHECK(m.of("close").size() == 1);
  m.run(1.0);
  CHECK(m.of("open").size() == 1);                // holdoff: no reopen
  int slot = m.s.assign_cc(146012500);
  CHECK(slot == 1);
  CHECK(m.s.lane(1).id == "cc_146012500" && m.s.lane(1).priority);
  m.run(0.8);
  m.set(1, KEYED, true);
  m.run(0.2);
  CHECK(m.s.audible() == 1);                      // cc lane is priority
  CHECK(m.s.skip(300, m.t) == 146012500);
  CHECK(m.s.lane(1).parked());
}

TEST(scanner_tune_closes_open_lanes_before_tuned) {
  Sim m;
  m.s.tune(146e6, {ch("a")}, false);
  m.run(0.8);
  m.set(0, KEYED, true);
  m.run(0.2);
  m.ev.clear();
  m.s.tune(147e6, {ch("b")}, false);
  CHECK(m.ev.size() >= 3);
  CHECK(m.ev[0]["ev"] == "close" && m.ev[0]["id"] == "a");
  CHECK(m.ev[1]["ev"] == "audible" && m.ev[1]["id"].is_null());
  CHECK(m.ev[2]["ev"] == "tuned");
}

TEST(scanner_background_lane_never_opens) {
  Sim m;
  auto bg = ch("nwr"); bg.background = true;
  m.s.tune(162e6, {bg}, false);
  m.run(0.8);
  m.set(kc::MAX_LANES - 1, KEYED, true);
  m.run(1.0);
  CHECK(m.of("open").empty());
}

TEST(scanner_monitor_mode_opens_immediately) {
  Sim m;
  m.s.tune(162e6, {ch("wx")}, true);
  auto o = m.of("open");
  CHECK(o.size() == 1 && o[0]["db"] == 0);
  CHECK(m.s.audible() == 0 && m.s.gate() > 0);
  m.run(1.0);
  CHECK(m.of("close").empty());                   // no squelch in monitor mode
}

TEST(scanner_rf_and_level_events) {
  Sim m;
  m.s.tune(146e6, {ch("a")}, false);
  m.run(0.8);
  m.set(0, KEYED, true);
  m.speech = -2;                                  // loud talker: leveler should pull gain down
  m.run(3.0);
  CHECK(!m.of("level").empty());
  CHECK(m.of("level").back()["db"].get<double>() < 0);
  m.set(0, FLOOR, false);
  m.run(2.5);
  auto rf = m.of("rf");
  CHECK(rf.size() == 1 && rf[0]["n"].get<int>() >= kc::RF_MIN_SAMPLES);
  CHECK_NEAR(rf[0]["db"].get<double>(), KEYED, 0.2);
}

TEST(scanner_power_and_noise_levels) {
  Sim m;
  m.s.tune(146e6, {ch("a")}, false);
  auto p = m.s.power_levels(m.r);
  CHECK(p.contains("a") && !p.contains(""));
  CHECK(m.s.noise_levels(m.r).contains("a"));
}
```

Run `npm run test:native`. Expected: FAIL to compile.

- [ ] **Step 2: `scanner.hpp`**

```cpp
// Squelch + speaker arbitration: port of wideband_helper.py poll()/tune()/skip()/alert_unmute(),
// decided every POLL_MS on the DSP thread. Emits protocol events through `emit`.
#pragma once
#include <functional>
#include <nlohmann/json.hpp>
#include <optional>
#include <string>
#include <vector>

#include "constants.hpp"
#include "protocol.hpp"

namespace kc {
struct LaneReading {
  float fast_db = -200, slow_db = -200, quiet_db = 200;
  bool quiet_ready = false;
};

struct LaneState {
  std::string id;  // empty = parked
  double freq_hz = 0;
  bool priority = false, am = false, allow_audio = true, audible_cfg = true, background = false;
  std::optional<double> open_db, hang_ms;
  double alert_until = -1;
  double level_db = 0, level_emitted = 0;
  std::optional<double> speech_db;
  std::optional<double> floor_db;
  bool open = false, carrier = false, quiet = false;
  int above = 0;
  double below_since = -1, skip_until = 0, warmup_s = 0;
  std::vector<float> rf;
  bool parked() const { return id.empty(); }
};

class Scanner {
 public:
  struct Params {
    double open_db = 9.0;
    double quiet_db = QUIET_DB_DEFAULT;
    double hang_ms = 2000.0;
  };
  using Emit = std::function<void(const nlohmann::json&)>;
  Scanner(Params p, Emit emit);

  void tune(double center_hz, std::vector<ChannelCmd> channels, bool monitor);
  void poll(double now, const std::vector<LaneReading>& r, float speech_db);
  long long skip(double holdoff_s, double now);
  void alert_unmute(const std::string& id, double hold_s, double now);
  int assign_cc(long long freq_hz);

  int audible() const { return audible_; }
  float gate() const { return gate_; }
  bool monitor() const { return monitor_; }
  const LaneState& lane(int i) const { return lanes_[i]; }
  std::vector<double> assigned_freqs() const;
  nlohmann::json power_levels(const std::vector<LaneReading>& r) const;
  nlohmann::json noise_levels(const std::vector<LaneReading>& r) const;

 private:
  void assign(int i, const ChannelCmd& c);
  void park(int i) { lanes_[i] = LaneState{}; }
  void set_audible(int i);
  int next_open() const;
  void level(LaneState& L, float speech_db);
  static float level_gain(const LaneState& L);
  void flush_rf(LaneState& L);

  Params p_;
  Emit emit_;
  std::vector<LaneState> lanes_;
  int audible_ = -1;
  float gate_ = 0;
  bool monitor_ = false;
};
}  // namespace kc
```

- [ ] **Step 3: `scanner.cpp`**

```cpp
#include "scanner.hpp"

#include <algorithm>
#include <cmath>

namespace kc {
using nlohmann::json;

Scanner::Scanner(Params p, Emit emit) : p_(p), emit_(std::move(emit)), lanes_(MAX_LANES) {}

void Scanner::assign(int i, const ChannelCmd& c) {
  LaneState L;
  L.id = c.id;
  L.freq_hz = c.freq_hz;
  L.priority = c.priority;
  L.am = c.mode == "am";
  L.allow_audio = L.audible_cfg = c.audible;
  L.background = c.background;
  L.open_db = c.open_db;
  L.hang_ms = c.hang_ms;
  L.level_db = L.level_emitted = c.level_db;
  L.warmup_s = WARMUP_MS / 1000.0;
  lanes_[i] = std::move(L);
}

void Scanner::tune(double center_hz, std::vector<ChannelCmd> channels, bool monitor) {
  // Close every open lane BEFORE the tuned ack: an open already in flight must not leave a stale
  // id in Node's open set with no close ever following (the scanner would park forever).
  for (auto& L : lanes_)
    if (!L.parked() && L.open) emit_({{"ev", "close"}, {"id", L.id}});
  const int n = MAX_LANES;
  if ((int)channels.size() > n) {
    emit_({{"ev", "log"}, {"msg", "group truncated to " + std::to_string(n) + " channels"}});
    channels.resize(n);
  }
  monitor_ = monitor;
  set_audible(-1);
  std::vector<ChannelCmd> bgs, regs;
  for (auto& c : channels) (c.background ? bgs : regs).push_back(c);
  if (!bgs.empty() && (int)regs.size() > n - 1) regs.resize(n - 1);   // the SAME slot is spoken for
  for (int i = 0; i < n; i++) {
    const ChannelCmd* c = nullptr;
    if (i == n - 1 && !bgs.empty()) c = &bgs[0];
    else if (i < (int)regs.size()) c = &regs[i];
    if (c) assign(i, *c); else park(i);
  }
  emit_({{"ev", "tuned"}, {"centerHz", num(center_hz)}});
  if (monitor) {
    // Weather-only: the operator chose this channel; hold it open and audible with no squelch.
    for (int i = 0; i < n; i++) {
      if (lanes_[i].parked()) continue;
      LaneState& L = lanes_[i];
      L.open = L.carrier = L.quiet = true;
      emit_({{"ev", "open"}, {"id", L.id}, {"db", 0}});
      set_audible(i);
      gate_ = level_gain(L);
      break;
    }
  }
}

void Scanner::set_audible(int i) {
  if (audible_ == i) return;
  audible_ = i;
  // Gate follows carrier, not just audibility: an open lane riding its hang time must not blast noise.
  gate_ = (i >= 0 && lanes_[i].carrier) ? level_gain(lanes_[i]) : 0.f;
  if (i >= 0) emit_({{"ev", "audible"}, {"id", lanes_[i].id}});
  else emit_({{"ev", "audible"}, {"id", nullptr}});
}

int Scanner::next_open() const {
  int best = -1;
  for (int i = 0; i < (int)lanes_.size(); i++) {
    const LaneState& L = lanes_[i];
    if (!L.parked() && L.open && L.allow_audio) {
      if (L.priority) return i;
      if (best < 0) best = i;
    }
  }
  return best;
}

float Scanner::level_gain(const LaneState& L) { return (float)std::pow(10.0, L.level_db / 20.0); }

void Scanner::level(LaneState& L, float speech_db) {
  if (speech_db <= LEVEL_MIN_DB) return;   // pause/silence: hold gain
  L.speech_db = L.speech_db ? *L.speech_db + LEVEL_EMA_ALPHA * (speech_db - *L.speech_db) : (double)speech_db;
  double desired = std::clamp((LEVEL_REF_DB - *L.speech_db) / 2, -LEVEL_MAX_DB, LEVEL_MAX_DB);
  double err = desired - L.level_db;
  if (std::fabs(err) > LEVEL_DEADBAND_DB) L.level_db += std::clamp(err, -LEVEL_SLEW_DOWN, LEVEL_SLEW_UP);
  if (std::fabs(L.level_db - L.level_emitted) >= LEVEL_EMIT_STEP_DB) {
    L.level_emitted = L.level_db;
    emit_({{"ev", "level"}, {"id", L.id}, {"db", round1(L.level_db)}});
  }
}

void Scanner::flush_rf(LaneState& L) {
  const int n = (int)L.rf.size();
  if (n >= RF_MIN_SAMPLES && L.id.rfind("cc_", 0) != 0) {
    std::vector<float> s = L.rf;
    std::nth_element(s.begin(), s.begin() + n / 2, s.end());
    emit_({{"ev", "rf"}, {"id", L.id}, {"db", round1(s[n / 2])}, {"n", n}});
  }
  L.rf.clear();
}

void Scanner::poll(double now, const std::vector<LaneReading>& r, float speech_db) {
  if (monitor_) return;
  const double poll_s = POLL_MS / 1000.0;
  const int n = (int)lanes_.size();
  std::vector<std::optional<double>> rd(n);
  for (int i = 0; i < n; i++) {
    LaneState& L = lanes_[i];
    if (L.parked()) continue;
    const double db = r[i].slow_db;
    if (L.warmup_s > 0) {
      L.warmup_s -= poll_s;
      if (L.warmup_s <= 1e-9) L.floor_db = db;   // first trusted reading seeds the floor
      continue;
    }
    rd[i] = db;
    if (!L.floor_db) L.floor_db = db;
    else if (!L.open) *L.floor_db += (db > *L.floor_db ? FLOOR_ALPHA_UP : FLOOR_ALPHA_DOWN) * (db - *L.floor_db);
  }
  std::optional<double> floor;
  for (const auto& L : lanes_)
    if (!L.parked() && L.floor_db) floor = floor ? std::min(*floor, *L.floor_db) : *L.floor_db;
  if (!floor) return;

  for (int i = 0; i < n; i++) {
    LaneState& L = lanes_[i];
    if (L.parked() || !rd[i] || L.background) continue;
    const double open_db = L.open_db.value_or(p_.open_db);
    const double quiet_db = p_.quiet_db;   // decision C: per-channel (GR-scale) quietDb ignored
    const double hang_s = L.hang_ms.value_or(p_.hang_ms) / 1000.0;
    if (L.alert_until >= 0 && now >= L.alert_until) {
      L.alert_until = -1;
      L.allow_audio = L.audible_cfg;
      if (!L.allow_audio && audible_ == i) {
        gate_ = 0;
        set_audible(next_open());
      }
    }
    const double db = *rd[i];
    if (L.open && (int)L.rf.size() < RF_MAX_SAMPLES) L.rf.push_back((float)db);

    const double gate_thresh = *floor + open_db - CLOSE_HYST_DB;
    const double fast = r[i].fast_db;
    L.carrier = L.carrier ? fast > gate_thresh - GATE_HYST_DB / 2 : fast > gate_thresh + GATE_HYST_DB / 2;
    if (!r[i].quiet_ready) L.quiet = false;
    else L.quiet = L.quiet ? r[i].quiet_db < quiet_db + QUIET_HYST_DB / 2 : r[i].quiet_db < quiet_db - QUIET_HYST_DB / 2;
    if (audible_ == i) {
      const bool open_now = L.carrier && L.quiet;
      if (open_now) level(L, speech_db);
      gate_ = open_now ? level_gain(L) : 0.f;
    }

    if (!L.open) {
      if (db > *floor + open_db && L.quiet && now >= L.skip_until) {
        if (++L.above >= OPEN_POLLS) {
          L.open = true;
          L.below_since = -1;
          emit_({{"ev", "open"}, {"id", L.id}, {"db", round1(db)}});
          if (!L.allow_audio) {
          } else if (audible_ < 0) {
            set_audible(i);
          } else if (L.priority && !lanes_[audible_].priority) {
            set_audible(i);
          }
        }
      } else {
        L.above = 0;
      }
    } else if (db < *floor + open_db - CLOSE_HYST_DB) {
      if (L.below_since < 0) L.below_since = now;
      else if (now - L.below_since >= hang_s) {
        L.open = false;
        L.above = 0;
        L.below_since = -1;
        flush_rf(L);
        emit_({{"ev", "close"}, {"id", L.id}});
        if (audible_ == i) set_audible(next_open());
        if (L.id.rfind("cc_", 0) == 0) park(i);   // discovery over: free the slot
      }
    } else {
      L.below_since = -1;
    }
  }
}

long long Scanner::skip(double holdoff_s, double now) {
  const int i = audible_;
  if (i < 0) return 0;
  LaneState& L = lanes_[i];
  const std::string id = L.id;
  L.open = false;
  L.above = 0;
  L.below_since = -1;
  flush_rf(L);
  emit_({{"ev", "close"}, {"id", id}});
  set_audible(next_open());
  if (id.rfind("cc_", 0) == 0) {
    park(i);
    try { return std::stoll(id.substr(3)); } catch (...) { return 0; }
  }
  L.skip_until = now + holdoff_s;
  return 0;
}

void Scanner::alert_unmute(const std::string& id, double hold_s, double now) {
  for (int i = 0; i < (int)lanes_.size(); i++) {
    LaneState& L = lanes_[i];
    if (L.parked() || L.id != id) continue;
    L.allow_audio = true;
    L.alert_until = now + hold_s;
    if (L.open && audible_ != i) set_audible(i);
    break;
  }
}

int Scanner::assign_cc(long long freq_hz) {
  for (int i = 0; i < (int)lanes_.size(); i++) {
    if (!lanes_[i].parked()) continue;
    ChannelCmd c;
    c.id = "cc_" + std::to_string(freq_hz);
    c.freq_hz = (double)freq_hz;
    c.priority = true;   // a live Close Call hit preempts
    assign(i, c);
    return i;
  }
  return -1;
}

std::vector<double> Scanner::assigned_freqs() const {
  std::vector<double> out;
  for (const auto& L : lanes_) if (!L.parked()) out.push_back(L.freq_hz);
  return out;
}

json Scanner::power_levels(const std::vector<LaneReading>& r) const {
  json o = json::object();
  for (int i = 0; i < (int)lanes_.size(); i++) if (!lanes_[i].parked()) o[lanes_[i].id] = round1(r[i].slow_db);
  return o;
}

json Scanner::noise_levels(const std::vector<LaneReading>& r) const {
  json o = json::object();
  for (int i = 0; i < (int)lanes_.size(); i++) if (!lanes_[i].parked()) o[lanes_[i].id] = round1(r[i].quiet_db);
  return o;
}
}  // namespace kc
```

- [ ] **Step 4: Run and commit**

Run `npm run test:native`. Expected: all pass, warning-free. In `scanner_see_only_and_alert_unmute`, `alert_unmute` sets the audible lane immediately because the lane is open; that's GR's behaviour.

```bash
git add kiosk/native/src/scanner.hpp kiosk/native/src/scanner.cpp kiosk/native/test/test_scanner.cpp
git commit -m "feat(native): Scanner — squelch, leveler, speaker arbitration, skip/alert/cc (port of the GR poll loop)"
```

---

### Task 5: SpeakerPath + SamePath

**Files:**
- Create: `kiosk/native/src/audio.hpp`, `kiosk/native/src/audio.cpp`
- Test: `kiosk/native/test/test_audio.cpp`

**Interfaces:**
- Consumes: `Deemphasis`, `AmEnvelope`, `FirFilter`, `design_lowpass`, `MeanSquare`, `Resampler` (pointer overload); constants.
- Produces:

```cpp
namespace kc {
void to_s16(const float* x, int n, float scale, std::vector<int16_t>& out);   // clears out, clamps
class SpeakerPath {
 public:
  SpeakerPath();
  void set_source(int lane, bool am);   // -1 = none; fades out current audio before switching
  void set_gain(float target);          // ramps only on 0<->non-zero edges; re-primes AM on open
  void reset();                         // hard cut to silence (retune)
  int feeding_lane() const;             // which lane's samples process() needs now
  void process(const cf* x, const float* disc, int n, std::vector<float>& out48);   // x/disc may be nullptr
  float speech_db() const;              // pre-gain audio mean square over SPEECH_WINDOW, -200 if not ready
};
class SamePath {
 public:
  SamePath();
  void push(const float* disc, int n, std::vector<int16_t>& out);   // appends 22.05 kHz s16
  void reset();
};
}
```

- [ ] **Step 1: Failing tests**

`kiosk/native/test/test_audio.cpp`:

```cpp
#include <cmath>
#include <vector>

#include "audio.hpp"
#include "check.hpp"
#include "constants.hpp"
#include "demod.hpp"
#include "signals.hpp"

namespace {
// Feed n lane samples of x through a SpeakerPath in 64-sample hops (as the engine does).
std::vector<float> run(kc::SpeakerPath& sp, const std::vector<sig::cf>& x, int lane) {
  kc::FmDiscriminator d;
  std::vector<float> out, disc(64);
  for (size_t i = 0; i + 64 <= x.size(); i += 64) {
    for (int k = 0; k < 64; k++) disc[k] = d.step(x[i + k]);
    bool feed = sp.feeding_lane() == lane;
    sp.process(feed ? &x[i] : nullptr, feed ? disc.data() : nullptr, 64, out);
  }
  return out;
}
}  // namespace

TEST(speaker_fm_level_and_rate) {
  kc::SpeakerPath sp;
  sp.set_source(0, false);
  sp.set_gain(1.0f);
  auto x = sig::fm_tone(kc::LANE_RATE, kc::LANE_RATE, 0, 3000, 1000, 0.3);
  auto y = run(sp, x, 0);
  CHECK(std::abs((int)y.size() - kc::AUDIO_RATE) <= 64);
  // 3 kHz dev -> 0.6 peak; 75 us de-emphasis at 1 kHz ~ -0.86 dB.
  CHECK_NEAR(sig::rms(y.data() + 4800, y.size() - 4800), 0.6 / std::sqrt(2.0) * 0.906, 0.02);
  CHECK(sp.speech_db() > -10 && sp.speech_db() < -7);   // ~-8.3 dB (0.384 rms)
}

TEST(speaker_gain_ramps_on_open_and_rail_clamps) {
  kc::SpeakerPath sp;
  sp.set_source(0, false);
  auto x = sig::tone(kc::LANE_RATE, kc::LANE_RATE / 2, 2500, 0.3);   // constant +0.5 discriminator output
  auto y0 = run(sp, x, 0);                                            // gain 0: silence
  CHECK(sig::rms(y0.data(), y0.size()) < 1e-6);
  sp.set_gain(4.0f);                                                  // 0.5 * 4 = 2 -> rail
  auto y = run(sp, x, 0);
  float peak = 0;
  for (float v : y) peak = std::max(peak, std::fabs(v));
  CHECK(peak <= kc::RAIL + 1e-6f);
  CHECK(std::fabs(y[10]) < std::fabs(y[kc::FADE_SAMPLES + 100]));   // ramping up, not a step
}

TEST(speaker_source_switch_fades_out_first) {
  kc::SpeakerPath sp;
  sp.set_source(0, false);
  sp.set_gain(1.0f);
  auto x = sig::fm_tone(kc::LANE_RATE, kc::LANE_RATE / 5, 0, 3000, 1000, 0.3);
  run(sp, x, 0);
  sp.set_source(1, false);
  CHECK(sp.feeding_lane() == 0);                  // still fading the old source
  std::vector<float> out, disc(64, 0.f);
  int hops = 0;
  while (sp.feeding_lane() == 0 && hops < 20) { sp.process(&x[0], disc.data(), 64, out); hops++; }
  CHECK(sp.feeding_lane() == 1);
  CHECK(hops >= 4 && hops <= 8);                  // ~6 ms fade = ~5 hops of 1.28 ms
}

TEST(speaker_silence_without_source_keeps_rate) {
  kc::SpeakerPath sp;
  std::vector<float> out;
  for (int i = 0; i < 781; i++) sp.process(nullptr, nullptr, 64, out);   // ~1 s
  CHECK(std::abs((int)out.size() - kc::AUDIO_RATE) <= 64);
  CHECK(sig::rms(out.data(), out.size()) == 0.0);
}

TEST(speaker_am_reprimes_on_open) {
  // Long near-silence on an AM lane, then a strong 50%-modulated carrier as the gate opens:
  // without re-priming, env/carrier starts huge (carrier tracked the noise) and slams the rail.
  kc::SpeakerPath sp;
  sp.set_source(0, true);
  std::vector<sig::cf> x(kc::LANE_RATE);
  for (size_t i = 0; i < x.size(); i++) {
    double a = i < x.size() / 2 ? 0.0005 : 0.2 * (1 + 0.5 * std::sin(2 * M_PI * 1000 * i / kc::LANE_RATE));
    x[i] = sig::cf((float)a, 0.f);
  }
  std::vector<float> out, disc(64, 0.f);
  const size_t half = x.size() / 2;
  for (size_t i = 0; i + 64 <= half; i += 64) sp.process(&x[i], disc.data(), 64, out);
  sp.set_gain(1.0f);
  out.clear();
  for (size_t i = half; i + 64 <= x.size(); i += 64) sp.process(&x[i], disc.data(), 64, out);
  const size_t first10ms = kc::AUDIO_RATE / 100;
  CHECK(sig::rms(out.data(), first10ms) < 0.4);   // not rail-slammed (0.8)
  CHECK_NEAR(sig::rms(out.data() + 4800, out.size() - 4800), 0.5 / std::sqrt(2.0) * kc::AM_GAIN, 0.04);
}

TEST(same_path_rate_and_scale) {
  kc::SamePath sp;
  std::vector<float> disc(kc::LANE_RATE);
  for (size_t i = 0; i < disc.size(); i++) disc[i] = 0.5f * (float)std::sin(2 * M_PI * 1000 * i / kc::LANE_RATE);
  std::vector<int16_t> out;
  for (size_t i = 0; i + 64 <= disc.size(); i += 64) sp.push(&disc[i], 64, out);
  CHECK(std::abs((int)out.size() - kc::SAME_RATE) <= 32);
  double s = 0;
  for (size_t i = 2000; i < out.size(); i++) s += (double)out[i] * out[i];
  double rms = std::sqrt(s / (out.size() - 2000)) / kc::SAME_S16_SCALE;
  CHECK_NEAR(rms, 0.5 / std::sqrt(2.0) * 0.906, 0.03);   // de-emphasis at 1 kHz
}

TEST(to_s16_clamps_and_scales) {
  std::vector<int16_t> o;
  float x[4] = {0.f, 0.5f, 2.f, -2.f};
  kc::to_s16(x, 4, 32767.f, o);
  CHECK(o.size() == 4 && o[0] == 0 && o[1] == 16384 && o[2] == 32767 && o[3] == -32768);
}
```

Run: `npm run test:native`. Expected: FAIL to compile.

- [ ] **Step 2: `audio.hpp`**

```cpp
// Speaker path (audible lane -> 48 kHz, gain/fade/rail) and SAME path (background lane -> 22.05 kHz s16).
#pragma once
#include <complex>
#include <cstdint>
#include <vector>

#include "constants.hpp"
#include "demod.hpp"
#include "fir.hpp"
#include "meters.hpp"
#include "resampler.hpp"

namespace kc {
void to_s16(const float* x, int n, float scale, std::vector<int16_t>& out);

class SpeakerPath {
 public:
  SpeakerPath();
  void set_source(int lane, bool am);
  void set_gain(float target);
  void reset();
  int feeding_lane() const { return cur_lane_; }
  void process(const cf* x, const float* disc, int n, std::vector<float>& out48);
  float speech_db() const { return speech_.ready() ? speech_.db() : -200.f; }

 private:
  void apply_target(float t);
  void switch_now();
  int cur_lane_ = -1, want_lane_ = -1;
  bool cur_am_ = false, want_am_ = false, switching_ = false;
  float gain_ = 0, target_ = 0, want_target_ = 0, ramp_step_ = 0;
  int ramp_left_ = 0;
  Deemphasis de_;
  FirFilter lpf_;
  AmEnvelope am_;
  MeanSquare speech_;
  Resampler rs_;
  std::vector<float> a50_, a48_;
};

class SamePath {
 public:
  SamePath();
  void push(const float* disc, int n, std::vector<int16_t>& out);
  void reset();

 private:
  Deemphasis de_;
  FirFilter lpf_;
  Resampler rs_;
  std::vector<float> a_, b_;
  std::vector<int16_t> tmp_;
};
}  // namespace kc
```

- [ ] **Step 3: `audio.cpp`**

```cpp
#include "audio.hpp"

#include <algorithm>
#include <cmath>

namespace kc {

void to_s16(const float* x, int n, float scale, std::vector<int16_t>& out) {
  out.resize(n);
  for (int i = 0; i < n; i++) {
    long v = std::lround(x[i] * scale);
    out[i] = (int16_t)std::clamp(v, -32768L, 32767L);
  }
}

SpeakerPath::SpeakerPath()
    : lpf_(design_lowpass(LANE_RATE, AUDIO_LPF_HZ, AUDIO_LPF_TRANSITION_HZ)),
      speech_(SPEECH_WINDOW),
      rs_(24, 25, LANE_RATE, SPEAKER_RS_CUTOFF_HZ, SPEAKER_RS_TRANSITION_HZ) {
  a50_.resize(256);
  a48_.resize(256);
}

void SpeakerPath::apply_target(float t) {
  if (t == target_) return;
  // AM re-prime on gate open: after silence the carrier tracker followed the noise, so the
  // first ~40-100 ms of a new transmission would be hugely over-gained.
  if (target_ == 0.f && t > 0.f && cur_am_) am_.reset();
  const bool edge = (gain_ == 0.f && t > 0.f) || t == 0.f;
  if (edge) {
    ramp_step_ = (t - gain_) / FADE_SAMPLES;
    ramp_left_ = FADE_SAMPLES;
  } else {
    gain_ = t;
    ramp_left_ = 0;
  }
  target_ = t;
}

void SpeakerPath::set_gain(float target) {
  want_target_ = target;
  if (!switching_) apply_target(target);
}

void SpeakerPath::set_source(int lane, bool am) {
  if (lane == want_lane_ && am == want_am_) return;
  want_lane_ = lane;
  want_am_ = am;
  if (gain_ > 0.f || ramp_left_ > 0) {
    switching_ = true;
    apply_target(0.f);   // fade the old source out first
  } else {
    switch_now();
  }
}

void SpeakerPath::switch_now() {
  cur_lane_ = want_lane_;
  cur_am_ = want_am_;
  switching_ = false;
  de_.reset();
  lpf_.reset();
  am_.reset();
  speech_.reset();
  gain_ = target_ = 0.f;
  ramp_left_ = 0;
  apply_target(want_target_);
}

void SpeakerPath::reset() {
  want_lane_ = -1;
  want_am_ = false;
  want_target_ = 0.f;
  switch_now();
  rs_.reset();
}

void SpeakerPath::process(const cf* x, const float* disc, int n, std::vector<float>& out48) {
  if ((int)a50_.size() < n) a50_.resize(n);
  for (int i = 0; i < n; i++) {
    float a = 0.f;
    if (cur_lane_ >= 0 && x && disc) {
      a = cur_am_ ? am_.step(x[i]) * AM_GAIN : lpf_.step(de_.step(disc[i]));
      speech_.push(a);
    }
    a50_[i] = a;
  }
  const int cap = rs_.max_out(n);
  if ((int)a48_.size() < cap) a48_.resize(cap);
  const int m = rs_.push(a50_.data(), n, a48_.data(), cap);
  for (int i = 0; i < m; i++) {
    if (ramp_left_ > 0) {
      gain_ += ramp_step_;
      if (--ramp_left_ == 0) gain_ = target_;
    }
    out48.push_back(std::clamp(a48_[i] * gain_, -RAIL, RAIL));
  }
  if (switching_ && ramp_left_ == 0 && gain_ == 0.f) switch_now();
}

SamePath::SamePath()
    : lpf_(design_lowpass(LANE_RATE, AUDIO_LPF_HZ, AUDIO_LPF_TRANSITION_HZ)),
      rs_(441, 1000, LANE_RATE, SAME_RS_CUTOFF_HZ, SAME_RS_TRANSITION_HZ) {}

void SamePath::push(const float* disc, int n, std::vector<int16_t>& out) {
  if ((int)a_.size() < n) a_.resize(n);
  for (int i = 0; i < n; i++) a_[i] = lpf_.step(de_.step(disc[i]));
  const int cap = rs_.max_out(n);
  if ((int)b_.size() < cap) b_.resize(cap);
  const int m = rs_.push(a_.data(), n, b_.data(), cap);
  to_s16(b_.data(), m, SAME_S16_SCALE, tmp_);
  out.insert(out.end(), tmp_.begin(), tmp_.end());
}

void SamePath::reset() {
  de_.reset();
  lpf_.reset();
  rs_.reset();
}
}  // namespace kc
```

(`out48.push_back` reuses capacity once the engine keeps `out48` alive and clears it per hop. The engine does this.)

- [ ] **Step 4: Run and commit**

Run `npm run test:native`. Expected: all pass. If `speaker_am_reprimes_on_open` fails, **temporarily** delete the `am_.reset()` line in `apply_target` and confirm the test's first CHECK fails without it (record it in the report), then restore.

```bash
git add kiosk/native/src/audio.hpp kiosk/native/src/audio.cpp kiosk/native/test/test_audio.cpp
git commit -m "feat(native): speaker path (fade/leveler gain/rail, AM re-prime on open) and SAME path"
```

---

### Task 6: Close Call detector

**Files:**
- Create: `kiosk/native/src/closecall.hpp`, `kiosk/native/src/closecall.cpp`
- Test: `kiosk/native/test/test_closecall.cpp`

**Interfaces:**
- Consumes: `FftwBuf`, `FftwPlanPtr` (channelizer.hpp); constants.
- Produces:

```cpp
namespace kc {
class CloseCall {
 public:
  explicit CloseCall(int rate);      // plans FFTW: construct on the thread that built the Channelizer
  void reset(double center_hz);      // new window: clears accumulation and pending
  void set_known(std::vector<double> hz);
  void set_db(double db);
  void push_raw(const cf* x, int n); // full-rate samples; one frame every rate/CC_FPS samples, start-to-start
  std::optional<long long> check(double now, const std::vector<double>& assigned_hz);
  void cooldown(long long freq_hz, double until);
  int frames_since_check() const;
};
}
```

- [ ] **Step 1: Failing tests**

`kiosk/native/test/test_closecall.cpp`:

```cpp
#include <algorithm>
#include <vector>

#include "check.hpp"
#include "closecall.hpp"
#include "constants.hpp"
#include "signals.hpp"

namespace {
constexpr int RATE = 2'400'000;
constexpr double CENTER = 146'000'000;
// Feed `seconds` of x (repeating it) and run a check every 200 ms; return all hits.
std::vector<long long> drive(kc::CloseCall& cc, const std::vector<sig::cf>& x, double seconds, std::vector<double> assigned = {}) {
  std::vector<long long> hits;
  const int per_check = RATE / 5;
  double t = 0;
  for (int k = 0; k < (int)(seconds * 5); k++) {
    for (int done = 0; done < per_check;) {
      int n = std::min<int>((int)x.size(), per_check - done);
      cc.push_raw(x.data(), n);
      done += n;
    }
    t += 0.2;
    if (auto h = cc.check(t, assigned)) hits.push_back(*h);
  }
  return hits;
}
}  // namespace

TEST(closecall_frame_pacing_is_start_to_start) {
  kc::CloseCall cc(RATE);
  cc.reset(CENTER);
  std::vector<sig::cf> z(RATE, sig::cf(0, 0));
  cc.push_raw(z.data(), (int)z.size());
  CHECK(cc.frames_since_check() == kc::CC_FPS);
}

TEST(closecall_confirms_strong_unknown_signal_on_raster) {
  kc::CloseCall cc(RATE);
  cc.reset(CENTER);
  auto x = sig::noise(RATE / 5, 0.01, 1);
  sig::add(x, sig::tone(RATE, x.size(), 600'000, 0.2));
  auto hits = drive(cc, x, 1.0);
  CHECK(hits.size() == 1);                        // confirm x2, then 300 s cooldown
  CHECK(!hits.empty() && hits[0] == 146'600'000);
}

TEST(closecall_suppresses_known_and_assigned) {
  kc::CloseCall cc(RATE);
  cc.reset(CENTER);
  cc.set_known({146'600'000});
  auto x = sig::noise(RATE / 5, 0.01, 2);
  sig::add(x, sig::tone(RATE, x.size(), 600'000, 0.2));
  CHECK(drive(cc, x, 1.0).empty());
  kc::CloseCall cc2(RATE);
  cc2.reset(CENTER);
  CHECK(drive(cc2, x, 1.0, {146'600'000}).empty());
}

TEST(closecall_rejects_tuner_image) {
  kc::CloseCall cc(RATE);
  cc.reset(CENTER);
  cc.set_known({146'600'000});                    // the real signal is known...
  auto x = sig::noise(RATE / 5, 0.01, 3);
  sig::add(x, sig::tone(RATE, x.size(), 600'000, 0.3));
  sig::add(x, sig::tone(RATE, x.size(), -600'000, 0.03));   // ...its mirror image is 20 dB down
  CHECK(drive(cc, x, 1.0).empty());
}

TEST(closecall_ignores_dc_and_edges_and_weak) {
  kc::CloseCall cc(RATE);
  cc.reset(CENTER);
  auto x = sig::noise(RATE / 5, 0.01, 4);
  sig::add(x, sig::tone(RATE, x.size(), 5'000, 0.3));        // DC region
  sig::add(x, sig::tone(RATE, x.size(), 1'150'000, 0.3));    // outer 10%
  sig::add(x, sig::tone(RATE, x.size(), 300'000, 0.0005));   // below floor + db
  CHECK(drive(cc, x, 1.0).empty());
}

TEST(closecall_cooldown_blocks_refire) {
  kc::CloseCall cc(RATE);
  cc.reset(CENTER);
  cc.cooldown(146'600'000, 1e9);
  auto x = sig::noise(RATE / 5, 0.01, 5);
  sig::add(x, sig::tone(RATE, x.size(), 600'000, 0.2));
  CHECK(drive(cc, x, 1.0).empty());
}
```

Run `npm run test:native`. Expected: FAIL to compile.

- [ ] **Step 2: Implement**

`kiosk/native/src/closecall.hpp`:

```cpp
// Close Call: a windowed full-window FFT; a sustained peak well above the median floor on a
// non-configured frequency is a nearby transmission. Port of wideband_helper.py close_call_check().
#pragma once
#include <map>
#include <optional>
#include <utility>
#include <vector>

#include "channelizer.hpp"
#include "constants.hpp"

namespace kc {
class CloseCall {
 public:
  explicit CloseCall(int rate);
  void reset(double center_hz);
  void set_known(std::vector<double> hz) { known_ = std::move(hz); }
  void set_db(double db) { db_ = db; }
  void push_raw(const cf* x, int n);
  std::optional<long long> check(double now, const std::vector<double>& assigned_hz);
  void cooldown(long long freq_hz, double until) { cooldown_[freq_hz] = until; }
  int frames_since_check() const { return frames_; }

 private:
  int rate_;
  long every_;
  long since_;
  int fill_ = 0, frames_ = 0;
  double center_ = 0, db_ = CC_DB_DEFAULT;
  std::vector<float> win_, acc_;
  std::vector<double> known_;
  FftwBuf in_, out_;
  FftwPlanPtr plan_;
  std::map<long long, double> cooldown_;
  std::optional<std::pair<long long, int>> pending_;
};
}  // namespace kc
```

`kiosk/native/src/closecall.cpp`:

```cpp
#include "closecall.hpp"

#include <algorithm>
#include <cmath>

namespace kc {

CloseCall::CloseCall(int rate) : rate_(rate), every_(rate / CC_FPS), since_(rate / CC_FPS), win_(CC_FFT), acc_(CC_FFT, 0.f) {
  for (int i = 0; i < CC_FFT; i++) {
    double r = 2 * M_PI * i / (CC_FFT - 1);
    win_[i] = (float)(0.35875 - 0.48829 * std::cos(r) + 0.14128 * std::cos(2 * r) - 0.01168 * std::cos(3 * r));
  }
  in_.reset(fftwf_alloc_complex(CC_FFT));
  out_.reset(fftwf_alloc_complex(CC_FFT));
  plan_.reset(fftwf_plan_dft_1d(CC_FFT, in_.get(), out_.get(), FFTW_FORWARD, FFTW_MEASURE));
}

void CloseCall::reset(double center_hz) {
  center_ = center_hz;
  std::fill(acc_.begin(), acc_.end(), 0.f);
  frames_ = 0;
  fill_ = 0;
  since_ = every_;
  pending_.reset();
}

void CloseCall::push_raw(const cf* x, int n) {
  for (int i = 0; i < n; i++) {
    if (fill_ == 0) {
      if (since_ < every_) { since_++; continue; }
      since_ = 0;   // frames are paced start-to-start
    }
    since_++;
    in_[fill_][0] = x[i].real() * win_[fill_];
    in_[fill_][1] = x[i].imag() * win_[fill_];
    if (++fill_ == CC_FFT) {
      fftwf_execute(plan_.get());
      for (int k = 0; k < CC_FFT; k++) {
        const int s = (k + CC_FFT / 2) % CC_FFT;   // fftshift: DC at the center bin
        acc_[s] += out_[k][0] * out_[k][0] + out_[k][1] * out_[k][1];
      }
      frames_++;
      fill_ = 0;
    }
  }
}

std::optional<long long> CloseCall::check(double now, const std::vector<double>& assigned_hz) {
  if (frames_ == 0) return std::nullopt;
  std::vector<double> db(CC_FFT);
  for (int k = 0; k < CC_FFT; k++) db[k] = 10 * std::log10(acc_[k] / frames_ + 1e-20);
  std::fill(acc_.begin(), acc_.end(), 0.f);
  frames_ = 0;

  std::vector<double> sorted = db;
  std::nth_element(sorted.begin(), sorted.begin() + CC_FFT / 2, sorted.end());
  const double floor = sorted[CC_FFT / 2];

  std::vector<bool> mask(CC_FFT, true);
  const int edge = (int)(CC_FFT * CC_EDGE_FRAC);
  for (int k = 0; k < edge; k++) mask[k] = mask[CC_FFT - 1 - k] = false;
  const int dc = CC_FFT / 2, dcw = std::max(1, (int)(CC_FFT * CC_DC_FRAC));
  for (int k = dc - dcw; k <= dc + dcw; k++) mask[k] = false;
  const double binw = (double)rate_ / CC_FFT;
  auto suppress = [&](double f) {
    const int b = (int)std::lround((f - center_) / binw) + dc;
    const int g = (int)(CC_GUARD_HZ / binw) + 1;
    for (int k = std::max(0, b - g); k < std::min(CC_FFT, b + g + 1); k++) mask[k] = false;
  };
  for (double f : known_) suppress(f);
  for (double f : assigned_hz) suppress(f);

  int idx = -1;
  for (int k = 0; k < CC_FFT; k++)
    if (mask[k] && (idx < 0 || db[k] > db[idx])) idx = k;
  if (idx < 0) return std::nullopt;
  if (db[idx] < floor + db_) { pending_.reset(); return std::nullopt; }
  // Image rejection: the tuner mirrors strong signals around center; a markedly stronger mirror
  // means the candidate IS the ghost.
  const int mirror = 2 * dc - idx;
  if (mirror >= 0 && mirror < CC_FFT && db[mirror] > db[idx] + CC_IMAGE_REJECT_DB) { pending_.reset(); return std::nullopt; }
  const double f = center_ + (idx - dc) * binw;
  const long long freq = (long long)std::llround(f / CC_RASTER_HZ) * (long long)CC_RASTER_HZ;
  if (auto it = cooldown_.find(freq); it != cooldown_.end() && now < it->second) return std::nullopt;
  if (pending_ && pending_->first == freq) pending_->second++;
  else pending_ = std::make_pair(freq, 1);
  if (pending_->second < CC_CONFIRM) return std::nullopt;
  pending_.reset();
  cooldown_[freq] = now + CC_COOLDOWN_S;
  return freq;
}
}  // namespace kc
```

- [ ] **Step 3: Run and commit**

Run `npm run test:native`. Expected: all pass.

```bash
git add kiosk/native/src/closecall.hpp kiosk/native/src/closecall.cpp kiosk/native/test/test_closecall.cpp
git commit -m "feat(native): Close Call detector (20 fps averaged FFT, masks, image reject, confirm, cooldown)"
```

---

### Task 7: Engine + `kerchunk-dsp` replay binary + real-capture proof

**Files:**
- Create: `kiosk/native/src/engine.hpp`, `kiosk/native/src/engine.cpp`, `kiosk/native/app/main.cpp`
- Modify: `kiosk/native/CMakeLists.txt`, `kiosk/bench/RESULTS-2026-09-25-native-p1b.md`
- Test: `kiosk/native/test/test_engine.cpp`

**Interfaces:**
- Consumes: everything above.
- Produces:

```cpp
namespace kc {
struct EngineOptions { int rate = 2'400'000; Scanner::Params squelch{}; bool close_call = false; bool same = false; };
class Engine {
 public:
  using Emit = std::function<void(const nlohmann::json&)>;
  using Pcm = std::function<void(const int16_t*, int)>;   // may be empty
  Engine(const EngineOptions& o, Emit emit, Pcm speaker, Pcm tee, Pcm same);
  void command(const Command& c);
  void push_u8(const uint8_t* iq, size_t nsamples);
  double now() const;
  bool quit() const;
};
}
```

`kerchunk-dsp --iq-file F --tune JSON [--rate HZ] [--open-db X] [--quiet-db X] [--hang-ms X] [--close-call] [--same-enable] [--audio-out F.s16] [--same-out F.s16] [--realtime]`: writes `ready`, then the tune's events, then all events with `"t"`, one JSON line each, to stdout. Its last stderr line is `REPLAY iq_s=… cpu_s=… core_pct=…`.

- [ ] **Step 1: Failing engine tests**

`kiosk/native/test/test_engine.cpp`:

```cpp
#include <algorithm>
#include <cmath>
#include <vector>

#include "check.hpp"
#include "engine.hpp"
#include "signals.hpp"

namespace {
constexpr int RATE = 250'000;
constexpr double CENTER = 146'000'000;

std::vector<uint8_t> to_u8(const std::vector<sig::cf>& x) {
  std::vector<uint8_t> iq(2 * x.size());
  for (size_t i = 0; i < x.size(); i++) {
    iq[2 * i] = (uint8_t)std::lround(std::clamp(x[i].real() * 127.5f + 127.5f, 0.f, 255.f));
    iq[2 * i + 1] = (uint8_t)std::lround(std::clamp(x[i].imag() * 127.5f + 127.5f, 0.f, 255.f));
  }
  return iq;
}

struct Rig {
  std::vector<nlohmann::json> ev;
  std::vector<int16_t> pcm;
  kc::Engine e;
  explicit Rig(kc::EngineOptions o)
      : e(o, [this](const nlohmann::json& j) { auto k = j; k["t"] = e.now(); ev.push_back(k); },
          [this](const int16_t* p, int n) { pcm.insert(pcm.end(), p, p + n); }, nullptr, nullptr) {}
  void tune(const std::string& json) {
    std::string err;
    auto c = kc::parse_command(json, err);
    CHECK(c.has_value());
    if (c) e.command(*c);
  }
  void feed(const std::vector<sig::cf>& x) {
    auto iq = to_u8(x);
    const size_t slice = RATE / 100;
    for (size_t i = 0; i < x.size(); i += slice) e.push_u8(&iq[2 * i], std::min(slice, x.size() - i));
  }
  std::vector<nlohmann::json> of(const std::string& type) const {
    std::vector<nlohmann::json> out;
    for (auto& j : ev) if (j["ev"] == type) out.push_back(j);
    return out;
  }
  double pcm_rms(double t0, double t1) const {
    size_t a = (size_t)(t0 * kc::AUDIO_RATE), b = std::min(pcm.size(), (size_t)(t1 * kc::AUDIO_RATE));
    double s = 0;
    for (size_t i = a; i < b; i++) s += (double)pcm[i] * pcm[i];
    return b > a ? std::sqrt(s / (b - a)) / 32767.0 : 0;
  }
};

const char* TWO_LANES =
    R"({"cmd":"tune","centerHz":146000000,"channels":[{"id":"a","freqHz":146050000,"hangMs":500},)"
    R"({"id":"b","freqHz":145940000}],"closeCall":false,"knownHz":[146050000,145940000]})";

std::vector<sig::cf> scene(double seconds, unsigned seed) { return sig::noise((size_t)(seconds * RATE), 0.01, seed); }

void burst_fm(std::vector<sig::cf>& x, double off, double t0, double t1) {
  auto fm = sig::fm_tone(RATE, x.size(), off, 3000, 1000, 0.2);
  for (size_t i = (size_t)(t0 * RATE); i < (size_t)(t1 * RATE) && i < x.size(); i++) x[i] += fm[i];
}
}  // namespace

TEST(engine_fm_burst_opens_speaks_mutes_and_closes) {
  kc::EngineOptions o; o.rate = RATE;
  Rig r(o);
  r.tune(TWO_LANES);
  auto x = scene(3.2, 1);
  burst_fm(x, 50'000, 1.0, 2.0);
  r.feed(x);
  CHECK(r.ev.front()["ev"] == "tuned");
  auto op = r.of("open");
  CHECK(op.size() == 1 && op[0]["id"] == "a");
  if (!op.empty()) { CHECK(op[0]["t"].get<double>() > 1.08); CHECK(op[0]["t"].get<double>() < 1.2); }
  auto cl = r.of("close");
  CHECK(cl.size() == 1);
  if (!cl.empty()) { CHECK(cl[0]["t"].get<double>() > 2.5); CHECK(cl[0]["t"].get<double>() < 2.75); }
  CHECK(r.of("audible").size() == 2);             // a, then null
  CHECK(r.pcm_rms(1.3, 1.9) > 0.05);              // speaking
  CHECK(r.pcm_rms(2.06, 2.5) < 1e-3);             // gate muted within ~30 ms of carrier drop
  CHECK(!r.of("power").empty());
  CHECK(std::abs((double)r.pcm.size() - 3.2 * kc::AUDIO_RATE) < 2 * kc::AUDIO_RATE / 100);
}

TEST(engine_unquieted_power_does_not_open) {
  kc::EngineOptions o; o.rate = RATE;
  Rig r(o);
  r.tune(TWO_LANES);
  auto x = scene(2.5, 2);
  auto hot = sig::noise(x.size(), 0.1, 3);
  for (size_t i = RATE; i < (size_t)(2 * RATE); i++) x[i] += hot[i];   // broadband junk, no carrier
  r.feed(x);
  CHECK(r.of("open").empty());
}

TEST(engine_close_call_discovers_and_listens) {
  kc::EngineOptions o; o.rate = RATE; o.close_call = true;
  Rig r(o);
  r.tune(R"({"cmd":"tune","centerHz":146000000,"channels":[{"id":"a","freqHz":146050000}],)"
         R"("closeCall":true,"closeCallDb":15,"knownHz":[146050000]})");
  auto x = scene(3.0, 4);
  auto c = sig::tone(RATE, x.size(), 87'500, 0.2);
  for (size_t i = (size_t)(0.6 * RATE); i < x.size(); i++) x[i] += c[i];
  r.feed(x);
  auto cc = r.of("closecall");
  CHECK(cc.size() == 1 && cc[0]["freqHz"] == 146087500);
  auto op = r.of("open");
  CHECK(!op.empty() && op.back()["id"] == "cc_146087500");
}

TEST(engine_monitor_mode_and_retune_order) {
  kc::EngineOptions o; o.rate = RATE;
  Rig r(o);
  r.tune(R"({"cmd":"tune","centerHz":146000000,"channels":[{"id":"wx","freqHz":146050000}],"monitor":true})");
  CHECK(r.ev.size() >= 3 && r.ev[0]["ev"] == "tuned" && r.ev[1]["ev"] == "open" && r.ev[2]["ev"] == "audible");
  r.ev.clear();
  r.tune(TWO_LANES);
  CHECK(r.ev.size() >= 3 && r.ev[0]["ev"] == "close" && r.ev[1]["ev"] == "audible" && r.ev[2]["ev"] == "tuned");
}

TEST(engine_drops_out_of_window_channels_with_log) {
  kc::EngineOptions o; o.rate = RATE;
  Rig r(o);
  r.tune(R"({"cmd":"tune","centerHz":146000000,"channels":[{"id":"far","freqHz":147000000},{"id":"a","freqHz":146050000}]})");
  CHECK(!r.of("log").empty());
  CHECK(r.of("tuned").size() == 1);
}
```

Run `npm run test:native`. Expected: FAIL to compile.

- [ ] **Step 2: `engine.hpp`**

```cpp
// kerchunk-dsp engine: one DSP thread, clocked by input samples (now = samples/rate).
#pragma once
#include <cstdint>
#include <functional>
#include <memory>
#include <nlohmann/json.hpp>
#include <vector>

#include "audio.hpp"
#include "channelizer.hpp"
#include "closecall.hpp"
#include "demod.hpp"
#include "meters.hpp"
#include "protocol.hpp"
#include "scanner.hpp"

namespace kc {
struct EngineOptions {
  int rate = 2'400'000;
  Scanner::Params squelch{};
  bool close_call = false;
  bool same = false;
};

class Engine {
 public:
  using Emit = std::function<void(const nlohmann::json&)>;
  using Pcm = std::function<void(const int16_t*, int)>;
  Engine(const EngineOptions& o, Emit emit, Pcm speaker, Pcm tee, Pcm same);
  void command(const Command& c);
  void push_u8(const uint8_t* iq, size_t nsamples);
  double now() const { return (double)samples_ / opt_.rate; }
  bool quit() const { return quit_; }

 private:
  void tune(const TuneCmd& t);
  void on_hop(const cf* lanes, int per, const cf* raw, int raw_n);
  void poll();
  void reset_lane(int i);

  EngineOptions opt_;
  Emit emit_;
  Pcm speaker_, tee_, same_;
  Channelizer ch_;
  Scanner sc_;
  SpeakerPath spk_;
  SamePath same_path_;
  std::unique_ptr<CloseCall> cc_;
  std::vector<ChunkPower> power_;
  std::vector<FmDiscriminator> disc_;
  std::vector<QuietingMeter> quiet_;
  std::vector<std::vector<float>> disc_buf_;
  std::vector<LaneReading> readings_;
  std::vector<float> out48_;
  std::vector<int16_t> s16_, same16_;
  double center_ = 0;
  bool tuned_ = false, cc_on_ = false, quit_ = false;
  long long samples_ = 0, lane_samples_ = 0, next_poll_ = CHUNK_SAMPLES;
  long polls_ = 0;
};
}  // namespace kc
```

- [ ] **Step 3: `engine.cpp`**

```cpp
#include "engine.hpp"

#include <cmath>
#include <string>
#include <type_traits>

namespace kc {
using nlohmann::json;

Engine::Engine(const EngineOptions& o, Emit emit, Pcm speaker, Pcm tee, Pcm same)
    : opt_(o), emit_(std::move(emit)), speaker_(std::move(speaker)), tee_(std::move(tee)), same_(std::move(same)),
      ch_(o.rate), sc_(o.squelch, [this](const json& j) { emit_(j); }),
      power_(MAX_LANES), disc_(MAX_LANES), quiet_(MAX_LANES),
      disc_buf_(MAX_LANES, std::vector<float>(Channelizer::kLaneSamplesPerHop)), readings_(MAX_LANES) {
  if (o.close_call) cc_ = std::make_unique<CloseCall>(o.rate);   // FFTW planning on this (the DSP) thread
  ch_.set_lanes(std::vector<double>(MAX_LANES, 0.0));
  out48_.reserve(256);
}

void Engine::reset_lane(int i) {
  power_[i].reset();
  disc_[i].reset();
  quiet_[i].reset();
}

void Engine::command(const Command& c) {
  std::visit([this](const auto& cmd) {
    using T = std::decay_t<decltype(cmd)>;
    if constexpr (std::is_same_v<T, TuneCmd>) tune(cmd);
    else if constexpr (std::is_same_v<T, KnownCmd>) { if (cc_) cc_->set_known(cmd.known_hz); }
    else if constexpr (std::is_same_v<T, SkipCmd>) {
      long long f = sc_.skip(cmd.holdoff_s, now());
      if (f && cc_) cc_->cooldown(f, now() + cmd.holdoff_s);
    }
    else if constexpr (std::is_same_v<T, AlertUnmuteCmd>) sc_.alert_unmute(cmd.id, cmd.hold_s, now());
    else if constexpr (std::is_same_v<T, QuitCmd>) quit_ = true;
  }, c);
}

void Engine::tune(const TuneCmd& t) {
  center_ = t.center_hz;
  const double limit = opt_.rate / 2.0 - LANE_RATE / 2.0;
  std::vector<ChannelCmd> ok;
  for (const auto& c : t.channels) {
    const double off = c.freq_hz - center_;
    if (!std::isfinite(off) || std::fabs(off) > limit) {
      emit_({{"ev", "log"}, {"msg", "channel " + c.id + " is outside the tuned window; dropped"}});
      continue;
    }
    ok.push_back(c);
  }
  sc_.tune(center_, ok, t.monitor);
  std::vector<double> offsets(MAX_LANES, 0.0);
  for (int i = 0; i < MAX_LANES; i++)
    if (!sc_.lane(i).parked()) offsets[i] = sc_.lane(i).freq_hz - center_;
  ch_.reset_stream();
  ch_.set_lanes(offsets);
  for (int i = 0; i < MAX_LANES; i++) reset_lane(i);
  spk_.reset();   // retune: hard cut is fine, there is no audio context to preserve
  same_path_.reset();
  if (cc_) {
    cc_->reset(center_);
    cc_->set_known(t.known_hz);
    cc_->set_db(t.close_call_db);
  }
  cc_on_ = cc_ && t.close_call && !t.monitor;
  const int a = sc_.audible();
  spk_.set_source(a, a >= 0 && sc_.lane(a).am);
  spk_.set_gain(sc_.gate());
  lane_samples_ = 0;
  next_poll_ = CHUNK_SAMPLES;
  polls_ = 0;
  tuned_ = true;
}

void Engine::push_u8(const uint8_t* iq, size_t nsamples) {
  if (!tuned_) { samples_ += (long long)nsamples; return; }
  ch_.push_u8(iq, nsamples, [this](const cf* lanes, int, int per, const cf* raw, int raw_n) { on_hop(lanes, per, raw, raw_n); });
}

void Engine::on_hop(const cf* lanes, int per, const cf* raw, int raw_n) {
  samples_ += raw_n;
  for (int i = 0; i < MAX_LANES; i++) {
    const LaneState& L = sc_.lane(i);
    if (L.parked()) continue;
    const cf* y = lanes + i * per;
    power_[i].push(y, per);
    float* db = disc_buf_[i].data();
    for (int d = 0; d < per; d++) {
      db[d] = disc_[i].step(y[d]);
      quiet_[i].push(db[d]);
    }
    if (L.background && opt_.same) {
      same16_.clear();
      same_path_.push(db, per, same16_);
      if (same_ && !same16_.empty()) same_(same16_.data(), (int)same16_.size());
    }
  }
  out48_.clear();
  const int f = spk_.feeding_lane();
  if (f >= 0 && !sc_.lane(f).parked()) spk_.process(lanes + f * per, disc_buf_[f].data(), per, out48_);
  else spk_.process(nullptr, nullptr, per, out48_);
  if (!out48_.empty()) {
    if (speaker_) { to_s16(out48_.data(), (int)out48_.size(), SPEAKER_S16_SCALE, s16_); speaker_(s16_.data(), (int)s16_.size()); }
    if (tee_) { to_s16(out48_.data(), (int)out48_.size(), TEE_S16_SCALE, s16_); tee_(s16_.data(), (int)s16_.size()); }
  }
  if (cc_on_) cc_->push_raw(raw, raw_n);
  lane_samples_ += per;
  while (lane_samples_ >= next_poll_) {
    poll();
    next_poll_ += CHUNK_SAMPLES;
  }
}

void Engine::poll() {
  polls_++;
  for (int i = 0; i < MAX_LANES; i++)
    readings_[i] = {power_[i].fast_db(), power_[i].slow_db(), quiet_[i].db(), quiet_[i].ready()};
  sc_.poll(now(), readings_, spk_.speech_db());
  const int a = sc_.audible();
  spk_.set_source(a, a >= 0 && sc_.lane(a).am);
  spk_.set_gain(sc_.gate());
  if (polls_ % POWER_EVERY_POLLS == 0)
    emit_({{"ev", "power"}, {"levels", sc_.power_levels(readings_)}, {"noise", sc_.noise_levels(readings_)}});
  if (cc_on_ && polls_ % CC_EVERY_POLLS == 0) {
    if (auto hit = cc_->check(now(), sc_.assigned_freqs())) {
      emit_({{"ev", "closecall"}, {"freqHz", *hit}});
      const int s = sc_.assign_cc(*hit);
      const double off = (double)*hit - center_;
      if (s >= 0 && std::fabs(off) <= opt_.rate / 2.0 - LANE_RATE / 2.0) {
        ch_.set_lane_offset(s, off);
        reset_lane(s);
      }
    }
  }
}
}  // namespace kc
```

- [ ] **Step 4: The binary**

`kiosk/native/app/main.cpp`:

```cpp
// kerchunk-dsp — P1b: replay mode only (--iq-file). Live SDR/ALSA/fd-3 arrive in P1c.
#include <sys/resource.h>

#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <iostream>
#include <string>
#include <thread>
#include <vector>

#include "engine.hpp"
#include "rt.hpp"

static double cpu_seconds() {
  rusage u{};
  getrusage(RUSAGE_SELF, &u);
  return u.ru_utime.tv_sec + u.ru_utime.tv_usec / 1e6 + u.ru_stime.tv_sec + u.ru_stime.tv_usec / 1e6;
}

int main(int argc, char** argv) {
  kc::EngineOptions o;
  std::string iq_file, tune_json, audio_out, same_out;
  bool realtime = false;
  for (int i = 1; i < argc; i++) {
    std::string k = argv[i];
    auto val = [&]() -> std::string {
      if (i + 1 >= argc) { std::fprintf(stderr, "kerchunk-dsp: missing value for %s\n", k.c_str()); std::exit(2); }
      return argv[++i];
    };
    if (k == "--iq-file") iq_file = val();
    else if (k == "--tune") tune_json = val();
    else if (k == "--rate") o.rate = std::atoi(val().c_str());
    else if (k == "--open-db") o.squelch.open_db = std::atof(val().c_str());
    else if (k == "--quiet-db") o.squelch.quiet_db = std::atof(val().c_str());   // native scale only
    else if (k == "--hang-ms") o.squelch.hang_ms = std::atof(val().c_str());
    else if (k == "--close-call") o.close_call = true;
    else if (k == "--same-enable") o.same = true;
    else if (k == "--audio-out") audio_out = val();
    else if (k == "--same-out") same_out = val();
    else if (k == "--realtime") realtime = true;
    else { std::fprintf(stderr, "kerchunk-dsp: unknown arg %s\n", k.c_str()); return 2; }
  }
  if (iq_file.empty()) {
    std::fprintf(stderr, "kerchunk-dsp: live SDR input arrives in P1c; use --iq-file\n");
    return 2;
  }
  kc::dsp_thread_init();
  std::ofstream aout, sout;
  if (!audio_out.empty()) aout.open(audio_out, std::ios::binary);
  if (!same_out.empty()) sout.open(same_out, std::ios::binary);
  kc::Engine* ep = nullptr;
  auto emit = [&](const nlohmann::json& j) {
    nlohmann::json e = j;
    if (ep) e["t"] = std::round(ep->now() * 1000.0) / 1000.0;
    std::fputs(kc::to_line(e).c_str(), stdout);
  };
  auto speaker = aout.is_open() ? kc::Engine::Pcm([&](const int16_t* p, int n) { aout.write((const char*)p, n * 2); }) : kc::Engine::Pcm();
  auto same = sout.is_open() ? kc::Engine::Pcm([&](const int16_t* p, int n) { sout.write((const char*)p, n * 2); }) : kc::Engine::Pcm();
  kc::Engine eng(o, emit, speaker, kc::Engine::Pcm(), same);
  ep = &eng;
  std::fputs(kc::to_line({{"ev", "ready"}}).c_str(), stdout);
  if (!tune_json.empty()) {
    std::string err;
    auto c = kc::parse_command(tune_json, err);
    if (!c) { std::fprintf(stderr, "kerchunk-dsp: bad --tune: %s\n", err.c_str()); return 2; }
    eng.command(*c);
  }
  FILE* f = std::fopen(iq_file.c_str(), "rb");
  if (!f) { std::perror(iq_file.c_str()); return 1; }
  std::vector<uint8_t> buf((size_t)o.rate / 100 * 2);
  long long total = 0;
  const auto wall0 = std::chrono::steady_clock::now();
  const double c0 = cpu_seconds();
  size_t got;
  while (!eng.quit() && (got = std::fread(buf.data(), 1, buf.size(), f)) >= 2) {
    eng.push_u8(buf.data(), got / 2);
    total += (long long)(got / 2);
    if (realtime) std::this_thread::sleep_until(wall0 + std::chrono::duration<double>((double)total / o.rate));
  }
  std::fclose(f);
  const double cpu = cpu_seconds() - c0, iq_s = (double)total / o.rate;
  std::fflush(stdout);
  std::fprintf(stderr, "REPLAY iq_s=%.2f cpu_s=%.3f core_pct=%.1f realtime=%d\n", iq_s, cpu, iq_s > 0 ? 100 * cpu / iq_s : 0.0, realtime ? 1 : 0);
  return 0;
}
```

Add to `CMakeLists.txt`, after the tests target:

```cmake
add_executable(kerchunk-dsp ${CMAKE_CURRENT_SOURCE_DIR}/app/main.cpp)
target_link_libraries(kerchunk-dsp PRIVATE kcdsp Threads::Threads)
```

- [ ] **Step 5: Run the tests**

Run `npm run test:native`. Expected: all tests `ok`, warning-free. If an engine timing check fails, print the event list with timestamps in the report. Adjust nothing in `Scanner` without a matching `test_scanner` change. The windows follow from: warm-up 500 ms, slow meter 100 ms, `OPEN_POLLS` 100 ms, hang 500 ms.

- [ ] **Step 6: Real-capture replay (batch once, real-time once)**

```bash
cd /home/kiosk/kerchunk-kiosk/kiosk
TUNE='{"cmd":"tune","centerHz":146033750,"channels":[{"id":"c145130000","freqHz":145130000},{"id":"c145150000","freqHz":145150000},{"id":"c145310000","freqHz":145310000},{"id":"c145470000","freqHz":145470000},{"id":"c146520000","freqHz":146520000},{"id":"c146625000","freqHz":146625000},{"id":"c146637500","freqHz":146637500},{"id":"c146700000","freqHz":146700000},{"id":"c146762500","freqHz":146762500},{"id":"c146790000","freqHz":146790000},{"id":"c146937500","freqHz":146937500}],"closeCall":true,"closeCallDb":15,"knownHz":[145130000,145150000,145310000,145470000,146520000,146625000,146637500,146700000,146762500,146790000,146937500]}'
native/build/kerchunk-dsp --iq-file /home/kiosk/kiosk-iq/2m-146033750-2400k.cu8 --tune "$TUNE" --close-call --audio-out /home/kiosk/kiosk-iq/2m-native.s16 > /home/kiosk/kiosk-iq/2m-native-events.jsonl
tail -1 /home/kiosk/kiosk-iq/2m-native-events.jsonl
native/build/kerchunk-dsp --iq-file /home/kiosk/kiosk-iq/2m-146033750-2400k.cu8 --tune "$TUNE" --close-call --realtime > /dev/null
/usr/bin/python3 - <<'EOF'
import json, collections, wave
ev = [json.loads(l) for l in open('/home/kiosk/kiosk-iq/2m-native-events.jsonl')]
print(collections.Counter(e['ev'] for e in ev))
for e in ev:
    if e['ev'] in ('open', 'close', 'audible', 'closecall', 'log', 'rf'): print(e)
raw = open('/home/kiosk/kiosk-iq/2m-native.s16', 'rb').read()
w = wave.open('/home/kiosk/kiosk-iq/2m-native.wav', 'wb'); w.setnchannels(1); w.setsampwidth(2); w.setframerate(48000); w.writeframes(raw); w.close()
print('wav seconds', len(raw) / 2 / 48000)
EOF
```

Expected: two `REPLAY` stderr lines (batch and `realtime=1`); an event summary; `2m-native.wav` of ≈30 s. (`$TUNE` is quoted, so zsh passes it as one argument.)

- [ ] **Step 7: Results + commit**

Append to `kiosk/bench/RESULTS-2026-09-25-native-p1b.md`:

```markdown
## Engine replay on real RF

Binary: kerchunk-dsp (P1b replay), 11 channels (the 2 m group), Close Call on, default squelch (open 9 dB, hang 2000 ms, QUIET_DB_DEFAULT).
- Batch: <REPLAY line>
- Real-time (--realtime): <REPLAY line>  ← the acceptance number; GNU Radio helper baseline 223–234%
- Events: <Counter output>
- Opens/closes/audible/closecall/log/rf: <the printed lines>
- Audio for listening: /home/kiosk/kiosk-iq/2m-native.wav (48 kHz mono, not in the repo)

Not included: USB reader thread, ALSA write, fd-3 tee (P1c).
```

Fill in the measured lines.

```bash
git add kiosk/native kiosk/bench/RESULTS-2026-09-25-native-p1b.md
git commit -m "feat(native): Engine + kerchunk-dsp replay binary; real-RF replay events, audio and real-time CPU"
```

---

## After P1b (not in this plan)

- **P1c (live I/O):** librtlsdr async reader (serial addressing, busy-retry 3 s, 2 s stall → exit), SPSC ring with overrun counting (`power.drops`), stdin command thread → lock-free queue to the DSP thread, ALSA writer with `snd_pcm_recover`, non-blocking fd-3 tee, multimon-ng child for SAME (respawn once), SIGTERM/EOF shutdown within 500 ms, live `--realtime` CPU% as acceptance.
- **P2 (Node):** `KERCHUNK_ENGINE=native`, the native path skips the lane plan/respawn and `--quiet-db`/per-channel `quietDb` (decision C), the weather radio moves to 250 kHz, build/deploy/docs.
