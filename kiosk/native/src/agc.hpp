// Speaker loudness: a feed-forward AGC/compressor (per-sample at LANE_RATE, right after the demod)
// and a peak limiter (at AUDIO_RATE, after the gate/fade). Replaces the per-channel level-trim
// learner: talker-to-talker variation is tracked inside each transmission instead of per channel.
#pragma once
#include "constants.hpp"

namespace kc {
struct AgcParams {
  double target_db = AGC_TARGET_DB;         // output mean-square level the AGC steers to (dBFS)
  double max_gain_db = AGC_MAX_GAIN_DB;     // boost cap (quiet talkers / weak AM)
  double min_gain_db = AGC_MIN_GAIN_DB;     // cut cap (hot talkers)
  double attack_ms = AGC_ATTACK_MS;         // envelope time constant while the level rises
  double release_ms = AGC_RELEASE_MS;       // ... and while it falls
  double hold_below_db = AGC_HOLD_BELOW_DB; // short-term level below this = pause: envelope frozen
};

class Agc {
 public:
  // Throws std::invalid_argument on non-positive time constants or min_gain_db > max_gain_db.
  explicit Agc(const AgcParams& p = {}, double rate = LANE_RATE);
  // New transmission: envelope := target (0 dB gain), short-term detector emptied.
  void reset();
  // One sample. frozen = gate closed or fading: no detector/envelope update, current gain applied.
  float step(float x, bool frozen) {
    if (!frozen) {
      const float xx = x * x;
      ms_ += det_a_ * (xx - ms_);
      pause_ms_ += pause_a_ * (xx - pause_ms_);
      if (++k_ == AGC_BLOCK) update();
    }
    g_ += g_step_;
    if (--g_left_ <= 0) { g_ = g_target_; g_step_ = 0.f; g_left_ = 0; }
    return x * g_;
  }
  double gain_db() const { return gain_db_; }        // latest block's gain decision
  double envelope_db() const { return env_db_; }

 private:
  void update();   // every AGC_BLOCK unfrozen samples: envelope + gain decision (log/pow here only)
  AgcParams p_;
  float det_a_, pause_a_;
  double att_a_, rel_a_;
  float ms_ = 0.f, pause_ms_ = 0.f;   // envelope detector (AGC_DETECT_MS), pause detector (AGC_PAUSE_DETECT_MS)
  int k_ = 0;
  double env_db_ = 0, gain_db_ = 0;
  float g_ = 1.f, g_target_ = 1.f, g_step_ = 0.f;
  int g_left_ = 0;
};

class Limiter {
 public:
  // Throws std::invalid_argument unless 0 < ceiling <= RAIL and release_ms > 0.
  explicit Limiter(double ceiling = LIMITER_CEILING, double release_ms = LIMITER_RELEASE_MS,
                   double rate = AUDIO_RATE);
  void reset() { g_ = 1.f; }
  // Instant attack (no output sample ever exceeds the ceiling), one-pole release back to unity.
  float step(float v) {
    g_ += rel_a_ * (1.f - g_);
    const float a = v < 0 ? -v : v;
    if (a * g_ > ceiling_) g_ = ceiling_ / a;
    // v * (ceiling/|v|) can round one ulp over: clamp so the ceiling is exact.
    const float y = v * g_;
    return y > ceiling_ ? ceiling_ : y < -ceiling_ ? -ceiling_ : y;
  }
  float gain() const { return g_; }

 private:
  float ceiling_, rel_a_;
  float g_ = 1.f;
};
}  // namespace kc
