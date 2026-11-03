#include <algorithm>
#include <cmath>
#include <vector>

#include "carrier_survey.hpp"
#include "check.hpp"
#include "engine.hpp"
#include "signals.hpp"

namespace {
constexpr int RATE = 750'000;
constexpr double CENTER = 7'350'000;
constexpr double SIGMA = 0.02;
constexpr size_t N = RATE * 2;

// Amplitude that sits `db` above the per-bin noise floor (Blackman-Harris processing gain, 2048 FFT).
double amp_for(double db) { return std::sqrt(std::pow(10, db / 10) / 1021.0 * 2 * SIGMA * SIGMA); }
std::vector<sig::cf> scene(const std::vector<std::pair<double, double>>& offset_db) {
  auto x = sig::noise(N, SIGMA, 7);
  for (auto& t : offset_db) sig::add(x, sig::tone(RATE, N, t.first, amp_for(t.second)));
  return x;
}
std::vector<kc::Carrier> survey(const std::vector<sig::cf>& x, double min_db = 10, double* floor = nullptr) {
  kc::CarrierSurvey s(RATE);
  s.reset(CENTER);
  s.push_raw(x.data(), (int)x.size());
  double f = 0;
  auto r = s.take(min_db, &f);
  if (floor) *floor = f;
  return r;
}
bool has(const std::vector<kc::Carrier>& c, long long hz) {
  return std::any_of(c.begin(), c.end(), [&](const kc::Carrier& k) { return k.hz == hz; });
}
}  // namespace

TEST(survey_finds_each_tone_on_raster) {
  auto c = survey(scene({{-50000, 25}, {-5000, 25}, {150000, 25}}));
  CHECK(c.size() == 3);
  CHECK(has(c, 7300000) && has(c, 7345000) && has(c, 7500000));
}

TEST(survey_snaps_an_off_raster_carrier) {
  auto c = survey(scene({{-5200, 25}}));
  CHECK(c.size() == 1 && has(c, 7345000));
}

TEST(survey_db_is_relative_to_floor) {
  auto c = survey(scene({{100000, 24}}));
  CHECK(c.size() == 1);
  if (!c.empty()) CHECK_NEAR(c[0].db_above_floor, 24, 3);
}

TEST(survey_respects_threshold) {
  CHECK(survey(scene({{100000, 6}}), 10).empty());
}

TEST(survey_big_station_does_not_lift_floor) {
  double quiet = 0, loud = 0;
  survey(scene({}), 10, &quiet);
  auto c = survey(scene({{-100000, 60}, {100000, 15}}), 10, &loud);
  CHECK_NEAR(loud, quiet, 1.0);
  CHECK(has(c, 7250000) && has(c, 7450000));
}

TEST(survey_ignores_dc_and_edges) {
  CHECK(survey(scene({{0, 40}})).empty());
  CHECK(survey(scene({{0.48 * RATE, 40}})).empty());
  CHECK(survey(scene({{-0.48 * RATE, 40}})).empty());
}

TEST(survey_center_spike_does_not_hide_stations_beside_it) {
  auto c = survey(scene({{0, 30}, {5000, 25}, {-7000, 25}}));
  CHECK(has(c, 7355000));
  CHECK(has(c, 7345000));
  CHECK(!has(c, 7350000));
}

TEST(survey_covers_the_usable_span_and_close_to_center) {
  auto c = survey(scene({{320000, 25}, {-320000, 25}, {10000, 25}}));
  CHECK(has(c, 7670000) && has(c, 7030000) && has(c, 7360000));
}

TEST(survey_reports_an_am_station_once) {
  auto x = scene({});
  sig::add(x, sig::tone(RATE, N, 100000, amp_for(40)));
  sig::add(x, sig::tone(RATE, N, 103000, amp_for(30)));   // upper sideband
  sig::add(x, sig::tone(RATE, N, 97000, amp_for(30)));    // lower sideband
  auto c = survey(x);
  CHECK(c.size() == 1 && has(c, 7450000));
}

