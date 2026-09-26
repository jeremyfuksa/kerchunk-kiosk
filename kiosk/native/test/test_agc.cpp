#include <algorithm>
#include <cmath>
#include <vector>

#include "agc.hpp"
#include "audio.hpp"
#include "check.hpp"
#include "constants.hpp"
#include "demod.hpp"
#include "signals.hpp"

namespace {
// Mean-square dBFS tone amplitude: a sine of amplitude A has mean square A^2/2.
double amp_for_db(double db) { return std::sqrt(2.0 * std::pow(10.0, db / 10.0)); }

// Run `seconds` of a 1 kHz tone at `db` (mean-square dBFS) through the AGC; return the output.
std::vector<float> agc_tone(kc::Agc& g, double db, double seconds, bool frozen = false) {
  const double a = amp_for_db(db);
  const int n = (int)(seconds * kc::LANE_RATE);
  std::vector<float> y(n);
  for (int i = 0; i < n; i++) y[i] = g.step((float)(a * std::sin(2 * M_PI * 1000.0 * i / kc::LANE_RATE)), frozen);
  return y;
}

double tail_db(const std::vector<float>& y, double seconds) {
  const size_t n = std::min(y.size(), (size_t)(seconds * kc::LANE_RATE));
  const double r = sig::rms(y.data() + y.size() - n, n);
  return 20 * std::log10(r + 1e-20);
}
}  // namespace

TEST(agc_brings_quiet_and_hot_tones_to_target) {
  kc::AgcParams p;
  p.max_gain_db = 20;   // -35 needs +17 dB: lift the default 15 dB cap so this measures tracking, not the cap
  {
    kc::Agc g(p);
    auto y = agc_tone(g, -35, 3.0);
    CHECK_NEAR(tail_db(y, 0.5), p.target_db, 2.0);
  }
  {
    kc::Agc g;   // defaults: -8 needs -10 dB, inside the -20 cut cap
    auto y = agc_tone(g, -8, 1.0);
    CHECK_NEAR(tail_db(y, 0.5), kc::AGC_TARGET_DB, 2.0);
    CHECK_NEAR(g.gain_db(), kc::AGC_TARGET_DB - -8, 1.0);
  }
}

TEST(agc_attack_is_fast_release_is_slow) {
  kc::Agc g;
  agc_tone(g, -18, 0.5);                    // settled at 0 dB gain
  agc_tone(g, -2, 0.08);                    // +16 dB step: attack (10 ms) pulls gain down within ~80 ms
  CHECK(g.gain_db() < -13);
  agc_tone(g, -30, 0.1);                    // -28 dB drop: release (400 ms) only partially recovers in 100 ms
  CHECK(g.gain_db() < 0);
}

TEST(agc_gain_capped_for_very_quiet_input) {
  kc::Agc g;
  auto y = agc_tone(g, -45, 4.0);           // above hold (-50) but needs +27 dB
  CHECK_NEAR(g.gain_db(), kc::AGC_MAX_GAIN_DB, 1e-9);
  CHECK_NEAR(tail_db(y, 0.5), -45 + kc::AGC_MAX_GAIN_DB, 0.5);
  kc::AgcParams p;                          // cut cap: 0 dBFS needs -18, capped at -6
  p.min_gain_db = -6;
  kc::Agc c(p);
  agc_tone(c, 0, 1.0);
  CHECK_NEAR(c.gain_db(), -6, 1e-9);
}

TEST(agc_pause_hold_does_not_pump_gain_up) {
  kc::Agc g;
  agc_tone(g, -8, 0.5);                     // loud talker: gain ~ -10 dB
  const double loud = g.gain_db();
  CHECK(loud < -8);
  agc_tone(g, -70, 3.0);                    // near-silence far below hold_below_db for 3 s
  CHECK_NEAR(g.gain_db(), loud, 0.5);       // held, not released toward +15
  agc_tone(g, -30, 2.0);                    // a real (quiet) talker above hold: now it releases
  CHECK(g.gain_db() > loud + 10);
}

TEST(agc_frozen_holds_everything_and_reset_restores_unity) {
  kc::Agc g;
  agc_tone(g, -8, 0.5);
  const double before = g.gain_db();
  agc_tone(g, -45, 2.0, /*frozen=*/true);
  CHECK(g.gain_db() == before);
  g.reset();
  CHECK(g.gain_db() == 0.0);
  CHECK(g.envelope_db() == kc::AGC_TARGET_DB);
  CHECK(g.step(0.25f, true) == 0.25f);      // 0 dB applied at once, no glide from the old gain
}

