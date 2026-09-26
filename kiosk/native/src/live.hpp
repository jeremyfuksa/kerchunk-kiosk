// Live DSP loop: the single place commands meet the sample stream. Runs on the DSP thread only.
#pragma once
#include <array>
#include <cstdint>
#include <functional>
#include <optional>

#include "constants.hpp"
#include "engine.hpp"
#include "protocol.hpp"
#include "spsc.hpp"

namespace kc {
// A block is at most IQ_BLOCK_BYTES of raw u8 IQ (<= 10 ms at any configured rate), with `n` (bytes,
// always even -- 2 bytes per complex sample) <= data.size(). A settle discard (LiveLoop::step)
// drops a whole block at a time, so a source must hand back full ~10 ms blocks, not split ones.
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
  virtual void set_center(double hz) = 0;
  virtual uint32_t generation() const = 0;
  virtual uint64_t take_dropped() = 0;
};

class LiveLoop {
 public:
  LiveLoop(Engine& e, IqSource& src, SpscQueue<Command>& cmds, int rate);
  bool step();
  bool quit() const { return eng_.quit(); }

 private:
  Engine& eng_;
  IqSource& src_;
  SpscQueue<Command>& cmds_;
  std::optional<TuneCmd> pending_;
  uint32_t want_gen_ = 0;
  long long settle_left_ = 0;
  const long long settle_samples_;
};
}  // namespace kc
