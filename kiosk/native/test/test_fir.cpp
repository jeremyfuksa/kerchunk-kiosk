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
