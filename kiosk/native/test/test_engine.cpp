#include <algorithm>
#include <cmath>
#include <cstdio>
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

// Skipping an audible Close Call lane parks its slot at once; the speaker must still fade the
// parked lane's real audio out (not zeros) or the skip is a hard cut -- an audible click.
TEST(engine_skip_audible_cc_lane_fades_without_click) {
  kc::EngineOptions o; o.rate = RATE; o.close_call = true;
  Rig r(o);
  r.tune(CC_TUNE);
  auto x = scene(3.0, 9);
  auto fm = sig::fm_tone(RATE, x.size(), 87'500, 3000, 1000, 0.2);
  for (size_t i = (size_t)(0.6 * RATE); i < x.size(); i++) x[i] += fm[i];
  r.feed(x, 0, 2.0);
  CHECK(r.of("closecall").size() == 1);
  CHECK(!r.of("audible").empty() && r.of("audible").back()["id"] == "cc_146087500");
  // Cut on a loud sample: advance in single hops until the last emitted sample is well off zero.
  auto iq = to_u8(x);
  size_t pos = (size_t)(2.0 * RATE);
  const size_t hop = RATE / kc::LANE_RATE * kc::Channelizer::kLaneSamplesPerHop;
  while (!r.pcm.empty() && std::abs(r.pcm.back()) < 3000 && pos + hop < (size_t)(2.5 * RATE)) {
    r.e.push_u8(&iq[2 * pos], hop);
    pos += hop;
  }
  const size_t n0 = r.pcm.size();
  CHECK(n0 > 4800 && std::abs(r.pcm.back()) >= 3000);
  int steady = 0;
  for (size_t i = n0 - 4800; i < n0; i++) steady = std::max(steady, std::abs(r.pcm[i] - r.pcm[i - 1]));
  r.cmd(R"({"cmd":"skip","holdoffS":10})");
  CHECK(r.of("audible").back()["id"].is_null());
  r.feed(x, (double)pos / RATE, 3.0);
  CHECK(r.pcm.size() > n0 + 4800);
  int across = 0;
  for (size_t i = n0; i < n0 + kc::FADE_SAMPLES + 64 && i < r.pcm.size(); i++)
    across = std::max(across, std::abs(r.pcm[i] - r.pcm[i - 1]));
  std::printf("  skip: steady max|d|=%d across-skip max|d|=%d last=%d\n", steady, across, (int)r.pcm[n0 - 1]);
  CHECK(steady > 0 && across <= 2 * steady);
  // Silent within the fade plus one hop of audio, and it stays silent.
  bool zero = true;
  for (size_t i = n0 + kc::FADE_SAMPLES + 64; i < r.pcm.size(); i++) zero = zero && r.pcm[i] == 0;
  CHECK(zero);
}

namespace {
// `regs` channels spread from -90 kHz over span_hz (the +-90 kHz usable window at RATE by default),
// plus an optional background channel appended last.
std::string many_channels(int regs, bool bg, long long span_hz = 180'000) {
  std::string s = R"({"cmd":"tune","centerHz":146000000,"channels":[)";
  for (int i = 0; i < regs; i++) {
    const long long f = 146'000'000LL - 90'000 + (long long)i * span_hz / std::max(1, regs - 1);
    s += (i ? "," : "") + std::string(R"({"id":"c)") + std::to_string(i) + R"(","freqHz":)" + std::to_string(f) + "}";
  }
  if (bg) s += std::string(regs ? "," : "") + R"({"id":"nwr","freqHz":146000000,"background":true})";
  return s + "]}";
}
}  // namespace

TEST(engine_lanes_32_assigns_32_channels_background_last) {
  kc::EngineOptions o; o.rate = RATE; o.lanes = 32;
  Rig r(o);
  r.tune(many_channels(31, true));
  const auto& sc = r.e.scanner();
  CHECK(sc.lanes() == 32);
  for (int i = 0; i < 31; i++) CHECK(sc.lane(i).id == "c" + std::to_string(i));
  CHECK(sc.lane(31).id == "nwr" && sc.lane(31).background);
  CHECK(r.of("log").empty());
  r.feed(scene(0.5, 11));
  auto pw = r.of("power");
  CHECK(!pw.empty() && pw.back()["levels"].size() == 32 && pw.back()["noise"].size() == 32);
  // More channels than slots: extras dropped with a log line, background keeps the last slot.
  r.ev.clear();
  r.tune(many_channels(40, true));
  CHECK(r.of("log").size() == 1);
  CHECK(r.e.scanner().lane(30).id == "c30" && r.e.scanner().lane(31).id == "nwr");
}

TEST(engine_lanes_32_close_call_lands_in_first_parked_slot) {
  kc::EngineOptions o; o.rate = RATE; o.lanes = 32; o.close_call = true;
  Rig r(o);
  std::string t = many_channels(20, false, 100'000);   // -90..+10 kHz: clear of the 87.5 kHz hit
  t.pop_back();   // strip '}' to append the Close Call fields
  r.tune(t + R"(,"closeCall":true,"closeCallDb":15,"knownHz":[]})");
  auto x = scene(3.0, 12);
  auto c = sig::tone(RATE, x.size(), 87'500, 0.2);
  for (size_t i = (size_t)(0.6 * RATE); i < x.size(); i++) x[i] += c[i];
  r.feed(x);
  auto cc = r.of("closecall");
  CHECK(!cc.empty() && cc[0]["freqHz"] == 146087500);
  CHECK(r.e.scanner().lane(20).id == "cc_146087500");   // slot 20: first parked slot above 12
}

TEST(engine_lanes_1_single_background_lane) {
  kc::EngineOptions o; o.rate = RATE; o.lanes = 1; o.same = true;
  Rig r(o);
  r.tune(many_channels(1, true));   // one regular + the background: background wins the only slot
  CHECK(r.e.scanner().lanes() == 1 && r.e.scanner().lane(0).id == "nwr");
  auto x = scene(1.0, 13);
  burst_fm(x, 0, 0.0, 1.0);
  r.feed(x);
  CHECK(!r.same_pcm.empty());
  CHECK(r.of("open").empty());
  kc::EngineOptions bad; bad.rate = RATE; bad.lanes = 0;
  CHECK_THROWS(Rig(bad));
  bad.lanes = kc::MAX_LANES + 1;
  CHECK_THROWS(Rig(bad));
}

namespace {
// FM carrier at `off` Hz carrying a 1 kHz "voice" tone (3 kHz dev) plus, if ctcss > 0, a CTCSS tone
// at 600 Hz deviation -- added into x over [t0, t1).
void burst_fm_ctcss(std::vector<sig::cf>& x, double off, double t0, double t1, double ctcss) {
  double ph = 0;
  for (size_t i = (size_t)(t0 * RATE); i < (size_t)(t1 * RATE) && i < x.size(); i++) {
    const double t = (double)i / RATE;
    double f = off + 3000 * std::sin(2 * M_PI * 1000 * t);
    if (ctcss > 0) f += 600 * std::sin(2 * M_PI * ctcss * t);
    ph += 2 * M_PI * f / RATE;
    x[i] += sig::cf((float)(0.2 * std::cos(ph)), (float)(0.2 * std::sin(ph)));
  }
}
const char* toned_tune(const char* ctcss) {
  static std::string s;
  s = std::string(R"({"cmd":"tune","centerHz":146000000,"channels":[{"id":"a","freqHz":146050000,"hangMs":500)") +
      (ctcss ? std::string(R"(,"ctcssHz":)") + ctcss : std::string()) + R"(}],"closeCall":false})";
  return s.c_str();
}
}  // namespace

TEST(engine_ctcss_right_tone_opens_and_reports) {
  kc::EngineOptions o; o.rate = RATE;
  Rig r(o);
  r.tune(toned_tune("100.0"));
  auto x = scene(3.0, 11);
  burst_fm_ctcss(x, 50'000, 1.0, 2.5, 100.0);
  r.feed(x);
  auto op = r.of("open");
  CHECK(op.size() == 1);
  if (!op.empty()) CHECK(op[0]["t"].get<double>() < 1.75);   // window fill + 2 hops + OPEN_POLLS
  auto t = r.of("tone");
  CHECK(t.size() == 1 && t[0]["id"] == "a" && t[0]["ctcssHz"] == 100.0);
  CHECK(r.pcm_rms(1.9, 2.4) > 0.05);
}

TEST(engine_ctcss_wrong_tone_or_none_never_opens) {
  for (double tx : {123.0, 0.0}) {
    kc::EngineOptions o; o.rate = RATE;
    Rig r(o);
    r.tune(toned_tune("100.0"));
    auto x = scene(3.0, 12);
    burst_fm_ctcss(x, 50'000, 1.0, 2.8, tx);
    r.feed(x);
    CHECK(r.of("open").empty());
    CHECK(r.pcm_rms(1.0, 3.0) < 1e-3);
  }
}

TEST(engine_untoned_channel_opens_as_before_and_reports_heard_tone) {
  kc::EngineOptions o; o.rate = RATE;
  Rig r(o);
  r.tune(toned_tune(nullptr));
  auto x = scene(3.0, 13);
  burst_fm_ctcss(x, 50'000, 1.0, 2.0, 151.4);
  r.feed(x);
  auto op = r.of("open");
  CHECK(op.size() == 1);
  if (!op.empty()) { CHECK(op[0]["t"].get<double>() > 1.08); CHECK(op[0]["t"].get<double>() < 1.2); }
  auto t = r.of("tone");
  CHECK(t.size() == 1 && t[0]["ctcssHz"] == 151.4);
}
