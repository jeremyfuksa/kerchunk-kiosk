// Speaker path (audible lane -> AGC -> 48 kHz, gate/fade -> limiter -> rail) and SAME path (background lane -> 22.05 kHz s16).
#pragma once
#include <complex>
#include <cstdint>
#include <vector>

#include "agc.hpp"
#include "constants.hpp"
#include "demod.hpp"
#include "fir.hpp"
#include "meters.hpp"
#include "resampler.hpp"

namespace kc {
void to_s16(const float* x, int n, float scale, std::vector<int16_t>& out);

class SpeakerPath {
 public:
  // lpf_hz: speaker audio LPF cutoff (0 < lpf_hz < LANE_RATE/2, else std::invalid_argument).
  // am_gain: linear gain on normalized AM audio (default AM_GAIN; the engine applies --am-gain-db).
  // agc / limiter_*: speaker loudness knobs (the engine applies --agc-* / --limiter-*).
  explicit SpeakerPath(double lpf_hz = SPEAKER_LPF_HZ, float am_gain = AM_GAIN, const AgcParams& agc = {},
                       double limiter_ceiling = LIMITER_CEILING, double limiter_release_ms = LIMITER_RELEASE_MS,
                       double hpf_hz = SPEAKER_HPF_HZ);
  void set_source(int lane, bool am);
  void set_gain(float target);
  void reset();   // hard cut: drops the source and zeroes all state (the next sample may step)
  // Soft cut (retune): same end state as reset(), but the output ramps from the last emitted
  // sample to 0 over FADE_SAMPLES (held-sample decay) instead of stepping.
  void cut();
  int feeding_lane() const { return cur_lane_; }
  void process(const cf* x, const float* disc, int n, std::vector<float>& out48);
  const Agc& agc() const { return agc_; }

 private:
  void apply_target(float t);
  void switch_now();
  int cur_lane_ = -1, want_lane_ = -1;
  bool cur_am_ = false, want_am_ = false, switching_ = false;
  float gain_ = 0, target_ = 0, want_target_ = 0, ramp_step_ = 0;
  int ramp_left_ = 0;
  float last_out_ = 0, hold_ = 0;   // last emitted sample; held value decaying after cut()
  int hold_left_ = 0;
  float am_gain_;
  Deemphasis de_;
  FirFilter lpf_;
  ButterHighpass hpf_;
  AmEnvelope am_;
  Agc agc_;
  Limiter lim_;
  Resampler rs_;
  std::vector<float> a50_, a48_;
};

class SamePath {
 public:
  SamePath();   // fixed voiceband LPF (SAME_LPF_HZ)
  void push(const float* disc, int n, std::vector<int16_t>& out);
  void reset();

 private:
  Deemphasis de_;
  FirFilter lpf_;
  Resampler rs_;
  std::vector<float> a_, b_;
  std::vector<int16_t> tmp_;
};
}  // namespace kc
