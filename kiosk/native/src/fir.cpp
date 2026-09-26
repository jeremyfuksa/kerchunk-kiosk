#include "fir.hpp"

#include <algorithm>
#include <cmath>
#include <stdexcept>

#include "constants.hpp"

namespace kc {

std::vector<float> design_lowpass_taps(int ntaps, double cutoff_norm) {
  if (ntaps < 1) throw std::invalid_argument("design_lowpass_taps: ntaps < 1");
  std::vector<double> h(ntaps);
  double sum = 0;
  for (int i = 0; i < ntaps; i++) {
    double m = i - (ntaps - 1) / 2.0;
    double s = m == 0 ? 2 * cutoff_norm : std::sin(2 * M_PI * cutoff_norm * m) / (M_PI * m);
    double w = ntaps == 1 ? 1.0 : 0.54 - 0.46 * std::cos(2 * M_PI * i / (ntaps - 1));
    h[i] = s * w;
    sum += h[i];
  }
  std::vector<float> out(ntaps);
  for (int i = 0; i < ntaps; i++) out[i] = (float)(h[i] / sum);
  return out;
}

std::vector<float> design_lowpass(double rate, double cutoff_hz, double transition_hz) {
  int n = (int)std::ceil(TAPS_PER_FS_OVER_TW * rate / transition_hz);
  if (n % 2 == 0) n++;
  return design_lowpass_taps(n, cutoff_hz / rate);
}

std::vector<float> design_highpass(double rate, double cutoff_hz, double transition_hz) {
  std::vector<float> h = design_lowpass(rate, cutoff_hz, transition_hz);
  for (float& v : h) v = -v;
  h[h.size() / 2] += 1.0f;
  return h;
}

FirFilter::FirFilter(std::vector<float> taps) : n_((int)taps.size()) {
  if (n_ < 1) throw std::invalid_argument("FirFilter: empty taps");
  rev_.assign(taps.rbegin(), taps.rend());
  buf_.assign(2 * n_, 0.f);
}

float FirFilter::step(float x) {
  buf_[pos_] = x;
  buf_[pos_ + n_] = x;
  const float* w = &buf_[pos_ + 1];
  // 8 independent partial sums: without -ffast-math the compiler may not reassociate a single
  // accumulator, so one sum is a serial add chain; 8 lanes vectorize into one ymm accumulator.
  float a[8] = {0, 0, 0, 0, 0, 0, 0, 0};
  int j = 0;
  for (; j + 8 <= n_; j += 8)
    for (int k = 0; k < 8; k++) a[k] += rev_[j + k] * w[j + k];
  float acc = ((a[0] + a[1]) + (a[2] + a[3])) + ((a[4] + a[5]) + (a[6] + a[7]));
  for (; j < n_; j++) acc += rev_[j] * w[j];
  pos_ = pos_ + 1 == n_ ? 0 : pos_ + 1;
  return acc;
}

void FirFilter::reset() {
  std::fill(buf_.begin(), buf_.end(), 0.f);
  pos_ = 0;
}

}  // namespace kc
