// Live DSP loop: the single place commands meet the sample stream. Runs on the DSP thread only.
#pragma once
#include <array>
#include <cstdint>
#include <functional>
#include <optional>
#include <string>

#include "constants.hpp"
#include "engine.hpp"
#include "protocol.hpp"
#include "spsc.hpp"

namespace kc {
// A block is at most IQ_BLOCK_BYTES of raw u8 IQ (<= 10 ms at any configured rate), with `n` (bytes,
// always even -- 2 bytes per complex sample) <= data.size(). A settle discard (LiveLoop::step)
// drops a whole block at a time, and the ring depth (IQ_RING_BLOCKS) is counted in blocks, so a
// source hands back full 10 ms blocks (RtlSource coalesces its ~3.4 ms USB transfers into them).
// The one exception is a generation boundary: a partial block is flushed early so no block ever
// mixes samples from two generations.
// LiveLoop still clamps defensively rather than trusting this contract blindly -- see step().
struct IqBlock {
  uint32_t gen = 0;
  uint32_t n = 0;   // bytes (2 per complex sample); see the block-size contract above
  std::array<uint8_t, IQ_BLOCK_BYTES> data;
};

// Non-blocking source of u8 IQ blocks feeding the DSP thread. consume() invokes `use` with at most
// one block per call (false if none available yet); set_center()/generation() implement the retune
// handshake LiveLoop drives (see step()); take_dropped() reports ring-overrun IQ samples lost since
// the last call.
class IqSource {
 public:
  virtual ~IqSource() = default;
  virtual bool consume(const std::function<void(const IqBlock&)>& use) = 0;
  // false = the new center didn't take (RTL: refused after retries; SpyServer: the send failed): the
  // loop fails rather than demodulate the old window as if it were the new one.
  virtual bool set_center(double hz) = 0;
  virtual uint32_t generation() const = 0;
  virtual uint64_t take_dropped() = 0;
  // IQ samples the source itself threw away at a retune since the last call, at the DSP rate. Not an
  // overrun, but wall time all the same: the speaker has to be fed through it.
  virtual uint64_t take_discarded() { return 0; }
};

// A real radio: the part of a source run_live drives that a test double doesn't need.
class DeviceSource : public IqSource {
 public:
  virtual bool open(std::string& err, const std::function<bool()>& should_stop) = 0;
  virtual void start() = 0;
  virtual void stop() = 0;
  virtual double seconds_since_rx() const = 0;
  virtual double stall_limit_s() const { return STALL_S; }   // no samples this long = lost radio, exit 3
};

class LiveLoop {
 public:
  LiveLoop(Engine& e, IqSource& src, SpscQueue<Command>& cmds, int rate);
  bool step();
  bool quit() const { return eng_.quit(); }
  bool failed() const { return failed_; }   // a retune failed: the caller exits (3) so Node respawns

 private:
  Engine& eng_;
  IqSource& src_;
  SpscQueue<Command>& cmds_;
  std::optional<TuneCmd> pending_;
  uint32_t want_gen_ = 0;
  long long settle_left_ = 0;
  bool failed_ = false;
  const long long settle_samples_;
};
}  // namespace kc
