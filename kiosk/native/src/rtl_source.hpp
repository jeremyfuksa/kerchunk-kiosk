// RTL-SDR input: librtlsdr async reads -> SPSC ring of 10 ms IQ blocks tagged with a generation.
#pragma once
#include <rtl-sdr.h>

#include <atomic>
#include <functional>
#include <string>
#include <thread>

#include "live.hpp"
#include "outputs.hpp"

namespace kc {
class RtlSource : public IqSource {
 public:
  struct Options { std::string serial; int index = -1; int rate = 2'400'000; std::string gain = "auto"; };
  RtlSource(Options o, LogFn log);
  ~RtlSource() override;
  // Opens the dongle (by serial, else index), retrying for BUSY_RETRY_S while a previous helper
  // releases it. `should_stop` is polled each retry; when it returns true open() gives up with
  // err = "aborted". Every other failure's err starts with "failed to open RTL-SDR" (Node's
  // NO_DEVICE classifier keys on that prefix).
  bool open(std::string& err, const std::function<bool()>& should_stop = {});
  void start();
  void stop();
  double seconds_since_rx() const;
  bool consume(const std::function<void(const IqBlock&)>& use) override { return ring_.try_consume(use); }
  void set_center(double hz) override;
  uint32_t generation() const override { return gen_.load(); }
  uint64_t take_dropped() override { return dropped_.exchange(0); }
  // librtlsdr's async callback (USB thread). Public so tests can drive it with fake buffers on a
  // source that was never opened.
  static void on_samples(unsigned char* buf, uint32_t len, void* ctx);

 private:
  void publish_acc();   // callback thread only
  std::string who() const;
  Options o_;
  LogFn log_;
  rtlsdr_dev_t* dev_ = nullptr;
  SpscQueue<IqBlock> ring_{IQ_RING_BLOCKS};
  std::atomic<uint32_t> gen_{0};
  std::atomic<uint64_t> dropped_{0};
  std::atomic<long long> last_rx_ns_{0};
  size_t block_bytes_;
  // Coalescing buffer: USB transfers (RTL_BUF_LEN, ~3.4 ms at 2.4 Msps) accumulate here until a
  // full block_bytes_ (10 ms) block exists. Touched only by the callback thread -- never shared.
  IqBlock acc_{};
  uint32_t acc_n_ = 0;
  std::thread t_;
  std::atomic<bool> running_{false};
  std::atomic<bool> async_done_{true};   // rtlsdr_read_async has returned (or never started)
};
}  // namespace kc
