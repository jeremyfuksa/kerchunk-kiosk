// Per-lane demodulators at LANE_RATE.
#pragma once
#include <complex>
#include <string>

#include "constants.hpp"
#include "fir.hpp"
#include "meters.hpp"

namespace kc {
using cf = std::complex<float>;

// Lane demodulator kind, from the tune channel's "mode" ("am"; anything else is FM).
// Ext is the speaker's external PCM source (pcmIn tunes) -- never a lane, never from a tune's mode.
enum class Demod { Fm, Am, Ext };
inline Demod demod_for(const std::string& mode) { return mode == "am" ? Demod::Am : Demod::Fm; }
inline const char* demod_name(Demod d) { return d == Demod::Am ? "am" : d == Demod::Ext ? "ext" : "fm"; }

// FM discriminator: arg(x[n] * conj(x[n-1])), scaled so +-1.0 == +-FM_MAX_DEV_HZ.
// The first sample after reset only primes the history and outputs 0, so an arbitrary
// starting phase can't inject a +-pi impulse into the quieting meter.
class FmDiscriminator {
 public:
  float step(cf x);
  void reset() { primed_ = false; }

 private:
  cf prev_{0, 0};
  bool primed_ = false;
};

// AM: envelope normalized by its own slow average (the carrier), DC removed:
// out = |x| / carrier - 1, so loudness is independent of RF level.
class AmEnvelope {
 public:
  float step(cf x);
  void reset() { primed_ = false; }

 private:
  float carrier_ = 0;
  bool primed_ = false;
};

// One-pole de-emphasis, tau = DEEMPH_TAU_S at LANE_RATE, unity DC gain.
class Deemphasis {
 public:
  float step(float x);
  void reset() { y_ = 0; }

 private:
  float y_ = 0;
};

// Quieting squelch input: HF-noise power of the discriminator output
// (HPF above NOISE_HPF_HZ, mean square over NOISE_WINDOW).
class QuietingMeter {
 public:
  QuietingMeter();
  bool push(float disc) { return ms_.push(hpf_.step(disc)); }
  float db() const { return ms_.db(); }
  bool ready() const { return ms_.ready(); }
  void reset() { hpf_.reset(); ms_.reset(); }

 private:
  FirFilter hpf_;
  MeanSquare ms_;
};
}  // namespace kc
