// SAME/EAS decoding via a multimon-ng child: PCM in on stdin (non-blocking pump), text lines out.
#pragma once
#include <sys/types.h>

#include <atomic>
#include <chrono>
#include <mutex>
#include <nlohmann/json.hpp>
#include <string>
#include <thread>
#include <vector>

#include "outputs.hpp"

namespace kc {
class Multimon {
 public:
  using Emit = std::function<void(const nlohmann::json&)>;
  Multimon(std::vector<std::string> argv, Emit emit, LogFn log, int max_respawns = MULTIMON_MAX_RESPAWNS,
           double healthy_s = MULTIMON_HEALTHY_S)
      : argv_(std::move(argv)), emit_(std::move(emit)), log_(std::move(log)), pump_(SAME_RING, log_, "multimon-ng"),
        max_respawns_(max_respawns), healthy_s_(healthy_s) {}
  ~Multimon() { stop(); }
  bool start(std::string& err);
  size_t write(const int16_t* x, size_t n) { return pump_.write(x, n); }
  void stop();
  static bool is_same_line(const std::string& l) { return l.find("ZCZC") != std::string::npos || l.find("NNNN") != std::string::npos; }

 private:
  bool spawn(std::string& err);   // caller must hold life_m_
  void reader();
  std::vector<std::string> argv_;
  Emit emit_;
  LogFn log_;
  FdPump pump_;
  pid_t pid_ = -1;                // guarded by life_m_ (only life_m_ holders touch pid_/out_fd_/respawns_)
  std::atomic<int> out_fd_{-1};   // read separately (without the lock) by reader()'s blocking read()
  std::atomic<bool> running_{false};
  const int max_respawns_;
  const double healthy_s_;
  int respawns_ = 0;   // quick restarts since the last healthy run
  std::chrono::steady_clock::time_point spawned_at_;   // guarded by life_m_
  // Serializes spawn()/stop()'s state transitions against reader()'s own respawn decision, so a
  // stop() racing an in-flight respawn can never hang shutdown or SIGTERM a stale/wrong pid.
  std::mutex life_m_;
  std::thread t_;
};
}  // namespace kc
