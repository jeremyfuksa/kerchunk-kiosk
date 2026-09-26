#include "resampler.hpp"

#include <algorithm>
#include <stdexcept>

#include "fir.hpp"

namespace kc {

Resampler::Resampler(int up, int down, double in_rate, double cutoff_hz, double transition_hz)
    : up_(up), down_(down) {
  if (up < 1 || down < 1) throw std::invalid_argument("Resampler: up/down must be >= 1");
  std::vector<float> proto = design_lowpass(in_rate * up, cutoff_hz, transition_hz);
  tpp_ = (int)((proto.size() + up - 1) / up);
  proto.resize((size_t)tpp_ * up, 0.f);
  poly_.resize((size_t)tpp_ * up);
  for (int p = 0; p < up; p++)
    for (int j = 0; j < tpp_; j++) poly_[(size_t)p * tpp_ + j] = up * proto[(size_t)p + (size_t)up * (tpp_ - 1 - j)];
  hist_.assign(2 * (size_t)tpp_, 0.f);
}

int Resampler::push(const float* x, int n, float* out, int cap) {
  int emitted = 0;
  for (int i = 0; i < n; i++) {
    hist_[pos_] = x[i];
    hist_[pos_ + tpp_] = x[i];
    const float* w = &hist_[pos_ + 1];  // oldest-first window of the last tpp inputs
    while (phase_ < up_) {
      const float* h = &poly_[(size_t)phase_ * tpp_];
      // 8 independent partial sums (see FirFilter::step for why this matters without -ffast-math).
      float a[8] = {0, 0, 0, 0, 0, 0, 0, 0};
      int j = 0;
      for (; j + 8 <= tpp_; j += 8)
        for (int k = 0; k < 8; k++) a[k] += h[j + k] * w[j + k];
      float acc = ((a[0] + a[1]) + (a[2] + a[3])) + ((a[4] + a[5]) + (a[6] + a[7]));
      for (; j < tpp_; j++) acc += h[j] * w[j];
      if (emitted < cap) out[emitted++] = acc;
      phase_ += down_;
    }
    phase_ -= up_;
    pos_ = pos_ + 1 == tpp_ ? 0 : pos_ + 1;
  }
  return emitted;
}

int Resampler::push(const float* x, int n, std::vector<float>& out) {
  size_t old = out.size();
  out.resize(old + (size_t)max_out(n));
  int got = push(x, n, out.data() + old, max_out(n));
  out.resize(old + (size_t)got);
  return got;
}

void Resampler::reset() {
  std::fill(hist_.begin(), hist_.end(), 0.f);
  pos_ = 0;
  phase_ = 0;
}

}  // namespace kc
