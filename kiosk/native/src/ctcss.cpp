#include "ctcss.hpp"

#include <algorithm>
#include <cmath>

namespace kc {

CtcssDetector::CtcssDetector()
    : lpf_(design_lowpass(LANE_RATE / CTCSS_DECIM1, CTCSS_LPF_HZ, CTCSS_LPF_TRANSITION_HZ)), ring_(kWindow, 0.f) {
  for (size_t k = 0; k < CTCSS_TONES.size(); k++)
    coeff_[k] = (float)(2 * std::cos(2 * M_PI * CTCSS_TONES[k] / CTCSS_RATE));
}

void CtcssDetector::reset() {
  if (!dirty_) return;
  lpf_.reset();
  std::fill(ring_.begin(), ring_.end(), 0.f);
  pos_ = fill_ = since_hop_ = 0;
  acc_ = 0;
  acc_n_ = 0;
  odd_ = false;
  cand_ = -1;
  streak_ = 0;
  tone_.reset();
  dirty_ = false;
}

void CtcssDetector::push(const float* disc, int n) {
  dirty_ = true;
  for (int i = 0; i < n; i++) {
    acc_ += disc[i];
    if (++acc_n_ < CTCSS_DECIM1) continue;
    const float y = lpf_.step(acc_ * (1.f / CTCSS_DECIM1));
    acc_ = 0;
    acc_n_ = 0;
    odd_ = !odd_;
    if (!odd_) continue;
    ring_[pos_] = y;
    pos_ = (pos_ + 1) % kWindow;
    if (fill_ < kWindow) fill_++;
    if (++since_hop_ >= kHop) {
      since_hop_ = 0;
      if (fill_ == kWindow) evaluate();
    }
  }
}

void CtcssDetector::evaluate() {
  constexpr int K = (int)CTCSS_TONES.size();
  // Unroll the ring oldest-first once, so each Goertzel is a straight pass.
  float x[kWindow];
  std::copy(ring_.begin() + pos_, ring_.end(), x);
  std::copy(ring_.begin(), ring_.begin() + pos_, x + (kWindow - pos_));
  float pw[K];
  for (int k = 0; k < K; k++) {
    const float c = coeff_[k];
    float s1 = 0, s2 = 0;
    for (int j = 0; j < kWindow; j++) {
      const float s = x[j] + c * s1 - s2;
      s2 = s1;
      s1 = s;
    }
    pw[k] = s1 * s1 + s2 * s2 - c * s1 * s2;   // |X|^2
  }
  int best = 0;
  double sum = 0;
  for (int k = 0; k < K; k++) {
    sum += pw[k];
    if (pw[k] > pw[best]) best = k;
  }
  const double others = (sum - pw[best]) / (K - 1);
  // |X|^2 -> mean square of a sinusoid of that amplitude: A = 2|X|/N, ms = A^2/2.
  const double ms = 2.0 * pw[best] / ((double)kWindow * kWindow);
  const bool pass = ms > std::pow(10.0, CTCSS_FLOOR_DB / 10) &&
                    pw[best] > others * std::pow(10.0, CTCSS_MARGIN_DB / 10);
  if (!pass) {
    cand_ = -1;
    streak_ = 0;
    tone_.reset();
    return;
  }
  if (best == cand_) streak_++;
  else { cand_ = best; streak_ = 1; tone_.reset(); }
  if (streak_ >= CTCSS_STABLE_HOPS) tone_ = CTCSS_TONES[best];
}
}  // namespace kc
