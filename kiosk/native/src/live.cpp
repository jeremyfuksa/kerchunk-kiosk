#include "live.hpp"

#include <cmath>

namespace kc {

LiveLoop::LiveLoop(Engine& e, IqSource& src, SpscQueue<Command>& cmds, int rate)
    : eng_(e), src_(src), cmds_(cmds), settle_samples_((long long)std::llround(rate * RETUNE_SETTLE_MS / 1000.0)) {}

bool LiveLoop::step() {
  // Commands drain here, between pushes -- never inside a hop -- so a retune can't reset the
  // channelizer underneath an in-progress hop.
  Command c;
  while (cmds_.try_pop(c)) {
    if (auto* t = std::get_if<TuneCmd>(&c)) {
      src_.set_center(t->center_hz);        // retune now; samples from the old center are still in flight
      want_gen_ = src_.generation();
      pending_ = *t;
      settle_left_ = settle_samples_;
    } else {
      eng_.command(c);
    }
  }
  if (const uint64_t d = src_.take_dropped()) eng_.note_gap((long long)d, true);
  return src_.consume([this](const IqBlock& b) {
    const long long n = b.n / 2;
    if (pending_) {
      if (b.gen < want_gen_) { eng_.note_gap(n, false); return; }     // old center
      if (settle_left_ > 0) { settle_left_ -= n; eng_.note_gap(n, false); return; }   // in-flight USB
      eng_.command(Command{*pending_});
      pending_.reset();
    }
    eng_.push_u8(b.data.data(), (size_t)n);
  });
}
}  // namespace kc
