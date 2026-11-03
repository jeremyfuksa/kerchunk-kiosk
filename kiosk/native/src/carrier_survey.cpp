#include "carrier_survey.hpp"

#include <algorithm>
#include <cmath>
#include <map>

#include "iq_rate.hpp"

namespace kc {

CarrierSurvey::CarrierSurvey(int rate)
    : rate_(rate), every_(rate / CC_FPS), since_(rate / CC_FPS), win_(CC_FFT), acc_(CC_FFT, 0.f) {
  for (int i = 0; i < CC_FFT; i++) {
    const double r = 2 * M_PI * i / (CC_FFT - 1);
    win_[i] = (float)(0.35875 - 0.48829 * std::cos(r) + 0.14128 * std::cos(2 * r) - 0.01168 * std::cos(3 * r));
  }
  in_.reset(fftwf_alloc_complex(CC_FFT));
  out_.reset(fftwf_alloc_complex(CC_FFT));
  plan_.reset(fftwf_plan_dft_1d(CC_FFT, in_.get(), out_.get(), FFTW_FORWARD, FFTW_MEASURE));
}

void CarrierSurvey::reset(double center_hz) {
  center_ = center_hz;
  std::fill(acc_.begin(), acc_.end(), 0.f);
  frames_ = 0;
  fill_ = 0;
  since_ = every_;
}

void CarrierSurvey::push_raw(const cf* x, int n) {
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

std::vector<Carrier> CarrierSurvey::take(double min_db, double* floor_db_out) {
  std::vector<Carrier> found;
  if (frames_ == 0) return found;
  std::vector<double> db(CC_FFT);
  for (int k = 0; k < CC_FFT; k++) db[k] = 10 * std::log10(acc_[k] / frames_ + 1e-20);
  std::fill(acc_.begin(), acc_.end(), 0.f);
  frames_ = 0;

  std::vector<double> sorted = db;
  std::nth_element(sorted.begin(), sorted.begin() + CC_FFT / 2, sorted.end());
  const double floor = sorted[CC_FFT / 2];
  if (floor_db_out) *floor_db_out = floor;

  const double binw = (double)rate_ / CC_FFT;
  const int dc = CC_FFT / 2;
  const int span = std::min(dc - 1, (int)(SURVEY_USABLE_HZ / binw));
  const int dcw = (int)std::ceil(SURVEY_DC_GUARD_HZ / binw);
  const int peak_w = (int)std::lround(SURVEY_PEAK_HZ / binw);
  const int near_w = (int)std::lround(SURVEY_NEAR_HZ / binw);
  const double image_hz = IqRateConverter::IN_RATE - IqRateConverter::OUT_RATE;
  const int image_w = (int)std::lround(image_hz / binw);
  const int image_from = (int)((SURVEY_USABLE_HZ - image_hz) / binw);

  std::map<long long, double> best;   // one entry per raster channel
  for (int k = dc - span; k <= dc + span; k++) {
    if (std::abs(k - dc) <= dcw || db[k] - floor < min_db) continue;
    // A carrier is the top of its neighbourhood, so an AM station's sidebands don't count as stations.
    // Past SURVEY_NEAR_HZ a stronger station can be a neighbour on the raster, so there it takes a
    // line standing clear of what's around it: a modulation skirt is a smooth slope.
    bool top = true, beside_stronger = false;
    for (int j = std::max(0, k - peak_w); j <= std::min(CC_FFT - 1, k + peak_w) && top; j++) {
      if (std::abs(j - dc) <= dcw || db[j] <= db[k]) continue;   // the center spike isn't a neighbour
      if (std::abs(j - k) <= near_w) top = false;
      else beside_stronger = true;
    }
    if (!top) continue;
    if (beside_stronger) {
      bool line = true;
      for (const int j : {k - SURVEY_LINE_BINS, k + SURVEY_LINE_BINS})
        if (std::abs(j - dc) > dcw && db[k] - db[j] < SURVEY_LINE_DB) line = false;
      if (!line) continue;
    }
    // IqRateConverter's image of a carrier just past the span edge lands image_w inward, where the
    // filter is weakest. Further in, an image would take a carrier well over any seen so far.
    if (std::abs(k - dc) >= image_from) {
      const int out = k + (k > dc ? image_w : -image_w);
      if (std::max({db[out - 1], db[out], db[out + 1]}) - db[k] >= SURVEY_IMAGE_DB) continue;
    }
    const double hz = center_ + (k - dc) * binw;
    const long long snapped = std::llround(hz / SURVEY_RASTER_HZ) * (long long)SURVEY_RASTER_HZ;
    auto it = best.find(snapped);
    if (it == best.end() || db[k] - floor > it->second) best[snapped] = db[k] - floor;
  }
  found.reserve(best.size());
  for (const auto& b : best) found.push_back({b.first, b.second});
  return found;
}
}  // namespace kc
