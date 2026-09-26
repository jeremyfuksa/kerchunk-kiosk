#include "agc.hpp"

#include <algorithm>
#include <cmath>
#include <stdexcept>

namespace kc {
static_assert(LIMITER_CEILING > 0 && LIMITER_CEILING <= RAIL, "limiter ceiling must sit at or below the rail");

namespace {
// One-pole coefficient for time constant tau_ms when updated every `every` samples at `rate`.
double pole(double tau_ms, double rate, int every) { return 1.0 - std::exp(-every / (tau_ms * 1e-3 * rate)); }
}  // namespace

Agc::Agc(const AgcParams& p, double rate) : p_(p) {
  if (!(p.attack_ms > 0 && p.release_ms > 0)) throw std::invalid_argument("Agc: attack/release must be > 0");
  if (!(p.min_gain_db <= p.max_gain_db)) throw std::invalid_argument("Agc: min_gain_db must be <= max_gain_db");
  det_a_ = (float)pole(AGC_DETECT_MS, rate, 1);
  pause_a_ = (float)pole(AGC_PAUSE_DETECT_MS, rate, 1);
  att_a_ = pole(p.attack_ms, rate, AGC_BLOCK);
  rel_a_ = pole(p.release_ms, rate, AGC_BLOCK);
  reset();
}

void Agc::reset() {
  ms_ = pause_ms_ = 0.f;   // detectors start empty: below hold_below_db, so nothing moves until it has a reading
  k_ = 0;
  env_db_ = p_.target_db;
  gain_db_ = std::clamp(0.0, p_.min_gain_db, p_.max_gain_db);
  g_ = g_target_ = (float)std::pow(10.0, gain_db_ / 20.0);
  g_step_ = 0.f;
  g_left_ = 0;
}

void Agc::update() {
  k_ = 0;
  const double st_db = 10.0 * std::log10((double)ms_ + 1e-20);
  const double pause_db = 10.0 * std::log10((double)pause_ms_ + 1e-20);
  // Pause hold: a gap between words (or dead air) must never let the release pump the gain up. The
  // pause test uses its own fast detector: the envelope detector's decay tail into a pause would
  // otherwise read as "quieter talker" for ~50 ms and leak ~2.5 dB of release per pause.
  if (st_db >= p_.hold_below_db && pause_db >= p_.hold_below_db) env_db_ += (st_db > env_db_ ? att_a_ : rel_a_) * (st_db - env_db_);
  gain_db_ = std::clamp(p_.target_db - env_db_, p_.min_gain_db, p_.max_gain_db);
  g_target_ = (float)std::pow(10.0, gain_db_ / 20.0);
  // Glide to the new gain over the next block: no zipper steps at block boundaries.
  g_step_ = (g_target_ - g_) / AGC_BLOCK;
  g_left_ = AGC_BLOCK;
}

Limiter::Limiter(double ceiling, double release_ms, double rate) {
  if (!(ceiling > 0 && ceiling <= RAIL)) throw std::invalid_argument("Limiter: ceiling must be in (0, RAIL]");
  if (!(release_ms > 0)) throw std::invalid_argument("Limiter: release_ms must be > 0");
  ceiling_ = (float)ceiling;
  rel_a_ = (float)pole(release_ms, rate, 1);
}
}  // namespace kc
