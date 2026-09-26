// SAME/EAS decoding via a multimon-ng child: PCM in on stdin (non-blocking pump), text lines out.
#pragma once
#include <sys/types.h>

#include <atomic>
#include <nlohmann/json.hpp>
#include <string>
#include <thread>
#include <vector>

#include "outputs.hpp"

namespace kc {
class Multimon {
 public:
  using Emit = std::function<void(const nlohmann::json&)>;
  Multimon(std::vector<std::string> argv, Emit emit, LogFn log)
      : argv_(std::move(argv)), emit_(std::move(emit)), log_(std::move(log)), pump_(SAME_RING, log_, "multimon-ng") {}
  ~Multimon() { stop(); }
  bool start(std::string& err);
  size_t write(const int16_t* x, size_t n) { return pump_.write(x, n); }
  void stop();
  static bool is_same_line(const std::string& l) { return l.find("ZCZC") != std::string::npos || l.find("NNNN") != std::string::npos; }

 private:
  bool spawn(std::string& err);
  void reader();
  std::vector<std::string> argv_;
  Emit emit_;
  LogFn log_;
  FdPump pump_;
  std::atomic<pid_t> pid_{-1};
  std::atomic<int> out_fd_{-1};
  std::atomic<bool> running_{false};
  int respawns_ = 0;
  int stdin_fd_ = -1;
  std::thread t_;
};
}  // namespace kc
