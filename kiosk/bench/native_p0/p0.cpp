// P0 bench (throwaway): cost of the native engine's DSP core on a .cu8 replay.
// Spec: docs/superpowers/specs/2026-09-25-native-dsp-engine-design.md §2.
#include <fftw3.h>
#include <sys/resource.h>
#include <algorithm>
#include <cmath>
#include <complex>
#include <cstdint>
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

  Demod dm_obj;
  Demod* dm = a.demod >= 0 && a.demod < (int)lanes.size() ? &dm_obj : nullptr;
  CcFft* cc = a.cc ? new CcFft(a.rate) : nullptr;

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
    cc_feed(cc, reinterpret_cast<cf*>(fin + HOP), HOP);
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
      if ((int)li == a.demod) demod_block(dm, l.out);
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
  if (dm) {
    printf("DEMOD audio_rms=%.4f noise_db=%.2f out48k=%ld\n",
           std::sqrt(dm->audio_acc / std::max(1L, dm->out_n)),
           10 * std::log10(dm->noise_acc / std::max(1L, dm->noise_n) + 1e-20), dm->out_n);
  }
  if (cc) printf("CC frames=%d\n", cc->frames);
  printf("P0 iq_s=%.2f cpu_s=%.3f core_pct=%.1f lanes=%zu demod=%d cc=%d\n",
         iq_s, cpu, 100 * cpu / iq_s, lanes.size(), a.demod >= 0 ? 1 : 0, a.cc ? 1 : 0);
  return 0;
}
