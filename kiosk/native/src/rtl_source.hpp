// RTL-SDR input: librtlsdr async reads -> SPSC ring of <= 10 ms IQ blocks tagged with a generation.
#pragma once
#include <rtl-sdr.h>

#include <atomic>
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
  bool open(std::string& err);
  void start();
  void stop();
  double seconds_since_rx() const;
  bool consume(const std::function<void(const IqBlock&)>& use) override { return ring_.try_consume(use); }
  void set_center(double hz) override;
  uint32_t generation() const override { return gen_.load(); }
  uint64_t take_dropped() override { return dropped_.exchange(0); }

 private:
  static void on_samples(unsigned char* buf, uint32_t len, void* ctx);
  Options o_;
  LogFn log_;
  rtlsdr_dev_t* dev_ = nullptr;
  SpscQueue<IqBlock> ring_{IQ_RING_BLOCKS};
  std::atomic<uint32_t> gen_{0};
  std::atomic<uint64_t> dropped_{0};
  std::atomic<long long> last_rx_ns_{0};
  size_t block_bytes_;
  std::thread t_;
  std::atomic<bool> running_{false};
};
}  // namespace kc
