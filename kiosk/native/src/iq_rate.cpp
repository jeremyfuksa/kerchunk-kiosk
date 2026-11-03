#include "iq_rate.hpp"

#include <algorithm>
#include <cmath>

namespace kc {
namespace {
constexpr int UP = 125, DOWN = 128;
// Passes the usable +/-330 kHz. An image only reaches that span from 420 kHz or above (420 folds to
// 420 - 750 = -330), so the stopband can start there and the filter stays short.
constexpr double CUTOFF_HZ = 375000, TRANSITION_HZ = 90000;
uint8_t to_u8(float v) { return (uint8_t)std::clamp(std::lround(127.5f + 127.5f * v), 0L, 255L); }
}  // namespace

IqRateConverter::IqRateConverter()
    : i_(UP, DOWN, IN_RATE, CUTOFF_HZ, TRANSITION_HZ), q_(UP, DOWN, IN_RATE, CUTOFF_HZ, TRANSITION_HZ) {}

size_t IqRateConverter::push(const uint8_t* iq, size_t nsamples, uint8_t* out, size_t out_cap_samples) {
  if (in_i_.size() < nsamples) {
    in_i_.resize(nsamples);
    in_q_.resize(nsamples);
    out_i_.resize(max_out(nsamples));
    out_q_.resize(max_out(nsamples));
  }
  for (size_t k = 0; k < nsamples; k++) {
    in_i_[k] = ((float)iq[2 * k] - 127.5f) / 127.5f;
    in_q_[k] = ((float)iq[2 * k + 1] - 127.5f) / 127.5f;
  }
  const int cap = (int)std::min(out_cap_samples, out_i_.size());
  const int got = i_.push(in_i_.data(), (int)nsamples, out_i_.data(), cap);
  q_.push(in_q_.data(), (int)nsamples, out_q_.data(), cap);
  for (int k = 0; k < got; k++) {
    out[2 * k] = to_u8(out_i_[k]);
    out[2 * k + 1] = to_u8(out_q_[k]);
  }
  return (size_t)got;
}

void IqRateConverter::reset() {
  i_.reset();
  q_.reset();
}
}  // namespace kc
