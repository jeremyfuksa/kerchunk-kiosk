#include "scanner.hpp"

#include <algorithm>
#include <cmath>

namespace kc {
using nlohmann::json;

Scanner::Scanner(Params p, Emit emit) : p_(p), emit_(std::move(emit)), lanes_(MAX_LANES) {}

void Scanner::assign(int i, const ChannelCmd& c) {
  LaneState L;
  L.id = c.id;
  L.freq_hz = c.freq_hz;
  L.priority = c.priority;
  L.am = c.mode == "am";
  L.allow_audio = L.audible_cfg = c.audible;
  L.background = c.background;
  L.open_db = c.open_db;
  L.hang_ms = c.hang_ms;
  L.level_db = L.level_emitted = c.level_db;
  L.warmup_polls = (int)WARMUP_MS / POLL_MS;
  lanes_[i] = std::move(L);
}

void Scanner::tune(double center_hz, std::vector<ChannelCmd> channels, bool monitor) {
  // Close every open lane BEFORE the tuned ack: an open already in flight must not leave a stale
  // id in Node's open set with no close ever following (the scanner would park forever).
  for (auto& L : lanes_)
    if (!L.parked() && L.open) emit_({{"ev", "close"}, {"id", L.id}});
  const int n = MAX_LANES;
  if ((int)channels.size() > n) {
    emit_({{"ev", "log"}, {"msg", "group truncated to " + std::to_string(n) + " channels"}});
    channels.resize(n);
  }
  monitor_ = monitor;
  set_audible(-1);
  std::vector<ChannelCmd> bgs, regs;
  for (auto& c : channels) (c.background ? bgs : regs).push_back(c);
  if (!bgs.empty() && (int)regs.size() > n - 1) regs.resize(n - 1);   // the SAME slot is spoken for
  for (int i = 0; i < n; i++) {
    const ChannelCmd* c = nullptr;
    if (i == n - 1 && !bgs.empty()) c = &bgs[0];
    else if (i < (int)regs.size()) c = &regs[i];
    if (c) assign(i, *c); else park(i);
  }
  emit_({{"ev", "tuned"}, {"centerHz", num(center_hz)}});
  if (monitor) {
    // Weather-only: the operator chose this channel; hold it open and audible with no squelch.
    for (int i = 0; i < n; i++) {
      if (lanes_[i].parked()) continue;
      LaneState& L = lanes_[i];
      L.open = L.carrier = L.quiet = true;
      emit_({{"ev", "open"}, {"id", L.id}, {"db", 0}});
      set_audible(i);
      gate_ = level_gain(L);
      break;
    }
  }
}

void Scanner::set_audible(int i) {
  if (audible_ == i) return;
  audible_ = i;
  // Gate follows carrier, not just audibility: an open lane riding its hang time must not blast noise.
  gate_ = (i >= 0 && lanes_[i].carrier) ? level_gain(lanes_[i]) : 0.f;
  if (i >= 0) emit_({{"ev", "audible"}, {"id", lanes_[i].id}});
  else emit_({{"ev", "audible"}, {"id", nullptr}});
}

int Scanner::next_open() const {
  int best = -1;
  for (int i = 0; i < (int)lanes_.size(); i++) {
    const LaneState& L = lanes_[i];
    if (!L.parked() && L.open && L.allow_audio) {
      if (L.priority) return i;
      if (best < 0) best = i;
    }
  }
  return best;
}

float Scanner::level_gain(const LaneState& L) { return (float)std::pow(10.0, L.level_db / 20.0); }

void Scanner::level(LaneState& L, float speech_db) {
  if (speech_db <= LEVEL_MIN_DB) return;   // pause/silence: hold gain
  L.speech_db = L.speech_db ? *L.speech_db + LEVEL_EMA_ALPHA * (speech_db - *L.speech_db) : (double)speech_db;
  double desired = std::clamp((LEVEL_REF_DB - *L.speech_db) / 2, -LEVEL_MAX_DB, LEVEL_MAX_DB);
  double err = desired - L.level_db;
  if (std::fabs(err) > LEVEL_DEADBAND_DB) L.level_db += std::clamp(err, -LEVEL_SLEW_DOWN, LEVEL_SLEW_UP);
  if (std::fabs(L.level_db - L.level_emitted) >= LEVEL_EMIT_STEP_DB) {
    L.level_emitted = L.level_db;
    emit_({{"ev", "level"}, {"id", L.id}, {"db", round1(L.level_db)}});
  }
}

void Scanner::flush_rf(LaneState& L) {
  const int n = (int)L.rf.size();
  if (n >= RF_MIN_SAMPLES && L.id.rfind("cc_", 0) != 0) {
    std::vector<float> s = L.rf;
    std::nth_element(s.begin(), s.begin() + n / 2, s.end());
    emit_({{"ev", "rf"}, {"id", L.id}, {"db", round1(s[n / 2])}, {"n", n}});
  }
  L.rf.clear();
}

void Scanner::poll(double now, const std::vector<LaneReading>& r, float speech_db) {
  if (monitor_) return;
  if (r.size() != lanes_.size()) return;   // malformed reading vector: skip this poll, don't crash
  const int n = (int)lanes_.size();
  std::vector<std::optional<double>> rd(n);
  for (int i = 0; i < n; i++) {
    LaneState& L = lanes_[i];
    if (L.parked()) continue;
    const double db = r[i].slow_db;
    if (L.warmup_polls > 0) {
      if (--L.warmup_polls == 0) L.floor_db = db;   // first trusted reading seeds the floor
      continue;
    }
    rd[i] = db;
    if (!L.floor_db) L.floor_db = db;
    else if (!L.open) *L.floor_db += (db > *L.floor_db ? FLOOR_ALPHA_UP : FLOOR_ALPHA_DOWN) * (db - *L.floor_db);
  }
  std::optional<double> floor;
  for (const auto& L : lanes_)
    if (!L.parked() && L.floor_db) floor = floor ? std::min(*floor, *L.floor_db) : *L.floor_db;
  if (!floor) return;

  for (int i = 0; i < n; i++) {
    LaneState& L = lanes_[i];
    if (L.parked() || !rd[i] || L.background) continue;
    const double open_db = L.open_db.value_or(p_.open_db);
    const double quiet_db = p_.quiet_db;   // decision C: per-channel (GR-scale) quietDb ignored
    const double hang_s = L.hang_ms.value_or(p_.hang_ms) / 1000.0;
    if (L.alert_until >= 0 && now >= L.alert_until) {
      L.alert_until = -1;
      L.allow_audio = L.audible_cfg;
      if (!L.allow_audio && audible_ == i) {
        gate_ = 0;
        set_audible(next_open());
      }
    }
    const double db = *rd[i];
    if (L.open && (int)L.rf.size() < RF_MAX_SAMPLES) L.rf.push_back((float)db);

    const double gate_thresh = *floor + open_db - CLOSE_HYST_DB;
    const double fast = r[i].fast_db;
    L.carrier = L.carrier ? fast > gate_thresh - GATE_HYST_DB / 2 : fast > gate_thresh + GATE_HYST_DB / 2;
    if (!r[i].quiet_ready) L.quiet = false;
    else L.quiet = L.quiet ? r[i].quiet_db < quiet_db + QUIET_HYST_DB / 2 : r[i].quiet_db < quiet_db - QUIET_HYST_DB / 2;
    if (audible_ == i) {
      const bool open_now = L.carrier && L.quiet;
      if (open_now) level(L, speech_db);
      gate_ = open_now ? level_gain(L) : 0.f;
    }

    if (!L.open) {
      if (db > *floor + open_db && L.quiet && now >= L.skip_until) {
        if (++L.above >= OPEN_POLLS) {
          L.open = true;
          L.below_since = -1;
          emit_({{"ev", "open"}, {"id", L.id}, {"db", round1(db)}});
          if (!L.allow_audio) {
            // see-only: report, never speak
          } else if (audible_ < 0) {
            set_audible(i);
          } else if (L.priority && !lanes_[audible_].priority) {
            set_audible(i);
          }
        }
      } else {
        L.above = 0;
      }
    } else if (db < *floor + open_db - CLOSE_HYST_DB) {
      if (L.below_since < 0) L.below_since = now;
      else if (now - L.below_since >= hang_s) {
        L.open = false;
        L.above = 0;
        L.below_since = -1;
        flush_rf(L);
        emit_({{"ev", "close"}, {"id", L.id}});
        if (audible_ == i) set_audible(next_open());
        if (L.id.rfind("cc_", 0) == 0) park(i);   // discovery over: free the slot
      }
    } else {
      L.below_since = -1;
    }
  }
}

long long Scanner::skip(double holdoff_s, double now) {
  const int i = audible_;
  if (i < 0) return 0;
  LaneState& L = lanes_[i];
  const std::string id = L.id;
  L.open = false;
  L.above = 0;
  L.below_since = -1;
  flush_rf(L);
  emit_({{"ev", "close"}, {"id", id}});
  set_audible(next_open());
  if (id.rfind("cc_", 0) == 0) {
    park(i);
    try { return std::stoll(id.substr(3)); } catch (...) { return 0; }
  }
  L.skip_until = now + holdoff_s;
  return 0;
}

void Scanner::alert_unmute(const std::string& id, double hold_s, double now) {
  for (int i = 0; i < (int)lanes_.size(); i++) {
    LaneState& L = lanes_[i];
    if (L.parked() || L.id != id) continue;
    L.allow_audio = true;
    L.alert_until = now + hold_s;
    if (L.open && audible_ != i) set_audible(i);
    break;
  }
}

int Scanner::assign_cc(long long freq_hz) {
  for (int i = 0; i < (int)lanes_.size(); i++) {
    if (!lanes_[i].parked()) continue;
    ChannelCmd c;
    c.id = "cc_" + std::to_string(freq_hz);
    c.freq_hz = (double)freq_hz;
    c.priority = true;   // a live Close Call hit preempts
    assign(i, c);
    return i;
  }
  return -1;
}

std::vector<double> Scanner::assigned_freqs() const {
  std::vector<double> out;
  for (const auto& L : lanes_) if (!L.parked()) out.push_back(L.freq_hz);
  return out;
}

json Scanner::power_levels(const std::vector<LaneReading>& r) const {
  json o = json::object();
  for (int i = 0; i < (int)lanes_.size(); i++) if (!lanes_[i].parked()) o[lanes_[i].id] = round1(r[i].slow_db);
  return o;
}

json Scanner::noise_levels(const std::vector<LaneReading>& r) const {
  json o = json::object();
  for (int i = 0; i < (int)lanes_.size(); i++) if (!lanes_[i].parked()) o[lanes_[i].id] = round1(r[i].quiet_db);
  return o;
}
}  // namespace kc
