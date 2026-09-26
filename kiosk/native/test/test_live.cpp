#include <deque>
#include <string>
#include <vector>

#include "check.hpp"
#include "engine.hpp"
#include "live.hpp"

namespace {
constexpr int RATE = 250'000;
constexpr int BLOCK = RATE / 100 * 2;   // 10 ms of u8 IQ

struct FakeSource : kc::IqSource {
  std::deque<kc::IqBlock> q;
  uint32_t gen = 0;
  std::vector<double> centers;
  uint64_t dropped = 0;
  void add(int blocks, uint32_t g) {
    for (int i = 0; i < blocks; i++) {
      kc::IqBlock b;
      b.gen = g;
      b.n = BLOCK;
      for (int k = 0; k < BLOCK; k++) b.data[k] = 127;
      q.push_back(b);
    }
  }
  bool consume(const std::function<void(const kc::IqBlock&)>& use) override {
    if (q.empty()) return false;
    use(q.front());
    q.pop_front();
    return true;
  }
  void set_center(double hz) override { centers.push_back(hz); gen++; }
  uint32_t generation() const override { return gen; }
  uint64_t take_dropped() override { auto d = dropped; dropped = 0; return d; }
};

struct Rig {
  std::vector<nlohmann::json> ev;
  kc::EngineOptions o;
  std::unique_ptr<kc::Engine> e;
  FakeSource src;
  kc::SpscQueue<kc::Command> cmds{64};
  std::unique_ptr<kc::LiveLoop> loop;
  Rig() {
    o.rate = RATE;
    e = std::make_unique<kc::Engine>(o, [this](const nlohmann::json& j) { auto k = j; k["t"] = e->now(); ev.push_back(k); },
                                     nullptr, nullptr, nullptr);
    loop = std::make_unique<kc::LiveLoop>(*e, src, cmds, RATE);
  }
  void send(const std::string& line) { std::string err; auto c = kc::parse_command(line, err); CHECK(c.has_value()); if (c) cmds.try_push(*c); }
  void run() { while (loop->step()) {} }
  int count(const std::string& type) const { int n = 0; for (auto& j : ev) if (j["ev"] == type) n++; return n; }
};

const char* TUNE = R"({"cmd":"tune","centerHz":146000000,"channels":[{"id":"a","freqHz":146050000}]})";
}  // namespace

TEST(live_tune_waits_for_new_generation_and_settle) {
  Rig r;
  r.src.add(5, 0);                  // old-center blocks already queued
  r.send(TUNE);
  r.src.add(5, 1);                  // new-generation blocks (first 2 = settle discard)
  r.run();
  CHECK(r.src.centers.size() == 1 && r.src.centers[0] == 146000000);
  CHECK(r.count("tuned") == 1);
  double tuned_t = -1;
  for (auto& j : r.ev) if (j["ev"] == "tuned") tuned_t = j["t"].get<double>();
  CHECK_NEAR(tuned_t, 0.07, 1e-9);  // 5 old + 2 settle blocks (10 ms each) discarded before the tune applies
  CHECK_NEAR(r.e->now(), 0.10, 0.0015);   // all 10 blocks counted on the clock (hop-granular)
}

TEST(live_non_tune_commands_apply_immediately_and_quit) {
  Rig r;
  r.send(TUNE);
  r.src.add(10, 1);
  r.run();
  r.send(R"({"cmd":"quit"})");
  r.loop->step();
  CHECK(r.loop->quit());
}

TEST(live_drops_advance_clock_and_report) {
  Rig r;
  r.send(TUNE);
  r.src.add(3, 1);
  r.run();
  r.src.dropped = 2500;             // 10 ms lost in the ring
  r.loop->step();
  // note_gap resyncs samples_ to pushed_ (like tune()), so the gap can't lose the partial hop it
  // discards off the clock: by this point 3 blocks have been consumed (2 settle-discarded + the one
  // real push once the tune landed) = 3*2500 = 7500 samples, plus the 2500-sample gap just noted =
  // 10000 samples exactly, no hop-granular slack.
  CHECK_NEAR(r.e->now(), 10000.0 / RATE, 1e-9);
  r.src.add(40, 1);
  r.run();
  bool saw = false;
  for (auto& j : r.ev) if (j["ev"] == "power" && j.contains("drops")) { saw = true; CHECK(j["drops"].get<long long>() == 2500); }
  CHECK(saw);
  CHECK(r.count("log") == 1);       // rate-limited overrun log
  CHECK_NEAR(r.e->now(), 0.44, 0.0015);
}

TEST(live_retune_mid_stream_discards_old_generation) {
  Rig r;
  r.send(TUNE);
  r.src.add(10, 1);
  r.run();
  r.src.add(3, 1);                  // queued before the retune lands: old center
  r.send(R"({"cmd":"tune","centerHz":147000000,"channels":[{"id":"b","freqHz":147050000}]})");
  r.src.add(4, 2);
  r.run();
  CHECK(r.count("tuned") == 2);
  CHECK(r.src.centers.size() == 2 && r.src.centers[1] == 147000000);
}
