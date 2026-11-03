#include <algorithm>
#include <chrono>
#include <cmath>
#include <complex>
#include <cstdint>
#include <vector>

#include "check.hpp"
#include "iq_rate.hpp"

namespace {
constexpr double PI = 3.14159265358979323846;
constexpr int IN = kc::IqRateConverter::IN_RATE, OUT = kc::IqRateConverter::OUT_RATE;

std::vector<uint8_t> u8_tone(double hz, size_t n, double amp = 0.5) {
  std::vector<uint8_t> b(n * 2);
  for (size_t i = 0; i < n; i++) {
    const double ph = 2 * PI * hz * (double)i / IN;
    b[2 * i] = (uint8_t)std::lround(127.5 + 127.5 * amp * std::cos(ph));
    b[2 * i + 1] = (uint8_t)std::lround(127.5 + 127.5 * amp * std::sin(ph));
  }
  return b;
}
std::vector<uint8_t> convert(kc::IqRateConverter& c, const std::vector<uint8_t>& in, size_t block = 7680) {
  std::vector<uint8_t> out;
  std::vector<uint8_t> tmp(block * 2 + 64);
  const size_t total = in.size() / 2;
  for (size_t at = 0; at < total; at += block) {
    const size_t n = std::min(block, total - at);
    const size_t got = c.push(in.data() + at * 2, n, tmp.data(), tmp.size() / 2);
    out.insert(out.end(), tmp.begin(), tmp.begin() + (std::ptrdiff_t)got * 2);
  }
  return out;
}
// Power of the output at hz, in dB relative to full scale, skipping the filter's start-up.
double level_db(const std::vector<uint8_t>& iq, double hz) {
  const size_t skip = 2000, n = iq.size() / 2;
  std::complex<double> acc = 0;
  for (size_t i = skip; i < n; i++) {
    const std::complex<double> s((iq[2 * i] - 127.5) / 127.5, (iq[2 * i + 1] - 127.5) / 127.5);
    acc += s * std::polar(1.0, -2 * PI * hz * (double)i / OUT);
  }
  return 20 * std::log10(std::abs(acc) / (double)(n - skip) + 1e-12);
}
double output_db(double hz, double measure_at) {
  kc::IqRateConverter c;
  return level_db(convert(c, u8_tone(hz, 76800)), measure_at);
}
}  // namespace

TEST(iq_rate_output_count_is_ratio) {
  kc::IqRateConverter c;
  auto out = convert(c, u8_tone(50000, 768000));
  CHECK_NEAR((double)out.size() / 2, 750000, 2);
}

TEST(iq_rate_keeps_tone_at_its_frequency) {
  const double at = output_db(200000, 200000), off = output_db(200000, 200000 + 3000);
  CHECK_NEAR(at, 20 * std::log10(0.5), 1.0);
  CHECK(at - off > 30);
}

TEST(iq_rate_passband_edge_within_1db) {
  CHECK_NEAR(output_db(330000, 330000), output_db(50000, 50000), 1.0);
  CHECK_NEAR(output_db(-330000, -330000), output_db(50000, 50000), 1.0);
}

TEST(iq_rate_rejects_images_that_would_land_in_the_usable_span) {
  // A +340 kHz input has an upsampling image at 340 - 768 = -428 kHz, which the 750 kHz output
  // folds to -428 + 750 = +322 kHz, inside the 660 kHz usable span.
  CHECK(output_db(340000, 340000) - output_db(340000, 322000) > 40);
}

TEST(iq_rate_reset_clears_history) {
  kc::IqRateConverter c;
  convert(c, u8_tone(50000, 20000));
  c.reset();
  std::vector<uint8_t> silence(2 * 7680, 127);
  std::vector<uint8_t> out(2 * 7680);
  const size_t got = c.push(silence.data(), 7680, out.data(), 7680);
  CHECK(got > 0);
  for (size_t i = 0; i < got * 2; i++) CHECK(std::abs((int)out[i] - 127) <= 1);
}

TEST(iq_rate_never_writes_past_capacity) {
  kc::IqRateConverter c;
  auto in = u8_tone(50000, 7680);
  std::vector<uint8_t> out(2 * 100 + 2, 0xAB);
  const size_t got = c.push(in.data(), 7680, out.data(), 100);
  CHECK(got <= 100);
  CHECK(out[200] == 0xAB && out[201] == 0xAB);
}

TEST(iq_rate_cpu_is_realtime) {
  kc::IqRateConverter c;
  auto in = u8_tone(50000, 768000);
  const auto t0 = std::chrono::steady_clock::now();
  for (int i = 0; i < 10; i++) convert(c, in);
  const double s = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
  CHECK(s < 1.0);
}
