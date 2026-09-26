#include <algorithm>
#include <vector>

#include "check.hpp"
#include "closecall.hpp"
#include "constants.hpp"
#include "signals.hpp"

namespace {
constexpr int RATE = 2'400'000;
constexpr double CENTER = 146'000'000;
// Feed `seconds` of x (repeating it) and run a check every 200 ms; return all hits.
std::vector<long long> drive(kc::CloseCall& cc, const std::vector<sig::cf>& x, double seconds, std::vector<double> assigned = {}) {
  std::vector<long long> hits;
  const int per_check = RATE / 5;
  double t = 0;
  for (int k = 0; k < (int)(seconds * 5); k++) {
    for (int done = 0; done < per_check;) {
      int n = std::min<int>((int)x.size(), per_check - done);
      cc.push_raw(x.data(), n);
      done += n;
    }
    t += 0.2;
    if (auto h = cc.check(t, assigned)) hits.push_back(*h);
  }
  return hits;
}
}  // namespace

TEST(closecall_frame_pacing_is_start_to_start) {
  kc::CloseCall cc(RATE);
  cc.reset(CENTER);
  std::vector<sig::cf> z(RATE, sig::cf(0, 0));
  cc.push_raw(z.data(), (int)z.size());
  CHECK(cc.frames_since_check() == kc::CC_FPS);
}

TEST(closecall_confirms_strong_unknown_signal_on_raster) {
  kc::CloseCall cc(RATE);
  cc.reset(CENTER);
  auto x = sig::noise(RATE / 5, 0.01, 1);
  sig::add(x, sig::tone(RATE, x.size(), 600'000, 0.2));
  auto hits = drive(cc, x, 1.0);
  CHECK(hits.size() == 1);                        // confirm x2, then 300 s cooldown
  CHECK(!hits.empty() && hits[0] == 146'600'000);
}

TEST(closecall_suppresses_known_and_assigned) {
  kc::CloseCall cc(RATE);
  cc.reset(CENTER);
  cc.set_known({146'600'000});
  auto x = sig::noise(RATE / 5, 0.01, 2);
  sig::add(x, sig::tone(RATE, x.size(), 600'000, 0.2));
  CHECK(drive(cc, x, 1.0).empty());
  kc::CloseCall cc2(RATE);
  cc2.reset(CENTER);
  CHECK(drive(cc2, x, 1.0, {146'600'000}).empty());
}

TEST(closecall_rejects_tuner_image) {
  kc::CloseCall cc(RATE);
  cc.reset(CENTER);
  cc.set_known({146'600'000});                    // the real signal is known...
  auto x = sig::noise(RATE / 5, 0.01, 3);
  sig::add(x, sig::tone(RATE, x.size(), 600'000, 0.3));
  sig::add(x, sig::tone(RATE, x.size(), -600'000, 0.03));   // ...its mirror image is 20 dB down
  CHECK(drive(cc, x, 1.0).empty());
}

TEST(closecall_ignores_dc_and_edges_and_weak) {
  kc::CloseCall cc(RATE);
  cc.reset(CENTER);
  auto x = sig::noise(RATE / 5, 0.01, 4);
  sig::add(x, sig::tone(RATE, x.size(), 5'000, 0.3));        // DC region
  sig::add(x, sig::tone(RATE, x.size(), 1'150'000, 0.3));    // outer 10%
  sig::add(x, sig::tone(RATE, x.size(), 300'000, 0.0005));   // below floor + db
  CHECK(drive(cc, x, 1.0).empty());
}

TEST(closecall_cooldown_blocks_refire) {
  kc::CloseCall cc(RATE);
  cc.reset(CENTER);
  cc.cooldown(146'600'000, 1e9);
  auto x = sig::noise(RATE / 5, 0.01, 5);
  sig::add(x, sig::tone(RATE, x.size(), 600'000, 0.2));
  CHECK(drive(cc, x, 1.0).empty());
}
