// Synthetic signal generators + measurements for tests.
#pragma once
#include <cmath>
#include <complex>
#include <random>
#include <vector>

namespace sig {
using cf = std::complex<float>;

inline std::vector<cf> tone(double rate, size_t n, double freq, double amp, double phase = 0) {
  std::vector<cf> x(n);
  for (size_t i = 0; i < n; i++) {
    double p = 2 * M_PI * freq * i / rate + phase;
    x[i] = cf((float)(amp * std::cos(p)), (float)(amp * std::sin(p)));
  }
  return x;
}

// Complex FM: carrier at `carrier` Hz, sinusoidal modulation `mod_hz` with peak deviation `dev_hz`.
inline std::vector<cf> fm_tone(double rate, size_t n, double carrier, double dev_hz, double mod_hz, double amp) {
  std::vector<cf> x(n);
  double beta = dev_hz / mod_hz;
  for (size_t i = 0; i < n; i++) {
    double t = i / rate;
    double p = 2 * M_PI * carrier * t + beta * std::sin(2 * M_PI * mod_hz * t);
    x[i] = cf((float)(amp * std::cos(p)), (float)(amp * std::sin(p)));
  }
  return x;
}

inline std::vector<cf> noise(size_t n, double sigma, unsigned seed) {
  std::mt19937 g(seed);
  std::normal_distribution<float> d(0.f, (float)sigma);
  std::vector<cf> x(n);
  for (auto& v : x) v = cf(d(g), d(g));
  return x;
}

inline void add(std::vector<cf>& a, const std::vector<cf>& b) {
  for (size_t i = 0; i < a.size() && i < b.size(); i++) a[i] += b[i];
}

inline double rms(const float* x, size_t n) {
  double s = 0;
  for (size_t i = 0; i < n; i++) s += (double)x[i] * x[i];
  return std::sqrt(s / (double)(n ? n : 1));
}

inline double db_power(double mean_square) { return 10 * std::log10(mean_square + 1e-20); }
}  // namespace sig
