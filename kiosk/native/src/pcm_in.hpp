// External speaker audio (CB via FernSDR): a jitter ring fed from a pipe by a reader thread and
// drained by the DSP thread in hop-sized pulls.
#pragma once
#include <cstdint>
#include <vector>

#include "constants.hpp"
#include "outputs.hpp"
#include "spsc.hpp"

namespace kc {
class PcmIn {
 public:
  PcmIn(double target_ms, double max_ms);
  size_t write(const int16_t* x, size_t n);   // producer: drops what doesn't fit
  // Consumer: n samples scaled to [-1, 1). Priming (or after an underrun) yields silence until
  // target_ms is buffered; a backlog over max_ms drops the oldest back to target_ms; an underrun
  // plays what is left, zero-fills, and returns to priming.
  void pull(float* out, int n);
  bool playing() const { return playing_; }
  void reset();                               // consumer: drop everything, back to priming
  // Detached thread: blocking reads from fd into the ring until EOF/error. Deliberately leaked
  // with the process, like the stdin reader in main.cpp.
  void start_reader(int fd, LogFn log);

 private:
  SpscRing<int16_t> ring_;
  size_t target_, max_;
  bool playing_ = false;
  std::vector<int16_t> tmp_;
};
}  // namespace kc
