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
