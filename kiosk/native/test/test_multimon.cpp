#include <chrono>
#include <cstring>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "check.hpp"
#include "multimon.hpp"

namespace {
struct Sink {
  std::mutex m;
  std::vector<nlohmann::json> ev;
  std::vector<std::string> logs;
  kc::Multimon::Emit emit() { return [this](const nlohmann::json& j) { std::lock_guard<std::mutex> g(m); ev.push_back(j); }; }
  kc::LogFn log() { return [this](const std::string& s) { std::lock_guard<std::mutex> g(m); logs.push_back(s); }; }
  bool wait_events(size_t n, int ms) {
    for (int i = 0; i < ms / 10; i++) { { std::lock_guard<std::mutex> g(m); if (ev.size() >= n) return true; } std::this_thread::sleep_for(std::chrono::milliseconds(10)); }
    return false;
  }
};
}  // namespace

TEST(multimon_same_line_filter) {
  CHECK(kc::Multimon::is_same_line("EAS: ZCZC-WXR-TOR-029047+0030-2701234-KEAX/NWS-"));
  CHECK(kc::Multimon::is_same_line("EAS: NNNN"));
  CHECK(!kc::Multimon::is_same_line("multimon-ng 1.3.0"));
}

TEST(multimon_pipes_lines_through_child) {
  Sink s;
  kc::Multimon mm({"cat"}, s.emit(), s.log());   // cat echoes our "PCM" bytes back as text lines
  std::string err;
  CHECK(mm.start(err));
  const char* text = "EAS: ZCZC-WXR-TOR-029047+0030-2701234-KEAX/NWS-\nnoise line\n";
  std::vector<int16_t> pcm((std::strlen(text) + 1) / 2, 0);
  std::memcpy(pcm.data(), text, std::strlen(text));
  mm.write(pcm.data(), pcm.size());
  CHECK(s.wait_events(1, 2000));
  mm.stop();
  std::lock_guard<std::mutex> g(s.m);
  CHECK(s.ev.size() == 1);
  CHECK(!s.ev.empty() && s.ev[0]["ev"] == "same" && s.ev[0]["raw"].get<std::string>().find("ZCZC") != std::string::npos);
}

TEST(multimon_crash_loop_gives_up_after_max_quick_respawns) {
  Sink s;
  kc::Multimon mm({"sh", "-c", "echo 'EAS: NNNN'"}, s.emit(), s.log());   // default budget, 60 s healthy
  std::string err;
  CHECK(mm.start(err));
  CHECK(s.wait_events(1 + kc::MULTIMON_MAX_RESPAWNS, 3000));   // first run + every quick respawn
  std::this_thread::sleep_for(std::chrono::milliseconds(300));
  mm.stop();
  std::lock_guard<std::mutex> g(s.m);
  CHECK(s.ev.size() == (size_t)(1 + kc::MULTIMON_MAX_RESPAWNS));
  int exited = 0, gave_up = 0;
  for (auto& l : s.logs) {
    if (l == "multimon-ng exited: SAME decoding stopped") exited++;
    if (l.find("giving up") != std::string::npos) gave_up++;
  }
  CHECK(exited == 1 + kc::MULTIMON_MAX_RESPAWNS);
  CHECK(gave_up == 1);
}

TEST(multimon_healthy_run_refills_respawn_budget) {
  // Each child lives 0.3 s -- longer than the 0.2 s healthy mark -- so every exit is a fresh
  // failure: with a budget of 1 it keeps coming back well past one restart.
  Sink s;
  kc::Multimon mm({"sh", "-c", "sleep 0.3; echo 'EAS: NNNN'"}, s.emit(), s.log(), /*max_respawns=*/1, /*healthy_s=*/0.2);
  std::string err;
  CHECK(mm.start(err));
  CHECK(s.wait_events(4, 4000));
  mm.stop();
  std::lock_guard<std::mutex> g(s.m);
  for (auto& l : s.logs) CHECK(l.find("giving up") == std::string::npos);
}

TEST(multimon_stop_during_in_flight_respawn_returns_promptly) {
  Sink s;
  kc::Multimon mm({"sh", "-c", "exit 0"}, s.emit(), s.log());
  std::string err;
  CHECK(mm.start(err));
  std::this_thread::sleep_for(std::chrono::milliseconds(50));   // land stop() mid respawn cycle
  const auto t0 = std::chrono::steady_clock::now();
  mm.stop();
  const auto ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
  CHECK(ms < 1000);
}

TEST(multimon_stop_kills_unresponsive_child) {
  Sink s;
  kc::Multimon mm({"sh", "-c", "trap '' TERM; while true; do sleep 1; done"}, s.emit(), s.log());
  std::string err;
  CHECK(mm.start(err));
  std::this_thread::sleep_for(std::chrono::milliseconds(100));
  const auto t0 = std::chrono::steady_clock::now();
  mm.stop();
  const auto ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
  CHECK(ms < 1000);
}
