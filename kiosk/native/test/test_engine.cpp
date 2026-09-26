#include <algorithm>
#include <cmath>
#include <vector>

#include "check.hpp"
#include "engine.hpp"
#include "signals.hpp"

namespace {
constexpr int RATE = 250'000;
constexpr double CENTER = 146'000'000;

std::vector<uint8_t> to_u8(const std::vector<sig::cf>& x) {
  std::vector<uint8_t> iq(2 * x.size());
  for (size_t i = 0; i < x.size(); i++) {
    iq[2 * i] = (uint8_t)std::lround(std::clamp(x[i].real() * 127.5f + 127.5f, 0.f, 255.f));
    iq[2 * i + 1] = (uint8_t)std::lround(std::clamp(x[i].imag() * 127.5f + 127.5f, 0.f, 255.f));
  }
  return iq;
}

struct Rig {
  std::vector<nlohmann::json> ev;
  std::vector<int16_t> pcm, same_pcm;
  kc::Engine e;
  explicit Rig(kc::EngineOptions o)
      : e(o, [this](const nlohmann::json& j) { auto k = j; k["t"] = e.now(); ev.push_back(k); },
          [this](const int16_t* p, int n) { pcm.insert(pcm.end(), p, p + n); }, nullptr,
          [this](const int16_t* p, int n) { same_pcm.insert(same_pcm.end(), p, p + n); }) {}
  void cmd(const std::string& json) { tune(json); }
  void tune(const std::string& json) {
    std::string err;
    auto c = kc::parse_command(json, err);
    CHECK(c.has_value());
    if (c) e.command(*c);
  }
  void feed(const std::vector<sig::cf>& x) { feed(x, 0, 1e9); }
  // Feed x[t0*RATE, t1*RATE) in 10 ms slices (lets a test interleave commands with one continuous scene).
  void feed(const std::vector<sig::cf>& x, double t0, double t1) {
    auto iq = to_u8(x);
    const size_t a = (size_t)std::llround(t0 * RATE), b = std::min(x.size(), (size_t)std::llround(std::min(t1, 1e6) * RATE));
    const size_t slice = RATE / 100;
    for (size_t i = a; i < b; i += slice) e.push_u8(&iq[2 * i], std::min(slice, b - i));
  }
  std::vector<nlohmann::json> of(const std::string& type) const {
    std::vector<nlohmann::json> out;
    for (auto& j : ev) if (j["ev"] == type) out.push_back(j);
    return out;
  }
  double pcm_rms(double t0, double t1) const {
    size_t a = (size_t)(t0 * kc::AUDIO_RATE), b = std::min(pcm.size(), (size_t)(t1 * kc::AUDIO_RATE));
    double s = 0;
    for (size_t i = a; i < b; i++) s += (double)pcm[i] * pcm[i];
    return b > a ? std::sqrt(s / (b - a)) / 32767.0 : 0;
  }
};

const char* TWO_LANES =
    R"({"cmd":"tune","centerHz":146000000,"channels":[{"id":"a","freqHz":146050000,"hangMs":500},)"
    R"({"id":"b","freqHz":145940000}],"closeCall":false,"knownHz":[146050000,145940000]})";

std::vector<sig::cf> scene(double seconds, unsigned seed) { return sig::noise((size_t)(seconds * RATE), 0.01, seed); }

void burst_fm(std::vector<sig::cf>& x, double off, double t0, double t1) {
  auto fm = sig::fm_tone(RATE, x.size(), off, 3000, 1000, 0.2);
  for (size_t i = (size_t)(t0 * RATE); i < (size_t)(t1 * RATE) && i < x.size(); i++) x[i] += fm[i];
}
}  // namespace

