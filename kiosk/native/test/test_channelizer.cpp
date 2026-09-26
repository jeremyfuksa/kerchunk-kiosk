#include <algorithm>
#include <cmath>
#include <complex>
#include <limits>
#include <random>
#include <vector>

#include "channelizer.hpp"
#include "check.hpp"
#include "meters.hpp"
#include "signals.hpp"

namespace {
constexpr int RATE = 2'400'000;

// Run x through a channelizer with the given lanes; return each lane's slow power (dB)
// measured after skipping the first `skip_chunks` chunks (filter warm-up).
std::vector<float> lane_power_db(int rate, const std::vector<double>& lanes, const std::vector<sig::cf>& x,
                                 int skip_chunks = 5) {
  kc::Channelizer ch(rate);
  ch.set_lanes(lanes);
  std::vector<kc::ChunkPower> meters(lanes.size());
  std::vector<double> acc(lanes.size(), 0);
  std::vector<long> cnt(lanes.size(), 0);
  ch.push_cf(x.data(), x.size(), [&](const kc::cf* out, int n_l, int per, const kc::cf*, int) {
    for (int l = 0; l < n_l; l++) {
      const kc::cf* y = out + l * per;
      for (int d = 0; d < per; d++) {
        if (meters[l].chunks() >= skip_chunks) { acc[l] += std::norm(y[d]); cnt[l]++; }
        meters[l].push(&y[d], 1);
      }
    }
  });
  std::vector<float> db;
  for (size_t l = 0; l < lanes.size(); l++) db.push_back((float)sig::db_power(acc[l] / (double)(cnt[l] ? cnt[l] : 1)));
  return db;
}
}  // namespace

