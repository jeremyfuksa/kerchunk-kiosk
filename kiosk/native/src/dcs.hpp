// DCS (Digital-Coded Squelch, a.k.a. CDCSS / DPL) for one FM lane: the lane's SubaudioDecimator
// output (SUBAUDIO_RATE) in, the stable DCS code out. Knobs: constants.hpp (DCS_*).
//
// Signal (ETSI TS 103 236; cross-checked below): a 23-bit Golay(23,12) codeword sent back to back,
// NRZ at 134.4 bit/s on the FM deviation. 12 data bits = the 9-bit code (three octal digits, C1 =
// LSB) then the fixed 0,0,1; then 11 parity bits. On air the LSB goes first ("the first bit
// transmitted is the LSB", sigidwiki.com/wiki/Digital-Coded_Squelch_(DCS)), so with bit i = the
// i-th bit sent, the word is  data | 0x800 | parity << 12  -- the layout of dcs.c in the Quansheng
// UV-K5 firmware (github.com/DualTachyon/uv-k5-firmware, DCS_CalculateGolay / DCS_GetGolayCodeWord),
// whose parity LFSR this file reproduces. Every such word is a multiple of the Golay generator
// g(x) = x^11+x^10+x^6+x^5+x^4+x^2+1 (0xC75) with bit i = coefficient of x^i, so the code is cyclic:
// any 23-bit window of the repeating word is a rotation of a codeword. Published check values
// (test_dcs.cpp): 023N = 0x763813 (UV-K5), and its time-ordered value 6557239 in sdrtrunk's
// DCSCode.N023 (github.com/DSheirer/sdrtrunk, "as defined in ETSI TS 103 236"). Normal polarity:
// a 1 bit is a positive frequency deviation (positive discriminator); Inverted flips every bit.
//
// Aliasing: the all-ones word is itself a Golay codeword, so every inverted code is a rotation of
// some other normal code (023I == 047N, 023N == 047I, the standard "inversion pair" table). The
// 104 standard codes x {N, I} therefore form exactly 104 on-air classes, one normal code each; the
// detector reports that normal member (dcs_canonical) and gating compares canonical forms.
#pragma once
#include <array>
#include <cstdint>
#include <optional>
#include <string>
#include <vector>

#include "constants.hpp"
#include "fir.hpp"

namespace kc {
// The 104 standard DCS codes, as octal literals (023 == octal 23). Mirrored in Node:
// src/backend/config/dcs.ts.
inline constexpr std::array<uint16_t, 104> DCS_CODES = {
    0023, 0025, 0026, 0031, 0032, 0036, 0043, 0047, 0051, 0053, 0054, 0065, 0071, 0072, 0073,
    0074, 0114, 0115, 0116, 0122, 0125, 0131, 0132, 0134, 0143, 0145, 0152, 0155, 0156, 0162,
    0165, 0172, 0174, 0205, 0212, 0223, 0225, 0226, 0243, 0244, 0245, 0246, 0251, 0252, 0255,
    0261, 0263, 0265, 0266, 0271, 0274, 0306, 0311, 0315, 0325, 0331, 0332, 0343, 0346, 0351,
    0356, 0364, 0365, 0371, 0411, 0412, 0413, 0423, 0431, 0432, 0445, 0446, 0452, 0454, 0455,
    0462, 0464, 0465, 0466, 0503, 0506, 0516, 0523, 0526, 0532, 0546, 0565, 0606, 0612, 0624,
    0627, 0631, 0632, 0654, 0662, 0664, 0703, 0712, 0723, 0731, 0732, 0734, 0743, 0754};

struct DcsCode {
  uint16_t code = 0;       // 9-bit value of the three octal digits (023 -> 19)
  bool inverted = false;   // "I" polarity
  bool operator==(const DcsCode& o) const { return code == o.code && inverted == o.inverted; }
  bool operator!=(const DcsCode& o) const { return !(*this == o); }
};

inline constexpr uint32_t DCS_WORD_MASK = (1u << DCS_WORD_BITS) - 1;
// The on-air 23-bit word, bit i = i-th bit sent (N polarity: 1 = positive deviation).
uint32_t dcs_word(DcsCode c);
// Rotate a 23-bit word one bit (the window one bit later reads the next rotation).
inline uint32_t dcs_rotate(uint32_t w) { return ((w >> 1) | ((w & 1u) << (DCS_WORD_BITS - 1))) & DCS_WORD_MASK; }
// The normal-polarity standard code that is on-air identical to c (c itself when c is normal).
// c must be a standard code.
DcsCode dcs_canonical(DcsCode c);
bool dcs_is_standard(uint16_t code);
// "023N" / "023I" <-> DcsCode. parse rejects anything else, including non-standard codes.
std::optional<DcsCode> dcs_parse(const std::string& s);
std::string dcs_format(DcsCode c);

class DcsDetector {
 public:
  DcsDetector();
  // sub: n samples at SUBAUDIO_RATE (SubaudioDecimator::push output).
  void push(const float* sub, int n);
  // The detected code, canonical (normal-polarity) form, once the same code has matched exactly on
  // DCS_MATCH_PERIODS consecutive 23-bit periods; cleared by the first bit whose 23-bit window no
  // longer matches it (the Scanner's DCS_LOSS_MS rides through that).
  std::optional<DcsCode> code() const { return code_; }
  // Cheap when already reset (Engine calls it every hop on lanes the detector is idle on).
  void reset();

 private:
  void on_bit(bool bit);

  static constexpr int kDcLen = (int)(SUBAUDIO_RATE * DCS_WORD_BITS / DCS_BITRATE + 0.5);   // one word
  FirFilter lpf_;
  std::vector<float> dc_ring_;   // kDcLen LPF outputs: the moving average over one word is the DC
  double dc_sum_ = 0;
  int dc_pos_ = 0, dc_fill_ = 0;
  double phase_ = 0;             // bit clock, in bits; a bit ends when it reaches 1
  float prev_ = 0;
  bool primed_ = false;
  float acc_ = 0;                // integrate-and-dump over the current bit
  uint32_t reg_ = 0;             // last 23 bits, newest at bit 22 (so the oldest is bit 0 = sent first)
  long long bits_ = 0;
  std::array<int, DCS_WORD_BITS> hist_class_{};   // per bit phase: class matched there ...
  std::array<int, DCS_WORD_BITS> hist_count_{};   // ... on this many consecutive periods
  int locked_ = -1, since_lock_ = 0;
  std::optional<DcsCode> code_;
  bool dirty_ = false;
};
}  // namespace kc