TEST(agc_gain_changes_smoothly) {
  // Gain moves only by glides: a step in input level must not put a step in the gain applied to a
  // constant signal (zipper noise). Measure the output of a DC input across a level change.
  kc::Agc g;
  std::vector<float> y;
  for (int i = 0; i < kc::LANE_RATE / 2; i++) y.push_back(g.step(0.126f, false));   // -18 dB DC: gain 0
  for (int i = 0; i < kc::LANE_RATE / 2; i++) y.push_back(g.step(0.8f, false));     // +16 dB: attack
  float worst = 0;
  for (size_t i = kc::LANE_RATE / 2 + 1; i < y.size(); i++) worst = std::max(worst, std::fabs(y[i] - y[i - 1]));
  CHECK(worst < 0.01f);   // ~0.6 of gain over 32-sample glides, never a jump
}

TEST(limiter_holds_burst_under_ceiling) {
  kc::Limiter lim;
  std::vector<float> y;
  for (int i = 0; i < kc::AUDIO_RATE / 4; i++) {
    const double a = (i > 1200 && i < 4800) ? 1.5 : 0.3;   // 75 ms burst far over the ceiling
    y.push_back(lim.step((float)(a * std::sin(2 * M_PI * 700.0 * i / kc::AUDIO_RATE))));
  }
  float peak = 0;
  for (float v : y) peak = std::max(peak, std::fabs(v));
  CHECK(peak <= (float)kc::LIMITER_CEILING);
  // Released back to unity well after the burst (50 ms release; 150 ms of quiet follow it).
  CHECK(lim.gain() > 0.97f);
  lim.step(2.0f);
  CHECK(lim.gain() < 0.5f);
  lim.reset();
  CHECK(lim.gain() == 1.0f);
  CHECK_THROWS(kc::Limiter(0.0));
  CHECK_THROWS(kc::Limiter(kc::RAIL + 0.01));
}

// End to end: a quiet and a hot FM talker leave the speaker path at about the same loudness.
TEST(speaker_agc_evens_out_talkers) {
  auto out_db = [](double dev_hz) {
    kc::SpeakerPath sp;
    sp.set_source(0, false);
    sp.set_gain(1.0f);
    auto x = sig::fm_tone(kc::LANE_RATE, 2 * kc::LANE_RATE, 0, dev_hz, 1000, 0.3);
    kc::FmDiscriminator d;
    std::vector<float> out, disc(64);
    for (size_t i = 0; i + 64 <= x.size(); i += 64) {
      for (int k = 0; k < 64; k++) disc[k] = d.step(x[i + k]);
      sp.process(&x[i], disc.data(), 64, out);
    }
    const size_t n = kc::AUDIO_RATE / 2;
    return 20 * std::log10(sig::rms(out.data() + out.size() - n, n));
  };
  const double quiet = out_db(600), hot = out_db(4500);   // ~13 dB apart at the discriminator
  CHECK_NEAR(quiet, kc::AGC_TARGET_DB, 2.0);
  CHECK_NEAR(hot, kc::AGC_TARGET_DB, 2.0);
}

TEST(speaker_agc_resets_on_new_transmission_and_freezes_while_closed) {
  kc::SpeakerPath sp;
  sp.set_source(0, false);
  sp.set_gain(1.0f);
  auto x = sig::fm_tone(kc::LANE_RATE, kc::LANE_RATE, 0, 4500, 1000, 0.3);
  kc::FmDiscriminator d;
  std::vector<float> out, disc(64);
  auto feed = [&](size_t from, size_t to) {
    for (size_t i = from; i + 64 <= to; i += 64) {
      for (int k = 0; k < 64; k++) disc[k] = d.step(x[i + k]);
      sp.process(&x[i], disc.data(), 64, out);
    }
  };
  feed(0, x.size() / 2);
  const double talking = sp.agc().gain_db();
  CHECK(talking < -3);                       // hot talker pulled down
  sp.set_gain(0.f);                          // gate closes (carrier drop / squelch)
  feed(x.size() / 2, x.size());              // loud "noise" while closed: must not move the AGC
  CHECK(sp.agc().gain_db() == talking);
  sp.set_gain(1.0f);                         // next transmission opens the gate
  CHECK(sp.agc().gain_db() == 0.0);
}
