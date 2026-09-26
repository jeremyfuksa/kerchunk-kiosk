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
