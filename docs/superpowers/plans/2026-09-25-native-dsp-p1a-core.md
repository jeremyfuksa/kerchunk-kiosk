# Native DSP P1a — DSP Core Library Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and unit-test the signal-processing core of `kerchunk-dsp` (channelizer, meters, FM/AM demod, de-emphasis, FIR, rational resampler) as a C++ static library with its own test runner, wired into npm and CI. Then measure the batch cost of always-on demod on all 12 lanes on the real capture, to settle demod-on-demand for P1b.

**Architecture:** `kiosk/native/` is a CMake project that builds the static library `kcdsp` from `src/*.cpp`, a test runner `kerchunk-dsp-tests` from `test/*.cpp` (a tiny in-repo harness with no vendored framework), and a batch cost tool `kc-cost-bench`. The channelizer is the P0 bench's overlap-save design, now with a partial-hop input buffer, rate-derived tap count, validated rates, and per-lane phase continuity for odd k0. Nothing is wired into Node yet (P2).

**Tech Stack:** C++17, CMake ≥ 3.20, g++, FFTW3 float (`fftw3f` via pkg-config), npm scripts, GitHub Actions (ubuntu-latest).

**Spec:** `docs/superpowers/specs/2026-09-25-native-dsp-engine-design.md` (§2 DSP pipeline). P0 results: `kiosk/bench/RESULTS-2026-09-25-native-p0.md`.

## Global Constraints

- Lane rate 50 kHz. SDR rate must be a positive multiple of 50 kHz; D = rate / 50 000; `FFT_N` = 128·D; hop = FFT_N/2 input samples → 64 lane samples per hop per lane.
- Channel filter: Hamming windowed-sinc low-pass, cutoff 8000 Hz, transition 4000 Hz, tap count = ceil(3.3·rate/transition) forced odd, and it must be ≤ FFT_N/2 + 1 (else construction fails).
- Meters: fast = mean |x|² over the latest 10 ms chunk (500 lane samples); slow = mean of the last 10 chunk means (100 ms). dB = 10·log10(v + 1e-20).
- FM discriminator output: ±1.0 at ±5000 Hz deviation. The first sample after reset primes it and outputs 0 (no startup impulse).
- De-emphasis τ = 75 µs. Quieting HPF cutoff 8000 Hz at 50 kHz.
- No `-ffast-math`. Flags: `-O3 -march=native -Wall -Wextra -Wpedantic` (Release). The code is built on the machine that runs it (appliance or CI runner).
- Everything C++ lives under `kiosk/native/`. The build dir `kiosk/native/build/` is ignored by the root `.gitignore` (`build/`).
- Python only via `/usr/bin/python3`. Never stop services or touch SDRs in this plan. The real capture is `/home/kiosk/kiosk-iq/2m-146033750-2400k.cu8` (outside the repo, read-only).
- The Bash tool runs zsh: unquoted `$VAR` does not word-split. Use arrays or `bash -c`.

## File Structure

