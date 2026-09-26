#include "closecall.hpp"

#include <algorithm>
#include <cmath>

namespace kc {

CloseCall::CloseCall(int rate) : rate_(rate), every_(rate / CC_FPS), since_(rate / CC_FPS), win_(CC_FFT), acc_(CC_FFT, 0.f) {
  for (int i = 0; i < CC_FFT; i++) {
    double r = 2 * M_PI * i / (CC_FFT - 1);
    win_[i] = (float)(0.35875 - 0.48829 * std::cos(r) + 0.14128 * std::cos(2 * r) - 0.01168 * std::cos(3 * r));
  }
  in_.reset(fftwf_alloc_complex(CC_FFT));
  out_.reset(fftwf_alloc_complex(CC_FFT));
  plan_.reset(fftwf_plan_dft_1d(CC_FFT, in_.get(), out_.get(), FFTW_FORWARD, FFTW_MEASURE));
}

void CloseCall::reset(double center_hz) {
  center_ = center_hz;
  std::fill(acc_.begin(), acc_.end(), 0.f);
  frames_ = 0;
  fill_ = 0;
  since_ = every_;
  pending_.reset();
}

void CloseCall::push_raw(const cf* x, int n) {
  for (int i = 0; i < n; i++) {
    if (fill_ == 0) {
      if (since_ < every_) { since_++; continue; }
      since_ = 0;   // frames are paced start-to-start
    }
    since_++;
    in_[fill_][0] = x[i].real() * win_[fill_];
    in_[fill_][1] = x[i].imag() * win_[fill_];
    if (++fill_ == CC_FFT) {
      fftwf_execute(plan_.get());
      for (int k = 0; k < CC_FFT; k++) {
        const int s = (k + CC_FFT / 2) % CC_FFT;   // fftshift: DC at the center bin
        acc_[s] += out_[k][0] * out_[k][0] + out_[k][1] * out_[k][1];
      }
      frames_++;
      fill_ = 0;
    }
  }
}

std::optional<long long> CloseCall::check(double now, const std::vector<double>& assigned_hz) {
  if (frames_ == 0) return std::nullopt;
  std::vector<double> db(CC_FFT);
  for (int k = 0; k < CC_FFT; k++) db[k] = 10 * std::log10(acc_[k] / frames_ + 1e-20);
  std::fill(acc_.begin(), acc_.end(), 0.f);
  frames_ = 0;

  std::vector<double> sorted = db;
  std::nth_element(sorted.begin(), sorted.begin() + CC_FFT / 2, sorted.end());
  const double floor = sorted[CC_FFT / 2];

  std::vector<bool> mask(CC_FFT, true);
  const int edge = (int)(CC_FFT * CC_EDGE_FRAC);
  for (int k = 0; k < edge; k++) mask[k] = mask[CC_FFT - 1 - k] = false;
  const int dc = CC_FFT / 2, dcw = std::max(1, (int)(CC_FFT * CC_DC_FRAC));
  for (int k = dc - dcw; k <= dc + dcw; k++) mask[k] = false;
  const double binw = (double)rate_ / CC_FFT;
  auto suppress = [&](double f) {
    const int b = (int)std::lround((f - center_) / binw) + dc;
    const int g = (int)(CC_GUARD_HZ / binw) + 1;
    for (int k = std::max(0, b - g); k < std::min(CC_FFT, b + g + 1); k++) mask[k] = false;
  };
  for (double f : known_) suppress(f);
  for (double f : assigned_hz) suppress(f);

  int idx = -1;
  for (int k = 0; k < CC_FFT; k++)
    if (mask[k] && (idx < 0 || db[k] > db[idx])) idx = k;
  if (idx < 0) return std::nullopt;
  if (db[idx] < floor + db_) { pending_.reset(); return std::nullopt; }
  // Image rejection: the tuner mirrors strong signals around center; a markedly stronger mirror
  // means the candidate IS the ghost.
  const int mirror = 2 * dc - idx;
  if (mirror >= 0 && mirror < CC_FFT && db[mirror] > db[idx] + CC_IMAGE_REJECT_DB) { pending_.reset(); return std::nullopt; }
  const double f = center_ + (idx - dc) * binw;
  const long long freq = (long long)std::llround(f / CC_RASTER_HZ) * (long long)CC_RASTER_HZ;
  if (auto it = cooldown_.find(freq); it != cooldown_.end() && now < it->second) return std::nullopt;
  if (pending_ && pending_->first == freq) pending_->second++;
  else pending_ = std::make_pair(freq, 1);
  if (pending_->second < CC_CONFIRM) return std::nullopt;
  pending_.reset();
  cooldown_[freq] = now + CC_COOLDOWN_S;
  return freq;
}
}  // namespace kc
