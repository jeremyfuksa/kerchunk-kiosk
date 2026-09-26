// Output side of the live helper: event serialization, non-blocking fd pumps, and the ALSA writer.
#pragma once
#include <alsa/asoundlib.h>

#include <atomic>
#include <cerrno>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <cstdio>
#include <deque>
#include <functional>
#include <mutex>
#include <nlohmann/json.hpp>
#include <string>
#include <thread>
#include <vector>

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

// FdPump owns the lifetime of whatever fd it currently holds: set_fd only *publishes* a pending
// fd (+ whether the pump should own/close it); the pump thread swaps it in -- and closes the
// previous one, if it owned it -- itself, only ever between writes, never mid-write. Callers must
// never close an fd they handed to the pump with owned=true (review fix: a caller-side close
// racing the pump's in-flight write could hand the pump a recycled fd number and write PCM into
// an unrelated file). A caller that lends the pump an fd it does not own (e.g. the tee's fd 3)
// passes owned=false; the pump will drop that fd on handoff/stop without closing it.
class FdPump {
 public:
  FdPump(size_t capacity, LogFn log, std::string name) : ring_(capacity), log_(std::move(log)), name_(std::move(name)) {}
  ~FdPump() { stop(); }
  void set_fd(int fd, bool owned = true);
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
  std::atomic<bool> running_{false};
  std::atomic<uint64_t> dropped_{0};

  // fd handoff: producer/other threads only ever touch the "pending" side under fd_m_; the pump
  // thread alone reads/writes "cur_*" (and the byte-alignment carry), so no lock is needed there.
  std::mutex fd_m_;
  int pending_fd_ = -1;
  bool pending_owned_ = false;
  std::atomic<bool> pending_{false};
  int cur_fd_ = -1;
  bool cur_owned_ = false;
  bool failed_logged_ = false;
  bool have_carry_ = false;   // one buffered byte from a chunk we had to abandon mid-sample
  unsigned char carry_byte_ = 0;
  std::thread t_;
};

struct AlsaPolicy {
  enum class Action { Read, Silence, Wait };
  // Pure decision function (unit-tested in isolation): what should the ALSA writer thread do this
  // period, given how many samples are queued, whether it's currently recovering from an
  // underrun, and how long (ms) it has already spent in Wait for the current stretch of
  // 0 < queued < ALSA_PERIOD. The caller owns the `underrun`/`waited_ms` state across calls; this
  // function only reads them and reports what they should become (Read clears underrun and resets
  // the wait clock, Silence sets underrun, Wait leaves both as-is for the caller to keep timing).
  static Action decide(size_t queued, bool underrun, double waited_ms) {
    if (underrun) {
      // Don't resume until a full prebuffer exists -- resuming right at one period reopens the
      // underrun on the very next tick if the producer is still catching up.
      return queued >= (size_t)(2 * ALSA_PERIOD) ? Action::Read : Action::Silence;
    }
    if (queued >= (size_t)ALSA_PERIOD) return Action::Read;
    // 0 <= queued < ALSA_PERIOD while flowing (including an exact-zero ring): give the producer a
    // few ms to catch up before declaring an underrun -- a producer that happens to drain the ring
    // to exactly 0 between ticks is not yet an underrun, any more than a partial period is (a
    // stutter, not silence, is what a hair-trigger threshold buys you).
    return waited_ms >= 5.0 ? Action::Silence : Action::Wait;
  }
};

// Pure retry loop behind AlsaSink::open (unit-tested without a device). `attempt` returns 0 on
// success or a negative errno. -EBUSY/-EAGAIN retry every `interval_ms` until `timeout_s` has
// elapsed; any other error fails at once; `should_stop` (optional) is polled after each busy attempt.
// `last_rc` receives the final attempt's return code.
struct BusyRetry {
  enum class Result { Ok, Failed, TimedOut, Aborted };
  static Result run(const std::function<int()>& attempt, const std::function<bool()>& should_stop,
                    double timeout_s, int interval_ms, int& last_rc) {
    const auto t0 = std::chrono::steady_clock::now();
    for (;;) {
      last_rc = attempt();
      if (last_rc >= 0) return Result::Ok;
      if (last_rc != -EBUSY && last_rc != -EAGAIN) return Result::Failed;
      if (should_stop && should_stop()) return Result::Aborted;
      if (std::chrono::steady_clock::now() - t0 >= std::chrono::duration<double>(timeout_s)) return Result::TimedOut;
      std::this_thread::sleep_for(std::chrono::milliseconds(interval_ms));
    }
  }
};

class AlsaSink {
 public:
  AlsaSink(std::string device, LogFn log) : device_(std::move(device)), log_(std::move(log)), ring_(AUDIO_RING) {}
  ~AlsaSink() { stop(); }
  // Non-blocking open with a bounded busy retry (see BusyRetry / ALSA_BUSY_RETRY_S); should_stop
  // aborts the wait (err = "aborted"). Writes stay blocking once open.
  bool open(std::string& err, const std::function<bool()>& should_stop = {});
  void start();
  void stop();
  size_t write(const int16_t* x, size_t n) {
    const size_t w = ring_.write(x, n);
    if (w < n) overflow_.fetch_add(n - w, std::memory_order_relaxed);
    return w;
  }
  // Speaker-output losses since the last take_stats(): samples the full ring refused (DSP ahead of
  // the card), samples trimmed for SDR-vs-card clock drift, silence samples padded in on underrun
  // (card starved), and ALSA write errors (xruns) the writer recovered from.
  struct Stats { uint64_t overflow = 0, drift = 0, underrun = 0, xruns = 0; };
  Stats take_stats() {
    return {overflow_.exchange(0), drift_.exchange(0), underrun_.exchange(0), xruns_.exchange(0)};
  }
  // One log line, or "" when nothing was lost (samples at AUDIO_RATE).
  static std::string format_stats(const Stats& s, double window_s);

 private:
  void run();
  std::atomic<uint64_t> overflow_{0}, drift_{0}, underrun_{0}, xruns_{0};
  std::string device_;
  LogFn log_;
  SpscRing<int16_t> ring_;
  snd_pcm_t* pcm_ = nullptr;
  std::atomic<bool> running_{false};
  std::thread t_;
};
}  // namespace kc