- `kiosk/native/CMakeLists.txt`: builds `kcdsp` (glob `src/*.cpp`), `kerchunk-dsp-tests` (glob `test/*.cpp`) and `kc-cost-bench` (`tools/cost_bench.cpp`).
- `kiosk/native/src/constants.hpp`: every DSP knob (the spec's constants header).
- `kiosk/native/src/fir.hpp/.cpp`: filter design (low/high-pass) and the `FirFilter` stream filter.
- `kiosk/native/src/channelizer.hpp/.cpp`: overlap-save channelizer.
- `kiosk/native/src/meters.hpp`: `ChunkPower` (lane power fast/slow) and `MeanSquare` (real-stream windowed power). Header-only.
- `kiosk/native/src/demod.hpp/.cpp`: `FmDiscriminator`, `AmEnvelope`, `Deemphasis`.
- `kiosk/native/src/resampler.hpp/.cpp`: rational polyphase `Resampler`.
- `kiosk/native/test/check.hpp`: test harness macros.
- `kiosk/native/test/signals.hpp`: synthetic signal generators for tests.
- `kiosk/native/test/test_main.cpp`: the runner.
- `kiosk/native/test/test_fir.cpp`, `test_channelizer.cpp`, `test_demod.cpp`, `test_resampler.cpp`: the tests.
- `kiosk/native/tools/cost_bench.cpp`: batch cost measurement on a `.cu8`.
- `kiosk/package.json`: adds `build:native` and `test:native`.
- `.github/workflows/ci.yml`: installs deps and runs `test:native`.
- `kiosk/bench/RESULTS-2026-09-25-native-p1a.md`: the always-on demod cost result.

---

### Task 1: Scaffold, harness, constants, FIR, npm and CI wiring

**Files:**
- Create: `kiosk/native/CMakeLists.txt`, `kiosk/native/src/constants.hpp`, `kiosk/native/src/fir.hpp`, `kiosk/native/src/fir.cpp`, `kiosk/native/test/check.hpp`, `kiosk/native/test/signals.hpp`, `kiosk/native/test/test_main.cpp`, `kiosk/native/test/test_fir.cpp`
- Modify: `kiosk/package.json` (scripts), `.github/workflows/ci.yml`

**Interfaces:**
- Produces (used by all later tasks):
  - `namespace kc` constants (see `constants.hpp` below).
  - `std::vector<float> kc::design_lowpass(double rate, double cutoff_hz, double transition_hz)`
  - `std::vector<float> kc::design_lowpass_taps(int ntaps, double cutoff_norm)` (cutoff_norm = cutoff/rate)
  - `std::vector<float> kc::design_highpass(double rate, double cutoff_hz, double transition_hz)`
  - `class kc::FirFilter { explicit FirFilter(std::vector<float> taps); float step(float x); void reset(); int size() const; }`
  - Test macros `TEST(name)`, `CHECK(cond)`, `CHECK_NEAR(a,b,tol)`, `CHECK_THROWS(expr)`.
  - Signal helpers in `namespace sig`: `tone`, `fm_tone`, `noise`, `rms`, `db_power`.
  - npm: `npm run build:native`, `npm run test:native` (from `kiosk/`).

- [ ] **Step 1: Install the build tool**

Run: `sudo apt-get install -y cmake`
Expected: `cmake --version` prints ≥ 3.20. (`libfftw3-dev` and `pkg-config` are already installed; `pkg-config --modversion fftw3f` → `3.3.10`.)

- [ ] **Step 2: Write the harness, signals, runner and constants**

`kiosk/native/test/check.hpp`:

```cpp
// Minimal test harness: TEST(name) registers a case; CHECK* record failures and keep going.
#pragma once
#include <cmath>
#include <cstdio>
#include <functional>
#include <string>
#include <utility>
#include <vector>

namespace check {
struct Case { const char* name; std::function<void()> fn; };
inline std::vector<Case>& registry() { static std::vector<Case> r; return r; }
inline int& failures() { static int f = 0; return f; }
struct Reg { Reg(const char* n, std::function<void()> f) { registry().push_back({n, std::move(f)}); } };
inline void fail(const char* file, int line, const std::string& msg) {
  std::fprintf(stderr, "  FAIL %s:%d: %s\n", file, line, msg.c_str());
  ++failures();
}
}  // namespace check

#define KC_CAT2(a, b) a##b
#define KC_CAT(a, b) KC_CAT2(a, b)
#define TEST(name) \
  static void name(); \
  static check::Reg KC_CAT(reg_, name)(#name, name); \
  static void name()
#define CHECK(cond) \
  do { if (!(cond)) check::fail(__FILE__, __LINE__, #cond); } while (0)
#define CHECK_NEAR(a, b, tol) \
  do { \
    double kc_a_ = (a), kc_b_ = (b); \
    if (!(std::fabs(kc_a_ - kc_b_) <= (tol))) \
      check::fail(__FILE__, __LINE__, std::string(#a " ~ " #b ": ") + std::to_string(kc_a_) + " vs " + std::to_string(kc_b_)); \
  } while (0)
#define CHECK_THROWS(expr) \
  do { \
    bool kc_t_ = false; \
    try { (void)(expr); } catch (...) { kc_t_ = true; } \
    if (!kc_t_) check::fail(__FILE__, __LINE__, "expected throw: " #expr); \
  } while (0)
```

`kiosk/native/test/test_main.cpp`:

```cpp
// Runs every registered TEST; optional argv[1] = substring filter. Exit 1 on any failure.
#include <cstdio>
#include <cstring>
#include "check.hpp"

int main(int argc, char** argv) {
  const char* filter = argc > 1 ? argv[1] : nullptr;
  int ran = 0;
  for (auto& c : check::registry()) {
    if (filter && !std::strstr(c.name, filter)) continue;
    int before = check::failures();
    c.fn();
    ++ran;
    std::printf("%s %s\n", check::failures() == before ? "ok  " : "FAIL", c.name);
  }
  std::printf("%d tests, %d failed checks\n", ran, check::failures());
  return check::failures() == 0 && ran > 0 ? 0 : 1;
}
```

`kiosk/native/test/signals.hpp`:

```cpp
// Synthetic signal generators + measurements for tests.
#pragma once
#include <cmath>
#include <complex>
#include <random>
#include <vector>

namespace sig {
using cf = std::complex<float>;

inline std::vector<cf> tone(double rate, size_t n, double freq, double amp, double phase = 0) {
  std::vector<cf> x(n);
  for (size_t i = 0; i < n; i++) {
    double p = 2 * M_PI * freq * i / rate + phase;
    x[i] = cf((float)(amp * std::cos(p)), (float)(amp * std::sin(p)));
  }
  return x;
}

// Complex FM: carrier at `carrier` Hz, sinusoidal modulation `mod_hz` with peak deviation `dev_hz`.
inline std::vector<cf> fm_tone(double rate, size_t n, double carrier, double dev_hz, double mod_hz, double amp) {
  std::vector<cf> x(n);
  double beta = dev_hz / mod_hz;
  for (size_t i = 0; i < n; i++) {
    double t = i / rate;
    double p = 2 * M_PI * carrier * t + beta * std::sin(2 * M_PI * mod_hz * t);
    x[i] = cf((float)(amp * std::cos(p)), (float)(amp * std::sin(p)));
  }
  return x;
}

inline std::vector<cf> noise(size_t n, double sigma, unsigned seed) {
  std::mt19937 g(seed);
  std::normal_distribution<float> d(0.f, (float)sigma);
  std::vector<cf> x(n);
  for (auto& v : x) v = cf(d(g), d(g));
  return x;
}

inline void add(std::vector<cf>& a, const std::vector<cf>& b) {
  for (size_t i = 0; i < a.size() && i < b.size(); i++) a[i] += b[i];
}

inline double rms(const float* x, size_t n) {
  double s = 0;
  for (size_t i = 0; i < n; i++) s += (double)x[i] * x[i];
  return std::sqrt(s / (double)(n ? n : 1));
}

inline double db_power(double mean_square) { return 10 * std::log10(mean_square + 1e-20); }
}  // namespace sig
```

`kiosk/native/src/constants.hpp`:

```cpp
// Every DSP knob for kerchunk-dsp. Spec: docs/superpowers/specs/2026-09-25-native-dsp-engine-design.md §2.
#pragma once

namespace kc {
inline constexpr int LANE_RATE = 50000;            // every lane is decimated to this
inline constexpr int LANE_BINS = 128;              // bins per lane = lane IFFT size (FFT_N = LANE_BINS * rate/LANE_RATE)
inline constexpr double CHAN_CUTOFF_HZ = 8000;     // channel filter -6 dB point
inline constexpr double CHAN_TRANSITION_HZ = 4000; // channel filter transition width
inline constexpr double TAPS_PER_FS_OVER_TW = 3.3; // Hamming tap-count rule: ntaps = 3.3 * fs / tw
inline constexpr int CHUNK_SAMPLES = LANE_RATE / 100;  // 10 ms meter chunk
inline constexpr int SLOW_CHUNKS = 10;                 // slow meter = mean of last 10 chunks (100 ms)
inline constexpr double FM_MAX_DEV_HZ = 5000;      // discriminator +-1.0 at this deviation
inline constexpr double DEEMPH_TAU_S = 75e-6;
inline constexpr double NOISE_HPF_HZ = 8000;       // quieting band lower edge (lane Nyquist is the top)
inline constexpr double NOISE_HPF_TRANSITION_HZ = 2000;
inline constexpr int NOISE_WINDOW = CHUNK_SAMPLES;          // quieting meter window (10 ms)
inline constexpr int SPEECH_WINDOW = 10 * CHUNK_SAMPLES;    // leveler speech meter window (100 ms)
inline constexpr double AM_CARRIER_TAU_S = 0.04;   // AM carrier tracker (~40 ms)
inline constexpr double AUDIO_LPF_HZ = 3500;
inline constexpr double AUDIO_LPF_TRANSITION_HZ = 1500;
inline constexpr int AUDIO_RATE = 48000;           // speaker/tee rate (50k -> 48k = 24/25)
inline constexpr int SAME_RATE = 22050;            // multimon-ng raw rate (50k -> 22.05k = 441/1000)
}  // namespace kc
```

- [ ] **Step 3: Write the failing FIR tests**

`kiosk/native/test/test_fir.cpp`:

```cpp
#include <cmath>
#include <numeric>
#include "check.hpp"
#include "constants.hpp"
#include "fir.hpp"

TEST(fir_lowpass_tap_count_follows_rate) {
  CHECK(kc::design_lowpass(2'400'000, kc::CHAN_CUTOFF_HZ, kc::CHAN_TRANSITION_HZ).size() == 1981);
  CHECK(kc::design_lowpass(250'000, kc::CHAN_CUTOFF_HZ, kc::CHAN_TRANSITION_HZ).size() == 207);
}

TEST(fir_lowpass_unity_dc_gain_and_symmetric) {
  auto h = kc::design_lowpass(50'000, 3500, 1500);
  CHECK(h.size() % 2 == 1);
  CHECK_NEAR(std::accumulate(h.begin(), h.end(), 0.0), 1.0, 1e-5);
  for (size_t i = 0; i < h.size() / 2; i++) CHECK_NEAR(h[i], h[h.size() - 1 - i], 1e-7);
}

TEST(fir_highpass_blocks_dc_passes_nyquist) {
  auto h = kc::design_highpass(50'000, kc::NOISE_HPF_HZ, kc::NOISE_HPF_TRANSITION_HZ);
  CHECK_NEAR(std::accumulate(h.begin(), h.end(), 0.0), 0.0, 1e-5);
  double nyq = 0;
  for (size_t i = 0; i < h.size(); i++) nyq += (i % 2 ? -1.0 : 1.0) * h[i];
  CHECK_NEAR(std::fabs(nyq), 1.0, 0.01);
}

TEST(fir_filter_matches_direct_convolution) {
  std::vector<float> h = {0.1f, -0.2f, 0.5f, 0.3f};
  kc::FirFilter f(h);
  std::vector<float> x = {1, 2, -1, 0.5f, 3, -2, 0, 1};
  for (size_t t = 0; t < x.size(); t++) {
    double ref = 0;
    for (size_t k = 0; k < h.size() && k <= t; k++) ref += h[k] * x[t - k];
    CHECK_NEAR(f.step(x[t]), ref, 1e-6);
  }
  f.reset();
  CHECK_NEAR(f.step(1.0f), 0.1, 1e-7);
}
```

- [ ] **Step 4: Write CMake + FIR headers and the npm scripts, and watch the tests fail**

`kiosk/native/CMakeLists.txt`:

```cmake
cmake_minimum_required(VERSION 3.20)
project(kerchunk_dsp CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release)
endif()
# Always built on the machine that runs it (the appliance, or the CI runner that tests it).
# No -ffast-math: it silently breaks NaN/inf checks the engine relies on.
set(CMAKE_CXX_FLAGS_RELEASE "-O3 -march=native")
add_compile_options(-Wall -Wextra -Wpedantic)

find_package(PkgConfig REQUIRED)
pkg_check_modules(FFTW3F REQUIRED IMPORTED_TARGET fftw3f)

file(GLOB KC_SRC CONFIGURE_DEPENDS ${CMAKE_CURRENT_SOURCE_DIR}/src/*.cpp)
add_library(kcdsp STATIC ${KC_SRC})
target_include_directories(kcdsp PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/src)
target_link_libraries(kcdsp PUBLIC PkgConfig::FFTW3F m)

file(GLOB KC_TESTS CONFIGURE_DEPENDS ${CMAKE_CURRENT_SOURCE_DIR}/test/*.cpp)
add_executable(kerchunk-dsp-tests ${KC_TESTS})
target_link_libraries(kerchunk-dsp-tests PRIVATE kcdsp)

if(EXISTS ${CMAKE_CURRENT_SOURCE_DIR}/tools/cost_bench.cpp)
  add_executable(kc-cost-bench ${CMAKE_CURRENT_SOURCE_DIR}/tools/cost_bench.cpp)
  target_link_libraries(kc-cost-bench PRIVATE kcdsp)
endif()
```

`kiosk/native/src/fir.hpp`:

```cpp
// Filter design and a streaming real FIR.
#pragma once
#include <vector>

namespace kc {
// Hamming windowed-sinc low-pass, unity DC gain. ntaps = ceil(3.3*rate/transition), forced odd.
std::vector<float> design_lowpass(double rate, double cutoff_hz, double transition_hz);
// Same design with an explicit tap count; cutoff_norm = cutoff_hz / rate.
std::vector<float> design_lowpass_taps(int ntaps, double cutoff_norm);
// Spectral inversion of design_lowpass: delta - lowpass (odd length, zero DC gain).
std::vector<float> design_highpass(double rate, double cutoff_hz, double transition_hz);

// Streaming real FIR. History lives in a doubled ring so every output is one contiguous dot product.
class FirFilter {
 public:
  explicit FirFilter(std::vector<float> taps);
  float step(float x);
  void reset();
  int size() const { return n_; }

 private:
  std::vector<float> rev_;  // taps reversed: rev_[j] = h[n-1-j] pairs with the oldest-first window
  std::vector<float> buf_;  // 2n: each sample written at pos and pos+n
  int n_;
  int pos_ = 0;
};
}  // namespace kc
```

Add to `kiosk/package.json` `"scripts"` (after `"test:py"`):

```json
    "build:native": "cmake -S native -B native/build && cmake --build native/build -j",
    "test:native": "npm run build:native && native/build/kerchunk-dsp-tests",
```

Run: `cd /home/kiosk/kerchunk-kiosk/kiosk && npm run test:native`
Expected: FAIL. `fir.cpp` doesn't exist yet, so either CMake stops with `No SOURCES given to target: kcdsp` (empty glob) or the link fails on undefined `kc::design_lowpass` / `kc::FirFilter`. Either is the expected RED.

- [ ] **Step 5: Implement `fir.cpp`**

`kiosk/native/src/fir.cpp`:

```cpp
#include "fir.hpp"

#include <algorithm>
#include <cmath>
#include <stdexcept>

#include "constants.hpp"

namespace kc {

std::vector<float> design_lowpass_taps(int ntaps, double cutoff_norm) {
  if (ntaps < 1) throw std::invalid_argument("design_lowpass_taps: ntaps < 1");
  std::vector<double> h(ntaps);
  double sum = 0;
  for (int i = 0; i < ntaps; i++) {
    double m = i - (ntaps - 1) / 2.0;
    double s = m == 0 ? 2 * cutoff_norm : std::sin(2 * M_PI * cutoff_norm * m) / (M_PI * m);
    double w = ntaps == 1 ? 1.0 : 0.54 - 0.46 * std::cos(2 * M_PI * i / (ntaps - 1));
    h[i] = s * w;
    sum += h[i];
  }
  std::vector<float> out(ntaps);
  for (int i = 0; i < ntaps; i++) out[i] = (float)(h[i] / sum);
  return out;
}

std::vector<float> design_lowpass(double rate, double cutoff_hz, double transition_hz) {
  int n = (int)std::ceil(TAPS_PER_FS_OVER_TW * rate / transition_hz);
  if (n % 2 == 0) n++;
  return design_lowpass_taps(n, cutoff_hz / rate);
}

std::vector<float> design_highpass(double rate, double cutoff_hz, double transition_hz) {
  std::vector<float> h = design_lowpass(rate, cutoff_hz, transition_hz);
  for (float& v : h) v = -v;
  h[h.size() / 2] += 1.0f;
  return h;
}

FirFilter::FirFilter(std::vector<float> taps) : n_((int)taps.size()) {
  if (n_ < 1) throw std::invalid_argument("FirFilter: empty taps");
  rev_.assign(taps.rbegin(), taps.rend());
  buf_.assign(2 * n_, 0.f);
}

float FirFilter::step(float x) {
  buf_[pos_] = x;
  buf_[pos_ + n_] = x;
  // Oldest-to-newest window of the last n samples is buf_[pos_+1 .. pos_+n_].
  const float* w = &buf_[pos_ + 1];
  float acc = 0.f;
  for (int j = 0; j < n_; j++) acc += rev_[j] * w[j];
  pos_ = pos_ + 1 == n_ ? 0 : pos_ + 1;
  return acc;
}

void FirFilter::reset() {
  std::fill(buf_.begin(), buf_.end(), 0.f);
  pos_ = 0;
}

}  // namespace kc
```

- [ ] **Step 6: Run the tests**

Run: `cd /home/kiosk/kerchunk-kiosk/kiosk && npm run test:native`
Expected: four `ok` lines, then `4 tests, 0 failed checks`, exit 0, and a warning-free build.

- [ ] **Step 7: Wire CI**

In `.github/workflows/ci.yml`, after the `Install dependencies` step, add:

```yaml
      # Native DSP core (kiosk/native): C++17 + FFTW. Built with -march=native
      # on the runner that tests it — the artifact is never shipped from CI.
      - name: Install native build deps
        run: sudo apt-get update && sudo apt-get install -y cmake libfftw3-dev pkg-config

      - name: Test (native DSP core)
        run: npm run test:native
```

- [ ] **Step 8: Commit**

```bash
cd /home/kiosk/kerchunk-kiosk
git add kiosk/native .github/workflows/ci.yml kiosk/package.json
git commit -m "feat(native): kiosk/native CMake project, test harness, DSP constants, FIR design + stream filter"
```
(End every commit message in this plan with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.)

---

### Task 2: Overlap-save channelizer + lane power meter

**Files:**
- Create: `kiosk/native/src/channelizer.hpp`, `kiosk/native/src/channelizer.cpp`, `kiosk/native/src/meters.hpp`
- Test: `kiosk/native/test/test_channelizer.cpp`

**Interfaces:**
- Consumes: `kc::design_lowpass`, constants (Task 1); `sig::*` helpers; test macros.
- Produces:
  ```cpp
  namespace kc {
  using cf = std::complex<float>;
  class Channelizer {
   public:
    explicit Channelizer(int rate);            // throws std::invalid_argument on a bad rate or oversize filter
    int rate() const; int fft_size() const; int hop() const;   // hop = fft_size()/2 input samples
    static constexpr int kLaneSamplesPerHop = LANE_BINS / 2;  // 64
    void set_lanes(const std::vector<double>& offsets_hz);    // resets NCOs and block parity
    int lanes() const;
    // Called once per completed hop. lanes_out: lanes*64 samples, lane-major. raw: the hop's hop() new input samples.
    using HopSink = std::function<void(const cf* lanes_out, int lanes, int per_lane, const cf* raw, int raw_n)>;
    void push_u8(const uint8_t* iq, size_t nsamples, const HopSink& sink);
    void push_cf(const cf* x, size_t nsamples, const HopSink& sink);
  };
  class ChunkPower {   // meters.hpp
   public:
    int push(const cf* x, int n);   // returns chunks completed during this push
    float fast_db() const; float slow_db() const; long chunks() const; void reset();
  };
  class MeanSquare {   // meters.hpp
   public:
    explicit MeanSquare(int window);
    bool push(float x);             // true when a window completed (value updated)
    float db() const; bool ready() const; void reset();
  };
  }
  ```

- [ ] **Step 1: Write the failing tests**

`kiosk/native/test/test_channelizer.cpp`:

```cpp
#include <algorithm>
#include <cmath>
#include <complex>
#include <random>
#include <vector>

#include "channelizer.hpp"
#include "check.hpp"
#include "meters.hpp"
#include "signals.hpp"

namespace {
constexpr int RATE = 2'400'000;

// Run x through a channelizer with the given lanes; return each lane's slow power (dB)
// measured after skipping the first `skip_chunks` chunks (filter warm-up).
std::vector<float> lane_power_db(int rate, const std::vector<double>& lanes, const std::vector<sig::cf>& x,
                                 int skip_chunks = 5) {
  kc::Channelizer ch(rate);
  ch.set_lanes(lanes);
  std::vector<kc::ChunkPower> meters(lanes.size());
  std::vector<double> acc(lanes.size(), 0);
  std::vector<long> cnt(lanes.size(), 0);
  ch.push_cf(x.data(), x.size(), [&](const kc::cf* out, int n_l, int per, const kc::cf*, int) {
    for (int l = 0; l < n_l; l++) {
      const kc::cf* y = out + l * per;
      for (int d = 0; d < per; d++) {
        if (meters[l].chunks() >= skip_chunks) { acc[l] += std::norm(y[d]); cnt[l]++; }
        meters[l].push(&y[d], 1);
      }
    }
  });
  std::vector<float> db;
  for (size_t l = 0; l < lanes.size(); l++) db.push_back((float)sig::db_power(acc[l] / (double)(cnt[l] ? cnt[l] : 1)));
  return db;
}
}  // namespace

TEST(channelizer_rejects_bad_rates) {
  CHECK_THROWS(kc::Channelizer(2'048'000));   // not a multiple of 50 kHz
  CHECK_THROWS(kc::Channelizer(0));
  CHECK_THROWS(kc::Channelizer(-50'000));
}

TEST(channelizer_geometry) {
  kc::Channelizer a(RATE);
  CHECK(a.fft_size() == 6144);
  CHECK(a.hop() == 3072);
  kc::Channelizer b(250'000);
  CHECK(b.fft_size() == 640);
  CHECK(b.hop() == 320);
}

TEST(channelizer_level_offgrid_and_rejection) {
  const size_t n = RATE;  // 1 s
  auto x = sig::tone(RATE, n, 250'000, 0.3);
  sig::add(x, sig::tone(RATE, n, -412'600, 0.03));        // off the 390.625 Hz bin grid
  sig::add(x, sig::noise(n, 0.0005, 1));
  auto db = lane_power_db(RATE, {250'000, 262'500, 275'000, -412'600, 600'000}, x);
  CHECK_NEAR(db[0], 10 * std::log10(0.09), 0.2);          // on-lane level
  CHECK(db[0] - db[1] > 45);                              // +-12.5 kHz neighbor
  CHECK(db[0] - db[2] > 50);                              // +-25 kHz neighbor
  CHECK_NEAR(db[0] - db[3], 20.0, 0.3);                   // off-grid lane measures right
  CHECK(db[0] - db[4] > 50);                              // empty lane at the floor
}

TEST(channelizer_250k_rate) {
  const int rate = 250'000;
  auto x = sig::tone(rate, rate, 50'000, 0.2);
  auto db = lane_power_db(rate, {50'000, -60'000}, x);
  CHECK_NEAR(db[0], 10 * std::log10(0.04), 0.2);
  CHECK(db[0] - db[1] > 50);
}

// A tone 1 kHz above a lane's center must come out as a clean 1 kHz rotation:
// constant per-sample phase step. A block-parity bug on odd k0 shows as a pi jump every other hop.
static void check_phase_continuity(double lane_hz) {
  const size_t n = RATE / 2;
  auto x = sig::tone(RATE, n, lane_hz + 1000, 0.3);
  kc::Channelizer ch(RATE);
  ch.set_lanes({lane_hz});
  std::vector<kc::cf> y;
  ch.push_cf(x.data(), n, [&](const kc::cf* out, int, int per, const kc::cf*, int) { y.insert(y.end(), out, out + per); });
  const double want = 2 * M_PI * 1000.0 / kc::LANE_RATE;
  double worst = 0;
  for (size_t i = 200; i < y.size(); i++) {
    double step = std::arg(y[i] * std::conj(y[i - 1]));
    worst = std::max(worst, std::fabs(step - want));
  }
  CHECK(worst < 0.01);
}
TEST(channelizer_phase_continuity_even_k0) { check_phase_continuity(250'000); }       // k0 = 640
TEST(channelizer_phase_continuity_odd_k0) { check_phase_continuity(250'390.625); }    // k0 = 641
TEST(channelizer_phase_continuity_offgrid) { check_phase_continuity(250'200); }       // k0 = 641, resid < 0
TEST(channelizer_phase_continuity_negative_odd_k0) { check_phase_continuity(-412'890.625); }  // k0 = -1057

TEST(channelizer_push_size_invariance) {
  const size_t n = 200'000;
  auto x = sig::tone(RATE, n, 123'456, 0.25);
  sig::add(x, sig::noise(n, 0.01, 2));
  auto run = [&](bool chunked) {
    kc::Channelizer ch(RATE);
    ch.set_lanes({123'456, -300'000});
    std::vector<kc::cf> y;
    auto sink = [&](const kc::cf* out, int n_l, int per, const kc::cf*, int) { y.insert(y.end(), out, out + n_l * per); };
    if (!chunked) { ch.push_cf(x.data(), n, sink); return y; }
    std::mt19937 g(3);
    size_t pos = 0;
    while (pos < n) {
      size_t k = std::min<size_t>(n - pos, 1 + g() % 9000);
      ch.push_cf(x.data() + pos, k, sink);
      pos += k;
    }
    return y;
  };
  auto a = run(false), b = run(true);
  CHECK(a.size() == b.size());
  double worst = 0;
  for (size_t i = 0; i < a.size() && i < b.size(); i++) worst = std::max(worst, (double)std::abs(a[i] - b[i]));
  CHECK(worst < 1e-5);
}

TEST(channelizer_u8_path_matches_level) {
  const size_t n = RATE;
  auto x = sig::tone(RATE, n, 250'000, 0.3);
  std::vector<uint8_t> iq(2 * n);
  for (size_t i = 0; i < n; i++) {
    iq[2 * i] = (uint8_t)std::lround(std::clamp(x[i].real() * 127.5f + 127.5f, 0.f, 255.f));
    iq[2 * i + 1] = (uint8_t)std::lround(std::clamp(x[i].imag() * 127.5f + 127.5f, 0.f, 255.f));
  }
  kc::Channelizer ch(RATE);
  ch.set_lanes({250'000});
  kc::ChunkPower m;
  double acc = 0; long cnt = 0;
  ch.push_u8(iq.data(), n, [&](const kc::cf* out, int, int per, const kc::cf*, int) {
    for (int d = 0; d < per; d++) {
      if (m.chunks() >= 5) { acc += std::norm(out[d]); cnt++; }
      m.push(&out[d], 1);
    }
  });
  CHECK_NEAR(sig::db_power(acc / cnt), 10 * std::log10(0.09), 0.3);
}

TEST(chunk_power_fast_and_slow) {
  kc::ChunkPower m;
  std::vector<kc::cf> a(kc::CHUNK_SAMPLES * 10, kc::cf(1, 0));   // 10 chunks at power 1
  CHECK(m.push(a.data(), (int)a.size()) == 10);
  CHECK_NEAR(m.fast_db(), 0.0, 1e-4);
  CHECK_NEAR(m.slow_db(), 0.0, 1e-4);
  std::vector<kc::cf> b(kc::CHUNK_SAMPLES, kc::cf(0, 0));         // one silent chunk
  CHECK(m.push(b.data(), (int)b.size()) == 1);
  CHECK(m.fast_db() < -150);                                      // fast drops at once
  CHECK_NEAR(m.slow_db(), 10 * std::log10(0.9), 1e-3);            // slow = mean of last 10 chunks
  CHECK(m.chunks() == 11);
}

TEST(mean_square_window) {
  kc::MeanSquare ms(4);
  CHECK(!ms.ready());
  CHECK(!ms.push(1)); CHECK(!ms.push(1)); CHECK(!ms.push(1));
  CHECK(ms.push(1));
  CHECK(ms.ready());
  CHECK_NEAR(ms.db(), 0.0, 1e-6);
}
```

Run: `cd /home/kiosk/kerchunk-kiosk/kiosk && npm run test:native`
Expected: FAIL to compile, since `channelizer.hpp` and `meters.hpp` don't exist.

- [ ] **Step 2: Write `meters.hpp`**

```cpp
// Lane power meters. dB = 10*log10(mean + 1e-20).
#pragma once
#include <cmath>
#include <complex>

#include "constants.hpp"

namespace kc {

// Mean |x|^2 over consecutive CHUNK_SAMPLES chunks. fast = latest chunk (10 ms, audio gate);
// slow = mean of the last SLOW_CHUNKS chunk means (100 ms, detection/floor).
class ChunkPower {
 public:
  int push(const std::complex<float>* x, int n) {
    int done = 0;
    for (int i = 0; i < n; i++) {
      acc_ += std::norm(x[i]);
      if (++acc_n_ == CHUNK_SAMPLES) {
        fast_ = acc_ / CHUNK_SAMPLES;
        ring_[ring_pos_] = fast_;
        ring_pos_ = (ring_pos_ + 1) % SLOW_CHUNKS;
        if (ring_fill_ < SLOW_CHUNKS) ring_fill_++;
        acc_ = 0;
        acc_n_ = 0;
        chunks_++;
        done++;
      }
    }
    return done;
  }
  float fast_db() const { return (float)(10 * std::log10(fast_ + 1e-20)); }
  float slow_db() const {
    double s = 0;
    for (int i = 0; i < ring_fill_; i++) s += ring_[i];
    return (float)(10 * std::log10((ring_fill_ ? s / ring_fill_ : 0) + 1e-20));
  }
  long chunks() const { return chunks_; }
  void reset() { *this = ChunkPower(); }

 private:
  double acc_ = 0;
  int acc_n_ = 0;
  double fast_ = 0;
  double ring_[SLOW_CHUNKS] = {};
  int ring_pos_ = 0;
  int ring_fill_ = 0;
  long chunks_ = 0;
};

// Mean square of a real stream over consecutive fixed windows (value updates once per window).
class MeanSquare {
 public:
  explicit MeanSquare(int window) : window_(window) {}
  bool push(float x) {
    acc_ += (double)x * x;
    if (++n_ < window_) return false;
    value_ = acc_ / window_;
    acc_ = 0;
    n_ = 0;
    ready_ = true;
    return true;
  }
  float db() const { return (float)(10 * std::log10(value_ + 1e-20)); }
  bool ready() const { return ready_; }
  void reset() { acc_ = 0; n_ = 0; value_ = 0; ready_ = false; }

 private:
  int window_;
  double acc_ = 0;
  int n_ = 0;
  double value_ = 0;
  bool ready_ = false;
};

}  // namespace kc
```

- [ ] **Step 3: Write `channelizer.hpp`**

```cpp
// Overlap-save FFT channelizer: one shared FFT per hop, then per lane a LANE_BINS-bin extract,
// channel-filter multiply, small IFFT, and residual-offset NCO. Output: LANE_RATE complex per lane.
#pragma once
#include <fftw3.h>

#include <complex>
#include <cstdint>
#include <functional>
#include <vector>

#include "constants.hpp"

namespace kc {
using cf = std::complex<float>;

class Channelizer {
 public:
  explicit Channelizer(int rate);
  ~Channelizer();
  Channelizer(const Channelizer&) = delete;
  Channelizer& operator=(const Channelizer&) = delete;

  int rate() const { return rate_; }
  int fft_size() const { return n_; }
  int hop() const { return n_ / 2; }
  static constexpr int kLaneSamplesPerHop = LANE_BINS / 2;

  void set_lanes(const std::vector<double>& offsets_hz);
  int lanes() const { return (int)lanes_.size(); }

  using HopSink = std::function<void(const cf* lanes_out, int lanes, int per_lane, const cf* raw, int raw_n)>;
  void push_u8(const uint8_t* iq, size_t nsamples, const HopSink& sink);
  void push_cf(const cf* x, size_t nsamples, const HopSink& sink);

 private:
  struct Lane {
    int k0;        // center bin (signed)
    cf nco{1, 0};  // residual-offset rotator state
    cf nco_step{1, 0};
  };
  void run_hop(const HopSink& sink);

  int rate_, n_;
  std::vector<cf> H_;        // channel filter response, n_ bins
  std::vector<Lane> lanes_;
  std::vector<cf> out_;      // lanes * kLaneSamplesPerHop
  float lut_[256];
  fftwf_complex* fin_ = nullptr;   // [previous hop | current hop]
  fftwf_complex* fout_ = nullptr;
  fftwf_complex* lin_ = nullptr;
  fftwf_complex* lout_ = nullptr;
  fftwf_plan pf_ = nullptr, pl_ = nullptr;
  int fill_ = 0;             // samples of the current hop received
  long block_ = 0;           // hops processed since set_lanes (parity for odd-k0 sign)
};
}  // namespace kc
```

- [ ] **Step 4: Write `channelizer.cpp`**

```cpp
#include "channelizer.hpp"

#include <cmath>
#include <cstring>
#include <stdexcept>
#include <string>

#include "fir.hpp"

namespace kc {

Channelizer::Channelizer(int rate) : rate_(rate) {
  if (rate <= 0 || rate % LANE_RATE != 0)
    throw std::invalid_argument("Channelizer: rate " + std::to_string(rate) + " is not a positive multiple of 50 kHz");
  n_ = LANE_BINS * (rate / LANE_RATE);
  std::vector<float> h = design_lowpass(rate, CHAN_CUTOFF_HZ, CHAN_TRANSITION_HZ);
  if ((int)h.size() > n_ / 2 + 1)
    throw std::invalid_argument("Channelizer: " + std::to_string(h.size()) + " taps exceed the overlap-save valid region (" +
                                std::to_string(n_ / 2 + 1) + ") at rate " + std::to_string(rate));
  for (int i = 0; i < 256; i++) lut_[i] = (i - 127.5f) / 127.5f;

  fin_ = fftwf_alloc_complex(n_);
  fout_ = fftwf_alloc_complex(n_);
  lin_ = fftwf_alloc_complex(LANE_BINS);
  lout_ = fftwf_alloc_complex(LANE_BINS);
  // Filter response: taps zero-padded to n_, forward FFT (one-off ESTIMATE plan on the output buffer).
  std::memset(fout_, 0, sizeof(fftwf_complex) * n_);
  for (size_t i = 0; i < h.size(); i++) fout_[i][0] = h[i];
  fftwf_plan ph = fftwf_plan_dft_1d(n_, fout_, fout_, FFTW_FORWARD, FFTW_ESTIMATE);
  fftwf_execute(ph);
  fftwf_destroy_plan(ph);
  H_.resize(n_);
  for (int i = 0; i < n_; i++) H_[i] = cf(fout_[i][0], fout_[i][1]);
  // MEASURE may scribble on the buffers, so plan before zeroing the input history.
  pf_ = fftwf_plan_dft_1d(n_, fin_, fout_, FFTW_FORWARD, FFTW_MEASURE);
  pl_ = fftwf_plan_dft_1d(LANE_BINS, lin_, lout_, FFTW_BACKWARD, FFTW_MEASURE);
  std::memset(fin_, 0, sizeof(fftwf_complex) * n_);
}

Channelizer::~Channelizer() {
  fftwf_destroy_plan(pf_);
  fftwf_destroy_plan(pl_);
  fftwf_free(fin_);
  fftwf_free(fout_);
  fftwf_free(lin_);
  fftwf_free(lout_);
}

void Channelizer::set_lanes(const std::vector<double>& offsets_hz) {
  const double binw = (double)rate_ / n_;
  lanes_.clear();
  for (double off : offsets_hz) {
    Lane l;
    l.k0 = (int)std::lround(off / binw);
    double resid = off - l.k0 * binw;
    double w = -2 * M_PI * resid / LANE_RATE;
    l.nco_step = cf((float)std::cos(w), (float)std::sin(w));
    lanes_.push_back(l);
  }
  out_.assign(lanes_.size() * kLaneSamplesPerHop, cf(0, 0));
  block_ = 0;
}

void Channelizer::push_u8(const uint8_t* iq, size_t nsamples, const HopSink& sink) {
  const int hop = n_ / 2;
  for (size_t i = 0; i < nsamples; i++) {
    fin_[hop + fill_][0] = lut_[iq[2 * i]];
    fin_[hop + fill_][1] = lut_[iq[2 * i + 1]];
    if (++fill_ == hop) run_hop(sink);
  }
}

void Channelizer::push_cf(const cf* x, size_t nsamples, const HopSink& sink) {
  const int hop = n_ / 2;
  for (size_t i = 0; i < nsamples; i++) {
    fin_[hop + fill_][0] = x[i].real();
    fin_[hop + fill_][1] = x[i].imag();
    if (++fill_ == hop) run_hop(sink);
  }
}

void Channelizer::run_hop(const HopSink& sink) {
  const int hop = n_ / 2, keep = kLaneSamplesPerHop, M = LANE_BINS;
  const float scale = 1.0f / n_;
  fftwf_execute(pf_);
  const cf* X = reinterpret_cast<const cf*>(fout_);
  cf* Y = reinterpret_cast<cf*>(lin_);
  const cf* yb = reinterpret_cast<const cf*>(lout_);
  for (size_t li = 0; li < lanes_.size(); li++) {
    Lane& l = lanes_[li];
    for (int m = -M / 2; m < M / 2; m++) {
      int kx = ((l.k0 + m) % n_ + n_) % n_;
      int kh = (m + n_) % n_;
      Y[(m + M) % M] = X[kx] * H_[kh];
    }
    fftwf_execute(pl_);
    // Hop n/2 advances the k0 mixer by pi*k0 per block: flip sign on odd k0, odd block.
    const float s = ((l.k0 & 1) && (block_ & 1)) ? -scale : scale;
    cf* o = &out_[li * keep];
    for (int d = 0; d < keep; d++) {
      o[d] = yb[keep + d] * s * l.nco;
      l.nco *= l.nco_step;
    }
    l.nco /= std::abs(l.nco);  // renormalize once per hop so float drift can't grow
  }
  block_++;
  sink(out_.data(), (int)lanes_.size(), keep, reinterpret_cast<const cf*>(fin_ + hop), hop);
  std::memmove(fin_, fin_ + hop, sizeof(fftwf_complex) * hop);
  fill_ = 0;
}

}  // namespace kc
```

- [ ] **Step 5: Run the tests**

Run: `cd /home/kiosk/kerchunk-kiosk/kiosk && npm run test:native`
Expected: all channelizer and meter tests plus the FIR tests `ok`, `0 failed checks`, and a warning-free build.

- [ ] **Step 6: Commit**

```bash
git add kiosk/native/src/channelizer.hpp kiosk/native/src/channelizer.cpp kiosk/native/src/meters.hpp kiosk/native/test/test_channelizer.cpp
git commit -m "feat(native): overlap-save channelizer with partial-hop input, validated rates, odd-k0 continuity; lane meters"
```

---

### Task 3: FM discriminator, AM envelope, de-emphasis, quieting

**Files:**
- Create: `kiosk/native/src/demod.hpp`, `kiosk/native/src/demod.cpp`
- Test: `kiosk/native/test/test_demod.cpp`

**Interfaces:**
- Consumes: `kc::FirFilter`, `kc::design_highpass`, `kc::MeanSquare`, constants; `sig::*`.
- Produces:
  ```cpp
  namespace kc {
  class FmDiscriminator { public: float step(cf x); void reset(); };      // +-1 at FM_MAX_DEV_HZ; first sample -> 0
  class AmEnvelope { public: float step(cf x); void reset(); };           // |x|/carrier - 1, carrier primed from first sample
  class Deemphasis { public: float step(float x); void reset(); };        // one-pole, tau = DEEMPH_TAU_S at LANE_RATE
  class QuietingMeter {                                                   // HPF(NOISE_HPF_HZ) -> MeanSquare(NOISE_WINDOW)
   public: QuietingMeter(); bool push(float disc); float db() const; bool ready() const; void reset();
  };
  }
  ```

- [ ] **Step 1: Write the failing tests**

`kiosk/native/test/test_demod.cpp`:

```cpp
#include <cmath>
#include <vector>

#include "check.hpp"
#include "constants.hpp"
#include "demod.hpp"
#include "signals.hpp"

constexpr double LR = kc::LANE_RATE;

TEST(fm_discriminator_first_sample_is_zero) {
  kc::FmDiscriminator d;
  CHECK(d.step(kc::cf(0, 1)) == 0.0f);        // arbitrary phase: no startup impulse
  CHECK_NEAR(d.step(kc::cf(0, 1)), 0.0, 1e-6); // no rotation -> 0
}

TEST(fm_discriminator_scale) {
  // 3 kHz deviation, 1 kHz tone -> output amplitude 0.6, rms 0.6/sqrt(2).
  auto x = sig::fm_tone(LR, 50'000, 0, 3000, 1000, 0.3);
  kc::FmDiscriminator d;
  std::vector<float> y;
  for (auto v : x) y.push_back(d.step(v));
  CHECK_NEAR(sig::rms(y.data() + 1000, y.size() - 1000), 0.6 / std::sqrt(2.0), 0.01);
}

TEST(fm_discriminator_static_offset) {
  // A carrier 1 kHz off center reads as constant 1000/5000 = 0.2.
  auto x = sig::tone(LR, 2000, 1000, 0.3);
  kc::FmDiscriminator d;
  float last = 0;
  for (auto v : x) last = d.step(v);
  CHECK_NEAR(last, 0.2, 1e-3);
}

TEST(quieting_separates_carrier_from_noise) {
  auto carrier = sig::fm_tone(LR, 50'000, 0, 3000, 1000, 0.3);
  sig::add(carrier, sig::noise(50'000, 0.004, 5));
  auto noise = sig::noise(50'000, 0.05, 6);
  auto run = [](const std::vector<sig::cf>& x) {
    kc::FmDiscriminator d;
    kc::QuietingMeter q;
    for (auto v : x) q.push(d.step(v));
    CHECK(q.ready());
    return q.db();
  };
  double c = run(carrier), n = run(noise);
  CHECK(n - c > 30);
}

TEST(am_envelope_normalizes_carrier) {
  auto am = [](double carrier_amp) {
    std::vector<sig::cf> x(50'000);
    for (size_t i = 0; i < x.size(); i++) {
      double a = carrier_amp * (1 + 0.5 * std::sin(2 * M_PI * 1000 * i / LR));
      x[i] = sig::cf((float)a, 0.f);
    }
    kc::AmEnvelope e;
    std::vector<float> y;
    for (auto v : x) y.push_back(e.step(v));
    return sig::rms(y.data() + 10'000, y.size() - 10'000);
  };
  double strong = am(0.2), weak = am(0.02);
  CHECK_NEAR(strong, 0.5 / std::sqrt(2.0), 0.03);
  CHECK_NEAR(weak, strong, 0.01);   // loudness independent of RF level
}

TEST(deemphasis_dc_and_corner) {
  kc::Deemphasis de;
  float y = 0;
  for (int i = 0; i < 20'000; i++) y = de.step(1.0f);
  CHECK_NEAR(y, 1.0, 1e-3);
  // At the 75 us corner (2122 Hz) a one-pole is -3 dB.
  kc::Deemphasis d2;
  std::vector<float> out;
  for (int i = 0; i < 50'000; i++) out.push_back(d2.step((float)std::sin(2 * M_PI * 2122.1 * i / LR)));
  double g = sig::rms(out.data() + 5000, out.size() - 5000) / (1 / std::sqrt(2.0));
  CHECK_NEAR(20 * std::log10(g), -3.0, 0.6);
}
```

Run: `npm run test:native`
Expected: FAIL to compile (`demod.hpp` missing).

- [ ] **Step 2: Write `demod.hpp`**

```cpp
// Per-lane demodulators at LANE_RATE.
#pragma once
#include <complex>

#include "constants.hpp"
#include "fir.hpp"
#include "meters.hpp"

namespace kc {
using cf = std::complex<float>;

// FM discriminator: arg(x[n] * conj(x[n-1])), scaled so +-1.0 == +-FM_MAX_DEV_HZ.
// The first sample after reset only primes the history and outputs 0, so an arbitrary
// starting phase can't inject a +-pi impulse into the quieting meter.
class FmDiscriminator {
 public:
  float step(cf x);
  void reset() { primed_ = false; }

 private:
  cf prev_{0, 0};
  bool primed_ = false;
};

// AM: envelope normalized by its own slow average (the carrier), DC removed:
// out = |x| / carrier - 1, so loudness is independent of RF level.
class AmEnvelope {
 public:
  float step(cf x);
  void reset() { primed_ = false; }

 private:
  float carrier_ = 0;
  bool primed_ = false;
};

// One-pole de-emphasis, tau = DEEMPH_TAU_S at LANE_RATE, unity DC gain.
class Deemphasis {
 public:
  float step(float x);
  void reset() { y_ = 0; }

 private:
  float y_ = 0;
};

// Quieting squelch input: HF-noise power of the discriminator output
// (HPF above NOISE_HPF_HZ, mean square over NOISE_WINDOW).
class QuietingMeter {
 public:
  QuietingMeter();
  bool push(float disc) { return ms_.push(hpf_.step(disc)); }
  float db() const { return ms_.db(); }
  bool ready() const { return ms_.ready(); }
  void reset() { hpf_.reset(); ms_.reset(); }

 private:
  FirFilter hpf_;
  MeanSquare ms_;
};
}  // namespace kc
```

- [ ] **Step 3: Write `demod.cpp`**

```cpp
#include "demod.hpp"

#include <cmath>

namespace kc {

namespace {
const float kDiscScale = (float)(LANE_RATE / (2 * M_PI * FM_MAX_DEV_HZ));
const float kAmAlpha = (float)(1 - std::exp(-1.0 / (AM_CARRIER_TAU_S * LANE_RATE)));
const float kDeemphA = (float)std::exp(-1.0 / (LANE_RATE * DEEMPH_TAU_S));
}  // namespace

float FmDiscriminator::step(cf x) {
  if (!primed_) {
    prev_ = x;
    primed_ = true;
    return 0.f;
  }
  cf c = x * std::conj(prev_);
  prev_ = x;
  return std::atan2(c.imag(), c.real()) * kDiscScale;
}

float AmEnvelope::step(cf x) {
  float env = std::abs(x);
  if (!primed_) {
    carrier_ = env;
    primed_ = true;
  } else {
    carrier_ += kAmAlpha * (env - carrier_);
  }
  return carrier_ > 1e-12f ? env / carrier_ - 1.f : 0.f;
}

float Deemphasis::step(float x) {
  y_ = kDeemphA * y_ + (1 - kDeemphA) * x;
  return y_;
}

QuietingMeter::QuietingMeter()
    : hpf_(design_highpass(LANE_RATE, NOISE_HPF_HZ, NOISE_HPF_TRANSITION_HZ)), ms_(NOISE_WINDOW) {}

}  // namespace kc
```

- [ ] **Step 4: Run the tests**

Run: `npm run test:native`
Expected: all tests `ok`, `0 failed checks`.

- [ ] **Step 5: Commit**

```bash
git add kiosk/native/src/demod.hpp kiosk/native/src/demod.cpp kiosk/native/test/test_demod.cpp
git commit -m "feat(native): primed FM discriminator, carrier-normalized AM, de-emphasis, quieting meter"
```

---

### Task 4: Rational polyphase resampler (50k→48k speaker, 50k→22.05k SAME)

**Files:**
- Create: `kiosk/native/src/resampler.hpp`, `kiosk/native/src/resampler.cpp`
- Test: `kiosk/native/test/test_resampler.cpp`

**Interfaces:**
- Consumes: `kc::design_lowpass`; `sig::*`.
- Produces:
  ```cpp
  namespace kc {
  class Resampler {
   public:
    // up/down ratio; prototype low-pass designed at in_rate*up with cutoff/transition in Hz.
    Resampler(int up, int down, double in_rate, double cutoff_hz, double transition_hz);
    int push(const float* x, int n, std::vector<float>& out);   // appends; returns count appended
    void reset();
    int taps_per_phase() const;
  };
  }
  ```

- [ ] **Step 1: Write the failing tests**

`kiosk/native/test/test_resampler.cpp`:

```cpp
#include <cmath>
#include <vector>

#include "check.hpp"
#include "constants.hpp"
#include "resampler.hpp"
#include "signals.hpp"

static std::vector<float> sine(double rate, int n, double f, double a) {
  std::vector<float> x(n);
  for (int i = 0; i < n; i++) x[i] = (float)(a * std::sin(2 * M_PI * f * i / rate));
  return x;
}

// Estimate frequency from positive-going zero crossings.
static double freq_of(const std::vector<float>& y, size_t from, double rate) {
  int crossings = 0;
  size_t first = 0, last = 0;
  for (size_t i = from + 1; i < y.size(); i++) {
    if (y[i - 1] < 0 && y[i] >= 0) {
      if (!crossings) first = i;
      last = i;
      crossings++;
    }
  }
  return crossings > 1 ? (crossings - 1) * rate / (double)(last - first) : 0;
}

TEST(resampler_speaker_50k_to_48k) {
  kc::Resampler r(24, 25, kc::LANE_RATE, 20'000, 4'000);
  auto x = sine(kc::LANE_RATE, 50'000, 1000, 0.5);
  std::vector<float> y;
  int got = r.push(x.data(), 20'000, y);
  got += r.push(x.data() + 20'000, 30'000, y);
  CHECK(got == (int)y.size());
  CHECK(std::abs((int)y.size() - 48'000) <= 1);
  CHECK_NEAR(sig::rms(y.data() + 2000, y.size() - 2000), 0.5 / std::sqrt(2.0), 0.005);
  CHECK_NEAR(freq_of(y, 2000, kc::AUDIO_RATE), 1000.0, 2.0);
}

TEST(resampler_same_50k_to_22050_rejects_images) {
  auto level = [](double f) {
    kc::Resampler r(441, 1000, kc::LANE_RATE, 10'000, 1'000);
    auto x = sine(kc::LANE_RATE, 50'000, f, 0.5);
    std::vector<float> y;
    r.push(x.data(), (int)x.size(), y);
    CHECK(std::abs((int)y.size() - 22'050) <= 1);
    return 20 * std::log10(sig::rms(y.data() + 2000, y.size() - 2000) + 1e-12);
  };
  double pass = level(1000), stop = level(15'000);   // 15 kHz folds above 11.025 kHz output Nyquist
  CHECK_NEAR(pass, 20 * std::log10(0.5 / std::sqrt(2.0)), 0.1);
  CHECK(pass - stop > 40);
}

TEST(resampler_reset_restarts_cleanly) {
  kc::Resampler r(24, 25, kc::LANE_RATE, 20'000, 4'000);
  auto x = sine(kc::LANE_RATE, 5000, 1000, 0.5);
  std::vector<float> a, b;
  r.push(x.data(), (int)x.size(), a);
  r.reset();
  r.push(x.data(), (int)x.size(), b);
  CHECK(a.size() == b.size());
  for (size_t i = 0; i < a.size() && i < b.size(); i++) CHECK_NEAR(a[i], b[i], 1e-7);
}
```

Run: `npm run test:native`. Expected: FAIL to compile (`resampler.hpp` missing).

- [ ] **Step 2: Write `resampler.hpp` and `resampler.cpp`**

`kiosk/native/src/resampler.hpp`:

```cpp
// Rational polyphase resampler (up/down) on a real stream.
#pragma once
#include <vector>

namespace kc {
class Resampler {
 public:
  Resampler(int up, int down, double in_rate, double cutoff_hz, double transition_hz);
  int push(const float* x, int n, std::vector<float>& out);
  void reset();
  int taps_per_phase() const { return tpp_; }

 private:
  int up_, down_, tpp_;
  std::vector<float> poly_;  // poly_[phase*tpp + j] = up * proto[phase + up*(tpp-1-j)] (oldest-first window order)
  std::vector<float> hist_;  // doubled ring, 2*tpp
  int pos_ = 0;
  int phase_ = 0;
};
}  // namespace kc
```

`kiosk/native/src/resampler.cpp`:

```cpp
#include "resampler.hpp"

#include <algorithm>
#include <stdexcept>

#include "fir.hpp"

namespace kc {

Resampler::Resampler(int up, int down, double in_rate, double cutoff_hz, double transition_hz)
    : up_(up), down_(down) {
  if (up < 1 || down < 1) throw std::invalid_argument("Resampler: up/down must be >= 1");
  std::vector<float> proto = design_lowpass(in_rate * up, cutoff_hz, transition_hz);
  tpp_ = (int)((proto.size() + up - 1) / up);
  proto.resize((size_t)tpp_ * up, 0.f);
  poly_.resize((size_t)tpp_ * up);
  for (int p = 0; p < up; p++)
    for (int j = 0; j < tpp_; j++) poly_[(size_t)p * tpp_ + j] = up * proto[(size_t)p + (size_t)up * (tpp_ - 1 - j)];
  hist_.assign(2 * (size_t)tpp_, 0.f);
}

int Resampler::push(const float* x, int n, std::vector<float>& out) {
  int emitted = 0;
  for (int i = 0; i < n; i++) {
    hist_[pos_] = x[i];
    hist_[pos_ + tpp_] = x[i];
    const float* w = &hist_[pos_ + 1];  // oldest-first window of the last tpp inputs
    while (phase_ < up_) {
      const float* h = &poly_[(size_t)phase_ * tpp_];
      float acc = 0.f;
      for (int j = 0; j < tpp_; j++) acc += h[j] * w[j];
      out.push_back(acc);
      emitted++;
      phase_ += down_;
    }
    phase_ -= up_;
    pos_ = pos_ + 1 == tpp_ ? 0 : pos_ + 1;
  }
  return emitted;
}

void Resampler::reset() {
  std::fill(hist_.begin(), hist_.end(), 0.f);
  pos_ = 0;
  phase_ = 0;
}

}  // namespace kc
```

- [ ] **Step 3: Run the tests**

Run: `npm run test:native`
Expected: all `ok`, `0 failed checks`. If `resampler_speaker_50k_to_48k` is off in frequency by ~4% (1041.7 or 960 Hz), the phase bookkeeping is inverted. Fix it in `push`, never in the test.

- [ ] **Step 4: Commit**

```bash
git add kiosk/native/src/resampler.hpp kiosk/native/src/resampler.cpp kiosk/native/test/test_resampler.cpp
git commit -m "feat(native): rational polyphase resampler (50k->48k speaker, 50k->22.05k SAME)"
```

---

### Task 5: Always-on demod cost on the real capture (the data for P1b's demod-on-demand ruling)

**Files:**
- Create: `kiosk/native/tools/cost_bench.cpp`
- Create: `kiosk/bench/RESULTS-2026-09-25-native-p1a.md`

**Interfaces:**
- Consumes: `Channelizer`, `ChunkPower`, `FmDiscriminator`, `QuietingMeter`, `MeanSquare`, `Deemphasis`, `FirFilter`, `design_lowpass`, `Resampler` (Tasks 1–4).
- Produces: `kiosk/native/build/kc-cost-bench --file F.cu8 --rate HZ --chan OFF [--chan ...] [--demod all|one|none]`. Last stdout line: `COST iq_s=<f> cpu_s=<f> core_pct=<f> lanes=<n> demod=<all|one|none>`.

- [ ] **Step 1: Write the tool**

`kiosk/native/tools/cost_bench.cpp`:

```cpp
// Batch cost of the DSP core on a .cu8 replay. demod=all: discriminator + quieting + speech meter
// on EVERY lane (always-on design); one: only lane 0; none: channelizer + power only.
// Lane 0 additionally runs the full speaker path (deemph -> audio LPF -> 50k->48k) in all/one modes.
#include <sys/resource.h>

#include <algorithm>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <vector>

#include "channelizer.hpp"
#include "demod.hpp"
#include "fir.hpp"
#include "meters.hpp"
#include "resampler.hpp"

static double cpu_seconds() {
  rusage u{};
  getrusage(RUSAGE_SELF, &u);
  return u.ru_utime.tv_sec + u.ru_utime.tv_usec / 1e6 + u.ru_stime.tv_sec + u.ru_stime.tv_usec / 1e6;
}

int main(int argc, char** argv) {
  std::string file, demod = "all";
  int rate = 2'400'000;
  std::vector<double> chans;
  for (int i = 1; i < argc; i++) {
    std::string k = argv[i];
    if (i + 1 >= argc) { std::fprintf(stderr, "missing value for %s\n", k.c_str()); return 2; }
    std::string v = argv[++i];
    if (k == "--file") file = v;
    else if (k == "--rate") rate = std::atoi(v.c_str());
    else if (k == "--chan") chans.push_back(std::atof(v.c_str()));
    else if (k == "--demod") demod = v;
    else { std::fprintf(stderr, "unknown arg %s\n", k.c_str()); return 2; }
  }
  if (file.empty() || chans.empty() || (demod != "all" && demod != "one" && demod != "none")) {
    std::fprintf(stderr, "usage: --file F.cu8 --chan OFF [--chan ...] [--rate HZ] [--demod all|one|none]\n");
    return 2;
  }
  FILE* f = std::fopen(file.c_str(), "rb");
  if (!f) { std::perror(file.c_str()); return 1; }
  std::vector<uint8_t> raw;
  { uint8_t buf[1 << 16]; size_t r; while ((r = std::fread(buf, 1, sizeof buf, f)) > 0) raw.insert(raw.end(), buf, buf + r); }
  std::fclose(f);
  const size_t nsamp = raw.size() / 2;

  kc::Channelizer ch(rate);
  ch.set_lanes(chans);
  const int L = (int)chans.size();
  std::vector<kc::ChunkPower> power(L);
  std::vector<kc::FmDiscriminator> disc(L);
  std::vector<kc::QuietingMeter> quiet(L);
  std::vector<kc::MeanSquare> speech(L, kc::MeanSquare(kc::SPEECH_WINDOW));
  kc::Deemphasis de;
  kc::FirFilter audio_lpf(kc::design_lowpass(kc::LANE_RATE, kc::AUDIO_LPF_HZ, kc::AUDIO_LPF_TRANSITION_HZ));
  kc::Resampler to48(24, 25, kc::LANE_RATE, 20'000, 4'000);
  std::vector<float> lane_audio(kc::Channelizer::kLaneSamplesPerHop), out48;
  const int demod_lanes = demod == "all" ? L : demod == "one" ? 1 : 0;
  double sink_guard = 0;

  // Feed in 10 ms slices like the live engine will.
  const size_t slice = (size_t)rate / 100;
  double c0 = cpu_seconds();
  for (size_t pos = 0; pos < nsamp; pos += slice) {
    size_t n = std::min(slice, nsamp - pos);
    ch.push_u8(&raw[2 * pos], n, [&](const kc::cf* out, int n_l, int per, const kc::cf*, int) {
      for (int l = 0; l < n_l; l++) {
        const kc::cf* y = out + l * per;
        power[l].push(y, per);
        if (l >= demod_lanes) continue;
        for (int d = 0; d < per; d++) {
          float v = disc[l].step(y[d]);
          quiet[l].push(v);
          speech[l].push(v);
          if (l == 0) lane_audio[d] = audio_lpf.step(de.step(v));
        }
        if (l == 0) {
          out48.clear();
          to48.push(lane_audio.data(), per, out48);
          for (float s : out48) sink_guard += s;
        }
      }
    });
  }
  double cpu = cpu_seconds() - c0;
  for (int l = 0; l < L; l++) sink_guard += power[l].slow_db() + quiet[l].db() + speech[l].db();
  double iq_s = (double)nsamp / rate;
  std::printf("guard=%g\n", sink_guard);  // keeps every meter observable so nothing is elided
  std::printf("COST iq_s=%.2f cpu_s=%.3f core_pct=%.1f lanes=%d demod=%s\n", iq_s, cpu, 100 * cpu / iq_s, L, demod.c_str());
  return 0;
}
```

- [ ] **Step 2: Build and smoke it on synthetic noise**

Run: `cd /home/kiosk/kerchunk-kiosk/kiosk && npm run build:native && ls /home/kiosk/kiosk-iq/noise10s.cu8`. If the file is missing, create it with:
`/usr/bin/python3 -c "import numpy as np; np.random.default_rng(0).integers(100,156,2*24_000_000).astype(np.uint8).tofile('/home/kiosk/kiosk-iq/noise10s.cu8')"`
Then: `native/build/kc-cost-bench --file /home/kiosk/kiosk-iq/noise10s.cu8 --chan 250000 --demod all`
Expected: a `COST ... lanes=1 demod=all` line.

- [ ] **Step 3: Measure on the real capture (3 runs per mode, median)**

The appliance is live and thermally tight. Run each mode exactly 3 times, back to back, with no extra loops. Record package temp before and after (`x86_pkg_temp` zone).

```bash
cd /home/kiosk/kerchunk-kiosk/kiosk
CH=(--chan -903750 --chan -883750 --chan -723750 --chan -563750 --chan 486250 --chan 591250 --chan 603750 --chan 666250 --chan 728750 --chan 756250 --chan 903750 --chan 0)
for m in none one all; do for i in 1 2 3; do native/build/kc-cost-bench --file /home/kiosk/kiosk-iq/2m-146033750-2400k.cu8 "${CH[@]}" --demod $m | tail -1; done; done
```

Expected: nine `COST ... lanes=12` lines.

- [ ] **Step 4: Write the results**

`kiosk/bench/RESULTS-2026-09-25-native-p1a.md`, with the measured medians in place of `<X>`:

```markdown
# Native DSP P1a — always-on demod cost — 2026-09-25

Library: kiosk/native (kcdsp), -O3 -march=native, no -ffast-math. Tool: kc-cost-bench, batch replay
fed in 10 ms slices, single thread. Capture: 2 m group, 146.03375 MHz, 2.4 Msps, 30 s (same as P0).
12 lanes = 11 real channels + DC stand-in. Package temp <before> -> <after> °C (live helper running).

| demod | what runs | core_pct (median of 3) |
|---|---|---|
| none | channelizer + lane power (12) | <X> |
| one | + discriminator/quieting/speech on lane 0 + speaker path | <X> |
| all | + discriminator/quieting/speech on all 12 lanes | <X> |

Raw lines: <the nine COST lines>

Always-on delta (all - one): <X> points.
Caveat (from P0): batch replay is turbo/cache-optimistic; real-time may cost 1.5-3x.

Recommendation for P1b: <drop demod-on-demand (always-on discriminator + quieting on every lane,
speaker path only on the audible lane) if `all` <= 25% batch; otherwise keep the spec's on-demand
arming> — one sentence stating which, with the number.
```

- [ ] **Step 5: Run the whole suite once more and commit**

Run: `cd /home/kiosk/kerchunk-kiosk/kiosk && npm run test:native && npm test 2>&1 | grep -E "Tests"`
Expected: native `0 failed checks`; vitest all passing.

```bash
git add kiosk/native/tools/cost_bench.cpp kiosk/bench/RESULTS-2026-09-25-native-p1a.md
git commit -m "bench(native): always-on demod cost on real RF (P1a) — data for the demod-on-demand ruling"
```

---

## After P1a (not in this plan)

- **P1b plan (engine):** squelch/arbitration state machine on chunk boundaries, Close Call detector, JSON protocol, `--iq-file` replay binary with deterministic events, and the demod-on-demand ruling applied from Task 5's numbers.
- **P1c plan (live I/O):** librtlsdr async reader thread + SPSC ring, ALSA writer with xrun recovery, non-blocking fd-3 tee, multimon-ng pipe, signals and shutdown, and real-time (`--realtime`) CPU% as acceptance.
