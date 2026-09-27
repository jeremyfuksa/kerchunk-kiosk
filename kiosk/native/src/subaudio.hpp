// Shared sub-audible front end for one FM lane: discriminator at LANE_RATE in, SUBAUDIO_RATE out.
// One per lane feeds both the CTCSS and the DCS detector, so the lane is decimated once.
// Knobs: constants.hpp (SUBAUDIO_*).
#pragma once
#include "constants.hpp"
#include "fir.hpp"

namespace kc {
class SubaudioDecimator {
 public:
  SubaudioDecimator();
  // Writes the SUBAUDIO_RATE samples produced by n input samples to out (room for
  // max_out(n)) and returns how many.
  int push(const float* disc, int n, float* out);
  static constexpr int max_out(int n) { return n / (SUBAUDIO_DECIM1 * 2) + 1; }
  void reset();   // cheap when already reset

 private:
  FirFilter lpf_;
  float acc_ = 0;
  int acc_n_ = 0;
  bool odd_ = false;   // 2 kHz -> 1 kHz: keep every 2nd LPF output
  bool dirty_ = false;
};
}  // namespace kc
