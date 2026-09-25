// Overlap-save FFT channelizer: one shared FFT per hop, then per lane a LANE_BINS-bin extract,
// channel-filter multiply, small IFFT, and residual-offset NCO. Output: LANE_RATE complex per lane.
#pragma once
#include <fftw3.h>

#include <complex>
#include <cstdint>
#include <functional>
#include <memory>
#include <type_traits>
#include <vector>

#include "constants.hpp"

namespace kc {
using cf = std::complex<float>;

// RAII deleters so a mid-construction throw (e.g. std::bad_alloc from a later member, or from
// planning itself) still frees every FFTW buffer/plan already created — no manual cleanup list.
struct FftwFree {
  void operator()(fftwf_complex* p) const { fftwf_free(p); }
};
struct FftwPlanDestroy {
  void operator()(std::remove_pointer_t<fftwf_plan>* p) const { fftwf_destroy_plan(p); }
};
using FftwBuf = std::unique_ptr<fftwf_complex[], FftwFree>;
using FftwPlanPtr = std::unique_ptr<std::remove_pointer_t<fftwf_plan>, FftwPlanDestroy>;

class Channelizer {
 public:
  explicit Channelizer(int rate);
  ~Channelizer() = default;
  Channelizer(const Channelizer&) = delete;
  Channelizer& operator=(const Channelizer&) = delete;

  int rate() const { return rate_; }
  int fft_size() const { return n_; }
  int hop() const { return n_ / 2; }
  static constexpr int kLaneSamplesPerHop = LANE_BINS / 2;

  void set_lanes(const std::vector<double>& offsets_hz);
  int lanes() const { return (int)lanes_.size(); }

  // lanes_out and raw point into the Channelizer's internal buffers and are valid only for the
  // duration of the callback — do not retain either pointer past the call.
  using HopSink = std::function<void(const cf* lanes_out, int lanes, int per_lane, const cf* raw, int raw_n)>;
  void push_u8(const uint8_t* iq, size_t nsamples, const HopSink& sink);
  void push_cf(const cf* x, size_t nsamples, const HopSink& sink);

 private:
  struct Lane {
    int k0;        // center bin (signed)
    cf nco{1, 0};  // residual-offset rotator state
    cf nco_step{1, 0};
  };
  void run_hop(const HopSink& sink);

  int rate_, n_;
  std::vector<cf> H_;        // channel filter response, n_ bins
  std::vector<Lane> lanes_;
  std::vector<cf> out_;      // lanes * kLaneSamplesPerHop
  float lut_[256];
  FftwBuf fin_;    // [previous hop | current hop]
  FftwBuf fout_;
  FftwBuf lin_;
  FftwBuf lout_;
  FftwPlanPtr pf_, pl_;
  int fill_ = 0;             // samples of the current hop received
  long block_ = 0;           // hops processed since set_lanes (parity for odd-k0 sign)
};
}  // namespace kc
