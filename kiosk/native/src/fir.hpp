// Filter design and a streaming real FIR.
#pragma once
#include <vector>

namespace kc {
// Hamming windowed-sinc low-pass, unity DC gain. ntaps = ceil(3.3*rate/transition), forced odd.
std::vector<float> design_lowpass(double rate, double cutoff_hz, double transition_hz);
// Same design with an explicit tap count; cutoff_norm = cutoff_hz / rate.
std::vector<float> design_lowpass_taps(int ntaps, double cutoff_norm);
// Spectral inversion of design_lowpass: delta - lowpass (odd length, zero DC gain).
std::vector<float> design_highpass(double rate, double cutoff_hz, double transition_hz);

// Butterworth high-pass as a cascade of 2nd-order sections (direct form II transposed, double
// state). order must be even (2..8); cutoff_hz <= 0 builds a pass-through.
class ButterHighpass {
 public:
  ButterHighpass(double rate, double cutoff_hz, int order);
  float step(float x);
  void reset();
  bool enabled() const { return !s_.empty(); }

 private:
  struct Sec { double b0, b1, b2, a1, a2, z1 = 0, z2 = 0; };
  std::vector<Sec> s_;
};

// Streaming real FIR. History lives in a doubled ring so every output is one contiguous dot product.
class FirFilter {
 public:
  explicit FirFilter(std::vector<float> taps);
  float step(float x);
  void reset();
  int size() const { return n_; }

 private:
  std::vector<float> rev_;  // taps reversed: rev_[j] = h[n-1-j] pairs with the oldest-first window
  std::vector<float> buf_;  // 2n: each sample written at pos and pos+n
  int n_;
  int pos_ = 0;
};
}  // namespace kc
