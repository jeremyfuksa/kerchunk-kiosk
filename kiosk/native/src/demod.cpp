#include "demod.hpp"

#include <cmath>
#include <vector>

namespace kc {

namespace {
const float kDiscScale = (float)(LANE_RATE / (2 * M_PI * FM_MAX_DEV_HZ));
const float kAmAlpha = (float)(1 - std::exp(-1.0 / (AM_CARRIER_TAU_S * LANE_RATE)));
const float kDeemphA = (float)std::exp(-1.0 / (LANE_RATE * DEEMPH_TAU_S));
const double kSsbW = 2 * M_PI * ((SSB_LO_HZ + SSB_HI_HZ) / 2) / LANE_RATE;   // sideband centre -> DC
const float kSsbAtt = (float)(1 - std::exp(-1.0 / (SSB_ENV_ATTACK_MS / 1000 * LANE_RATE)));
const float kSsbRel = (float)(1 - std::exp(-1.0 / (SSB_ENV_RELEASE_MS / 1000 * LANE_RATE)));
std::vector<float> ssb_aa() { return design_lowpass(LANE_RATE, SSB_AA_CUTOFF_HZ, SSB_AA_TRANSITION_HZ); }
std::vector<float> ssb_ch() { return design_lowpass(SSB_RATE, (SSB_HI_HZ - SSB_LO_HZ) / 2, SSB_TRANSITION_HZ); }
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

SsbDemod::SsbDemod()
    : dec_i_(ssb_aa()), dec_q_(ssb_aa()), ch_i_(ssb_ch()), ch_q_(ssb_ch()), int_i_(ssb_aa()), int_q_(ssb_aa()) {}

cf SsbDemod::step(cf x) {
  // The sideband is centred (LO+HI)/2 below the dial: rotate up by that much so it sits at DC.
  const cf rot = std::polar(1.0f, (float)ph_);
  ph_ += kSsbW;
  if (ph_ > M_PI) ph_ -= 2 * M_PI;
  const cf s = x * rot;
  const float di = dec_i_.step(s.real()), dq = dec_q_.step(s.imag());
  cf in{0, 0};
  // Every SSB_DECIM-th sample through the channel filter; the rest are zero-stuffed for the
  // interpolator, so x SSB_DECIM restores the level.
  if (k_ == 0) in = cf(ch_i_.step(di), ch_q_.step(dq)) * (float)SSB_DECIM;
  k_ = (k_ + 1) % SSB_DECIM;
  const cf u(int_i_.step(in.real()), int_q_.step(in.imag()));
  return u * std::conj(rot);   // back to where it was below the dial
}

void SsbDemod::reset() {
  dec_i_.reset();
  dec_q_.reset();
  ch_i_.reset();
  ch_q_.reset();
  int_i_.reset();
  int_q_.reset();
  ph_ = 0;
  k_ = 0;
}

float SsbLevel::step(cf x) {
  const float m = std::abs(x);
  if (!primed_) {
    env_ = m;
    primed_ = true;
  } else {
    env_ += (m > env_ ? kSsbAtt : kSsbRel) * (m - env_);
  }
  return env_ > 1e-12f ? x.real() / env_ : 0.f;
}

float Deemphasis::step(float x) {
  y_ = kDeemphA * y_ + (1 - kDeemphA) * x;
  return y_;
}

QuietingMeter::QuietingMeter()
    : hpf_(design_highpass(LANE_RATE, NOISE_HPF_HZ, NOISE_HPF_TRANSITION_HZ)), ms_(NOISE_WINDOW) {}

}  // namespace kc
