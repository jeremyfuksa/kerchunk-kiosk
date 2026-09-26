#include "audio.hpp"

#include <algorithm>
#include <cmath>
#include <stdexcept>

namespace kc {

void to_s16(const float* x, int n, float scale, std::vector<int16_t>& out) {
  out.resize(n);
  for (int i = 0; i < n; i++) {
    long v = std::lround(x[i] * scale);
    out[i] = (int16_t)std::clamp(v, -32768L, 32767L);
  }
}

namespace {
std::vector<float> speaker_lpf(double hz) {
  if (!(hz > 0 && hz < LANE_RATE / 2.0)) throw std::invalid_argument("SpeakerPath: lpf_hz must be in (0, LANE_RATE/2)");
  return design_lowpass(LANE_RATE, hz, SPEAKER_LPF_TRANSITION_HZ);
}
}  // namespace

SpeakerPath::SpeakerPath(double lpf_hz)
    : lpf_(speaker_lpf(lpf_hz)),
      speech_(SPEECH_WINDOW),
      rs_(24, 25, LANE_RATE, SPEAKER_RS_CUTOFF_HZ, SPEAKER_RS_TRANSITION_HZ) {
  a50_.resize(256);
  a48_.resize(256);
}

// The edge logic (fade, then switch_now() at the end of process()) assumes a fade completes
// within one engine poll: a set_gain()/set_source() issued at the next poll must never land
// mid-fade. FADE_SAMPLES of 48 kHz audio must be shorter than one CHUNK_SAMPLES poll at 50 kHz.
static_assert((long long)FADE_SAMPLES * LANE_RATE < (long long)CHUNK_SAMPLES * AUDIO_RATE,
              "SpeakerPath fade must finish before the next poll");

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
  hold_left_ = 0;
  last_out_ = 0;
}

void SpeakerPath::cut() {
  const float held = last_out_;
  reset();
  hold_ = held;
  hold_left_ = held != 0.f ? FADE_SAMPLES : 0;
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
    float v = a48_[i] * gain_;
    if (hold_left_ > 0) v += hold_ * (float)--hold_left_ / FADE_SAMPLES;   // reaches exactly 0
    last_out_ = std::clamp(v, -RAIL, RAIL);
    out48.push_back(last_out_);
  }
  if (switching_ && ramp_left_ == 0 && gain_ == 0.f) switch_now();
}

SamePath::SamePath()
    : lpf_(design_lowpass(LANE_RATE, SAME_LPF_HZ, SAME_LPF_TRANSITION_HZ)),
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
