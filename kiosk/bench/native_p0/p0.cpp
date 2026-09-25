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