TEST(channelizer_rejects_bad_rates) {
  CHECK_THROWS(kc::Channelizer(2'048'000));   // not a multiple of 50 kHz
  CHECK_THROWS(kc::Channelizer(0));
  CHECK_THROWS(kc::Channelizer(-50'000));
}

TEST(channelizer_geometry) {
  kc::Channelizer a(RATE);
  CHECK(a.fft_size() == 6144);
  CHECK(a.hop() == 3072);
  kc::Channelizer b(250'000);
  CHECK(b.fft_size() == 640);
  CHECK(b.hop() == 320);
}

TEST(channelizer_level_offgrid_and_rejection) {
  const size_t n = RATE;  // 1 s
  auto x = sig::tone(RATE, n, 250'000, 0.3);
  sig::add(x, sig::tone(RATE, n, -412'600, 0.03));        // off the 390.625 Hz bin grid
  sig::add(x, sig::noise(n, 0.0005, 1));
  auto db = lane_power_db(RATE, {250'000, 262'500, 275'000, -412'600, 600'000}, x);
  CHECK_NEAR(db[0], 10 * std::log10(0.09), 0.2);          // on-lane level
  CHECK(db[0] - db[1] > 45);                              // +-12.5 kHz neighbor
  CHECK(db[0] - db[2] > 50);                              // +-25 kHz neighbor
  CHECK_NEAR(db[0] - db[3], 20.0, 0.3);                   // off-grid lane measures right
  CHECK(db[0] - db[4] > 50);                              // empty lane at the floor
}

TEST(channelizer_250k_rate) {
  const int rate = 250'000;
  auto x = sig::tone(rate, rate, 50'000, 0.2);
  auto db = lane_power_db(rate, {50'000, -60'000}, x);
  CHECK_NEAR(db[0], 10 * std::log10(0.04), 0.2);
  CHECK(db[0] - db[1] > 50);
}

// A tone 1 kHz above a lane's center must come out as a clean 1 kHz rotation:
// constant per-sample phase step. A block-parity bug on odd k0 shows as a pi jump every other hop.
static void check_phase_continuity(double lane_hz) {
  const size_t n = RATE / 2;
  auto x = sig::tone(RATE, n, lane_hz + 1000, 0.3);
  kc::Channelizer ch(RATE);
  ch.set_lanes({lane_hz});
  std::vector<kc::cf> y;
  ch.push_cf(x.data(), n, [&](const kc::cf* out, int, int per, const kc::cf*, int) { y.insert(y.end(), out, out + per); });
  const double want = 2 * M_PI * 1000.0 / kc::LANE_RATE;
  double worst = 0;
  for (size_t i = 200; i < y.size(); i++) {
    double step = std::arg(y[i] * std::conj(y[i - 1]));
    worst = std::max(worst, std::fabs(step - want));
  }
  CHECK(worst < 0.01);
}
TEST(channelizer_phase_continuity_even_k0) { check_phase_continuity(250'000); }       // k0 = 640
TEST(channelizer_phase_continuity_odd_k0) { check_phase_continuity(250'390.625); }    // k0 = 641
TEST(channelizer_phase_continuity_offgrid) { check_phase_continuity(250'200); }       // k0 = 641, resid < 0
TEST(channelizer_phase_continuity_negative_odd_k0) { check_phase_continuity(-412'890.625); }  // k0 = -1057

TEST(channelizer_set_lanes_accepts_offset_at_limit) {
  kc::Channelizer ch(RATE);
  const double limit = RATE / 2.0 - kc::LANE_RATE / 2.0;
  ch.set_lanes({limit, -limit});
  CHECK(ch.lanes() == 2);
}

TEST(channelizer_set_lanes_throws_just_beyond_limit) {
  kc::Channelizer ch(RATE);
  const double limit = RATE / 2.0 - kc::LANE_RATE / 2.0;
  CHECK_THROWS(ch.set_lanes({limit + 1.0}));
  CHECK_THROWS(ch.set_lanes({-(limit + 1.0)}));
}

TEST(channelizer_set_lanes_throws_on_nan_and_inf) {
  kc::Channelizer ch(RATE);
  CHECK_THROWS(ch.set_lanes({std::nan("")}));
  CHECK_THROWS(ch.set_lanes({std::numeric_limits<double>::infinity()}));
  CHECK_THROWS(ch.set_lanes({-std::numeric_limits<double>::infinity()}));
}

TEST(channelizer_set_lanes_strong_exception_guarantee) {
  kc::Channelizer ch(RATE);
  ch.set_lanes({250'000, -300'000});
  CHECK(ch.lanes() == 2);
  const double limit = RATE / 2.0 - kc::LANE_RATE / 2.0;
  // Second offset in the batch is invalid; the whole call must throw before mutating any state,
  // including lanes already validated earlier in the same offsets_hz vector.
  CHECK_THROWS(ch.set_lanes({250'000, limit + 1.0}));
  CHECK(ch.lanes() == 2);

  // Not just the count: the previous lanes must still actually demodulate. Measure lane 0's
  // (250'000) level directly, the same way channelizer_level_offgrid_and_rejection does.
  const size_t n = RATE;
  auto x = sig::tone(RATE, n, 250'000, 0.3);
  kc::ChunkPower m0;
  double acc = 0; long cnt = 0;
  ch.push_cf(x.data(), n, [&](const kc::cf* out, int n_l, int per, const kc::cf*, int) {
    CHECK(n_l == 2);
    const kc::cf* y0 = out;  // lane 0 = 250'000
    for (int d = 0; d < per; d++) {
      if (m0.chunks() >= 5) { acc += std::norm(y0[d]); cnt++; }
      m0.push(&y0[d], 1);
    }
  });
  CHECK_NEAR(sig::db_power(acc / (double)(cnt ? cnt : 1)), 10 * std::log10(0.09), 0.3);
}

TEST(channelizer_push_size_invariance) {
  const size_t n = 200'000;
  auto x = sig::tone(RATE, n, 123'456, 0.25);
  sig::add(x, sig::noise(n, 0.01, 2));
  auto run = [&](bool chunked) {
    kc::Channelizer ch(RATE);
    ch.set_lanes({123'456, -300'000});
    std::vector<kc::cf> y;
    auto sink = [&](const kc::cf* out, int n_l, int per, const kc::cf*, int) { y.insert(y.end(), out, out + n_l * per); };
    if (!chunked) { ch.push_cf(x.data(), n, sink); return y; }
    std::mt19937 g(3);
    size_t pos = 0;
    while (pos < n) {
      size_t k = std::min<size_t>(n - pos, 1 + g() % 9000);
      ch.push_cf(x.data() + pos, k, sink);
      pos += k;
    }
    return y;
  };
  auto a = run(false), b = run(true);
  CHECK(a.size() == b.size());
  double worst = 0;
  for (size_t i = 0; i < a.size() && i < b.size(); i++) worst = std::max(worst, (double)std::abs(a[i] - b[i]));
  CHECK(worst < 1e-5);
}

TEST(channelizer_u8_path_matches_level) {
  const size_t n = RATE;
  auto x = sig::tone(RATE, n, 250'000, 0.3);
  std::vector<uint8_t> iq(2 * n);
  for (size_t i = 0; i < n; i++) {
    iq[2 * i] = (uint8_t)std::lround(std::clamp(x[i].real() * 127.5f + 127.5f, 0.f, 255.f));
    iq[2 * i + 1] = (uint8_t)std::lround(std::clamp(x[i].imag() * 127.5f + 127.5f, 0.f, 255.f));
  }
  kc::Channelizer ch(RATE);
  ch.set_lanes({250'000});
  kc::ChunkPower m;
  double acc = 0; long cnt = 0;
  ch.push_u8(iq.data(), n, [&](const kc::cf* out, int, int per, const kc::cf*, int) {
    for (int d = 0; d < per; d++) {
      if (m.chunks() >= 5) { acc += std::norm(out[d]); cnt++; }
      m.push(&out[d], 1);
    }
  });
  CHECK_NEAR(sig::db_power(acc / cnt), 10 * std::log10(0.09), 0.3);
}

TEST(chunk_power_fast_and_slow) {
  kc::ChunkPower m;
  std::vector<kc::cf> a(kc::CHUNK_SAMPLES * 10, kc::cf(1, 0));   // 10 chunks at power 1
  CHECK(m.push(a.data(), (int)a.size()) == 10);
  CHECK_NEAR(m.fast_db(), 0.0, 1e-4);
  CHECK_NEAR(m.slow_db(), 0.0, 1e-4);
  std::vector<kc::cf> b(kc::CHUNK_SAMPLES, kc::cf(0, 0));         // one silent chunk
  CHECK(m.push(b.data(), (int)b.size()) == 1);
  CHECK(m.fast_db() < -150);                                      // fast drops at once
  CHECK_NEAR(m.slow_db(), 10 * std::log10(0.9), 1e-3);            // slow = mean of last 10 chunks
  CHECK(m.chunks() == 11);
}

TEST(mean_square_window) {
  kc::MeanSquare ms(4);
  CHECK(!ms.ready());
  CHECK(!ms.push(1)); CHECK(!ms.push(1)); CHECK(!ms.push(1));
  CHECK(ms.push(1));
  CHECK(ms.ready());
  CHECK_NEAR(ms.db(), 0.0, 1e-6);
}
