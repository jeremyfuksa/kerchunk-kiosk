// Close Call: a windowed full-window FFT; a sustained peak well above the median floor on a
// non-configured frequency is a nearby transmission. Port of wideband_helper.py close_call_check().
#pragma once
#include <map>
#include <optional>
#include <utility>
#include <vector>

#include "channelizer.hpp"
#include "constants.hpp"

namespace kc {
class CloseCall {
 public:
  explicit CloseCall(int rate);
  void reset(double center_hz);
  void set_known(std::vector<double> hz) { known_ = std::move(hz); }
  void set_db(double db) { db_ = db; }
  void push_raw(const cf* x, int n);
  std::optional<long long> check(double now, const std::vector<double>& assigned_hz);
  void cooldown(long long freq_hz, double until) { cooldown_[freq_hz] = until; }
  int frames_since_check() const { return frames_; }

 private:
  int rate_;
  long every_;
  long since_;
  int fill_ = 0, frames_ = 0;
  double center_ = 0, db_ = CC_DB_DEFAULT;
  std::vector<float> win_, acc_;
  std::vector<double> known_;
  FftwBuf in_, out_;
  FftwPlanPtr plan_;
  std::map<long long, double> cooldown_;
  std::optional<std::pair<long long, int>> pending_;
};
}  // namespace kc
