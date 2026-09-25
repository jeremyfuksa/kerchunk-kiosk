#include <algorithm>
#include <cmath>
#include <random>
#include <vector>

#include "check.hpp"
#include "constants.hpp"
#include "fir.hpp"
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
  kc::Resampler r(24, 25, kc::LANE_RATE, kc::SPEAKER_RS_CUTOFF_HZ, kc::SPEAKER_RS_TRANSITION_HZ);
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
    kc::Resampler r(441, 1000, kc::LANE_RATE, kc::SAME_RS_CUTOFF_HZ, kc::SAME_RS_TRANSITION_HZ);
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
  kc::Resampler r(24, 25, kc::LANE_RATE, kc::SPEAKER_RS_CUTOFF_HZ, kc::SPEAKER_RS_TRANSITION_HZ);
  auto x = sine(kc::LANE_RATE, 5000, 1000, 0.5);
  std::vector<float> a, b;
  r.push(x.data(), (int)x.size(), a);
  r.reset();
  r.push(x.data(), (int)x.size(), b);
  CHECK(a.size() == b.size());
  for (size_t i = 0; i < a.size() && i < b.size(); i++) CHECK_NEAR(a[i], b[i], 1e-7);
}

// Textbook upfirdn reference: zero-stuff x by `up`, convolve with `up * proto` (proto zero-padded
// to tpp*up), then take every `down`-th sample starting at index 0. `tpp` is derived the same way
// Resampler derives it, from the same prototype design. This is independent of Resampler's
// internal ring-buffer/phase bookkeeping, so an equality match at ~1e-5 pins down both the filter
// coefficients AND the exact output alignment (catches a time-reversed-per-phase-kernel bug that
// |H|-based rms/dB checks cannot see).
static std::vector<float> reference_resample(int up, int down, double in_rate, double cutoff_hz,
                                              double transition_hz, const std::vector<float>& x,
                                              int& tpp_out) {
  std::vector<float> proto = kc::design_lowpass(in_rate * up, cutoff_hz, transition_hz);
  int tpp = (int)((proto.size() + up - 1) / up);
  tpp_out = tpp;
  proto.resize((size_t)tpp * up, 0.f);
  std::vector<float> h(proto.size());
  for (size_t i = 0; i < proto.size(); i++) h[i] = (float)(up * proto[i]);

  const long n_in = (long)x.size();
  std::vector<float> y;
  for (long n = 0;; n += down) {
    long i = n / up;  // floor, n >= 0
    if (i >= n_in) break;
    double acc = 0.0;
    for (long k = 0; k < (long)h.size(); k++) {
      long j = n - k;
      if (j < 0 || j % up != 0) continue;
      long ii = j / up;
      if (ii < 0 || ii >= n_in) continue;
      acc += h[k] * x[ii];
    }
    y.push_back((float)acc);
  }
  return y;
}

static void check_matches_reference(int up, int down, double in_rate, double cutoff_hz,
                                     double transition_hz) {
  std::mt19937 rng(1000u + (unsigned)up * 31u + (unsigned)down);
  std::uniform_real_distribution<float> dist(-1.f, 1.f);
  std::vector<float> x(400);
  for (auto& v : x) v = dist(rng);

  kc::Resampler r(up, down, in_rate, cutoff_hz, transition_hz);
  std::vector<float> y;
  r.push(x.data(), (int)x.size(), y);

  int tpp_ref = 0;
  std::vector<float> ref = reference_resample(up, down, in_rate, cutoff_hz, transition_hz, x, tpp_ref);

  std::vector<float> proto = kc::design_lowpass(in_rate * up, cutoff_hz, transition_hz);
  int tpp_expected = (int)((proto.size() + up - 1) / up);
  CHECK(r.taps_per_phase() == tpp_expected);
  CHECK(tpp_ref == tpp_expected);

  CHECK(y.size() == ref.size());
  size_t len = std::min(y.size(), ref.size());
  for (size_t i = 0; i < len; i++) CHECK_NEAR(y[i], ref[i], 1e-5);
}

TEST(resampler_matches_textbook_upfirdn_up_gt_down) {
  check_matches_reference(3, 2, 6000, 2000, 800);
}

TEST(resampler_matches_textbook_upfirdn_down_gt_up) {
  check_matches_reference(2, 5, 6000, 2000, 800);
}

TEST(resampler_matches_textbook_upfirdn_speaker_ratio) {
  check_matches_reference(24, 25, 50'000, 20'000, 4'000);
}
