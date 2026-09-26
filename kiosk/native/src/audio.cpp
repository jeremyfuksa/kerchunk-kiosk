#include "audio.hpp"

#include <algorithm>
#include <cmath>

namespace kc {

void to_s16(const float* x, int n, float scale, std::vector<int16_t>& out) {
  out.resize(n);
  for (int i = 0; i < n; i++) {
    long v = std::lround(x[i] * scale);
    out[i] = (int16_t)std::clamp(v, -32768L, 32767L);
  }
}

SpeakerPath::SpeakerPath()
    : lpf_(design_lowpass(LANE_RATE, AUDIO_LPF_HZ, AUDIO_LPF_TRANSITION_HZ)),
      speech_(SPEECH_WINDOW),
      rs_(24, 25, LANE_RATE, SPEAKER_RS_CUTOFF_HZ, SPEAKER_RS_TRANSITION_HZ) {
  a50_.resize(256);
  a48_.resize(256);
}

void SpeakerPath::apply_target(float t) {
  if (t == target_) return;
  // AM re-prime on gate open: after silence the carrier tracker followed the noise, so the
  // first ~40-100 ms of a new transmission would be hugely over-gained.
  if (target_ == 0.f && t > 0.f && cur_am_) am_.reset();
  const bool edge = (gain_ == 0.f && t > 0.f) || t == 0.f;
  if (edge) {
    ramp_step_ = (t - gain_) / FADE_SAMPLES;
    ramp_left_ = FADE_SAMPLES;
  } else {
    gain_ = t;
    ramp_left_ = 0;
  }
  target_ = t;
}

void SpeakerPath::set_gain(float target) {
  want_target_ = target;
  if (!switching_) apply_target(target);
}

void SpeakerPath::set_source(int lane, bool am) {
  if (lane == want_lane_ && am == want_am_) return;
  want_lane_ = lane;
  want_am_ = am;
  if (gain_ > 0.f || ramp_left_ > 0) {
    switching_ = true;
    apply_target(0.f);   // fade the old source out first
  } else {
    switch_now();
  }
}

void SpeakerPath::switch_now() {
  cur_lane_ = want_lane_;
  cur_am_ = want_am_;
  switching_ = false;
  de_.reset();
  lpf_.reset();
  am_.reset();
  speech_.reset();
  gain_ = target_ = 0.f;
  ramp_left_ = 0;
  apply_target(want_target_);
}

void SpeakerPath::reset() {
  want_lane_ = -1;
  want_am_ = false;
  want_target_ = 0.f;
  switch_now();
  rs_.reset();
}

void SpeakerPath::process(const cf* x, const float* disc, int n, std::vector<float>& out48) {
  if ((int)a50_.size() < n) a50_.resize(n);
  for (int i = 0; i < n; i++) {
    float a = 0.f;
    if (cur_lane_ >= 0 && x && disc) {
      a = cur_am_ ? am_.step(x[i]) * AM_GAIN : lpf_.step(de_.step(disc[i]));
      speech_.push(a);
    }
    a50_[i] = a;
  }
  const int cap = rs_.max_out(n);
  if ((int)a48_.size() < cap) a48_.resize(cap);
  const int m = rs_.push(a50_.data(), n, a48_.data(), cap);
  for (int i = 0; i < m; i++) {
    if (ramp_left_ > 0) {
      gain_ += ramp_step_;
      if (--ramp_left_ == 0) gain_ = target_;
    }
    out48.push_back(std::clamp(a48_[i] * gain_, -RAIL, RAIL));
  }
  if (switching_ && ramp_left_ == 0 && gain_ == 0.f) switch_now();
}

SamePath::SamePath()
    : lpf_(design_lowpass(LANE_RATE, AUDIO_LPF_HZ, AUDIO_LPF_TRANSITION_HZ)),
      rs_(441, 1000, LANE_RATE, SAME_RS_CUTOFF_HZ, SAME_RS_TRANSITION_HZ) {}

void SamePath::push(const float* disc, int n, std::vector<int16_t>& out) {
  if ((int)a_.size() < n) a_.resize(n);
  for (int i = 0; i < n; i++) a_[i] = lpf_.step(de_.step(disc[i]));
  const int cap = rs_.max_out(n);
  if ((int)b_.size() < cap) b_.resize(cap);
  const int m = rs_.push(a_.data(), n, b_.data(), cap);
  to_s16(b_.data(), m, SAME_S16_SCALE, tmp_);
  out.insert(out.end(), tmp_.begin(), tmp_.end());
}

void SamePath::reset() {
  de_.reset();
  lpf_.reset();
  rs_.reset();
}
}  // namespace kc
