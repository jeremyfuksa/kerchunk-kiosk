#include <cstring>
#include <deque>
#include <string>
#include <vector>

#include "check.hpp"
#include "engine.hpp"
#include "live.hpp"
#include "signals.hpp"

namespace {
constexpr int RATE = 250'000;
constexpr int BLOCK = RATE / 100 * 2;   // 10 ms of u8 IQ

std::vector<uint8_t> to_u8(const std::vector<sig::cf>& x) {
  std::vector<uint8_t> iq(2 * x.size());
  for (size_t i = 0; i < x.size(); i++) {
    iq[2 * i] = (uint8_t)std::lround(std::clamp(x[i].real() * 127.5f + 127.5f, 0.f, 255.f));
    iq[2 * i + 1] = (uint8_t)std::lround(std::clamp(x[i].imag() * 127.5f + 127.5f, 0.f, 255.f));
  }
  return iq;
}

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
  // Continuous single-tone IQ (dithered by a touch of background noise, matching test_engine.cpp's
  // scene()+tone() pattern -- a pure 8-bit-quantized tone at a low-order rational multiple of the
  // rate, like 87500/250000 = 7/20, produces strong *coherent* quantization harmonics with no dither
  // at all, which can masquerade as extra close calls of their own), chopped into `blocks`
  // BLOCK-byte chunks -- for behavioural Close Call tests (a genuine carrier, not the silence
  // `add()` produces).
  void add_tone(int blocks, uint32_t g, double freq_hz, double amp) {
    const size_t n = (size_t)blocks * (BLOCK / 2);
    auto x = sig::noise(n, 0.01, 42);
    sig::add(x, sig::tone(RATE, n, freq_hz, amp));
    auto u8 = to_u8(x);
    for (int i = 0; i < blocks; i++) {
      kc::IqBlock b;
      b.gen = g;
      b.n = BLOCK;
      std::memcpy(b.data.data(), u8.data() + (size_t)i * BLOCK, BLOCK);
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
  explicit Rig(bool close_call = false) {
    o.rate = RATE;
    o.close_call = close_call;
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
  CHECK(r.count("log") == 0);       // retune discards (old-center, settle) are not drops
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
  int drop_events = 0;
  for (auto& j : r.ev) if (j["ev"] == "power" && j.contains("drops")) { drop_events++; CHECK(j["drops"].get<long long>() == 2500); }
  CHECK(drop_events == 1);          // drops_since_power_ is reset on report -- exactly one power event carries it
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
  // 10 + 3 old-gen + 2 settle blocks (10 ms each) discarded before the second tune applies.
  double second_tuned_t = -1;
  for (auto& j : r.ev) if (j["ev"] == "tuned") second_tuned_t = j["t"].get<double>();
  CHECK_NEAR(second_tuned_t, 0.15, 1e-9);
}

TEST(live_coalesces_multiple_pending_tunes) {
  Rig r;
  // Two tunes queued in the same drain (before any block is consumed): the second overwrites
  // pending_ before the first ever applies -- only the *last* center's tuned event should fire, but
  // the source still sees both retune calls.
  r.send(TUNE);
  r.send(R"({"cmd":"tune","centerHz":147000000,"channels":[{"id":"b","freqHz":147050000}]})");
  r.src.add(5, 0);                  // stale pre-drain blocks (gen 0, from before either tune): discarded
  r.src.add(3, 2);                  // gen 2 (both set_center calls already landed): 2 settle + 1 real
  r.run();
  CHECK(r.count("tuned") == 1);
  CHECK(r.src.centers.size() == 2 && r.src.centers[0] == 146000000 && r.src.centers[1] == 147000000);
  double t1 = -1;
  for (auto& j : r.ev) if (j["ev"] == "tuned") t1 = j["centerHz"].get<double>();
  CHECK(t1 == 147000000);

  // A second tune arriving mid-settle (settle_left_ partially spent, not full and not zero) also
  // overrides cleanly: the in-progress settle countdown is discarded wholesale, not carried over.
  r.send(R"({"cmd":"tune","centerHz":148000000,"channels":[{"id":"c","freqHz":148050000}]})");
  r.src.add(1, 3);                  // 1 of 2 settle blocks lands before the next tune arrives
  r.run();
  r.send(R"({"cmd":"tune","centerHz":149000000,"channels":[{"id":"d","freqHz":149050000}]})");
  r.src.add(2, 3);                  // stale gen-3 remainder: now old-center (want_gen_ moved to 4)
  r.src.add(3, 4);                  // gen 4: 2 settle + 1 real
  r.run();
  CHECK(r.count("tuned") == 2);     // one more tuned overall -- the superseded 148 MHz never fired
  CHECK(r.src.centers.size() == 4 && r.src.centers.back() == 149000000);
  double t2 = -1;
  for (auto& j : r.ev) if (j["ev"] == "tuned") t2 = j["centerHz"].get<double>();
  CHECK(t2 == 149000000);
}

TEST(live_known_command_folds_into_pending_tune) {
  const char* CC_TUNE_EMPTY_KNOWN =
      R"({"cmd":"tune","centerHz":146000000,"channels":[{"id":"a","freqHz":146050000}],)"
      R"("closeCall":true,"closeCallDb":15,"knownHz":[]})";
  constexpr double TONE_HZ = 87'500;   // 146087500 absolute: not the channel, not masked by knownHz:[]
  constexpr int SETTLE_BLOCKS = 2;     // 20 ms settle at 250 kHz / 2500-sample blocks
  constexpr int TONE_BLOCKS = 100;     // 1 s of carrier

  // Bug this proves fixed: a `known` command queued while a tune is pending used to apply to the
  // engine's outgoing window, then get silently overwritten the moment the pending tune's own
  // (older/empty) knownHz landed -- so the new list never actually suppressed anything post-retune.
  {
    Rig r(/*close_call=*/true);
    r.send(CC_TUNE_EMPTY_KNOWN);
    r.send(R"({"cmd":"known","knownHz":[146050000,146087500]})");   // arrives while pending_ is set
    r.src.add(SETTLE_BLOCKS, 1);
    r.src.add_tone(TONE_BLOCKS, 1, TONE_HZ, 0.2);
    r.run();
    CHECK(r.count("closecall") == 0);   // suppressed: the fold applied the new known list to the pending tune
  }
  // Control: identical scene, no known command -- the tone is a genuine, unsuppressed close call.
  {
    Rig r(/*close_call=*/true);
    r.send(CC_TUNE_EMPTY_KNOWN);
    r.src.add(SETTLE_BLOCKS, 1);
    r.src.add_tone(TONE_BLOCKS, 1, TONE_HZ, 0.2);
    r.run();
    bool saw = false;
    for (auto& j : r.ev) if (j["ev"] == "closecall" && j["freqHz"].get<long long>() == 146087500) saw = true;
    CHECK(saw);
  }
}