TEST(engine_fm_burst_opens_speaks_mutes_and_closes) {
  kc::EngineOptions o; o.rate = RATE;
  Rig r(o);
  r.tune(TWO_LANES);
  auto x = scene(3.2, 1);
  burst_fm(x, 50'000, 1.0, 2.0);
  r.feed(x);
  CHECK(r.ev.front()["ev"] == "tuned");
  auto op = r.of("open");
  CHECK(op.size() == 1 && op[0]["id"] == "a");
  if (!op.empty()) { CHECK(op[0]["t"].get<double>() > 1.08); CHECK(op[0]["t"].get<double>() < 1.2); }
  auto cl = r.of("close");
  CHECK(cl.size() == 1);
  if (!cl.empty()) { CHECK(cl[0]["t"].get<double>() > 2.5); CHECK(cl[0]["t"].get<double>() < 2.75); }
  CHECK(r.of("audible").size() == 2);             // a, then null
  CHECK(r.pcm_rms(1.3, 1.9) > 0.05);              // speaking
  CHECK(r.pcm_rms(2.06, 2.5) < 1e-3);             // gate muted within ~30 ms of carrier drop
  CHECK(!r.of("power").empty());
  CHECK(std::abs((double)r.pcm.size() - 3.2 * kc::AUDIO_RATE) < 2 * kc::AUDIO_RATE / 100);
}

TEST(engine_unquieted_power_does_not_open) {
  kc::EngineOptions o; o.rate = RATE;
  Rig r(o);
  r.tune(TWO_LANES);
  auto x = scene(2.5, 2);
  auto hot = sig::noise(x.size(), 0.1, 3);
  for (size_t i = RATE; i < (size_t)(2 * RATE); i++) x[i] += hot[i];   // broadband junk, no carrier
  r.feed(x);
  CHECK(r.of("open").empty());
}

TEST(engine_close_call_discovers_and_listens) {
  kc::EngineOptions o; o.rate = RATE; o.close_call = true;
  Rig r(o);
  r.tune(R"({"cmd":"tune","centerHz":146000000,"channels":[{"id":"a","freqHz":146050000}],)"
         R"("closeCall":true,"closeCallDb":15,"knownHz":[146050000]})");
  auto x = scene(3.0, 4);
  auto c = sig::tone(RATE, x.size(), 87'500, 0.2);
  for (size_t i = (size_t)(0.6 * RATE); i < x.size(); i++) x[i] += c[i];
  r.feed(x);
  auto cc = r.of("closecall");
  CHECK(cc.size() == 1 && cc[0]["freqHz"] == 146087500);
  auto op = r.of("open");
  CHECK(!op.empty() && op.back()["id"] == "cc_146087500");
}

TEST(engine_monitor_mode_and_retune_order) {
  kc::EngineOptions o; o.rate = RATE;
  Rig r(o);
  r.tune(R"({"cmd":"tune","centerHz":146000000,"channels":[{"id":"wx","freqHz":146050000}],"monitor":true})");
  CHECK(r.ev.size() >= 3 && r.ev[0]["ev"] == "tuned" && r.ev[1]["ev"] == "open" && r.ev[2]["ev"] == "audible");
  r.ev.clear();
  r.tune(TWO_LANES);
  CHECK(r.ev.size() >= 3 && r.ev[0]["ev"] == "close" && r.ev[1]["ev"] == "audible" && r.ev[2]["ev"] == "tuned");
}

TEST(engine_drops_out_of_window_channels_with_log) {
  kc::EngineOptions o; o.rate = RATE;
  Rig r(o);
  r.tune(R"({"cmd":"tune","centerHz":146000000,"channels":[{"id":"far","freqHz":147000000},{"id":"a","freqHz":146050000}]})");
  CHECK(!r.of("log").empty());
  CHECK(r.of("tuned").size() == 1);
}

namespace {
const char* CC_TUNE =
    R"({"cmd":"tune","centerHz":146000000,"channels":[{"id":"a","freqHz":146050000}],)"
    R"("closeCall":true,"closeCallDb":15,"knownHz":[146050000]})";

std::vector<sig::cf> cc_scene(double seconds, double t_on) {
  auto x = scene(seconds, 4);
  auto c = sig::tone(RATE, x.size(), 87'500, 0.2);
  for (size_t i = (size_t)(t_on * RATE); i < x.size(); i++) x[i] += c[i];
  return x;
}
}  // namespace

// Raster rounding pulls a hit toward the grid, so the out-of-window path needs an off-raster
// center: at 146 003 000 the last unmasked low bin (204, -100 097.7 Hz) rounds to 145 900 000,
// 103 kHz below center -- outside the +-100 kHz lane limit at 250 kHz.
TEST(engine_close_call_outside_lane_window_is_logged_and_ignored) {
  kc::EngineOptions o; o.rate = RATE; o.close_call = true;
  Rig r(o);
  r.tune(R"({"cmd":"tune","centerHz":146003000,"channels":[{"id":"a","freqHz":146050000}],)"
         R"("closeCall":true,"closeCallDb":15,"knownHz":[146050000]})");
  auto x = scene(2.5, 5);
  auto c = sig::tone(RATE, x.size(), (204 - 1024) * (double)RATE / kc::CC_FFT, 0.2);
  for (size_t i = (size_t)(0.3 * RATE); i < x.size(); i++) x[i] += c[i];
  r.feed(x);
  CHECK(r.of("closecall").empty());
  bool logged = false;
  for (auto& j : r.of("log")) logged = logged || j["msg"].get<std::string>().find("145900000") != std::string::npos;
  CHECK(logged);
  for (auto& j : r.of("open")) CHECK(j["id"].get<std::string>().rfind("cc_", 0) != 0);
}

TEST(engine_clock_counts_partial_hop_across_retune) {
  kc::EngineOptions o; o.rate = RATE;
  Rig r(o);
  r.tune(TWO_LANES);
  auto x = scene(0.01, 6);
  auto iq = to_u8(x);
  const size_t n = 1001;   // not a multiple of the 320-sample hop at 250 kHz
  r.e.push_u8(iq.data(), n);
  r.tune(TWO_LANES);
  CHECK(std::abs(r.e.now() - (double)n / RATE) < 1e-12);
  CHECK(std::abs(r.of("tuned").back()["t"].get<double>() - (double)n / RATE) < 1e-12);
}

TEST(engine_skip_cc_lane_cools_down_for_holdoff_then_refires) {
  kc::EngineOptions o; o.rate = RATE; o.close_call = true;
  Rig r(o);
  r.tune(CC_TUNE);
  auto x = cc_scene(5.0, 0.6);
  r.feed(x, 0, 2.0);
  CHECK(r.of("closecall").size() == 1);
  CHECK(!r.of("audible").empty() && r.of("audible").back()["id"] == "cc_146087500");
  r.cmd(R"({"cmd":"skip","holdoffS":1.5})");
  CHECK(r.of("audible").back()["id"].is_null());
  r.feed(x, 2.0, 3.4);
  CHECK(r.of("closecall").size() == 1);   // within the skip holdoff: no re-fire
  r.feed(x, 3.4, 5.0);
  auto cc = r.of("closecall");
  CHECK(cc.size() == 2);                  // holdoff over (the skip replaced the 300 s cooldown)
  if (cc.size() == 2) CHECK(cc[1]["t"].get<double>() > 3.5);
}

TEST(engine_known_command_suppresses_close_call) {
  kc::EngineOptions o; o.rate = RATE; o.close_call = true;
  Rig r(o);
  r.tune(CC_TUNE);
  auto x = cc_scene(3.0, 0.6);
  r.feed(x, 0, 0.5);
  r.cmd(R"({"cmd":"known","knownHz":[146050000,146087500]})");
  r.feed(x, 0.5, 3.0);
  CHECK(r.of("closecall").empty());
}

TEST(engine_alert_unmute_makes_see_only_lane_audible) {
  kc::EngineOptions o; o.rate = RATE;
  Rig r(o);
  r.tune(R"({"cmd":"tune","centerHz":146000000,"channels":[{"id":"a","freqHz":146050000,"audible":false}]})");
  auto x = scene(2.5, 7);
  burst_fm(x, 50'000, 1.0, 2.5);
  r.feed(x, 0, 1.5);
  CHECK(r.of("open").size() == 1);
  CHECK(r.of("audible").empty());
  CHECK(r.pcm_rms(1.2, 1.5) < 1e-3);
  r.cmd(R"({"cmd":"alert_unmute","id":"a","holdS":30})");
  auto au = r.of("audible");
  CHECK(au.size() == 1 && au[0]["id"] == "a");
  r.feed(x, 1.5, 2.5);
  CHECK(r.pcm_rms(1.7, 2.4) > 0.05);
}

TEST(engine_quit_command_sets_quit) {
  kc::EngineOptions o; o.rate = RATE;
  Rig r(o);
  CHECK(!r.e.quit());
  r.cmd(R"({"cmd":"quit"})");
  CHECK(r.e.quit());
}

TEST(engine_same_pcm_only_for_background_lane_when_enabled) {
  const char* BG = R"({"cmd":"tune","centerHz":146000000,"channels":[{"id":"a","freqHz":146050000},)"
                   R"({"id":"wx","freqHz":145940000,"background":true}]})";
  auto x = scene(2.0, 8);
  burst_fm(x, -60'000, 0.0, 2.0);
  {
    kc::EngineOptions o; o.rate = RATE; o.same = true;
    Rig r(o);
    r.tune(BG);
    r.feed(x);
    CHECK(std::abs((double)r.same_pcm.size() - 2.0 * kc::SAME_RATE) < kc::SAME_RATE / 50.0);
    double s = 0;
    for (auto v : r.same_pcm) s += (double)v * v;
    CHECK(!r.same_pcm.empty() && std::sqrt(s / (double)r.same_pcm.size()) > 100);   // the tone got through
  }
  {
    kc::EngineOptions o; o.rate = RATE;   // same disabled
    Rig r(o);
    r.tune(BG);
    r.feed(x);
    CHECK(r.same_pcm.empty());
  }
  {
    kc::EngineOptions o; o.rate = RATE; o.same = true;   // enabled, but no background lane
    Rig r(o);
    r.tune(TWO_LANES);
    r.feed(x);
    CHECK(r.same_pcm.empty());
  }
}
