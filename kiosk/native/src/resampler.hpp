// Rational polyphase resampler (up/down) on a real stream.
#pragma once
#include <vector>

namespace kc {
class Resampler {
 public:
  Resampler(int up, int down, double in_rate, double cutoff_hz, double transition_hz);
  int push(const float* x, int n, std::vector<float>& out);
  void reset();
  int taps_per_phase() const { return tpp_; }

 private:
  int up_, down_, tpp_;
  std::vector<float> poly_;  // poly_[phase*tpp + j] = up * proto[phase + up*(tpp-1-j)] (oldest-first window order)
  std::vector<float> hist_;  // doubled ring, 2*tpp
  int pos_ = 0;
  int phase_ = 0;
};
}  // namespace kc
