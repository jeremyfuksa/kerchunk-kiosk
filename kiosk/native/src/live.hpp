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
struct IqBlock {
  uint32_t gen = 0;
  uint32_t n = 0;   // bytes (2 per complex sample)
  std::array<uint8_t, IQ_BLOCK_BYTES> data;
};

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
