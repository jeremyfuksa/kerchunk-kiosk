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
// Retune settle at 250 kHz: one full in-flight USB transfer (RTL_BUF_LEN/2 = 8192 samples, 32.8 ms)
// plus the RETUNE_SETTLE_MS PLL margin (250000 * 20 / 1000 = 5000) = 13192 samples. LiveLoop discards
// whole 2500-sample blocks while settle_left_ > 0: 13192 -> 10692 -> 8192 -> 5692 -> 3192 -> 692 -> <0,
// i.e. exactly 6 blocks (60 ms).
constexpr int SETTLE_BLOCKS = 6;
static_assert((kc::RTL_BUF_LEN / 2 + RATE * (int)kc::RETUNE_SETTLE_MS / 1000 + BLOCK / 2 - 1) / (BLOCK / 2) == SETTLE_BLOCKS,
              "settle derivation above");

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
  bool refuse = false;   // simulate the device rejecting every retune
  bool set_center(double hz) override { centers.push_back(hz); if (refuse) return false; gen++; return true; }
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
  long long spk = 0;   // speaker samples (48 kHz) emitted
  explicit Rig(bool close_call = false) {
    o.rate = RATE;
    o.close_call = close_call;
    e = std::make_unique<kc::Engine>(o, [this](const nlohmann::json& j) { auto k = j; k["t"] = e->now(); ev.push_back(k); },
                                     [this](const int16_t*, int n) { spk += n; }, nullptr, nullptr);
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
  r.src.add(SETTLE_BLOCKS + 3, 1);  // new-generation blocks (first 6 = settle discard, then 3 real)
  r.run();
  CHECK(r.src.centers.size() == 1 && r.src.centers[0] == 146000000);
  CHECK(r.count("tuned") == 1);
  double tuned_t = -1;
  for (auto& j : r.ev) if (j["ev"] == "tuned") tuned_t = j["t"].get<double>();
  CHECK_NEAR(tuned_t, 0.11, 1e-9);  // 5 old + 6 settle blocks (10 ms each) discarded before the tune applies
  CHECK_NEAR(r.e->now(), 0.14, 0.0015);   // all 14 blocks counted on the clock (hop-granular)
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
  r.src.add(SETTLE_BLOCKS + 1, 1);
  r.run();
  r.src.dropped = 2500;             // 10 ms lost in the ring
  r.loop->step();
  // note_gap resyncs samples_ to pushed_ (like tune()), so the gap can't lose the partial hop it
  // discards off the clock: by this point 7 blocks have been consumed (6 settle-discarded + the one
  // real push once the tune landed) = 7*2500 = 17500 samples, plus the 2500-sample gap just noted =
  // 20000 samples exactly, no hop-granular slack.
  CHECK_NEAR(r.e->now(), 20000.0 / RATE, 1e-9);
  r.src.add(40, 1);
  r.run();
  int drop_events = 0;
  for (auto& j : r.ev) if (j["ev"] == "power" && j.contains("drops")) { drop_events++; CHECK(j["drops"].get<long long>() == 2500); }
  CHECK(drop_events == 1);          // drops_since_power_ is reset on report -- exactly one power event carries it
  CHECK(r.count("log") == 1);       // rate-limited overrun log
  CHECK_NEAR(r.e->now(), 0.48, 0.0015);   // 7 + 1 (gap) + 40 blocks
}

TEST(live_retune_mid_stream_discards_old_generation) {
  Rig r;
  r.send(TUNE);
  r.src.add(10, 1);
  r.run();
  r.src.add(3, 1);                  // queued before the retune lands: old center
  r.send(R"({"cmd":"tune","centerHz":147000000,"channels":[{"id":"b","freqHz":147050000}]})");
  r.src.add(SETTLE_BLOCKS + 2, 2);
  r.run();
  CHECK(r.count("tuned") == 2);
  CHECK(r.src.centers.size() == 2 && r.src.centers[1] == 147000000);
  // 10 + 3 old-gen + 6 settle blocks (10 ms each) discarded before the second tune applies.
  double second_tuned_t = -1;
  for (auto& j : r.ev) if (j["ev"] == "tuned") second_tuned_t = j["t"].get<double>();
  CHECK_NEAR(second_tuned_t, 0.19, 1e-9);
}

TEST(live_coalesces_multiple_pending_tunes) {
  Rig r;
  // Two tunes queued in the same drain (before any block is consumed): the second overwrites
  // pending_ before the first ever applies -- only the *last* center's tuned event should fire, but
  // the source still sees both retune calls.
  r.send(TUNE);
  r.send(R"({"cmd":"tune","centerHz":147000000,"channels":[{"id":"b","freqHz":147050000}]})");
  r.src.add(5, 0);                  // stale pre-drain blocks (gen 0, from before either tune): discarded
  r.src.add(SETTLE_BLOCKS + 1, 2);  // gen 2 (both set_center calls already landed): 6 settle + 1 real
  r.run();
  CHECK(r.count("tuned") == 1);
  CHECK(r.src.centers.size() == 2 && r.src.centers[0] == 146000000 && r.src.centers[1] == 147000000);
  double t1 = -1;
  for (auto& j : r.ev) if (j["ev"] == "tuned") t1 = j["centerHz"].get<double>();
  CHECK(t1 == 147000000);

  // A second tune arriving mid-settle (settle_left_ partially spent, not full and not zero) also
  // overrides cleanly: the in-progress settle countdown is discarded wholesale, not carried over.
  r.send(R"({"cmd":"tune","centerHz":148000000,"channels":[{"id":"c","freqHz":148050000}]})");
  r.src.add(1, 3);                  // 1 of 6 settle blocks lands before the next tune arrives
  r.run();
  r.send(R"({"cmd":"tune","centerHz":149000000,"channels":[{"id":"d","freqHz":149050000}]})");
  r.src.add(2, 3);                  // stale gen-3 remainder: now old-center (want_gen_ moved to 4)
  r.src.add(SETTLE_BLOCKS + 1, 4);  // gen 4: 6 settle + 1 real
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

TEST(live_refused_retune_fails_the_loop_instead_of_scanning_the_old_window) {
  Rig r;
  r.src.add(3, 0);
  r.src.refuse = true;
  r.send(TUNE);
  r.src.add(10, 0);
  r.run();
  CHECK(r.loop->failed());
  CHECK(r.count("tuned") == 0);     // the tune never applied to samples from the old center
  CHECK(!r.loop->step());           // stays failed
}

TEST(live_retune_gap_keeps_the_speaker_clock_fed) {
  // After the first tune applies, every 10 ms of wall time must reach the speaker as 480 samples --
  // including the old-center + settle blocks a retune discards (else the ALSA ring starves on
  // every group hop). 10 blocks audio, retune (3 old + 6 settle discarded), 10 blocks audio = 290 ms.
  Rig r;
  r.send(TUNE);
  r.src.add(SETTLE_BLOCKS + 10, 1);   // first tune: its settle is pre-tune (no speaker yet), then 100 ms
  r.run();
  r.src.add(3, 1);
  r.send(R"({"cmd":"tune","centerHz":147000000,"channels":[{"id":"b","freqHz":147050000}]})");
  r.src.add(SETTLE_BLOCKS + 10, 2);
  r.run();
  CHECK(r.count("tuned") == 2);
  CHECK_NEAR((double)r.spk, 0.29 * kc::AUDIO_RATE, 150);   // hop/resampler granularity; 200 ms without the fill
}
