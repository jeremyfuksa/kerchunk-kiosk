// SpyServer input: TCP u8 IQ at 768 kHz -> 750 kHz -> SPSC ring of 10 ms blocks tagged with a
// generation, the same contract RtlSource gives LiveLoop.
#pragma once
#include <atomic>
#include <functional>
#include <string>
#include <thread>
#include <vector>

#include "iq_rate.hpp"
#include "live.hpp"
#include "outputs.hpp"
#include "spyserver_protocol.hpp"

struct addrinfo;

namespace kc {
class SpyServerSource : public DeviceSource {
 public:
  struct Options {
    std::string host;
    int port = 5555;
    int gain = -1;           // gain index; -1 = leave the server's setting
    int digital_gain = SPY_DIGITAL_GAIN_DEFAULT;   // base IQ digital gain; retunes step it (see below)
    // Name lookup, getaddrinfo's shape. Absent = getaddrinfo. Runs on its own thread and may finish long
    // after open() gave up, so it owns what it captures. Tests inject one.
    std::function<int(const std::string& host, const std::string& port, addrinfo** out)> resolve = nullptr;
  };
  SpyServerSource(Options o, LogFn log);
  ~SpyServerSource() override;
  // Connects and handshakes. Unreachable: err starts "failed to open SpyServer". Refused: err names
  // the reason ("SpyServer: no control", unexpected rate or format). One attempt: Node's respawn is the retry.
  bool open(std::string& err, const std::function<bool()>& should_stop) override;
  void start() override;
  void stop() override;
  double seconds_since_rx() const override;
  double stall_limit_s() const override { return SPY_STALL_S; }
  bool consume(const std::function<void(const IqBlock&)>& use) override { return ring_.try_consume(use); }
  bool set_center(double hz) override;   // false: a send failed, and the log says how far it got
  uint32_t generation() const override { return gen_.load(); }
  uint64_t take_dropped() override { return dropped_.exchange(0); }
  uint64_t take_discarded() override;

 private:
  bool send_bytes(const std::vector<uint8_t>& b);
  void on_iq(uint32_t flags, const uint8_t* iq, size_t bytes);
  void publish_acc();
  Options o_;
  LogFn log_;
  int fd_ = -1;
  spy::FrameParser parser_;
  IqRateConverter conv_;
  std::vector<uint8_t> out_;
  SpscQueue<IqBlock> ring_{IQ_RING_BLOCKS};
  std::atomic<uint32_t> gen_{0};
  std::atomic<uint64_t> dropped_{0};
  std::atomic<long long> last_rx_ns_{0};
  // A retune is confirmed in stream order: it also steps the digital gain, and IQ frames echo the gain.
  // Until the echo arrives the reader holds, and last_rx_ns_ stands still, so a server that ignores the
  // retune reads as a stall (exit 3) rather than the old window labelled as the new one.
  int marker_step_ = 0;                          // DSP thread only
  std::atomic<uint32_t> want_gain_{0};
  bool waiting_marker_ = false;                  // reader thread only
  int drop_frames_ = 0;                          // reader thread only
  std::atomic<uint64_t> discarded_in_{0};        // at the server's rate, reader to DSP thread
  uint64_t discard_rem_ = 0;                     // DSP thread only
  std::string send_fail_;                        // the last failed send; every send is on the thread calling open/start/set_center
  uint32_t reader_gen_ = 0;                      // reader thread only
  IqBlock acc_{};                                // reader thread only
  uint32_t acc_n_ = 0;
  std::thread t_;
  std::atomic<bool> running_{false};
};
}  // namespace kc
