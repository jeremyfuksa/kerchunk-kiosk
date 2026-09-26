// Lane power meters. dB = 10*log10(mean + 1e-20).
#pragma once
#include <cmath>
#include <complex>

#include "constants.hpp"

namespace kc {

// Mean |x|^2 over consecutive CHUNK_SAMPLES chunks. fast = latest chunk (10 ms, audio gate);
// slow = mean of the last SLOW_CHUNKS chunk means (100 ms, detection/floor).
class ChunkPower {
 public:
  int push(const std::complex<float>* x, int n) {
    int done = 0;
    for (int i = 0; i < n; i++) {
      acc_ += std::norm(x[i]);
      if (++acc_n_ == CHUNK_SAMPLES) {
        fast_ = acc_ / CHUNK_SAMPLES;
        ring_[ring_pos_] = fast_;
        ring_pos_ = (ring_pos_ + 1) % SLOW_CHUNKS;
        if (ring_fill_ < SLOW_CHUNKS) ring_fill_++;
        acc_ = 0;
        acc_n_ = 0;
        chunks_++;
        done++;
      }
    }
    return done;
  }
  float fast_db() const { return (float)(10 * std::log10(fast_ + 1e-20)); }
  float slow_db() const {
    double s = 0;
    for (int i = 0; i < ring_fill_; i++) s += ring_[i];
    return (float)(10 * std::log10((ring_fill_ ? s / ring_fill_ : 0) + 1e-20));
  }
  long chunks() const { return chunks_; }
  void reset() { *this = ChunkPower(); }

 private:
  double acc_ = 0;
  int acc_n_ = 0;
  double fast_ = 0;
  double ring_[SLOW_CHUNKS] = {};
  int ring_pos_ = 0;
  int ring_fill_ = 0;
  long chunks_ = 0;
};

// Mean square of a real stream over consecutive fixed windows (value updates once per window).
class MeanSquare {
 public:
  explicit MeanSquare(int window) : window_(window) {}
  bool push(float x) {
    acc_ += (double)x * x;
    if (++n_ < window_) return false;
    value_ = acc_ / window_;
    acc_ = 0;
    n_ = 0;
    ready_ = true;
    return true;
  }
  float db() const { return (float)(10 * std::log10(value_ + 1e-20)); }
  bool ready() const { return ready_; }
  void reset() { acc_ = 0; n_ = 0; value_ = 0; ready_ = false; }

 private:
  int window_;
  double acc_ = 0;
  int n_ = 0;
  double value_ = 0;
  bool ready_ = false;
};

}  // namespace kc
