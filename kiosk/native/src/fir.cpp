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

namespace kc {
ButterHighpass::ButterHighpass(double rate, double cutoff_hz, int order) {
  if (cutoff_hz <= 0) return;
  if (order < 2 || order > 8 || order % 2) throw std::invalid_argument("ButterHighpass: order must be even, 2..8");
  if (!(cutoff_hz < rate / 2)) throw std::invalid_argument("ButterHighpass: cutoff must be below Nyquist");
  const double w0 = 2 * M_PI * cutoff_hz / rate, cw = std::cos(w0), sw = std::sin(w0);
  for (int k = 0; k < order / 2; k++) {
    // Butterworth pole pair k: Q = 1 / (2 cos(theta_k)), theta_k = (2k+1) pi / (2 order).
    const double q = 1.0 / (2.0 * std::cos((2 * k + 1) * M_PI / (2.0 * order)));
    const double alpha = sw / (2 * q), a0 = 1 + alpha;
    Sec x;
    x.b0 = (1 + cw) / 2 / a0;
    x.b1 = -(1 + cw) / a0;
    x.b2 = (1 + cw) / 2 / a0;
    x.a1 = -2 * cw / a0;
    x.a2 = (1 - alpha) / a0;
    s_.push_back(x);
  }
}

float ButterHighpass::step(float xin) {
  double x = xin;
  for (auto& q : s_) {
    const double y = q.b0 * x + q.z1;
    q.z1 = q.b1 * x - q.a1 * y + q.z2;
    q.z2 = q.b2 * x - q.a2 * y;
    x = y;
  }
  return (float)x;
}

void ButterHighpass::reset() { for (auto& q : s_) q.z1 = q.z2 = 0; }
}  // namespace kc
