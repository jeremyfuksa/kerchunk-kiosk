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
