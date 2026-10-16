#include <vector>

#include "check.hpp"
#include "constants.hpp"
#include "pcm_in.hpp"

namespace {
std::vector<int16_t> ramp(int n, int16_t v) { return std::vector<int16_t>(n, v); }
const int MS = kc::LANE_RATE / 1000;   // samples per ms at the lane rate
}  // namespace

TEST(pcm_in_primes_then_plays) {
  kc::PcmIn p(20, 100);
  std::vector<float> out(64);
  auto a = ramp(10 * MS, 16384);
  p.write(a.data(), a.size());
  p.pull(out.data(), 64);
  CHECK(!p.playing());
  CHECK_NEAR(out[0], 0.0, 0);          // still priming: silence
  auto b = ramp(15 * MS, 16384);
  p.write(b.data(), b.size());         // 25 ms >= 20 ms target
  p.pull(out.data(), 64);
  CHECK(p.playing());
  CHECK_NEAR(out[0], 0.5, 1e-6);
}

TEST(pcm_in_underrun_plays_tail_then_reprimes) {
  kc::PcmIn p(1, 100);
  std::vector<float> out(64, 9.f);
  auto a = ramp(100, 16384);
  p.write(a.data(), a.size());
  p.pull(out.data(), 64);              // 100 buffered >= 50 target
  CHECK(p.playing());
  p.pull(out.data(), 64);              // only 36 left
  CHECK_NEAR(out[35], 0.5, 1e-6);
  CHECK_NEAR(out[36], 0.0, 0);         // zero-filled
  CHECK(!p.playing());                 // back to priming
}

TEST(pcm_in_overflow_drops_oldest_to_target) {
  kc::PcmIn p(10, 20);
  std::vector<float> out(64);
  auto old = ramp(25 * MS, 1000);
  auto fresh = ramp(10 * MS, 2000);
  p.write(old.data(), old.size());
  p.write(fresh.data(), fresh.size()); // 35 ms > 20 ms max
  p.pull(out.data(), 64);
  CHECK(p.playing());
  CHECK_NEAR(out[0], 2000.0 / 32768.0, 1e-6);   // trimmed back to the newest 10 ms
}

TEST(pcm_in_reset_drops_everything) {
  kc::PcmIn p(1, 100);
  std::vector<float> out(64);
  auto a = ramp(500, 16384);
  p.write(a.data(), a.size());
  p.pull(out.data(), 64);
  p.reset();
  CHECK(!p.playing());
  p.pull(out.data(), 64);
  CHECK_NEAR(out[0], 0.0, 0);
}
