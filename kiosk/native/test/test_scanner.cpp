#include <vector>

#include "check.hpp"
#include "constants.hpp"
#include "scanner.hpp"

namespace {
constexpr float FLOOR = -60, KEYED = -40;
const float QUIET = (float)kc::QUIET_DB_DEFAULT - 10, NOISY = (float)kc::QUIET_DB_DEFAULT + 10;

struct Sim {
  std::vector<nlohmann::json> ev;
  kc::Scanner s;
  std::vector<kc::LaneReading> r = std::vector<kc::LaneReading>(kc::MAX_LANES);
  double t = 0;
  float speech = -200;
  explicit Sim(kc::Scanner::Params p = {}) : s(p, [this](const nlohmann::json& e) { ev.push_back(e); }) {
    for (auto& x : r) x = {FLOOR, FLOOR, NOISY, true};
  }
  void set(int i, float db, bool quiet) { r[i] = {db, db, quiet ? QUIET : NOISY, true}; }
  void run(double seconds) {
    int n = (int)(seconds * 1000 / kc::POLL_MS + 0.5);
    for (int k = 0; k < n; k++) { t += kc::POLL_MS / 1000.0; s.poll(t, r, speech); }
  }
  std::vector<nlohmann::json> of(const std::string& type) const {
    std::vector<nlohmann::json> out;
    for (auto& e : ev) if (e["ev"] == type) out.push_back(e);
    return out;
  }
};

kc::ChannelCmd ch(const std::string& id, bool priority = false, bool audible = true) {
  kc::ChannelCmd c; c.id = id; c.freq_hz = 146e6; c.priority = priority; c.audible = audible; return c;
}
}  // namespace

TEST(scanner_tune_emits_tuned_and_slots) {
  Sim m;
  auto bg = ch("nwr"); bg.background = true;
  m.s.tune(146e6, {ch("a"), bg, ch("b")}, false);
  CHECK(m.of("tuned").size() == 1);
  CHECK(m.s.lane(0).id == "a" && m.s.lane(1).id == "b");
  CHECK(m.s.lane(kc::MAX_LANES - 1).id == "nwr");
  CHECK(m.s.lane(2).parked());
}

TEST(scanner_truncates_oversize_group) {
  Sim m;
  std::vector<kc::ChannelCmd> v;
  for (int i = 0; i < 14; i++) v.push_back(ch("c" + std::to_string(i)));
  m.s.tune(146e6, v, false);
  CHECK(m.of("log").size() == 1);
  CHECK(m.s.lane(kc::MAX_LANES - 1).id == "c11");
}

TEST(scanner_no_open_during_warmup_then_opens_after_100ms) {
  Sim m;
  m.s.tune(146e6, {ch("a")}, false);
  m.set(0, KEYED, true);
  m.run(0.45);
  CHECK(m.of("open").empty());                    // still warming up (500 ms)
  m.set(0, FLOOR, false);
  m.run(0.3);                                     // floor learned
  m.set(0, KEYED, true);
  m.run(0.09);
  CHECK(m.of("open").empty());                    // 9 polls: not yet
  m.run(0.02);
  CHECK(m.of("open").size() == 1);
  CHECK(m.of("audible").back()["id"] == "a");
  CHECK(m.s.gate() > 0.5f);
}

TEST(scanner_power_without_quieting_never_opens) {
  Sim m;
  m.s.tune(146e6, {ch("a")}, false);
  m.run(0.8);
  m.set(0, KEYED, false);
  m.run(1.0);
  CHECK(m.of("open").empty());
}

TEST(scanner_gate_follows_carrier_then_close_after_hang) {
  kc::Scanner::Params p; p.hang_ms = 500;
  Sim m(p);
  m.s.tune(146e6, {ch("a")}, false);
  m.run(0.8);
  m.set(0, KEYED, true);
  m.run(0.5);
  CHECK(m.s.gate() > 0);
  m.set(0, FLOOR, false);
  m.run(0.01);
  CHECK(m.s.gate() == 0.0f);                      // muted within one poll of carrier drop
  CHECK(m.of("close").empty());                   // still in hang
  m.run(0.6);
  CHECK(m.of("close").size() == 1);
  CHECK(m.of("audible").back()["id"].is_null());
}

