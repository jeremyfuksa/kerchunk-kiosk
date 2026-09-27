// CTCSS (sub-audible tone) detector for one FM lane: the lane's SubaudioDecimator output
// (SUBAUDIO_RATE) in, the stable EIA tone (Hz) out. Every CTCSS_HOP_MS runs a Goertzel per
// standard tone over the last CTCSS_WINDOW_MS. Knobs: constants.hpp (CTCSS_*).
#pragma once
#include <array>
#include <optional>
#include <vector>

#include "constants.hpp"

namespace kc {
// The 50 standard EIA/TIA-603 CTCSS tones, Hz. Mirrored in Node: src/backend/config/ctcss.ts.
inline constexpr std::array<float, 50> CTCSS_TONES = {
    67.0f,  69.3f,  71.9f,  74.4f,  77.0f,  79.7f,  82.5f,  85.4f,  88.5f,  91.5f,
    94.8f,  97.4f,  100.0f, 103.5f, 107.2f, 110.9f, 114.8f, 118.8f, 123.0f, 127.3f,
    131.8f, 136.5f, 141.3f, 146.2f, 151.4f, 156.7f, 159.8f, 162.2f, 165.5f, 167.9f,
    171.3f, 173.8f, 177.3f, 179.9f, 183.5f, 186.2f, 189.9f, 192.8f, 196.6f, 199.5f,
    203.5f, 206.5f, 210.7f, 218.1f, 225.7f, 229.1f, 233.6f, 241.8f, 250.3f, 254.1f};

class CtcssDetector {
 public:
  CtcssDetector();
  // sub: n samples at SUBAUDIO_RATE (SubaudioDecimator::push output).
  void push(const float* sub, int n);
  // The detected tone (a CTCSS_TONES value), once the same tone has passed CTCSS_STABLE_HOPS hops in
  // a row; cleared by the first hop that doesn't pass.
  std::optional<float> tone() const { return tone_; }
  // Cheap when already reset (Engine calls it every hop on lanes the detector is idle on).
  void reset();

 private:
  void evaluate();

  static constexpr int kWindow = SUBAUDIO_RATE * CTCSS_WINDOW_MS / 1000;
  static constexpr int kHop = SUBAUDIO_RATE * CTCSS_HOP_MS / 1000;
  std::array<float, CTCSS_TONES.size()> coeff_{};
  std::vector<float> ring_;   // kWindow samples at SUBAUDIO_RATE, oldest at pos_
  int pos_ = 0, fill_ = 0, since_hop_ = 0;
  int cand_ = -1, streak_ = 0;
  std::optional<float> tone_;
  bool dirty_ = false;
};
}  // namespace kc
