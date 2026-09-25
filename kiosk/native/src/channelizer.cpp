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

  fin_ = fftwf_alloc_complex(n_);
  fout_ = fftwf_alloc_complex(n_);
  lin_ = fftwf_alloc_complex(LANE_BINS);
  lout_ = fftwf_alloc_complex(LANE_BINS);
  // Filter response: taps zero-padded to n_, forward FFT (one-off ESTIMATE plan on the output buffer).
  std::memset(fout_, 0, sizeof(fftwf_complex) * n_);
  for (size_t i = 0; i < h.size(); i++) fout_[i][0] = h[i];
  fftwf_plan ph = fftwf_plan_dft_1d(n_, fout_, fout_, FFTW_FORWARD, FFTW_ESTIMATE);
  fftwf_execute(ph);
  fftwf_destroy_plan(ph);
  H_.resize(n_);
  for (int i = 0; i < n_; i++) H_[i] = cf(fout_[i][0], fout_[i][1]);
  // MEASURE may scribble on the buffers, so plan before zeroing the input history.
  pf_ = fftwf_plan_dft_1d(n_, fin_, fout_, FFTW_FORWARD, FFTW_MEASURE);
  pl_ = fftwf_plan_dft_1d(LANE_BINS, lin_, lout_, FFTW_BACKWARD, FFTW_MEASURE);
  std::memset(fin_, 0, sizeof(fftwf_complex) * n_);
}

Channelizer::~Channelizer() {
  fftwf_destroy_plan(pf_);
  fftwf_destroy_plan(pl_);
  fftwf_free(fin_);
  fftwf_free(fout_);
  fftwf_free(lin_);
  fftwf_free(lout_);
}

void Channelizer::set_lanes(const std::vector<double>& offsets_hz) {
  const double binw = (double)rate_ / n_;
  lanes_.clear();
  for (double off : offsets_hz) {
    Lane l;
    l.k0 = (int)std::lround(off / binw);
    double resid = off - l.k0 * binw;
    double w = -2 * M_PI * resid / LANE_RATE;
    l.nco_step = cf((float)std::cos(w), (float)std::sin(w));
    lanes_.push_back(l);
  }
  out_.assign(lanes_.size() * kLaneSamplesPerHop, cf(0, 0));
  block_ = 0;
}

void Channelizer::push_u8(const uint8_t* iq, size_t nsamples, const HopSink& sink) {
  const int hop = n_ / 2;
  for (size_t i = 0; i < nsamples; i++) {
    fin_[hop + fill_][0] = lut_[iq[2 * i]];
    fin_[hop + fill_][1] = lut_[iq[2 * i + 1]];
    if (++fill_ == hop) run_hop(sink);
  }
}

void Channelizer::push_cf(const cf* x, size_t nsamples, const HopSink& sink) {
  const int hop = n_ / 2;
  for (size_t i = 0; i < nsamples; i++) {
    fin_[hop + fill_][0] = x[i].real();
    fin_[hop + fill_][1] = x[i].imag();
    if (++fill_ == hop) run_hop(sink);
  }
}

void Channelizer::run_hop(const HopSink& sink) {
  const int hop = n_ / 2, keep = kLaneSamplesPerHop, M = LANE_BINS;
  const float scale = 1.0f / n_;
  fftwf_execute(pf_);
  const cf* X = reinterpret_cast<const cf*>(fout_);
  cf* Y = reinterpret_cast<cf*>(lin_);
  const cf* yb = reinterpret_cast<const cf*>(lout_);
  for (size_t li = 0; li < lanes_.size(); li++) {
    Lane& l = lanes_[li];
    for (int m = -M / 2; m < M / 2; m++) {
      int kx = ((l.k0 + m) % n_ + n_) % n_;
      int kh = (m + n_) % n_;
      Y[(m + M) % M] = X[kx] * H_[kh];
    }
    fftwf_execute(pl_);
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
  sink(out_.data(), (int)lanes_.size(), keep, reinterpret_cast<const cf*>(fin_ + hop), hop);
  std::memmove(fin_, fin_ + hop, sizeof(fftwf_complex) * hop);
  fill_ = 0;
}

}  // namespace kc
