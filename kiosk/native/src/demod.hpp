// Per-lane demodulators at LANE_RATE.
#pragma once
#include <complex>
#include <string>

#include "constants.hpp"
#include "fir.hpp"
#include "meters.hpp"

namespace kc {
using cf = std::complex<float>;

// Lane demodulator kind, from the tune channel's "mode" ("am", "lsb"; anything else is FM).
enum class Demod { Fm, Am, Lsb };
inline Demod demod_for(const std::string& mode) {
  return mode == "am" ? Demod::Am : mode == "lsb" ? Demod::Lsb : Demod::Fm;
}
inline const char* demod_name(Demod d) { return d == Demod::Am ? "am" : d == Demod::Lsb ? "lsb" : "fm"; }

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

// LSB: keeps only -SSB_HI_HZ..-SSB_LO_HZ of the lane. Output is the complex sideband signal at
// LANE_RATE: its power is the squelch's in-band energy, its real part is the audio (via SsbLevel).
class SsbDemod {
 public:
  SsbDemod();
  cf step(cf x);
  void reset();

 private:
  FirFilter dec_i_, dec_q_, ch_i_, ch_q_, int_i_, int_q_;
  double ph_ = 0;   // shift phase, radians
  int k_ = 0;       // decimation phase
};

// SSB speaker level: Re(x) over a peak-tracking envelope of |x| (fast attack, slow release), so
// a weak and a strong station reach the AGC at the same level. Primes on the first sample.
class SsbLevel {
 public:
  float step(cf x);
  void reset() { primed_ = false; }

 private:
  float env_ = 0;
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
