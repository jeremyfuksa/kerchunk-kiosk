// Output side of the live helper: event serialization, non-blocking fd pumps, and the ALSA writer.
#pragma once
#include <alsa/asoundlib.h>

#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <cstdio>
#include <deque>
#include <functional>
#include <mutex>
#include <nlohmann/json.hpp>
#include <string>
#include <thread>

#include "constants.hpp"
#include "spsc.hpp"

namespace kc {
using LogFn = std::function<void(const std::string&)>;

class EventOut {
 public:
  explicit EventOut(FILE* out) : out_(out) {}
  ~EventOut() { stop(); }
  void start();
  void stop();
  void emit(const nlohmann::json& ev);
  void log(const std::string& msg) { emit({{"ev", "log"}, {"msg", msg}}); }

 private:
  void run();
  FILE* out_;
  std::mutex m_;
  std::condition_variable cv_;
  std::deque<std::string> q_;
  bool running_ = false, stopping_ = false;
  std::thread t_;
};

struct JitterPolicy {
  static size_t drop_for(size_t queued) {
    return queued > (size_t)AUDIO_MAX_LAT ? queued - (size_t)AUDIO_TARGET_LAT : 0;
  }
};

class FdPump {
 public:
  FdPump(size_t capacity, LogFn log, std::string name) : ring_(capacity), log_(std::move(log)), name_(std::move(name)) {}
  ~FdPump() { stop(); }
  void set_fd(int fd);
  size_t write(const int16_t* x, size_t n) {
    const size_t w = ring_.write(x, n);
    if (w < n) dropped_.fetch_add(n - w, std::memory_order_relaxed);
    return w;
  }
  void start();
  void stop();
  uint64_t dropped() const { return dropped_.load(); }

 private:
  void run();
  SpscRing<int16_t> ring_;
  LogFn log_;
  std::string name_;
  std::atomic<int> fd_{-1};
  std::atomic<bool> running_{false};
  std::atomic<uint64_t> dropped_{0};
  bool failed_logged_ = false;
  std::thread t_;
};

class AlsaSink {
 public:
  AlsaSink(std::string device, LogFn log) : device_(std::move(device)), log_(std::move(log)), ring_(AUDIO_RING) {}
  ~AlsaSink() { stop(); }
  bool open(std::string& err);
  void start();
  void stop();
  size_t write(const int16_t* x, size_t n) { return ring_.write(x, n); }

 private:
  void run();
  std::string device_;
  LogFn log_;
  SpscRing<int16_t> ring_;
  snd_pcm_t* pcm_ = nullptr;
  std::atomic<bool> running_{false};
  std::thread t_;
};
}  // namespace kc