TEST(survey_reset_forgets_previous_window) {
  kc::CarrierSurvey s(RATE);
  s.reset(CENTER);
  auto a = scene({{100000, 30}});
  s.push_raw(a.data(), (int)a.size());
  s.reset(9650000);
  auto b = scene({});
  s.push_raw(b.data(), (int)b.size());
  double f = 0;
  CHECK(s.take(10, &f).empty());
}

TEST(survey_take_with_no_frames_is_empty) {
  kc::CarrierSurvey s(RATE);
  s.reset(CENTER);
  double f = 0;
  CHECK(s.take(10, &f).empty());
}

TEST(engine_lane_audio_and_survey_run_together) {
  kc::EngineOptions o;
  o.rate = RATE;
  o.lanes = 2;
  o.survey = true;
  std::vector<nlohmann::json> ev;
  std::vector<int16_t> pcm;
  kc::Engine e(o, [&](const nlohmann::json& j) { ev.push_back(j); },
               [&](const int16_t* p, int n) { pcm.insert(pcm.end(), p, p + n); }, nullptr, nullptr);
  std::string err;
  auto cmd = kc::parse_command(
      R"({"cmd":"tune","centerHz":7350000,"channels":[{"id":"a","freqHz":7400000,"mode":"am"}]})", err);
  CHECK(cmd.has_value());
  if (cmd) e.command(*cmd);

  const size_t total = RATE * 8, start = RATE * 3;
  auto x = sig::noise(total, 0.01, 3);
  sig::add(x, sig::tone(RATE, total, -100000, 0.05));
  const double pi = std::acos(-1.0);
  for (size_t i = start; i < total; i++) {   // AM at +50 kHz, 1 kHz tone, after the squelch has its floor
    const double t = (double)i / RATE;
    const double env = 0.25 * (1 + 0.8 * std::sin(2 * pi * 1000 * t));
    x[i] += sig::cf((float)(env * std::cos(2 * pi * 50000 * t)), (float)(env * std::sin(2 * pi * 50000 * t)));
  }
  std::vector<uint8_t> iq(total * 2);
  for (size_t i = 0; i < total; i++) {
    iq[2 * i] = (uint8_t)std::lround(std::clamp(x[i].real() * 127.5f + 127.5f, 0.f, 255.f));
    iq[2 * i + 1] = (uint8_t)std::lround(std::clamp(x[i].imag() * 127.5f + 127.5f, 0.f, 255.f));
  }
  for (size_t i = 0; i < total; i += RATE / 100) e.push_u8(&iq[2 * i], std::min<size_t>(RATE / 100, total - i));

  double peak = 0;
  for (int16_t s : pcm) peak = std::max(peak, std::fabs((double)s));
  CHECK(peak > 1000);   // the speaker played the lane

  bool both = false;
  for (auto& j : ev) {
    if (j.value("ev", "") != "carriers") continue;
    CHECK(j.contains("center") && j.contains("floorDb"));
    bool a = false, b = false;
    for (auto& c : j["carriers"]) {
      a = a || c["hz"].get<long long>() == 7400000;
      b = b || c["hz"].get<long long>() == 7250000;
    }
    both = both || (a && b);
  }
  CHECK(both);   // and the survey saw both carriers while it played
}

TEST(engine_survey_off_emits_no_carriers) {
  kc::EngineOptions o;
  o.rate = RATE;
  o.lanes = 2;
  std::vector<nlohmann::json> ev;
  kc::Engine e(o, [&](const nlohmann::json& j) { ev.push_back(j); }, nullptr, nullptr, nullptr);
  std::string err;
  auto cmd = kc::parse_command(R"({"cmd":"tune","centerHz":7350000,"channels":[]})", err);
  if (cmd) e.command(*cmd);
  std::vector<uint8_t> iq(RATE * 6 * 2, 127);
  for (size_t i = 0; i < (size_t)RATE * 6; i += RATE / 100) e.push_u8(&iq[2 * i], RATE / 100);
  for (auto& j : ev) CHECK(j.value("ev", "") != "carriers");
}
