// Squelch + speaker arbitration: port of wideband_helper.py poll()/tune()/skip()/alert_unmute(),
// decided every POLL_MS on the DSP thread. Emits protocol events through `emit`.
#pragma once
#include <functional>
#include <nlohmann/json.hpp>
#include <optional>
#include <string>
#include <vector>

#include "constants.hpp"
#include "protocol.hpp"

namespace kc {
struct LaneReading {
  float fast_db = -200, slow_db = -200, quiet_db = 200;
  bool quiet_ready = false;
};

struct LaneState {
  std::string id;  // empty = parked
  double freq_hz = 0;
  bool priority = false, am = false, allow_audio = true, audible_cfg = true, background = false;
  std::optional<double> open_db, hang_ms;
  double alert_until = -1;
  std::optional<double> floor_db;
  bool open = false, carrier = false, quiet = false;
  int above = 0;
  int warmup_polls = 0;   // GR-style integer poll countdown, not a wall-clock timer
  double below_since = -1, skip_until = 0;
  std::vector<float> rf;
  bool parked() const { return id.empty(); }
};

class Scanner {
 public:
  struct Params {
    double open_db = 9.0;
    double quiet_db = QUIET_DB_DEFAULT;
    double hang_ms = 2000.0;
  };
  using Emit = std::function<void(const nlohmann::json&)>;
  Scanner(Params p, Emit emit);

  void tune(double center_hz, std::vector<ChannelCmd> channels, bool monitor);
  void poll(double now, const std::vector<LaneReading>& r);
  long long skip(double holdoff_s, double now);
  void alert_unmute(const std::string& id, double hold_s, double now);
  int assign_cc(long long freq_hz);

  int audible() const { return audible_; }
  float gate() const { return gate_; }   // 1 = speaker open, 0 = closed (loudness is the AGC's job)
  bool monitor() const { return monitor_; }
  const LaneState& lane(int i) const { return lanes_[i]; }
  std::vector<double> assigned_freqs() const;
  nlohmann::json power_levels(const std::vector<LaneReading>& r) const;
  nlohmann::json noise_levels(const std::vector<LaneReading>& r) const;

 private:
  void assign(int i, const ChannelCmd& c);
  void park(int i) { lanes_[i] = LaneState{}; }
  void set_audible(int i);
  int next_open() const;
  void flush_rf(LaneState& L);

  Params p_;
  Emit emit_;
  std::vector<LaneState> lanes_;
  int audible_ = -1;
  float gate_ = 0;
  bool monitor_ = false;
};
}  // namespace kc
