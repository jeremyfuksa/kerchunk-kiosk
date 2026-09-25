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

int Resampler::push(const float* x, int n, std::vector<float>& out) {
  int emitted = 0;
  for (int i = 0; i < n; i++) {
    hist_[pos_] = x[i];
    hist_[pos_ + tpp_] = x[i];
    const float* w = &hist_[pos_ + 1];  // oldest-first window of the last tpp inputs
    while (phase_ < up_) {
      const float* h = &poly_[(size_t)phase_ * tpp_];
      float acc = 0.f;
      for (int j = 0; j < tpp_; j++) acc += h[j] * w[j];
      out.push_back(acc);
      emitted++;
      phase_ += down_;
    }
    phase_ -= up_;
    pos_ = pos_ + 1 == tpp_ ? 0 : pos_ + 1;
  }
  return emitted;
}

void Resampler::reset() {
  std::fill(hist_.begin(), hist_.end(), 0.f);
  pos_ = 0;
  phase_ = 0;
}

}  // namespace kc
