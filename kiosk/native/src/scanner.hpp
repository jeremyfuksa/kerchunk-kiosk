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
  std::optional<float> tone;   // CtcssDetector::tone() -- only fed on lanes Scanner::wants_tone()
};

struct LaneState {
  std::string id;  // empty = parked
  double freq_hz = 0;
  bool priority = false, am = false, allow_audio = true, audible_cfg = true, background = false;
  std::optional<double> open_db, hang_ms;
  std::optional<double> ctcss_hz;   // tone squelch (never set on AM / background lanes)
  double tone_seen = -1;            // last poll the configured tone matched (-1 = not this episode)
  bool tone_ok = true;              // tone present within CTCSS_LOSS_MS (always true without ctcss_hz)
  bool tone_reported = false;       // "tone" event already emitted for this open
  double alert_until = -1;
  std::optional<double> floor_db;
  bool open = false, carrier = false, quiet = false;
  int above = 0;
  int warmup_polls = 0;   // GR-style integer poll countdown, not a wall-clock timer
  double below_since = -1, skip_until = 0;
  std::vector<float> rf;
  bool parked() const { return id.empty(); }
};

// Squelch-calibration stats for one "carrier episode" on a lane: from the poll where power first
// exceeds floor+open_db until it drops below the close threshold (floor+open_db-CLOSE_HYST_DB), or
// the lane is skipped / retuned / parked. Instrumentation only -- never feeds a squelch decision.
// Sample buffers are reserved once (TX_MAX_SAMPLES) when the Scanner is built and reused via
// clear(), so the per-poll path never allocates.
struct TxEpisode {
  bool active = false;
  bool opened = false;   // the lane was open at some point during the episode
  int polls = 0;
  std::vector<float> quiet;   // quiet_db, only on quiet_ready polls
  std::vector<float> above;   // slow power minus the shared floor, every poll
};

class Scanner {
 public:
  struct Params {
    double open_db = 9.0;
    double quiet_db = QUIET_DB_DEFAULT;
    double hang_ms = 2000.0;
  };
  using Emit = std::function<void(const nlohmann::json&)>;
  // lanes: slot count, 1..MAX_LANES (throws std::invalid_argument otherwise).
  Scanner(Params p, Emit emit, int lanes = DEFAULT_LANES);

  void tune(double center_hz, std::vector<ChannelCmd> channels, bool monitor);
  void poll(double now, const std::vector<LaneReading>& r);
  long long skip(double holdoff_s, double now);
  void alert_unmute(const std::string& id, double hold_s, double now);
  int assign_cc(long long freq_hz);
  // Lane i needs its CTCSS detector fed: an FM, non-background, non-Close-Call lane that is open or
  // has a carrier episode in progress. Everything else leaves the detector idle (and reset).
  bool wants_tone(int i) const;

  int audible() const { return audible_; }
  float gate() const { return gate_; }   // 1 = speaker open, 0 = closed (loudness is the AGC's job)
  bool monitor() const { return monitor_; }
  const LaneState& lane(int i) const { return lanes_[i]; }
  int lanes() const { return (int)lanes_.size(); }
  std::vector<double> assigned_freqs() const;
  nlohmann::json power_levels(const std::vector<LaneReading>& r) const;
  nlohmann::json noise_levels(const std::vector<LaneReading>& r) const;

 private:
  void assign(int i, const ChannelCmd& c);
  void park(int i) { end_tx(i); lanes_[i] = LaneState{}; }
  // End lane i's carrier episode (if any) and emit its txstat, BEFORE the lane's id can change.
  // Rejected (never-opened) episodes shorter than OPEN_POLLS are dropped as noise blips.
  void end_tx(int i);
  void set_audible(int i);
  int next_open() const;
  void flush_rf(LaneState& L);

  Params p_;
  Emit emit_;
  std::vector<LaneState> lanes_;
  std::vector<TxEpisode> tx_;   // parallel to lanes_
  int audible_ = -1;
  float gate_ = 0;
  bool monitor_ = false;
};
}  // namespace kc
