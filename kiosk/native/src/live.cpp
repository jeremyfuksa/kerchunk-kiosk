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
      // A `known` command that lands while a tune is pending would otherwise apply to the engine's
      // *current* (soon-to-be-replaced) window, then get silently clobbered the moment the pending
      // tune's own (older) knownHz applies -- fold it into the pending tune so the new list survives
      // past the retune. Still forward it to the engine too: harmless for the window that's on its
      // way out, and it keeps `known` behaving immediately for anyone not mid-retune.
      if (pending_) {
        if (auto* k = std::get_if<KnownCmd>(&c)) pending_->known_hz = k->known_hz;
      }
      eng_.command(c);
    }
  }
  if (const uint64_t d = src_.take_dropped()) eng_.note_gap((long long)d, true);
  return src_.consume([this](const IqBlock& b) {
    // Defensive clamp: never trust a producer's block size blindly (a garbled/stale block should
    // degrade to "fewer samples", never read past `data`, and never leave n odd -- 2 bytes/sample).
    uint32_t bytes = b.n > (uint32_t)b.data.size() ? (uint32_t)b.data.size() : b.n;
    bytes &= ~1u;
    const long long n = bytes / 2;
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
