#include <cmath>
#include <optional>
#include <random>
#include <vector>

#include "check.hpp"
#include "constants.hpp"
#include "ctcss.hpp"
#include "subaudio.hpp"

namespace {
// Discriminator-scale signal (+-1.0 == FM_MAX_DEV_HZ) at LANE_RATE.
struct Disc {
  std::vector<float> x;
  explicit Disc(double seconds) : x((size_t)(seconds * kc::LANE_RATE), 0.f) {}
  Disc& tone(double hz, double dev_hz, double t0 = 0, double t1 = 1e9) {
    const double a = dev_hz / kc::FM_MAX_DEV_HZ;
    for (size_t i = (size_t)(t0 * kc::LANE_RATE); i < x.size() && i < t1 * kc::LANE_RATE; i++)
      x[i] += (float)(a * std::sin(2 * M_PI * hz * (double)i / kc::LANE_RATE));
    return *this;
  }
  Disc& noise(double sigma, unsigned seed) {
    std::mt19937 g(seed);
    std::normal_distribution<float> d(0.f, (float)sigma);
    for (auto& v : x) v += d(g);
    return *this;
  }
  // Voice-like: a few 300-3000 Hz partials (a transmitter's voice HPF leaves nothing sub-audible)
  // with a 4 Hz syllable envelope, ~3 kHz peak deviation, plus pre-emphasis-style HF tilt.
  Disc& voice(unsigned seed) {
    std::mt19937 g(seed);
    std::uniform_real_distribution<double> ph(0, 2 * M_PI);
    const double f[] = {320, 470, 710, 1150, 1800, 2600};
    double p[6];
    for (double& v : p) v = ph(g);
    for (size_t i = 0; i < x.size(); i++) {
      const double t = (double)i / kc::LANE_RATE;
      const double env = 0.5 + 0.5 * std::sin(2 * M_PI * 4 * t);
      double s = 0;
      for (int k = 0; k < 6; k++) s += (0.3 + f[k] / 3000) * std::sin(2 * M_PI * f[k] * t + p[k]);
      x[i] += (float)(0.12 * env * s);
    }
    return *this;
  }
};

// Feed in 10 ms pieces through the shared decimator (as Engine does); returns every tone() seen
// after each piece, plus when it first appeared.
struct Run {
  std::vector<std::optional<float>> seen;
  double first = -1;
};
Run run(kc::CtcssDetector& d, const Disc& s) {
  Run r;
  const int piece = kc::LANE_RATE / 100;
  kc::SubaudioDecimator dec;
  std::vector<float> sub(kc::SubaudioDecimator::max_out(piece));
  for (size_t i = 0; i < s.x.size(); i += piece) {
    const int ns = dec.push(&s.x[i], (int)std::min<size_t>(piece, s.x.size() - i), sub.data());
    d.push(sub.data(), ns);
    r.seen.push_back(d.tone());
    if (d.tone() && r.first < 0) r.first = (double)(i + piece) / kc::LANE_RATE;
  }
  return r;
}
bool always(const Run& r, float hz, size_t from) {
  for (size_t k = from; k < r.seen.size(); k++)
    if (!r.seen[k] || std::fabs(*r.seen[k] - hz) > 0.05f) return false;
  return true;
}
bool never(const Run& r) {
  for (auto& t : r.seen) if (t) return false;
  return true;
}
}  // namespace

TEST(ctcss_table_is_the_50_eia_tones) {
  CHECK(kc::CTCSS_TONES.size() == 50);
  CHECK(kc::CTCSS_TONES.front() == 67.0f && kc::CTCSS_TONES.back() == 254.1f);
  for (size_t k = 1; k < kc::CTCSS_TONES.size(); k++) CHECK(kc::CTCSS_TONES[k] > kc::CTCSS_TONES[k - 1]);
}

TEST(ctcss_detects_each_tone_within_600ms) {
  for (float hz : {67.0f, 100.0f, 151.4f, 254.1f}) {
    kc::CtcssDetector d;
    auto r = run(d, Disc(2.0).tone(hz, 600).noise(0.05, 1));
    CHECK(r.first > 0 && r.first <= 0.61);
    CHECK(always(r, hz, 60));   // from 600 ms on: steady, never a neighbour
  }
}

TEST(ctcss_adjacent_tones_not_confused) {
  for (float hz : {71.9f, 74.4f, 67.0f, 69.3f}) {
    kc::CtcssDetector d;
    auto r = run(d, Disc(3.0).tone(hz, 500).voice(2).noise(0.05, 3));
    CHECK(always(r, hz, 60));
  }
}

TEST(ctcss_tone_under_voice_and_noise_detected) {
  kc::CtcssDetector d;
  auto r = run(d, Disc(4.0).tone(100.0, 500).voice(4).noise(0.3, 5));
  CHECK(always(r, 100.0f, 60));
}

TEST(ctcss_no_tone_voice_or_noise_never_detects) {
  kc::CtcssDetector a, b, c;
  CHECK(never(run(a, Disc(20.0).voice(6).noise(0.05, 7))));
  CHECK(never(run(b, Disc(20.0).noise(0.5, 8))));   // unquieted: heavy discriminator noise
  CHECK(never(run(c, Disc(5.0))));                  // dead-silent carrier
}

TEST(ctcss_weak_tone_below_floor_ignored) {
  kc::CtcssDetector d;   // 30 Hz deviation = amplitude 0.006, -47 dB: under CTCSS_FLOOR_DB
  CHECK(never(run(d, Disc(3.0).tone(100.0, 30))));
}

TEST(ctcss_tone_loss_clears_and_reset_forgets) {
  kc::CtcssDetector d;
  auto r = run(d, Disc(3.0).tone(123.0, 600, 0, 1.5).noise(0.05, 9));
  CHECK(r.seen[140] && *r.seen[140] == 123.0f);
  CHECK(!r.seen[r.seen.size() - 1]);   // tone off at 1.5 s: window drained well before 3 s
  size_t cleared = 0;
  for (size_t k = 150; k < r.seen.size(); k++) if (!r.seen[k]) { cleared = k; break; }
  CHECK(cleared > 0 && cleared <= 150 + 45);   // within ~450 ms of key-up
  kc::CtcssDetector e;
  run(e, Disc(1.0).tone(100.0, 600));
  CHECK(e.tone().has_value());
  e.reset();
  CHECK(!e.tone().has_value());
  auto r2 = run(e, Disc(0.35).tone(100.0, 600));   // needs a fresh full window after reset
  CHECK(never(r2));
}
