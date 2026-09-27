#include <algorithm>
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
  std::vector<kc::LaneReading> r = std::vector<kc::LaneReading>(kc::DEFAULT_LANES);
  double t = 0;
  explicit Sim(kc::Scanner::Params p = {}) : s(p, [this](const nlohmann::json& e) { ev.push_back(e); }) {
    for (auto& x : r) x = {FLOOR, FLOOR, NOISY, true, {}};
  }
  void set(int i, float db, bool quiet) { r[i] = {db, db, quiet ? QUIET : NOISY, true, {}}; }
  void run(double seconds) {
    int n = (int)(seconds * 1000 / kc::POLL_MS + 0.5);
    for (int k = 0; k < n; k++) { t += kc::POLL_MS / 1000.0; s.poll(t, r); }
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
  CHECK(m.s.lane(kc::DEFAULT_LANES - 1).id == "nwr");
  CHECK(m.s.lane(2).parked());
}

TEST(scanner_truncates_oversize_group) {
  Sim m;
  std::vector<kc::ChannelCmd> v;
  for (int i = 0; i < 14; i++) v.push_back(ch("c" + std::to_string(i)));
  m.s.tune(146e6, v, false);
  CHECK(m.of("log").size() == 1);
  CHECK(m.s.lane(kc::DEFAULT_LANES - 1).id == "c11");
}

TEST(scanner_oversize_group_keeps_background_in_last_slot) {
  Sim m;
  std::vector<kc::ChannelCmd> v;
  for (int i = 0; i < 14; i++) v.push_back(ch("c" + std::to_string(i)));
  auto bg = ch("nwr"); bg.background = true;
  v.push_back(bg);   // listed last, past the slot count: must still land in the SAME slot
  m.s.tune(146e6, v, false);
  CHECK(m.of("log").size() == 1);
  CHECK(m.s.lane(kc::DEFAULT_LANES - 2).id == "c10");
  CHECK(m.s.lane(kc::DEFAULT_LANES - 1).id == "nwr");
}

