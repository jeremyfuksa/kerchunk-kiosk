#include <algorithm>
#include <cmath>
#include <cstdio>
#include <string>
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

TEST(fm_discriminator_reset_reprimes) {
  // Run over real history so prev_ holds a genuine phase, not the zero-init default.
  auto x = sig::tone(LR, 100, 1000, 0.3);
  kc::FmDiscriminator d;
  kc::cf last{0, 0};
  for (auto v : x) {
    d.step(v);
    last = v;
  }
  d.reset();
  // A sample at ~pi phase away from the pre-reset history: if reset didn't take,
  // this would read as a huge rotation instead of the priming zero.
  kc::cf jump = -last;
  CHECK(d.step(jump) == 0.0f);
  CHECK_NEAR(d.step(jump), 0.0, 1e-6);  // no rotation on the next sample -> 0
}

TEST(am_envelope_reset_reprimes) {
  kc::AmEnvelope e;
  for (int i = 0; i < 10'000; i++) e.step(kc::cf(0.5f, 0.f));
  e.reset();
  // Without re-priming this would read ~ 0.01/0.5 - 1 = -0.98 against the stale carrier.
  float first = e.step(kc::cf(0.01f, 0.f));
  CHECK_NEAR(first, 0.0, 1e-3);
}

TEST(quieting_meter_reset_clears) {
  kc::FmDiscriminator d;
  kc::QuietingMeter q;
  auto x = sig::noise(kc::NOISE_WINDOW * 4, 0.05, 8);
  for (auto v : x) {
    q.push(d.step(v));
    if (q.ready()) break;
  }
  CHECK(q.ready());
  q.reset();
  CHECK(!q.ready());
  // Zeros in -> zeros out only if reset also clears the HPF's own history.
  for (int i = 0; i < kc::NOISE_WINDOW; i++) q.push(0.0f);
  CHECK(q.ready());
  CHECK(q.db() < -150.0);
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

namespace {
double ssb_out_rms(double tone_hz, double amp) {
  auto x = sig::tone(LR, 50'000, tone_hz, amp);
  kc::SsbDemod d;
  std::vector<float> y;
  for (auto v : x) y.push_back(d.step(v).real());
  return sig::rms(y.data() + 5000, y.size() - 5000);   // skip the filters' settle
}
}  // namespace

TEST(demod_for_maps_modes) {
  CHECK(kc::demod_for("am") == kc::Demod::Am);
  CHECK(kc::demod_for("lsb") == kc::Demod::Lsb);
  CHECK(kc::demod_for("nfm") == kc::Demod::Fm && kc::demod_for("fm") == kc::Demod::Fm);
  CHECK(std::string(kc::demod_name(kc::Demod::Lsb)) == "lsb");
}

TEST(ssb_demod_passes_lower_sideband) {
  // 1 kHz below the dial = an LSB voice tone: comes out as a 1 kHz real tone at full level.
  CHECK_NEAR(ssb_out_rms(-1000, 0.3), 0.3 / std::sqrt(2.0), 0.02);
}

TEST(ssb_demod_rejects_usb_carrier_and_adjacent_channels) {
  const double pass = ssb_out_rms(-1000, 0.3);
  // USB of 38, the dial itself, the far edge of its own lane, and 37's USB / 39's LSB (10 kHz away).
  for (double f : {1000.0, 0.0, -5000.0, -8500.0, 8500.0}) {
    const double rej = 20 * std::log10(ssb_out_rms(f, 0.3) / pass);
    if (!(rej < -40)) std::fprintf(stderr, "  ssb rejection at %.0f Hz: %.1f dB\n", f, rej);
    CHECK(rej < -40);
  }
}

TEST(ssb_demod_reset_clears_history) {
  kc::SsbDemod d;
  for (auto v : sig::tone(LR, 10'000, -1000, 0.3)) d.step(v);
  d.reset();
  float worst = 0;
  for (int i = 0; i < 1000; i++) worst = std::max(worst, std::abs(d.step(kc::cf(0, 0))));
  CHECK(worst == 0.f);   // no ringing out of stale filter state
}

TEST(ssb_level_normalizes_weak_and_strong) {
  for (double amp : {0.003, 0.3}) {   // 40 dB apart: both land at unit peak
    kc::SsbLevel l;
    std::vector<float> y;
    for (auto v : sig::tone(LR, 50'000, -1000, amp)) y.push_back(l.step(v));
    CHECK_NEAR(sig::rms(y.data() + 10'000, y.size() - 10'000), 1 / std::sqrt(2.0), 0.05);
  }
}

TEST(ssb_level_reset_reprimes) {
  kc::SsbLevel l;
  for (int i = 0; i < 10'000; i++) l.step(kc::cf(0.5f, 0.f));
  l.reset();
  CHECK_NEAR(l.step(kc::cf(0.01f, 0.f)), 1.0, 1e-3);   // primes on the new level, not the stale 0.5
}
