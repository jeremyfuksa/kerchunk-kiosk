// Carrier survey: every station standing above the noise floor in the current window, on the
// shortwave broadcast raster. Runs beside the lanes on the raw window, like CloseCall, but it
// reports all of them and doesn't assign lanes or remember anything between windows.
#pragma once
#include <vector>

#include "channelizer.hpp"
#include "constants.hpp"

namespace kc {
struct Carrier {
  long long hz;
  double db_above_floor;
  double peak_hz = 0;    // where the peak really is; hz is snapped to the raster
  double steady_db = 0;  // power mean over log mean of that bin across the frames: about 0 for a
                         // steady carrier, 2.5 for noise, more for voice that comes and goes
};

class CarrierSurvey {
 public:
  explicit CarrierSurvey(int rate);
  void reset(double center_hz);
  void push_raw(const cf* x, int n);
  // Averages the frames since the last call, then clears them. Empty if there were none.
  std::vector<Carrier> take(double min_db, double* floor_db_out);

 private:
  int rate_;
  long every_, since_;
  int fill_ = 0, frames_ = 0;
  double center_ = 0;
  std::vector<float> win_, acc_, acc_log_;
  FftwBuf in_, out_;
  FftwPlanPtr plan_;
};
}  // namespace kc
