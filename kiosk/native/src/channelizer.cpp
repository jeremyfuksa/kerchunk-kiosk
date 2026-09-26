#include "channelizer.hpp"

#include <cmath>
#include <cstring>
#include <stdexcept>
#include <string>

#include "fir.hpp"

namespace kc {

Channelizer::Channelizer(int rate) : rate_(rate) {
  if (rate <= 0 || rate % LANE_RATE != 0)
    throw std::invalid_argument("Channelizer: rate " + std::to_string(rate) + " is not a positive multiple of 50 kHz");
  n_ = LANE_BINS * (rate / LANE_RATE);
  std::vector<float> h = design_lowpass(rate, CHAN_CUTOFF_HZ, CHAN_TRANSITION_HZ);
  if ((int)h.size() > n_ / 2 + 1)
    throw std::invalid_argument("Channelizer: " + std::to_string(h.size()) + " taps exceed the overlap-save valid region (" +
                                std::to_string(n_ / 2 + 1) + ") at rate " + std::to_string(rate));
  for (int i = 0; i < 256; i++) lut_[i] = (i - 127.5f) / 127.5f;

  fin_.reset(fftwf_alloc_complex(n_));
  fout_.reset(fftwf_alloc_complex(n_));
  lin_.reset(fftwf_alloc_complex(LANE_BINS));
  lout_.reset(fftwf_alloc_complex(LANE_BINS));
  // Filter response: taps zero-padded to n_, forward FFT (one-off ESTIMATE plan on the output buffer).
  std::memset(fout_.get(), 0, sizeof(fftwf_complex) * n_);
  for (size_t i = 0; i < h.size(); i++) fout_[i][0] = h[i];
  FftwPlanPtr ph(fftwf_plan_dft_1d(n_, fout_.get(), fout_.get(), FFTW_FORWARD, FFTW_ESTIMATE));
  fftwf_execute(ph.get());
  ph.reset();
  H_.resize(n_);
  for (int i = 0; i < n_; i++) H_[i] = cf(fout_[i][0], fout_[i][1]);
  // MEASURE may scribble on the buffers, so plan before zeroing the input history.
  pf_.reset(fftwf_plan_dft_1d(n_, fin_.get(), fout_.get(), FFTW_FORWARD, FFTW_MEASURE));
  pl_.reset(fftwf_plan_dft_1d(LANE_BINS, lin_.get(), lout_.get(), FFTW_BACKWARD, FFTW_MEASURE));
  std::memset(fin_.get(), 0, sizeof(fftwf_complex) * n_);
}

Channelizer::Lane Channelizer::make_lane(double off) const {
  const double binw = (double)rate_ / n_;
  const double limit = rate_ / 2.0 - LANE_RATE / 2.0;
  if (!std::isfinite(off))
    throw std::invalid_argument("Channelizer: offset " + std::to_string(off) + " Hz is not finite");
  if (std::fabs(off) > limit)
    throw std::invalid_argument("Channelizer: offset " + std::to_string(off) + " Hz exceeds the +-" +
                                std::to_string(limit) + " Hz limit (rate/2 - LANE_RATE/2) at rate " + std::to_string(rate_));
  Lane l;
  l.k0 = (int)std::lround(off / binw);
  double resid = off - l.k0 * binw;
  double w = -2 * M_PI * resid / LANE_RATE;
  l.nco_step = cf((float)std::cos(w), (float)std::sin(w));
  return l;
}

void Channelizer::set_lanes(const std::vector<double>& offsets_hz) {
  // Build into a local vector first: all offsets are validated by make_lane before any
  // mutation, keeping the strong exception guarantee — a throwing set_lanes must leave the
  // previously-installed lanes untouched.
  std::vector<Lane> lanes;
  lanes.reserve(offsets_hz.size());
  for (double off : offsets_hz) lanes.push_back(make_lane(off));   // throws before any mutation
  lanes_ = std::move(lanes);
  out_.assign(lanes_.size() * kLaneSamplesPerHop, cf(0, 0));
  block_ = 0;
}

void Channelizer::set_lane_offset(int i, double off) {
  if (i < 0 || i >= (int)lanes_.size()) throw std::out_of_range("Channelizer::set_lane_offset: bad lane index");
  lanes_[i] = make_lane(off);
}

void Channelizer::reset_stream() {
  std::memset(fin_.get(), 0, sizeof(fftwf_complex) * n_);
  fill_ = 0;
  block_ = 0;
}

void Channelizer::run_hop() {
  const int keep = kLaneSamplesPerHop, M = LANE_BINS;
  const float scale = 1.0f / n_;
  fftwf_execute(pf_.get());
  const cf* X = reinterpret_cast<const cf*>(fout_.get());
  cf* Y = reinterpret_cast<cf*>(lin_.get());
  const cf* yb = reinterpret_cast<const cf*>(lout_.get());
  for (size_t li = 0; li < lanes_.size(); li++) {
    Lane& l = lanes_[li];
    for (int m = -M / 2; m < M / 2; m++) {
      int kx = ((l.k0 + m) % n_ + n_) % n_;
      int kh = (m + n_) % n_;
      Y[(m + M) % M] = X[kx] * H_[kh];
    }
    fftwf_execute(pl_.get());
    // Hop n/2 advances the k0 mixer by pi*k0 per block: flip sign on odd k0, odd block.
    const float s = ((l.k0 & 1) && (block_ & 1)) ? -scale : scale;
    cf* o = &out_[li * keep];
    for (int d = 0; d < keep; d++) {
      o[d] = yb[keep + d] * s * l.nco;
      l.nco *= l.nco_step;
    }
    l.nco /= std::abs(l.nco);  // renormalize once per hop so float drift can't grow
  }
  block_++;
}

void Channelizer::advance_hop() {
  const int hop = n_ / 2;
  std::memmove(fin_.get(), fin_.get() + hop, sizeof(fftwf_complex) * hop);
  fill_ = 0;
}

}  // namespace kc
