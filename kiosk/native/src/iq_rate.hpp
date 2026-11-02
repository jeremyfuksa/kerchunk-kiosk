// SpyServer's Airspy HF+ stream is 768 kHz, but Channelizer needs a multiple of LANE_RATE (50 kHz),
// so u8 IQ is resampled to 750 kHz, 15 x LANE_RATE. Keeps the 660 kHz usable span.
#pragma once
#include <cstddef>
#include <cstdint>
#include <vector>

#include "resampler.hpp"

namespace kc {
class IqRateConverter {
 public:
  IqRateConverter();
  // Takes nsamples complex u8 samples and writes at most out_cap_samples complex samples to `out`.
  // Returns the number written. Size `out` with max_out(nsamples) to lose nothing.
  size_t push(const uint8_t* iq, size_t nsamples, uint8_t* out, size_t out_cap_samples);
  void reset();
  size_t max_out(size_t nsamples) const { return (size_t)i_.max_out((int)nsamples); }
  static constexpr int IN_RATE = 768000, OUT_RATE = 750000;

 private:
  Resampler i_, q_;
  std::vector<float> in_i_, in_q_, out_i_, out_q_;
};
}  // namespace kc
