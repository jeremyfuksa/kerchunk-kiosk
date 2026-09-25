#include "demod.hpp"

#include <cmath>

namespace kc {

namespace {
const float kDiscScale = (float)(LANE_RATE / (2 * M_PI * FM_MAX_DEV_HZ));
const float kAmAlpha = (float)(1 - std::exp(-1.0 / (AM_CARRIER_TAU_S * LANE_RATE)));
const float kDeemphA = (float)std::exp(-1.0 / (LANE_RATE * DEEMPH_TAU_S));
}  // namespace

float FmDiscriminator::step(cf x) {
  if (!primed_) {
    prev_ = x;
    primed_ = true;
    return 0.f;
  }
  cf c = x * std::conj(prev_);
  prev_ = x;
  return std::atan2(c.imag(), c.real()) * kDiscScale;
}

float AmEnvelope::step(cf x) {
  float env = std::abs(x);
  if (!primed_) {
    carrier_ = env;
    primed_ = true;
  } else {
    carrier_ += kAmAlpha * (env - carrier_);
  }
  return carrier_ > 1e-12f ? env / carrier_ - 1.f : 0.f;
}

float Deemphasis::step(float x) {
  y_ = kDeemphA * y_ + (1 - kDeemphA) * x;
  return y_;
}

QuietingMeter::QuietingMeter()
    : hpf_(design_highpass(LANE_RATE, NOISE_HPF_HZ, NOISE_HPF_TRANSITION_HZ)), ms_(NOISE_WINDOW) {}

}  // namespace kc
