#include "subaudio.hpp"

namespace kc {

SubaudioDecimator::SubaudioDecimator()
    : lpf_(design_lowpass(LANE_RATE / SUBAUDIO_DECIM1, SUBAUDIO_LPF_HZ, SUBAUDIO_LPF_TRANSITION_HZ)) {}

void SubaudioDecimator::reset() {
  if (!dirty_) return;
  lpf_.reset();
  acc_ = 0;
  acc_n_ = 0;
  odd_ = false;
  dirty_ = false;
}

int SubaudioDecimator::push(const float* disc, int n, float* out) {
  dirty_ = true;
  int k = 0;
  for (int i = 0; i < n; i++) {
    acc_ += disc[i];
    if (++acc_n_ < SUBAUDIO_DECIM1) continue;
    const float y = lpf_.step(acc_ * (1.f / SUBAUDIO_DECIM1));
    acc_ = 0;
    acc_n_ = 0;
    odd_ = !odd_;
    if (odd_) out[k++] = y;
  }
  return k;
}
}  // namespace kc
