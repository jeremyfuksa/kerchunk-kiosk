// Speaker path (audible lane -> 48 kHz, gain/fade/rail) and SAME path (background lane -> 22.05 kHz s16).
#pragma once
#include <complex>
#include <cstdint>
#include <vector>

#include "constants.hpp"
#include "demod.hpp"
#include "fir.hpp"
#include "meters.hpp"
#include "resampler.hpp"

namespace kc {
void to_s16(const float* x, int n, float scale, std::vector<int16_t>& out);

class SpeakerPath {
 public:
  SpeakerPath();
  void set_source(int lane, bool am);
  void set_gain(float target);
  void reset();
  int feeding_lane() const { return cur_lane_; }
  void process(const cf* x, const float* disc, int n, std::vector<float>& out48);
  float speech_db() const { return speech_.ready() ? speech_.db() : -200.f; }

 private:
  void apply_target(float t);
  void switch_now();
  int cur_lane_ = -1, want_lane_ = -1;
  bool cur_am_ = false, want_am_ = false, switching_ = false;
  float gain_ = 0, target_ = 0, want_target_ = 0, ramp_step_ = 0;
  int ramp_left_ = 0;
  Deemphasis de_;
  FirFilter lpf_;
  AmEnvelope am_;
  MeanSquare speech_;
  Resampler rs_;
  std::vector<float> a50_, a48_;
};

class SamePath {
 public:
  SamePath();
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