TEST(scanner_lane_count_bounds) {
  auto nop = [](const nlohmann::json&) {};
  CHECK(kc::Scanner({}, nop).lanes() == kc::DEFAULT_LANES);
  CHECK(kc::Scanner({}, nop, kc::MAX_LANES).lanes() == kc::MAX_LANES);
  CHECK_THROWS(kc::Scanner({}, nop, 0));
  CHECK_THROWS(kc::Scanner({}, nop, kc::MAX_LANES + 1));
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
  m.ev.erase(std::remove_if(m.ev.begin(), m.ev.end(),
                            [](const nlohmann::json& e) { return e["ev"] == "txstat"; }),
             m.ev.end());   // the cut episode's txstat leads; see the txstat retune test
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
  m.set(kc::DEFAULT_LANES - 1, KEYED, true);
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

TEST(scanner_rf_events_and_unity_gate) {
  Sim m;
  m.s.tune(146e6, {ch("a")}, false);
  m.run(0.8);
  m.set(0, KEYED, true);
  m.run(3.0);
  CHECK(m.s.gate() == 1.0f);                      // gate is on/off only; loudness is the speaker AGC's
  CHECK(m.of("level").empty());                   // the per-channel leveler (and its event) is gone
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

// --- fix-round-1 additions ---------------------------------------------------------------

TEST(scanner_carrier_hysteresis) {
  Sim m;
  m.s.tune(146e6, {ch("a")}, false);
  m.run(0.8);
  m.set(0, KEYED, true);
  m.run(0.2);                                       // opens; becomes audible
  CHECK(m.s.audible() == 0);
  const double floor = *m.s.lane(0).floor_db;
  const double gate_thresh = floor + 9.0 - kc::CLOSE_HYST_DB;   // Params::open_db default is 9.0
  m.r[0].slow_db = KEYED;                           // keep the lane open regardless of fast probing
  m.r[0].quiet_db = QUIET;                          // keep quiet fixed true throughout: isolate carrier

  m.r[0].fast_db = (float)(gate_thresh + 0.6);       // above entry threshold: carrier on
  m.run(0.01);
  CHECK(m.s.gate() > 0.f);

  m.r[0].fast_db = (float)gate_thresh;               // inside +-0.5 hysteresis band: stays on
  m.run(0.01);
  CHECK(m.s.gate() > 0.f);

  m.r[0].fast_db = (float)(gate_thresh - 0.6);        // below exit threshold: carrier off
  m.run(0.01);
  CHECK(m.s.gate() == 0.0f);

  m.r[0].fast_db = (float)(gate_thresh + 0.6);        // re-entry from off
  m.run(0.01);
  CHECK(m.s.gate() > 0.f);
}

TEST(scanner_quiet_hysteresis) {
  Sim m;
  m.s.tune(146e6, {ch("a")}, false);
  m.run(0.8);
  m.set(0, KEYED, true);
  m.run(0.2);                                       // opens; becomes audible; quiet already true
  CHECK(m.s.audible() == 0);
  m.r[0].fast_db = KEYED;                           // keep carrier fixed true throughout: isolate quiet
  m.r[0].slow_db = KEYED;                           // keep the lane open

  m.r[0].quiet_db = NOISY;                          // force quiet false first (prev true -> upper thresh -5)
  m.run(0.01);
  CHECK(m.s.gate() == 0.0f);

  m.r[0].quiet_db = (float)kc::QUIET_DB_DEFAULT - 1.5f;   // below entry threshold (-7): enters quiet
  m.run(0.01);
  CHECK(m.s.gate() > 0.f);

  m.r[0].quiet_db = (float)kc::QUIET_DB_DEFAULT;          // inside +-1 band: stays quiet
  m.run(0.01);
  CHECK(m.s.gate() > 0.f);

  m.r[0].quiet_db = (float)kc::QUIET_DB_DEFAULT + 1.5f;   // above exit threshold (-5): drops
  m.run(0.01);
  CHECK(m.s.gate() == 0.0f);
}

TEST(scanner_per_channel_open_db_and_hang_ms_overrides) {
  Sim m;
  kc::ChannelCmd c;
  c.id = "a";
  c.freq_hz = 146e6;
  c.open_db = 20.0;
  c.hang_ms = 50.0;
  m.s.tune(146e6, {c}, false);
  m.run(0.8);                                        // floor learns towards FLOOR (~-60)
  m.set(0, FLOOR + 15, true);                         // +15 dB: below the 20 dB override, must not open
  m.run(0.2);
  CHECK(m.of("open").empty());
  m.set(0, FLOOR + 25, true);                         // +25 dB: above the override, opens
  m.run(0.2);
  CHECK(m.of("open").size() == 1);
  m.set(0, FLOOR, false);                             // drop well below close threshold
  m.run(0.08);                                        // 80 ms > the 50 ms override (default hang is 2000 ms)
  CHECK(m.of("close").size() == 1);
}

TEST(scanner_priority_handoff_on_close_to_only_open_lane) {
  Sim m;
  m.s.tune(146e6, {ch("a"), ch("p", true)}, false);
  m.run(0.8);
  m.set(1, KEYED, true);                              // key "p" first
  m.run(0.2);
  CHECK(m.s.audible() == 1);                           // takes the speaker (audible_ was -1)
  m.set(0, KEYED, true);                               // key "a" too
  m.run(0.2);
  CHECK(m.s.audible() == 1);                           // "p" (priority) keeps it over "a"
  m.set(1, FLOOR, false);                              // "p" drops
  m.run(2.1);                                          // default 2000 ms hang expires
  CHECK(m.of("close").size() == 1 && m.of("close")[0]["id"] == "p");
  CHECK(m.s.audible() == 0);                           // hands to "a", the only remaining open lane
}

TEST(scanner_next_open_prefers_priority_over_lower_index) {
  Sim m;
  auto z = ch("z", true);         // index 0: priority, opened first (takes the seat regardless)
  auto a = ch("a", false);        // index 1: non-priority, lower index than p
  auto p = ch("p", true);         // index 2: priority
  m.s.tune(146e6, {z, a, p}, false);
  m.run(0.8);
  m.set(0, KEYED, true);
  m.run(0.2);
  CHECK(m.s.audible() == 0);                           // z takes the seat (audible_ was -1)
  m.set(1, KEYED, true);
  m.run(0.2);
  CHECK(m.s.audible() == 0);                           // a (non-priority) can't preempt priority z
  m.set(2, KEYED, true);
  m.run(0.2);
  CHECK(m.s.audible() == 0);                           // p can't preempt: z is ALSO priority
  m.set(0, FLOOR, false);                              // z drops
  m.run(2.1);                                          // default hang expires
  CHECK(m.of("close").size() == 1 && m.of("close")[0]["id"] == "z");
  CHECK(m.s.audible() == 2);                           // next_open prefers open priority "p" over lower-index "a"
}

TEST(scanner_cc_lane_parks_on_natural_close) {
  Sim m;
  m.s.tune(146e6, {ch("a")}, false);
  m.run(0.8);
  int slot = m.s.assign_cc(146012500);
  CHECK(slot == 1);
  m.run(0.8);                                          // warmup for the cc lane
  m.set(1, KEYED, true);
  m.run(0.2);
  CHECK(!m.of("open").empty());
  m.set(1, FLOOR, false);
  m.run(2.1);                                           // default hang expires -> natural close, not skip()
  CHECK(!m.of("close").empty());
  CHECK(m.s.lane(1).parked());                          // parks itself on natural close
}

TEST(scanner_skip_holdoff_expires_and_reopens) {
  // Short holdoff (vs. skip_holdoff_and_cc_park's 10/300 s) so the idle "!open" window is short
  // enough that the floor-follower's drift toward the still-keyed reading doesn't itself defeat
  // the reopen (FLOOR_ALPHA_UP creeps the floor up whenever a lane is unopened and above it).
  Sim m;
  m.s.tune(146e6, {ch("a")}, false);
  m.run(0.8);
  m.set(0, KEYED, true);
  m.run(0.2);
  CHECK(m.of("open").size() == 1);
  CHECK(m.s.skip(0.2, m.t) == 0);
  CHECK(m.of("close").size() == 1);
  m.run(0.05);                                          // still inside the 0.2 s holdoff
  CHECK(m.of("open").size() == 1);                       // no reopen yet
  m.run(0.3);                                            // holdoff passed, still keyed -> reopens
  CHECK(m.of("open").size() == 2);
}

TEST(scanner_alert_expiry_leaves_other_audible_lane_unchanged) {
  Sim m;
  m.s.tune(146e6, {ch("a", true), ch("s", false, false)}, false);   // a: priority; s: see-only
  m.run(0.8);
  m.set(1, KEYED, true);
  m.run(0.2);
  CHECK(m.of("open").size() == 1);
  CHECK(m.s.audible() == -1);                           // s open but muted: no speaker yet
  m.s.alert_unmute("s", 1.0, m.t);
  CHECK(m.s.audible() == 1);                             // GR quirk: forces s audible since it's open
  m.set(0, KEYED, true);
  m.run(0.2);
  CHECK(m.s.audible() == 0);                              // priority "a" preempts non-priority "s" on open
  m.run(0.9);                                             // s's 1.0 s alert hold expires meanwhile
  CHECK(m.s.audible() == 0);                               // audible lane (a) untouched by the expiry
  CHECK(!m.s.lane(1).allow_audio);                         // s's configured mute silently restored
}

TEST(scanner_quiet_ready_false_blocks_open) {
  Sim m;
  m.s.tune(146e6, {ch("a")}, false);
  m.run(0.8);
  m.r[0] = {KEYED, KEYED, QUIET, false, {}};                   // high power, low quiet_db, but not ready
  m.run(1.0);
  CHECK(m.of("open").empty());
}

TEST(scanner_floor_frozen_while_open_then_reopens_at_same_level) {
  Sim m;
  m.s.tune(146e6, {ch("a")}, false);
  m.run(0.8);
  m.set(0, KEYED, true);
  m.run(3.0);                                              // long hold: floor must stay frozen while open
  m.set(0, FLOOR, false);
  m.run(2.1);                                               // hang expires, lane closes
  CHECK(m.of("close").size() == 1);
  m.run(0.3);
  m.set(0, KEYED, true);                                     // re-key at the same level as before
  m.run(0.2);
  CHECK(m.of("open").size() == 2);                            // reopens: floor didn't creep up to KEYED
}

TEST(scanner_rekey_inside_hang_no_extra_events) {
  kc::Scanner::Params p; p.hang_ms = 500;
  Sim m(p);
  m.s.tune(146e6, {ch("a")}, false);
  m.run(0.8);
  m.set(0, KEYED, true);
  m.run(0.2);
  CHECK(m.of("open").size() == 1);
  CHECK(m.s.gate() > 0.f);
  m.ev.clear();
  m.set(0, FLOOR, false);                                    // carrier drops
  m.run(0.1);                                                 // well inside the 500 ms hang
  CHECK(m.s.gate() == 0.0f);
  CHECK(m.of("close").empty());
  m.set(0, KEYED, true);                                      // re-keys before hang expires
  m.run(0.05);
  CHECK(m.of("open").empty());                                 // same open session, no re-open
  CHECK(m.of("close").empty());
  CHECK(m.of("audible").empty());                               // no re-announcement of audible
  CHECK(m.s.gate() > 0.f);                                       // gate follows carrier back up
}

// --- squelch-calibration txstat (instrumentation only) --------------------------------------

TEST(scanner_txstat_opened_carrier_emits_one_with_quantiles) {
  Sim m;
  m.s.tune(146e6, {ch("a")}, false);
  m.run(0.8);
  m.set(0, KEYED, true);
  m.run(0.5);
  CHECK(m.of("txstat").empty());                             // still in the episode
  m.set(0, FLOOR, false);
  m.run(0.01);                                               // drop below close threshold: episode ends
  auto tx = m.of("txstat");
  CHECK(tx.size() == 1);
  CHECK(m.of("close").empty());                              // ...long before the hang closes the lane
  const auto& e = tx[0];
  CHECK(e["id"] == "a" && e["mode"] == "fm" && e["opened"] == true);
  CHECK(e["polls"].get<int>() == 50);
  CHECK_NEAR(e["quietP10"].get<double>(), QUIET, 0.05);
  CHECK_NEAR(e["quietP50"].get<double>(), QUIET, 0.05);
  CHECK_NEAR(e["quietP90"].get<double>(), QUIET, 0.05);
  // ~2 dB under KEYED-FLOOR: the floor creeps up (FLOOR_ALPHA_UP) during the pre-open polls.
  CHECK(e["aboveFloorP50"].get<double>() > KEYED - FLOOR - 3 && e["aboveFloorP50"].get<double>() <= KEYED - FLOOR);
  m.run(2.5);
  CHECK(m.of("txstat").size() == 1);                         // hang + close add nothing
}

TEST(scanner_txstat_quantiles_spread) {
  Sim m;
  m.s.tune(146e6, {ch("a")}, false);
  m.run(0.8);
  for (int k = 0; k < 100; k++) {                            // quiet_db -30 .. -10.2, all quieted
    m.r[0] = {KEYED, KEYED, -30.f + 0.2f * (float)k, true, {}};
    m.run(0.01);
  }
  m.set(0, FLOOR, false);
  m.run(0.01);
  auto tx = m.of("txstat");
  CHECK(tx.size() == 1 && tx[0]["opened"] == true);
  const double p10 = tx[0]["quietP10"].get<double>(), p50 = tx[0]["quietP50"].get<double>(),
               p90 = tx[0]["quietP90"].get<double>();
  CHECK(p10 < p50 && p50 < p90);
  CHECK_NEAR(p10, -28.0, 0.25);
  CHECK_NEAR(p50, -20.0, 0.25);
  CHECK_NEAR(p90, -12.2, 0.25);
}

TEST(scanner_txstat_rejected_carrier_emits_opened_false) {
  Sim m;
  m.s.tune(146e6, {ch("a")}, false);
  m.run(0.8);
  m.set(0, KEYED, false);                                    // power, no quieting: never opens
  m.run(0.2);
  m.set(0, FLOOR, false);
  m.run(0.01);
  CHECK(m.of("open").empty());
  auto tx = m.of("txstat");
  CHECK(tx.size() == 1);
  CHECK(tx[0]["id"] == "a" && tx[0]["opened"] == false && tx[0]["polls"].get<int>() == 20);
  CHECK_NEAR(tx[0]["quietP50"].get<double>(), NOISY, 0.05);
}

TEST(scanner_txstat_short_blip_emits_nothing) {
  Sim m;
  m.s.tune(146e6, {ch("a")}, false);
  m.run(0.8);
  m.set(0, KEYED, false);
  m.run(0.05);                                               // 5 polls < OPEN_POLLS
  m.set(0, FLOOR, false);
  m.run(0.5);
  CHECK(m.of("txstat").empty());
}

TEST(scanner_txstat_omits_quiet_fields_without_ready_samples) {
  Sim m;
  m.s.tune(146e6, {ch("a")}, false);
  m.run(0.8);
  m.r[0] = {KEYED, KEYED, QUIET, false, {}};                     // power, quiet meter not ready
  m.run(0.2);
  m.set(0, FLOOR, false);
  m.run(0.01);
  auto tx = m.of("txstat");
  CHECK(tx.size() == 1 && tx[0]["opened"] == false);
  CHECK(!tx[0].contains("quietP50") && tx[0].contains("aboveFloorP50"));
}

// Retune policy: an in-flight episode is emitted under its OLD id at the very start of tune(),
// before any slot is reassigned; nothing carries the old id afterwards.
TEST(scanner_txstat_retune_emits_old_id_before_reassignment) {
  Sim m;
  m.s.tune(146e6, {ch("a")}, false);
  m.run(0.8);
  m.set(0, KEYED, true);
  m.run(0.3);
  m.ev.clear();
  m.s.tune(147e6, {ch("b")}, false);
  CHECK(!m.ev.empty() && m.ev[0]["ev"] == "txstat" && m.ev[0]["id"] == "a" && m.ev[0]["opened"] == true);
  m.set(0, FLOOR, false);
  m.run(0.8);                                                // "b" warms up on the reused slot
  CHECK(m.of("txstat").size() == 1);
  m.set(0, KEYED, true);
  m.run(0.3);
  m.set(0, FLOOR, false);
  m.run(0.01);
  auto tx = m.of("txstat");
  CHECK(tx.size() == 2);
  CHECK(tx.size() == 2 && tx[1]["id"] == "b");               // the new id's own episode, never "a" again
}

TEST(scanner_txstat_skip_ends_episode_and_holdoff_starts_none) {
  Sim m;
  m.s.tune(146e6, {ch("a")}, false);
  m.run(0.8);
  m.set(0, KEYED, true);
  m.run(0.3);
  m.s.skip(0.5, m.t);
  auto tx = m.of("txstat");
  CHECK(tx.size() == 1 && tx[0]["opened"] == true);
  m.set(0, KEYED, false);                                    // still keyed but noisy, inside holdoff
  m.run(0.3);
  m.set(0, FLOOR, false);
  m.run(0.01);
  CHECK(m.of("txstat").size() == 1);                         // no rejected episode during the holdoff
}

TEST(scanner_txstat_am_mode_and_background_excluded) {
  Sim m;
  auto am = ch("air"); am.mode = "am";
  auto bg = ch("nwr"); bg.background = true;
  m.s.tune(120e6, {am, bg}, false);
  m.run(0.8);
  m.set(0, KEYED, true);
  m.set(kc::DEFAULT_LANES - 1, KEYED, true);
  m.run(0.3);
  m.set(0, FLOOR, false);
  m.set(kc::DEFAULT_LANES - 1, FLOOR, false);
  m.run(0.01);
  auto tx = m.of("txstat");
  CHECK(tx.size() == 1 && tx[0]["id"] == "air" && tx[0]["mode"] == "am");
}

// ---- CTCSS tone squelch + tone reporting

namespace {
kc::ChannelCmd toned(const std::string& id, double hz) { auto c = ch(id); c.ctcss_hz = hz; return c; }
}  // namespace

TEST(scanner_ctcss_wrong_or_missing_tone_never_opens) {
  Sim m;
  m.s.tune(146e6, {toned("a", 100.0), toned("b", 100.0)}, false);
  m.run(0.8);
  CHECK(!m.s.wants_tone(0));                      // idle lane: detector not fed
  m.set(0, KEYED, true); m.r[0].tone = 123.0f;    // co-channel user on another tone
  m.set(1, KEYED, true);                          // carrier with no tone at all
  m.run(0.05);
  CHECK(m.s.wants_tone(0) && m.s.wants_tone(1));  // carrier episode: detector runs
  m.run(3.0);
  CHECK(m.of("open").empty());
  CHECK(m.of("tone").empty());                    // tone reports are for open lanes only
}

TEST(scanner_ctcss_right_tone_opens_and_reports_once) {
  Sim m;
  m.s.tune(146e6, {toned("a", 100.0)}, false);
  m.run(0.8);
  m.set(0, KEYED, true);
  m.run(0.5);                                     // detector still filling its window
  CHECK(m.of("open").empty());
  m.r[0].tone = 100.0f;
  m.run(0.09);
  CHECK(m.of("open").empty());                    // still needs OPEN_POLLS with the tone
  m.run(0.02);
  CHECK(m.of("open").size() == 1 && m.s.gate() > 0.5f);
  m.run(1.0);
  auto t = m.of("tone");
  CHECK(t.size() == 1 && t[0]["id"] == "a" && t[0]["ctcssHz"] == 100.0);
}

TEST(scanner_ctcss_tone_loss_mutes_after_loss_ms_and_returns) {
  Sim m;
  m.s.tune(146e6, {toned("a", 100.0)}, false);
  m.run(0.8);
  m.set(0, KEYED, true); m.r[0].tone = 100.0f;
  m.run(0.5);
  CHECK(m.s.gate() > 0.5f);
  m.r[0].tone.reset();                            // carrier stays, tone gone (interferer)
  m.run(kc::CTCSS_LOSS_MS / 1000.0 - 0.05);
  CHECK(m.s.gate() > 0.5f);                       // brief dropout rides through
  m.run(0.1);
  CHECK(m.s.gate() == 0.0f);                      // muted like lost quieting ...
  CHECK(m.of("close").empty());                   // ... but the lane stays open on power
  m.r[0].tone = 100.0f;
  m.run(0.01);
  CHECK(m.s.gate() > 0.5f);
}

TEST(scanner_untoned_channel_opens_exactly_as_before) {
  // The same scene with and without a detected tone: identical open/audible/close streams.
  auto scene = [](bool tone) {
    kc::Scanner::Params p; p.hang_ms = 500;
    Sim m(p);
    m.s.tune(146e6, {ch("a")}, false);
    m.run(0.8);
    m.set(0, KEYED, true);
    if (tone) m.r[0].tone = 88.5f;
    m.run(1.0);
    m.set(0, FLOOR, false);
    m.run(1.0);
    std::vector<nlohmann::json> out;
    for (auto& e : m.ev) if (e["ev"] != "tone") out.push_back(e);
    return std::make_pair(out, m.of("tone"));
  };
  auto [plain, none] = scene(false);
  auto [with, heard] = scene(true);
  CHECK(plain == with);
  CHECK(none.empty());
  CHECK(heard.size() == 1 && heard[0]["ctcssHz"] == 88.5);
}

TEST(scanner_ctcss_ignored_on_am_and_background_lanes) {
  Sim m;
  auto am = toned("air", 100.0); am.mode = "am";
  auto bg = toned("nwr", 100.0); bg.background = true;
  m.s.tune(120e6, {am, bg}, false);
  m.run(0.8);
  m.set(0, KEYED, true);
  m.set(kc::DEFAULT_LANES - 1, KEYED, true);
  m.run(0.3);
  CHECK(m.of("open").size() == 1);                // AM opens with no tone
  CHECK(!m.s.wants_tone(0) && !m.s.wants_tone(kc::DEFAULT_LANES - 1));
}

TEST(scanner_tone_reported_again_on_next_open) {
  kc::Scanner::Params p; p.hang_ms = 200;
  Sim m(p);
  m.s.tune(146e6, {ch("a")}, false);
  m.run(0.8);
  for (int k = 0; k < 2; k++) {
    m.set(0, KEYED, true); m.r[0].tone = 131.8f;
    m.run(0.5);
    m.set(0, FLOOR, false);
    m.run(0.5);
  }
  CHECK(m.of("open").size() == 2);
  CHECK(m.of("tone").size() == 2);
  CHECK(!m.s.wants_tone(0));                      // closed, no episode: detector idle again
}
