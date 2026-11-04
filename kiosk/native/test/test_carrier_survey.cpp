#include <algorithm>
#include <cmath>
#include <complex>
#include <random>
#include <vector>

#include "carrier_survey.hpp"
#include "check.hpp"
#include "engine.hpp"
#include "iq_rate.hpp"
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

namespace {
// A carrierless voice stand-in: tones across the sideband, on for 200 ms and off for 200 ms.
void add_ssb(std::vector<sig::cf>& x, double dial, double db) {
  std::vector<sig::cf> v(x.size(), sig::cf(0, 0));
  for (int f = 300; f <= 2850; f += 170) sig::add(v, sig::tone(RATE, x.size(), dial + f, amp_for(db) / 3 * (1 + f % 7)));
  const size_t hop = RATE / 5;
  for (size_t i = 0; i < x.size(); i++) if ((i / hop) % 2 == 0) x[i] += v[i];
}
const kc::Carrier* strongest(const std::vector<kc::Carrier>& c) {
  const kc::Carrier* b = nullptr;
  for (auto& k : c) if (!b || k.db_above_floor > b->db_above_floor) b = &k;
  return b;
}
}  // namespace

TEST(survey_reports_where_the_peak_really_is) {
  auto c = survey(scene({{-5200, 25}}));
  CHECK(c.size() == 1);
  if (!c.empty()) CHECK_NEAR(c[0].peak_hz, CENTER - 5200, 200);
}

TEST(survey_calls_a_steady_carrier_steady) {
  auto c = survey(scene({{50000, 30}}));
  CHECK(c.size() == 1);
  if (!c.empty()) CHECK(c[0].steady_db < 1.0);
}

TEST(survey_marks_carrierless_voice_as_unsteady) {
  auto x = sig::noise(N, SIGMA, 7);
  add_ssb(x, 50000, 25);
  auto c = survey(x);
  const auto* k = strongest(c);
  CHECK(k != nullptr);
  if (k) CHECK(k->steady_db > 5.0);
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

TEST(survey_reports_adjacent_stations_5khz_apart) {
  auto c = survey(scene({{100000, 40}, {105000, 25}}));
  CHECK(c.size() == 2 && has(c, 7450000) && has(c, 7455000));
  for (auto& k : c) CHECK_NEAR(k.db_above_floor, k.hz == 7450000 ? 40 : 25, 3);
  auto d = survey(scene({{100000, 60}, {95000, 25}}));   // a much stronger one, on the other side
  CHECK(d.size() == 2 && has(d, 7450000) && has(d, 7445000));
}

namespace {
// A station at `offset`, `db` above the floor, with flat sidebands out to +/-7 kHz: hard-processed
// audio, the skirt that can fool the survey. A skirt falling away from its carrier can't, because a
// stronger bin is always within SURVEY_NEAR_HZ; on a plateau the top bin is just the luckiest one.
// Closely spaced tones at random frequencies, stepped by phasor: the frames stay incoherent.
void add_flat_skirt(std::vector<sig::cf>& x, double offset, double db, double tone_db) {
  sig::add(x, sig::tone(RATE, x.size(), offset, amp_for(db)));
  std::mt19937 g(11);
  std::uniform_real_distribution<double> jitter(50, 250), phase(0, 2 * M_PI);
  for (double f = 1500; f < 7000; f += jitter(g)) {
    for (const double side : {offset + f, offset - f}) {
      const std::complex<double> step = std::polar(1.0, 2 * M_PI * side / RATE);
      std::complex<double> p = std::polar(amp_for(tone_db), phase(g));
      for (auto& v : x) { v += sig::cf((float)p.real(), (float)p.imag()); p *= step; }
    }
  }
}
}  // namespace

TEST(survey_strong_station_skirt_is_not_a_neighbour) {
  auto x = scene({});
  add_flat_skirt(x, 100000, 60, 15);
  // With the threshold down at 3 dB the plateau is well over it, so only the line rule holds it back.
  auto c = survey(x, 3);
  CHECK(c.size() == 1 && has(c, 7450000));
  // The skirt must not hide a real line beside it either.
  sig::add(x, sig::tone(RATE, N, 105000, amp_for(45)));
  auto d = survey(x);
  CHECK(has(d, 7450000) && has(d, 7455000));
}

namespace {
// Through the real 768 -> 750 kHz converter, u8 in and out, as the SpyServer path does it.
std::vector<sig::cf> through_converter(const std::vector<std::pair<double, double>>& offset_amp, double sigma) {
  const size_t n = kc::IqRateConverter::IN_RATE * 2;
  auto x = sig::noise(n, sigma, 5);
  for (auto& t : offset_amp) sig::add(x, sig::tone(kc::IqRateConverter::IN_RATE, n, t.first, t.second));
  std::vector<uint8_t> in(n * 2), out(n * 2 + 64);
  for (size_t i = 0; i < n; i++) {
    in[2 * i] = (uint8_t)std::lround(std::clamp(x[i].real() * 127.5f + 127.5f, 0.f, 255.f));
    in[2 * i + 1] = (uint8_t)std::lround(std::clamp(x[i].imag() * 127.5f + 127.5f, 0.f, 255.f));
  }
  kc::IqRateConverter conv;
  const size_t got = conv.push(in.data(), n, out.data(), n + 32);
  std::vector<sig::cf> y(got);
  for (size_t i = 0; i < got; i++)
    y[i] = sig::cf(((float)out[2 * i] - 127.5f) / 127.5f, ((float)out[2 * i + 1] - 127.5f) / 127.5f);
  return y;
}
}  // namespace

TEST(survey_does_not_log_the_converter_image_of_a_strong_carrier) {
  // A carrier just past the span edge, at about +67 dB (observed max +60.6): its image lands 18 kHz
  // inward. The worst place for it is 348 kHz, where the filter's stopband begins.
  for (double f : {340000.0, 348000.0, -340000.0, -348000.0}) {
    const double ghost = f > 0 ? f - 18000 : f + 18000;
    auto y = through_converter({{f, 0.9}}, 0.009);
    auto c = survey(y);
    CHECK(!has(c, std::llround((CENTER + ghost) / 5000) * 5000));
    // Still a survey that works: a real station elsewhere in the same capture is reported.
    auto z = through_converter({{f, 0.9}, {f > 0 ? 200000.0 : -200000.0, 0.05}}, 0.009);
    CHECK(has(survey(z), std::llround((CENTER + (f > 0 ? 200000.0 : -200000.0)) / 5000) * 5000));
  }
}

TEST(survey_keeps_a_real_station_18khz_inside_a_strong_one) {
  // Well above where the image could be: 20 dB below the outer carrier, not 50.
  auto y = through_converter({{340000, 0.5}, {322000, 0.05}}, 0.009);
  CHECK(has(survey(y), 7670000));
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
