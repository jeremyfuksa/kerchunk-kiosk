# Native DSP P0 Bench (go/no-go) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Measure, on this appliance and on real captured RF, how much CPU the
native engine's DSP core costs, and decide go/no-go for P1.

**Architecture:** A throwaway single-file C++ bench (`kiosk/bench/native_p0/p0.cpp`)
replays a `.cu8` IQ capture as fast as possible through the spec's core:
u8 LUT → shared 6144-point overlap-save FFT → per-channel 128-bin extract +
filter + 128-point IFFT (50 kHz lanes) + residual NCO → 10 ms power per lane,
plus one full FM demod/audio lane and the 20 fps Close Call FFT. It reports
CPU-seconds per IQ-second. A numpy script checks the channelizer's correctness
on synthetic IQ (test) and against a time-domain reference on the real capture.

**Tech Stack:** C++17, g++, FFTW3 (float, `libfftw3-dev`, already installed),
system python3 + numpy, `rtl_sdr` CLI (installed).

**Spec:** `docs/superpowers/specs/2026-09-25-native-dsp-engine-design.md`
(this plan is phase P0 of §5; P1/P2 plans are written after the go decision).

## Global Constraints

- Lane rate 50 kHz; D = rate / 50 000; `FFT_N` = 128·D (2.4 Msps → D = 48, N = 6144); 50% overlap (hop N/2).
- Channel filter: windowed-sinc low-pass, cutoff 8000 Hz, transition 4000 Hz (Hamming, 2001 taps; matches today's `firdes.low_pass(1.0, rate, 8000, 4000)`).
- Chunk = 10 ms (500 lane samples). Close Call FFT: 2048-point Blackman-Harris at 20 frames/s.
- **Go criterion:** bench total ≤ 60% of one core (leaves margin for USB + audio + control under the spec's ≤ 1 core instance budget).
- Python runs with `/usr/bin/python3` (system python; numpy available).
- Stopping `kerchunk-kiosk` interrupts live audio: only in Task 4, only after the operator OKs it, and restart it immediately after.
- Bench lives in `kiosk/bench/` (like `pi_dsp_bench.py`); captures live OUTSIDE the repo in `/home/kiosk/kiosk-iq/`.

## File Structure

- `kiosk/bench/native_p0/p0.cpp`: the bench (channelizer, power, demod lane, CC FFT, timing, `--dump` CSV).
- `kiosk/bench/native_p0/build.sh`: one-line g++ build.
- `kiosk/bench/native_p0/test_p0.py`: synthetic-IQ correctness test (runs the binary).
- `kiosk/bench/native_p0/ref_check.py`: real-capture reference comparison (numpy time-domain filter vs bench dump).
- `kiosk/bench/RESULTS-2026-09-25-native-p0.md`: measured results and the go/no-go verdict.

---

### Task 1: Channelizer + power, proven on synthetic IQ

**Files:**
- Create: `kiosk/bench/native_p0/p0.cpp`
- Create: `kiosk/bench/native_p0/build.sh`
- Test: `kiosk/bench/native_p0/test_p0.py`

**Interfaces:**
- Produces: CLI `p0 --file F.cu8 --rate HZ --chan OFFSET_HZ [--chan ...] [--demod IDX] [--no-cc] [--dump out.csv] [--seconds S]`.
  `OFFSET_HZ` = channel freq − capture center (may be negative, need not be on a raster).
  `--dump` writes CSV: header `t,<ch0>,<ch1>,...` then one row per 100 ms: `t` (s) and each lane's mean power in dB (10·log10 of mean |y|² over that 100 ms).
  stdout last line: `P0 iq_s=<float> cpu_s=<float> core_pct=<float> lanes=<n> demod=<0|1> cc=<0|1>`.

- [ ] **Step 1: Write the failing test**

`kiosk/bench/native_p0/test_p0.py`:

```python
"""Synthetic-IQ correctness test for the P0 channelizer. Run: /usr/bin/python3 test_p0.py"""
import csv, os, subprocess, sys, tempfile
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
BIN = os.path.join(HERE, "p0")
RATE = 2_400_000

def write_cu8(path, x):
    iq = np.empty(2 * len(x), dtype=np.float64)
    iq[0::2], iq[1::2] = x.real, x.imag
    np.clip(np.round(iq * 127.5 + 127.5), 0, 255).astype(np.uint8).tofile(path)

def run(path, chans, extra=()):
    dump = path + ".csv"
    args = [BIN, "--file", path, "--rate", str(RATE), "--no-cc", "--dump", dump, *extra]
    for c in chans:
        args += ["--chan", str(c)]
    out = subprocess.run(args, check=True, capture_output=True, text=True).stdout
    rows = list(csv.reader(open(dump)))
    data = np.array([[float(v) for v in r[1:]] for r in rows[1:]])
    return out, data[2:].mean(axis=0)   # skip filter warm-up windows

rng = np.random.default_rng(1)
n = RATE  # 1 s
t = np.arange(n) / RATE
A_HZ, B_HZ = 250_000, -412_600               # B deliberately off the 390.625 Hz bin grid
x = (0.3 * np.exp(2j * np.pi * A_HZ * t)
     + 0.03 * np.exp(2j * np.pi * B_HZ * t)
     + 0.004 * (rng.standard_normal(n) + 1j * rng.standard_normal(n)))
chans = [A_HZ, A_HZ + 12_500, B_HZ, 600_000]  # A, A's neighbor, B, empty

with tempfile.TemporaryDirectory() as d:
    p = os.path.join(d, "syn.cu8")
    write_cu8(p, x)
    out, db = run(p, chans)
    pA, pN, pB, pE = db
    print("dB:", np.round(db, 2))
    assert abs(pA - 10 * np.log10(0.09)) < 0.5, pA          # 0.3^2 through unity-gain filter
    assert abs((pA - pB) - 20.0) < 1.0, (pA, pB)            # off-grid tone measured right
    assert pA - pN > 35, (pA, pN)                           # adjacent 12.5 kHz rejection
    assert pA - pE > 35, (pA, pE)                           # empty channel stays at floor
    last = out.strip().splitlines()[-1]
    assert last.startswith("P0 ") and "lanes=4" in last, last
    # Demod + CC paths run without disturbing lane powers.
    out2, db2 = run(p, chans, ("--demod", "0"))
    assert np.allclose(db, db2, atol=0.01), (db, db2)
    assert "demod=1" in out2.strip().splitlines()[-1]
print("test_p0: OK")
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/kiosk/kerchunk-kiosk/kiosk/bench/native_p0 && /usr/bin/python3 test_p0.py`
Expected: FAIL, `FileNotFoundError` for `.../p0` (binary not built).

- [ ] **Step 3: Write the build script**

`kiosk/bench/native_p0/build.sh`:

```sh
#!/bin/sh
# Throwaway P0 bench build. -march=native: this binary only ever runs on the appliance.
set -e
cd "$(dirname "$0")"
g++ -O3 -march=native -ffast-math -std=c++17 -Wall -Wextra -o p0 p0.cpp -lfftw3f -lm
```

Run: `chmod +x kiosk/bench/native_p0/build.sh`

- [ ] **Step 4: Write the bench (channelizer + power; demod and CC are stubs filled in Task 2)**

`kiosk/bench/native_p0/p0.cpp`:

```cpp
// P0 bench (throwaway): cost of the native engine's DSP core on a .cu8 replay.
// Spec: docs/superpowers/specs/2026-09-25-native-dsp-engine-design.md §2.
#include <fftw3.h>
#include <sys/resource.h>
#include <cmath>
#include <complex>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

using cf = std::complex<float>;
static constexpr int LANE_RATE = 50000;
static constexpr int M = 128;                 // lane IFFT size (bins per channel)
static constexpr int CHUNK = LANE_RATE / 100; // 10 ms of lane samples
static constexpr double CUTOFF_HZ = 8000, TRANS_HZ = 4000;
static constexpr int NTAPS = 2001;            // Hamming ~ 3.3*fs/tw, like firdes

struct Args {
  std::string file, dump;
  double rate = 2.4e6, seconds = 0;
  std::vector<double> chans;
  int demod = -1;
  bool cc = true;
};

static Args parse(int argc, char** argv) {
  Args a;
  for (int i = 1; i < argc; i++) {
    std::string k = argv[i];
    auto next = [&]() -> const char* {
      if (i + 1 >= argc) { fprintf(stderr, "missing value for %s\n", k.c_str()); exit(2); }
      return argv[++i];
    };
    if (k == "--file") a.file = next();
    else if (k == "--rate") a.rate = atof(next());
    else if (k == "--chan") a.chans.push_back(atof(next()));
    else if (k == "--demod") a.demod = atoi(next());
    else if (k == "--no-cc") a.cc = false;
    else if (k == "--dump") a.dump = next();
    else if (k == "--seconds") a.seconds = atof(next());
    else { fprintf(stderr, "unknown arg %s\n", k.c_str()); exit(2); }
  }
  if (a.file.empty() || a.chans.empty()) { fprintf(stderr, "need --file and --chan\n"); exit(2); }
  return a;
}

static double cpu_seconds() {
  rusage u{};
  getrusage(RUSAGE_SELF, &u);
  return u.ru_utime.tv_sec + u.ru_utime.tv_usec / 1e6 + u.ru_stime.tv_sec + u.ru_stime.tv_usec / 1e6;
}

struct Lane {
  int k0;               // center bin (signed)
  float resid_hz;       // channel freq - bin center
  cf nco{1, 0}, nco_step{1, 0};
  double acc = 0;       // |y|^2 sum for the current 10 ms chunk
  int acc_n = 0;
  double win_acc = 0;   // |y|^2 sum for the current 100 ms dump window
  int win_n = 0;
  std::vector<cf> out;  // lane samples of the current block (for the demod lane)
};

struct Demod;  // Task 2
static void demod_block(Demod*, const std::vector<cf>&) {}
struct CcFft;  // Task 2
static void cc_feed(CcFft*, const cf*, int) {}

int main(int argc, char** argv) {
  Args a = parse(argc, argv);
  const int D = (int)std::lround(a.rate / LANE_RATE);
  if (D * LANE_RATE != (int)a.rate) { fprintf(stderr, "rate must be a multiple of 50 kHz\n"); return 2; }
  const int N = M * D, HOP = N / 2, KEEP = M / 2;  // overlap-save: keep last half

  // Load the whole capture (excluded from timing).
  FILE* f = fopen(a.file.c_str(), "rb");
  if (!f) { perror(a.file.c_str()); return 1; }
  std::vector<uint8_t> raw;
  { uint8_t buf[1 << 16]; size_t r; while ((r = fread(buf, 1, sizeof buf, f)) > 0) raw.insert(raw.end(), buf, buf + r); }
  fclose(f);
  size_t nsamp = raw.size() / 2;
  if (a.seconds > 0) nsamp = std::min(nsamp, (size_t)(a.seconds * a.rate));

  // u8 -> float LUT.
  float lut[256];
  for (int i = 0; i < 256; i++) lut[i] = (i - 127.5f) / 127.5f;

  // Channel filter: Hamming windowed sinc, unity DC gain, zero-padded to N, FFT once.
  std::vector<cf> H(N);
  {
    fftwf_complex* hb = fftwf_alloc_complex(N);
    std::memset(hb, 0, sizeof(fftwf_complex) * N);
    double fc = CUTOFF_HZ / a.rate, sum = 0;
    std::vector<double> h(NTAPS);
    for (int i = 0; i < NTAPS; i++) {
      double m = i - (NTAPS - 1) / 2.0;
      double s = m == 0 ? 2 * fc : std::sin(2 * M_PI * fc * m) / (M_PI * m);
      h[i] = s * (0.54 - 0.46 * std::cos(2 * M_PI * i / (NTAPS - 1)));
      sum += h[i];
    }
    for (int i = 0; i < NTAPS; i++) hb[i][0] = (float)(h[i] / sum);
    fftwf_plan p = fftwf_plan_dft_1d(N, hb, hb, FFTW_FORWARD, FFTW_ESTIMATE);
    fftwf_execute(p);
    for (int i = 0; i < N; i++) H[i] = cf(hb[i][0], hb[i][1]);
    fftwf_destroy_plan(p);
    fftwf_free(hb);
  }
  (void)TRANS_HZ;

  const double binw = a.rate / N;
  std::vector<Lane> lanes;
  for (double off : a.chans) {
    Lane l;
    l.k0 = (int)std::lround(off / binw);
    l.resid_hz = (float)(off - l.k0 * binw);
    double w = -2 * M_PI * l.resid_hz / LANE_RATE;
    l.nco_step = cf((float)std::cos(w), (float)std::sin(w));
    l.out.resize(KEEP);
    lanes.push_back(l);
  }

  fftwf_complex* fin = fftwf_alloc_complex(N);
  fftwf_complex* fout = fftwf_alloc_complex(N);
  fftwf_complex* lin = fftwf_alloc_complex(M);
  fftwf_complex* lout = fftwf_alloc_complex(M);
  fftwf_plan pf = fftwf_plan_dft_1d(N, fin, fout, FFTW_FORWARD, FFTW_MEASURE);
  fftwf_plan pl = fftwf_plan_dft_1d(M, lin, lout, FFTW_BACKWARD, FFTW_MEASURE);
  std::memset(fin, 0, sizeof(fftwf_complex) * N);

  FILE* dump = a.dump.empty() ? nullptr : fopen(a.dump.c_str(), "w");
  if (dump) {
    fprintf(dump, "t");
    for (double c : a.chans) fprintf(dump, ",%.0f", c);
    fprintf(dump, "\n");
  }
  const int WIN = LANE_RATE / 10;  // 100 ms dump window in lane samples
  long lane_samples = 0;
  const float scale = 1.0f / N;

  double c0 = cpu_seconds();
  long block = 0;
  for (size_t pos = 0; pos + HOP <= nsamp; pos += HOP, block++) {
    // Slide: previous HOP samples to the front, HOP new samples behind them.
    std::memmove(fin, fin + HOP, sizeof(fftwf_complex) * HOP);
    const uint8_t* s = &raw[2 * pos];
    for (int i = 0; i < HOP; i++) { fin[HOP + i][0] = lut[s[2 * i]]; fin[HOP + i][1] = lut[s[2 * i + 1]]; }
    cc_feed(nullptr, reinterpret_cast<cf*>(fin + HOP), HOP);
    fftwf_execute(pf);
    const cf* X = reinterpret_cast<const cf*>(fout);
    for (size_t li = 0; li < lanes.size(); li++) {
      Lane& l = lanes[li];
      cf* Y = reinterpret_cast<cf*>(lin);
      for (int m = -M / 2; m < M / 2; m++) {
        int kx = ((l.k0 + m) % N + N) % N;
        int kh = (m + N) % N;
        Y[(m + M) % M] = X[kx] * H[kh];
      }
      fftwf_execute(pl);
      const cf* y = reinterpret_cast<const cf*>(lout);
      // Block phase continuity: hop N/2 advances the k0 mixer by pi*k0 per block.
      float sign = ((l.k0 & 1) && (block & 1)) ? -scale : scale;
      for (int d = 0; d < KEEP; d++) {
        cf v = y[KEEP + d] * sign * l.nco;
        l.nco *= l.nco_step;
        l.out[d] = v;
        float p = std::norm(v);
        l.acc += p; l.win_acc += p;
        if (++l.acc_n == CHUNK) { l.acc = 0; l.acc_n = 0; }  // 10 ms meter (read by squelch in P1)
        l.win_n++;
      }
      // Renormalize the NCO once per block so float drift can't grow its magnitude.
      l.nco /= std::abs(l.nco);
      if ((int)li == a.demod) demod_block(nullptr, l.out);
    }
    lane_samples += KEEP;
    if (lane_samples >= WIN) {
      lane_samples -= WIN;
      if (dump) {
        fprintf(dump, "%.6f", (pos + HOP) / a.rate);   // exact window end: ref_check aligns on it
        for (Lane& l : lanes) {
          fprintf(dump, ",%.3f", 10 * std::log10(l.win_acc / std::max(1, l.win_n) + 1e-20));
          l.win_acc = 0; l.win_n = 0;
        }
        fprintf(dump, "\n");
      }
    }
  }
  double cpu = cpu_seconds() - c0;
  if (dump) fclose(dump);
  double iq_s = nsamp / a.rate;
  printf("P0 iq_s=%.2f cpu_s=%.3f core_pct=%.1f lanes=%zu demod=%d cc=%d\n",
         iq_s, cpu, 100 * cpu / iq_s, lanes.size(), a.demod >= 0 ? 1 : 0, a.cc ? 1 : 0);
  return 0;
}
```

Note: the dump window is flushed when ≥ 5000 lane samples accumulate. Each block adds 64, so windows are ~100 ms (79 blocks = 5056 samples), which is fine for a mean-power comparison.

- [ ] **Step 5: Build and run the test**

Run: `cd /home/kiosk/kerchunk-kiosk/kiosk/bench/native_p0 && ./build.sh && /usr/bin/python3 test_p0.py`
Expected: `dB: [...]` then `test_p0: OK`. The `demod=1` check passes with the stubs because it only reflects the flag. If the power asserts fail, fix the channelizer before moving on. The usual culprits are the bin wrap (`kx`/`kh` modulo), the sign flip, or the 1/N scale.

- [ ] **Step 6: Commit**

```bash
cd /home/kiosk/kerchunk-kiosk
git add kiosk/bench/native_p0/p0.cpp kiosk/bench/native_p0/build.sh kiosk/bench/native_p0/test_p0.py
git commit -m "bench(native-p0): overlap-save channelizer + lane power, synthetic test"
```

(`p0` the binary and any `.csv` stay untracked. Add `kiosk/bench/native_p0/.gitignore` with `p0` and `*.csv` in this commit.)

---

### Task 2: Demod lane + Close Call FFT (the rest of the cost)

**Files:**
- Modify: `kiosk/bench/native_p0/p0.cpp` (replace the `Demod`/`CcFft` stubs)
- Test: `kiosk/bench/native_p0/test_p0.py` (add a demod-output assertion)

**Interfaces:**
- Consumes: `Lane::out` (64 lane samples per block), `cc_feed(CcFft*, const cf*, int n)` call site, `demod_block(Demod*, const std::vector<cf>&)` call site from Task 1.
- Produces: stdout line before the `P0` line: `DEMOD audio_rms=<float> noise_db=<float> out48k=<samples>` (used by the test and as a by-ear sanity proxy).

- [ ] **Step 1: Extend the test (failing)**

Append to `test_p0.py` before the final print, inside the `with` block:

```python
    # FM demod lane on a tone FM-modulated at 1 kHz, 3 kHz deviation: audio rms
    # must be clearly non-zero and the quieting noise (8-25 kHz) low vs pure noise.
    fm = 0.3 * np.exp(1j * (2 * np.pi * A_HZ * t + (3000 / 1000) * np.sin(2 * np.pi * 1000 * t)))
    pf = os.path.join(d, "fm.cu8")
    write_cu8(pf, fm + 0.004 * (rng.standard_normal(n) + 1j * rng.standard_normal(n)))
    out3, _ = run(pf, [A_HZ], ("--demod", "0"))
    dl = [l for l in out3.splitlines() if l.startswith("DEMOD ")][0]
    kv = dict(p.split("=") for p in dl.split()[1:])
    assert float(kv["audio_rms"]) > 0.05, dl
    assert int(kv["out48k"]) > 0.9 * 48_000, dl        # ~1 s of 48 kHz audio
    pn = os.path.join(d, "noise.cu8")
    write_cu8(pn, 0.05 * (rng.standard_normal(n) + 1j * rng.standard_normal(n)))
    out4, _ = run(pn, [A_HZ], ("--demod", "0"))
    dl4 = [l for l in out4.splitlines() if l.startswith("DEMOD ")][0]
    kv4 = dict(p.split("=") for p in dl4.split()[1:])
    assert float(kv4["noise_db"]) - float(kv["noise_db"]) > 10, (dl, dl4)   # quieting
```

Run: `/usr/bin/python3 test_p0.py`
Expected: FAIL with `IndexError` (no `DEMOD` line yet).

- [ ] **Step 2: Replace the stubs in `p0.cpp`**

Delete the four stub lines (`struct Demod;` … `static void cc_feed(...) {}`) and insert:

```cpp
// ---- Demod lane: FM discriminator, quieting meter, de-emphasis, audio LPF, 50k->48k ----
static std::vector<float> lowpass(int ntaps, double fc_norm) {   // Hamming windowed sinc, unity DC
  std::vector<float> h(ntaps);
  double sum = 0;
  for (int i = 0; i < ntaps; i++) {
    double m = i - (ntaps - 1) / 2.0;
    double s = m == 0 ? 2 * fc_norm : std::sin(2 * M_PI * fc_norm * m) / (M_PI * m);
    h[i] = (float)(s * (0.54 - 0.46 * std::cos(2 * M_PI * i / (ntaps - 1))));
    sum += h[i];
  }
  for (float& v : h) v = (float)(v / sum);
  return h;
}

struct Fir {                      // plain FIR with a history ring (lengths are small here)
  std::vector<float> h, hist;
  int pos = 0;
  explicit Fir(std::vector<float> taps) : h(std::move(taps)), hist(h.size(), 0.f) {}
  float step(float x) {
    hist[pos] = x;
    float acc = 0;
    int n = (int)h.size(), j = pos;
    for (int i = 0; i < n; i++) { acc += h[i] * hist[j]; if (--j < 0) j = n - 1; }
    if (++pos == n) pos = 0;
    return acc;
  }
};

struct Demod {
  cf prev{1, 0};
  Fir noise_hpf, audio_lpf;
  float deemph = 0, deemph_a;
  // 50k -> 48k polyphase (up 24, down 25) over a 24*16-tap prototype.
  std::vector<float> proto;
  std::vector<float> rs_hist;
  int rs_phase = 0;
  double noise_acc = 0, audio_acc = 0;
  long noise_n = 0, out_n = 0;
  Demod()
      : noise_hpf([] {                                   // HPF = delta - LPF(8 kHz)
          auto h = lowpass(41, 8000.0 / LANE_RATE);
          for (float& v : h) v = -v;
          h[20] += 1.0f;
          return h;
        }()),
        audio_lpf(lowpass(63, 3500.0 / LANE_RATE)),
        deemph_a((float)std::exp(-1.0 / (LANE_RATE * 75e-6))),
        proto(lowpass(24 * 16, 20000.0 / (LANE_RATE * 24.0))),   // 20 kHz at the 1.2 MHz upsampled rate
        rs_hist(16, 0.f) {
    for (float& v : proto) v *= 24;                     // interpolation gain
  }
  void push48(float x) {                                 // feed one 50k sample, emit 48k outputs
    rs_hist.erase(rs_hist.begin());
    rs_hist.push_back(x);
    // Each input advances the output phase by 24; emit while phase < 24 (i.e. ~24/25 outputs per input).
    while (rs_phase < 24) {
      float acc = 0;
      for (int k = 0; k < 16; k++) acc += proto[rs_phase + 24 * k] * rs_hist[15 - k];
      audio_acc += (double)acc * acc;
      out_n++;
      rs_phase += 25;
    }
    rs_phase -= 24;
  }
};

static void demod_block(Demod* dm, const std::vector<cf>& x) {
  if (!dm) return;
  for (const cf& v : x) {
    cf c = v * std::conj(dm->prev);
    dm->prev = v;
    float disc = std::atan2(c.imag(), c.real()) * (LANE_RATE / (2 * (float)M_PI * 5000.f));  // +-1 at 5 kHz dev
    float n = dm->noise_hpf.step(disc);
    dm->noise_acc += (double)n * n;
    dm->noise_n++;
    dm->deemph = dm->deemph_a * dm->deemph + (1 - dm->deemph_a) * disc;
    dm->push48(dm->audio_lpf.step(dm->deemph));
  }
}

// ---- Close Call: 2048-pt Blackman-Harris FFT at 20 frames/s, |X|^2 averaged ----
static constexpr int CC_N = 2048, CC_FPS = 20;
struct CcFft {
  fftwf_complex *in, *out;
  fftwf_plan plan;
  std::vector<float> win, acc;
  long every, since = 0;
  int fill = 0, frames = 0;
  explicit CcFft(double rate) : win(CC_N), acc(CC_N, 0.f), every((long)(rate / CC_FPS)) {
    in = fftwf_alloc_complex(CC_N);
    out = fftwf_alloc_complex(CC_N);
    plan = fftwf_plan_dft_1d(CC_N, in, out, FFTW_FORWARD, FFTW_MEASURE);
    for (int i = 0; i < CC_N; i++) {
      double r = 2 * M_PI * i / (CC_N - 1);
      win[i] = (float)(0.35875 - 0.48829 * std::cos(r) + 0.14128 * std::cos(2 * r) - 0.01168 * std::cos(3 * r));
    }
  }
};

static void cc_feed(CcFft* cc, const cf* s, int n) {
  if (!cc) return;
  for (int i = 0; i < n; i++) {
    if (cc->fill > 0 || cc->since >= cc->every) {
      cc->in[cc->fill][0] = s[i].real() * cc->win[cc->fill];
      cc->in[cc->fill][1] = s[i].imag() * cc->win[cc->fill];
      if (++cc->fill == CC_N) {
        fftwf_execute(cc->plan);
        for (int k = 0; k < CC_N; k++) cc->acc[k] += cc->out[k][0] * cc->out[k][0] + cc->out[k][1] * cc->out[k][1];
        cc->frames++;
        cc->fill = 0;
        cc->since = 0;
      }
    } else {
      cc->since++;
    }
  }
}
```

Then in `main`, after the lanes loop that builds `lanes`, create the objects:

```cpp
  Demod dm_obj;
  Demod* dm = a.demod >= 0 && a.demod < (int)lanes.size() ? &dm_obj : nullptr;
  CcFft* cc = a.cc ? new CcFft(a.rate) : nullptr;
```

Change the two call sites to pass them:

```cpp
    cc_feed(cc, reinterpret_cast<cf*>(fin + HOP), HOP);
```

```cpp
      if ((int)li == a.demod) demod_block(dm, l.out);
```

And just before the `P0` printf:

```cpp
  if (dm) {
    printf("DEMOD audio_rms=%.4f noise_db=%.2f out48k=%ld\n",
           std::sqrt(dm->audio_acc / std::max(1L, dm->out_n)),
           10 * std::log10(dm->noise_acc / std::max(1L, dm->noise_n) + 1e-20), dm->out_n);
  }
  if (cc) printf("CC frames=%d\n", cc->frames);
```

`CcFft` must be built before the `FFTW_MEASURE` plans in `main` or after them; either works. Keep it after, as written.

- [ ] **Step 3: Build and run the test**

Run: `cd /home/kiosk/kerchunk-kiosk/kiosk/bench/native_p0 && ./build.sh && /usr/bin/python3 test_p0.py`
Expected: `test_p0: OK`. The first `run()` passes `--no-cc`, so the lane-power `allclose` check still holds.

- [ ] **Step 4: Synthetic cost smoke (12 lanes + demod + CC)**

Run:
```bash
cd /home/kiosk/kerchunk-kiosk/kiosk/bench/native_p0
mkdir -p /home/kiosk/kiosk-iq
/usr/bin/python3 -c "
import numpy as np; r=np.random.default_rng(0); n=2_400_000*10
r.integers(100,156,2*n).astype(np.uint8).tofile('/home/kiosk/kiosk-iq/noise10s.cu8')"
./p0 --file /home/kiosk/kiosk-iq/noise10s.cu8 --demod 0 $(for o in -900000 -750000 -600000 -450000 -300000 -150000 150000 300000 450000 600000 750000 900000; do printf -- '--chan %s ' $o; done)
```
Expected: a `P0 ... lanes=12 demod=1 cc=1` line. Record `core_pct`. This is only an early read; Task 4 gives the real number.

- [ ] **Step 5: Commit**

```bash
cd /home/kiosk/kerchunk-kiosk
git add kiosk/bench/native_p0/p0.cpp kiosk/bench/native_p0/test_p0.py
git commit -m "bench(native-p0): FM demod lane (quieting, deemph, 50k->48k) + 20 fps CC FFT"
```

---

### Task 3: Reference check script (numpy time-domain channelizer)

**Files:**
- Create: `kiosk/bench/native_p0/ref_check.py`

**Interfaces:**
- Consumes: bench `--dump` CSV format (Task 1).
- Produces: CLI `ref_check.py CAPTURE.cu8 DUMP.csv --rate HZ --seconds S --chan OFF ...`. It exits 0 and prints `REF OK max_err_db=<x>` when every lane's 100 ms power after the first 2 windows matches the reference within 0.5 dB. Otherwise it exits 1 with the worst lane and window.

- [ ] **Step 1: Write the script**

```python
"""Compare the P0 bench's lane powers against a straightforward time-domain
reference (mix -> 2001-tap Hamming LPF -> decimate) on the first S seconds of
a capture. Run: /usr/bin/python3 ref_check.py CAP.cu8 DUMP.csv --rate 2400000 --seconds 3 --chan OFF ..."""
import argparse, csv, sys
import numpy as np

ap = argparse.ArgumentParser()
ap.add_argument("capture"); ap.add_argument("dump")
ap.add_argument("--rate", type=float, default=2.4e6)
ap.add_argument("--seconds", type=float, default=3.0)
ap.add_argument("--chan", type=float, action="append", required=True)
a = ap.parse_args()

n = int(a.rate * a.seconds)
raw = np.fromfile(a.capture, dtype=np.uint8, count=2 * n).astype(np.float32)
x = ((raw[0::2] - 127.5) + 1j * (raw[1::2] - 127.5)) / 127.5
NT, fc = 2001, 8000 / a.rate
m = np.arange(NT) - (NT - 1) / 2
h = np.where(m == 0, 2 * fc, np.sin(2 * np.pi * fc * m) / (np.pi * np.where(m == 0, 1, m)))
h *= 0.54 - 0.46 * np.cos(2 * np.pi * np.arange(NT) / (NT - 1))
h /= h.sum()
t = np.arange(len(x)) / a.rate
D = int(round(a.rate / 50_000))
L = 1 << int(np.ceil(np.log2(len(x) + NT)))
Hf = np.fft.fft(h, L)

rows = list(csv.reader(open(a.dump)))
dump_t = np.array([float(r[0]) for r in rows[1:]])
dump = np.array([[float(v) for v in r[1:]] for r in rows[1:]])
worst = (0.0, None)
for ci, off in enumerate(a.chan):
    y = np.fft.ifft(np.fft.fft(x * np.exp(-2j * np.pi * off * t), L) * Hf)[:len(x)][::D]
    p = np.abs(y) ** 2
    for wi in range(2, len(dump_t)):
        end = int(dump_t[wi] * 50_000)
        start = int(dump_t[wi - 1] * 50_000)
        if end > len(p):
            break
        ref = 10 * np.log10(p[start:end].mean() + 1e-20)
        err = abs(ref - dump[wi, ci])
        if err > worst[0]:
            worst = (err, (off, dump_t[wi], ref, dump[wi, ci]))
if worst[0] > 0.5:
    print("REF FAIL max_err_db=%.3f at off=%s t=%s ref=%.2f bench=%.2f" % (worst[0], *worst[1]))
    sys.exit(1)
print("REF OK max_err_db=%.3f" % worst[0])
```

- [ ] **Step 2: Validate it on the synthetic signal**

Run:
```bash
cd /home/kiosk/kerchunk-kiosk/kiosk/bench/native_p0
/usr/bin/python3 - <<'EOF'
import numpy as np
r=np.random.default_rng(3); n=2_400_000*3; t=np.arange(n)/2.4e6
x=0.3*np.exp(2j*np.pi*250_000*t)+0.03*np.exp(2j*np.pi*-412_600*t)+0.004*(r.standard_normal(n)+1j*r.standard_normal(n))
iq=np.empty(2*n); iq[0::2]=x.real; iq[1::2]=x.imag
np.clip(np.round(iq*127.5+127.5),0,255).astype(np.uint8).tofile('/home/kiosk/kiosk-iq/syn3s.cu8')
EOF
./p0 --file /home/kiosk/kiosk-iq/syn3s.cu8 --no-cc --dump /home/kiosk/kiosk-iq/syn3s.csv --chan 250000 --chan -412600 --chan 600000
/usr/bin/python3 ref_check.py /home/kiosk/kiosk-iq/syn3s.cu8 /home/kiosk/kiosk-iq/syn3s.csv --seconds 3 --chan 250000 --chan -412600 --chan 600000
```
Expected: `REF OK max_err_db=<small>`. If the reference and bench windows are misaligned by one block, the error shows up as ~0.1–0.3 dB on noise lanes and stays under 0.5. A larger error means a real bench bug: fix `p0.cpp`, not the tolerance.

- [ ] **Step 3: Commit**

```bash
cd /home/kiosk/kerchunk-kiosk
git add kiosk/bench/native_p0/ref_check.py
git commit -m "bench(native-p0): time-domain reference check for lane powers"
```

---

### Task 4: Real capture, measure, verdict (needs operator OK for a ~60 s outage)

**Files:**
- Create: `kiosk/bench/RESULTS-2026-09-25-native-p0.md`

**Interfaces:**
- Consumes: `p0` (Tasks 1–2), `ref_check.py` (Task 3).
- Produces: the go/no-go verdict that gates writing the P1 plan.

Capture target: the 2 m group, center **146 033 750 Hz** (midpoint of its 11 channels). Channel offsets (Hz):
`-903750 -883750 -723750 -563750 486250 591250 603750 666250 728750 756250 903750`.

- [ ] **Step 1: Ask the operator** before stopping the service: "Stopping kerchunk-kiosk for ~60 s to record 30 s of 2 m IQ. Audio and detection go dark, and the weather radio too. OK?" Do not continue without a yes.

- [ ] **Step 2: Capture**

```bash
mkdir -p /home/kiosk/kiosk-iq
sudo systemctl stop kerchunk-kiosk
rtl_sdr -d KIOSK01 -f 146033750 -s 2400000 -g 0 -n 72000000 /home/kiosk/kiosk-iq/2m-146033750-2400k.cu8
sudo systemctl start kerchunk-kiosk
ls -l /home/kiosk/kiosk-iq/2m-146033750-2400k.cu8
```
Expected: a 144,000,000-byte file, and the service is back (`systemctl is-active kerchunk-kiosk` → `active`). If `rtl_sdr` reports the device busy, wait 2 s and retry once (the helper releasing it).

- [ ] **Step 3: Correctness on real RF**

```bash
cd /home/kiosk/kerchunk-kiosk/kiosk/bench/native_p0
CH="--chan -903750 --chan -883750 --chan -723750 --chan -563750 --chan 486250 --chan 591250 --chan 603750 --chan 666250 --chan 728750 --chan 756250 --chan 903750"
./p0 --file /home/kiosk/kiosk-iq/2m-146033750-2400k.cu8 --no-cc --seconds 3 --dump /home/kiosk/kiosk-iq/2m3s.csv $CH
/usr/bin/python3 ref_check.py /home/kiosk/kiosk-iq/2m-146033750-2400k.cu8 /home/kiosk/kiosk-iq/2m3s.csv --seconds 3 $CH
```
Expected: `REF OK`.

- [ ] **Step 4: Cost on real RF (3 runs, take the median)**

```bash
for i in 1 2 3; do ./p0 --file /home/kiosk/kiosk-iq/2m-146033750-2400k.cu8 --demod 0 $CH --chan 0 | tail -1; done
```
This is 12 lanes: the 11 real channels plus one at DC standing in for a 12th. Expected: three `P0 ... lanes=12 demod=1 cc=1 core_pct=X` lines. Also record the same with `--no-cc` and without `--demod` to split the cost.

- [ ] **Step 5: Write the results and the verdict**

`kiosk/bench/RESULTS-2026-09-25-native-p0.md`, filled in with the measured numbers:

```markdown
# Native DSP P0 bench — 2026-09-25

Capture: KIOSK01, 2 m group center 146.03375 MHz, 2.4 Msps, 30 s, gain auto.
Bench: kiosk/bench/native_p0 (throwaway), -O3 -march=native, FFTW MEASURE, single thread.

| Config | core_pct (median of 3) |
|---|---|
| 12 lanes power only (--no-cc) | <X> |
| 12 lanes + 1 FM demod (--no-cc) | <X> |
| 12 lanes + 1 demod + CC 20 fps | <X> |

Reference check (3 s, 11 real lanes): REF OK max_err_db=<X>.
GNU Radio helper baseline on the same box: ~223–234% (2026-09-25, meas.sh 60 s ×3).

Verdict: GO / NO-GO: <total> vs the 60% go line. <one sentence on what dominates>.
```

The table must hold the measured values. If the verdict is NO-GO, stop and report to the operator. Don't write the P1 plan.

- [ ] **Step 6: Commit, PR, merge, clean up**

```bash
cd /home/kiosk/kerchunk-kiosk
git add kiosk/bench/RESULTS-2026-09-25-native-p0.md
git commit -m "bench(native-p0): real-RF results and go/no-go verdict"
git push -u origin HEAD
gh pr create --title "Native DSP P0 bench: channelizer cost on real RF" --body "..."
```
PR body: the results table plus the verdict, ending with the Claude Code attribution line. After the operator merges (or says merge): `gh pr merge <n> --merge --delete-branch`, then `git checkout main && git pull --ff-only && git fetch --prune && git branch -d <branch>`.

---

## After P0 (not in this plan)

- **GO:** write `docs/superpowers/plans/…-native-dsp-p1-engine.md` (the full `kerchunk-dsp` per spec §1–§4, with `test:native`) and then the P2 Node-integration plan, using the measured costs to set `FFT_N`/chunk defaults.
- **NO-GO:** report which stage dominates. Options go back to the operator (e.g. demod-on-demand is already assumed, so the next lever would be the channelizer itself).
- P3 (live A/B, ≥1 h per engine, by ear) and P4 (delete the GNU Radio path) follow the spec §5 unchanged.
