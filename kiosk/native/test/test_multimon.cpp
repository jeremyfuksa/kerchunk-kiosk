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

TEST(multimon_respawns_once_then_gives_up) {
  Sink s;
  kc::Multimon mm({"sh", "-c", "echo 'EAS: NNNN'"}, s.emit(), s.log());
  std::string err;
  CHECK(mm.start(err));
  CHECK(s.wait_events(2, 3000));                 // first run + one respawn
  std::this_thread::sleep_for(std::chrono::milliseconds(300));
  mm.stop();
  std::lock_guard<std::mutex> g(s.m);
  CHECK(s.ev.size() == 2);
  int exited = 0;
  for (auto& l : s.logs) if (l == "multimon-ng exited: SAME decoding stopped") exited++;
  CHECK(exited == 2);
}