TEST(scanner_priority_takes_speaker) {
  Sim m;
  m.s.tune(146e6, {ch("a"), ch("p", true)}, false);
  m.run(0.8);
  m.set(0, KEYED, true);
  m.run(0.2);
  CHECK(m.s.audible() == 0);
  m.set(1, KEYED, true);
  m.run(0.2);
  CHECK(m.s.audible() == 1);
}

TEST(scanner_see_only_and_alert_unmute) {
  Sim m;
  m.s.tune(146e6, {ch("s", false, false)}, false);
  m.run(0.8);
  m.set(0, KEYED, true);
  m.run(0.2);
  CHECK(m.of("open").size() == 1);
  CHECK(m.s.audible() == -1);                     // see-only: never speaks
  m.s.alert_unmute("s", 1.0, m.t);
  CHECK(m.s.audible() == 0);
  m.run(1.1);
  CHECK(m.s.audible() == -1);                     // hold expired: configured mute restored
}

TEST(scanner_skip_holdoff_and_cc_park) {
  Sim m;
  m.s.tune(146e6, {ch("a")}, false);
  m.run(0.8);
  m.set(0, KEYED, true);
  m.run(0.2);
  CHECK(m.s.skip(10, m.t) == 0);
  CHECK(m.of("close").size() == 1);
  m.run(1.0);
  CHECK(m.of("open").size() == 1);                // holdoff: no reopen
  int slot = m.s.assign_cc(146012500);
  CHECK(slot == 1);
  CHECK(m.s.lane(1).id == "cc_146012500" && m.s.lane(1).priority);
  m.run(0.8);
  m.set(1, KEYED, true);
  m.run(0.2);
  CHECK(m.s.audible() == 1);                      // cc lane is priority
  CHECK(m.s.skip(300, m.t) == 146012500);
  CHECK(m.s.lane(1).parked());
}

TEST(scanner_tune_closes_open_lanes_before_tuned) {
  Sim m;
  m.s.tune(146e6, {ch("a")}, false);
  m.run(0.8);
  m.set(0, KEYED, true);
  m.run(0.2);
  m.ev.clear();
  m.s.tune(147e6, {ch("b")}, false);
  CHECK(m.ev.size() >= 3);
  CHECK(m.ev[0]["ev"] == "close" && m.ev[0]["id"] == "a");
  CHECK(m.ev[1]["ev"] == "audible" && m.ev[1]["id"].is_null());
  CHECK(m.ev[2]["ev"] == "tuned");
}

TEST(scanner_background_lane_never_opens) {
  Sim m;
  auto bg = ch("nwr"); bg.background = true;
  m.s.tune(162e6, {bg}, false);
  m.run(0.8);
  m.set(kc::MAX_LANES - 1, KEYED, true);
  m.run(1.0);
  CHECK(m.of("open").empty());
}

TEST(scanner_monitor_mode_opens_immediately) {
  Sim m;
  m.s.tune(162e6, {ch("wx")}, true);
  auto o = m.of("open");
  CHECK(o.size() == 1 && o[0]["db"] == 0);
  CHECK(m.s.audible() == 0 && m.s.gate() > 0);
  m.run(1.0);
  CHECK(m.of("close").empty());                   // no squelch in monitor mode
}

TEST(scanner_rf_and_level_events) {
  Sim m;
  m.s.tune(146e6, {ch("a")}, false);
  m.run(0.8);
  m.set(0, KEYED, true);
  m.speech = -2;                                  // loud talker: leveler should pull gain down
  m.run(3.0);
  CHECK(!m.of("level").empty());
  CHECK(m.of("level").back()["db"].get<double>() < 0);
  m.set(0, FLOOR, false);
  m.run(2.5);
  auto rf = m.of("rf");
  CHECK(rf.size() == 1 && rf[0]["n"].get<int>() >= kc::RF_MIN_SAMPLES);
  CHECK_NEAR(rf[0]["db"].get<double>(), KEYED, 0.2);
}

TEST(scanner_power_and_noise_levels) {
  Sim m;
  m.s.tune(146e6, {ch("a")}, false);
  auto p = m.s.power_levels(m.r);
  CHECK(p.contains("a") && !p.contains(""));
  CHECK(m.s.noise_levels(m.r).contains("a"));
}
