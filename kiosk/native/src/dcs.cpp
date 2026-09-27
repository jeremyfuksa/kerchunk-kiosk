#include "dcs.hpp"

#include <algorithm>
#include <cmath>
#include <utility>

namespace kc {
namespace {
// Golay(23,12) parity, bit-exact with the UV-K5 firmware's DCS_CalculateGolay (see dcs.hpp): the
// 12 data bits in, data | parity << 12 out. Equivalent to making the word a multiple of 0xC75.
uint32_t golay23(uint32_t data12) {
  uint32_t w = data12;
  for (int i = 0; i < 12; i++) {
    w <<= 1;
    if (w & 0x1000) w ^= 0x08EA;
  }
  return data12 | ((w & 0x0FFE) << 11);
}

// Every rotation of every standard normal code's word -> index into DCS_CODES, sorted by word
// for binary search. 104 x 23 = 2392 entries, all distinct (104 disjoint on-air classes).
using Entry = std::pair<uint32_t, int>;
const std::vector<Entry>& table() {
  static const std::vector<Entry> t = [] {
    std::vector<Entry> v;
    v.reserve(DCS_CODES.size() * DCS_WORD_BITS);
    for (int k = 0; k < (int)DCS_CODES.size(); k++) {
      uint32_t w = dcs_word({DCS_CODES[k], false});
      for (int r = 0; r < DCS_WORD_BITS; r++, w = dcs_rotate(w)) v.push_back({w, k});
    }
    std::sort(v.begin(), v.end());
    return v;
  }();
  return t;
}

// Class (DCS_CODES index of the canonical normal code) of a received 23-bit window, or -1.
int lookup(uint32_t w) {
  const auto& t = table();
  auto it = std::lower_bound(t.begin(), t.end(), Entry{w, -1});
  return it != t.end() && it->first == w ? it->second : -1;
}
}  // namespace

uint32_t dcs_word(DcsCode c) {
  const uint32_t w = golay23((c.code & 0x1FFu) | 0x800u);
  return c.inverted ? w ^ DCS_WORD_MASK : w;
}

bool dcs_is_standard(uint16_t code) {
  return std::find(DCS_CODES.begin(), DCS_CODES.end(), code) != DCS_CODES.end();
}

DcsCode dcs_canonical(DcsCode c) {
  if (!c.inverted) return c;
  const int k = lookup(dcs_word(c));
  return k >= 0 ? DcsCode{DCS_CODES[k], false} : c;
}

std::optional<DcsCode> dcs_parse(const std::string& s) {
  if (s.size() != 4 || (s[3] != 'N' && s[3] != 'I')) return std::nullopt;
  uint16_t v = 0;
  for (int i = 0; i < 3; i++) {
    if (s[i] < '0' || s[i] > '7') return std::nullopt;
    v = (uint16_t)(v * 8 + (s[i] - '0'));
  }
  if (!dcs_is_standard(v)) return std::nullopt;
  return DcsCode{v, s[3] == 'I'};
}

std::string dcs_format(DcsCode c) {
  std::string s(4, '0');
  s[0] = (char)('0' + ((c.code >> 6) & 7));
  s[1] = (char)('0' + ((c.code >> 3) & 7));
  s[2] = (char)('0' + (c.code & 7));
  s[3] = c.inverted ? 'I' : 'N';
  return s;
}

DcsDetector::DcsDetector()
    : lpf_(design_lowpass(SUBAUDIO_RATE, DCS_LPF_HZ, DCS_LPF_TRANSITION_HZ)), dc_ring_(kDcLen, 0.f) {
  (void)table();   // build the shared rotation table here, not on the first decoded bit
  hist_class_.fill(-1);
}

void DcsDetector::reset() {
  if (!dirty_) return;
  lpf_.reset();
  std::fill(dc_ring_.begin(), dc_ring_.end(), 0.f);
  dc_sum_ = 0;
  dc_pos_ = dc_fill_ = 0;
  phase_ = 0;
  prev_ = 0;
  primed_ = false;
  acc_ = 0;
  reg_ = 0;
  bits_ = 0;
  hist_class_.fill(-1);
  hist_count_.fill(0);
  locked_ = -1;
  since_lock_ = 0;
  code_.reset();
  dirty_ = false;
}

void DcsDetector::push(const float* sub, int n) {
  dirty_ = true;
  constexpr double step = DCS_BITRATE / SUBAUDIO_RATE;   // bits per sample (~0.134)
  for (int i = 0; i < n; i++) {
    const float y = lpf_.step(sub[i]);
    // DC (carrier offset) out: subtract the mean over the last word period.
    dc_sum_ += y - dc_ring_[dc_pos_];
    dc_ring_[dc_pos_] = y;
    dc_pos_ = (dc_pos_ + 1) % kDcLen;
    if (dc_fill_ < kDcLen) dc_fill_++;
    const float x = y - (float)(dc_sum_ / dc_fill_);

    phase_ += step;
    // Zero crossing = a bit boundary, which the clock wants at phase 0 (mod 1). Interpolate where
    // between the previous sample and this one it crossed and pull the clock by a fraction of the
    // phase error there.
    if (primed_ && ((x >= 0) != (prev_ >= 0))) {
      const double frac = prev_ / (double)(prev_ - x);             // 0..1 from the previous sample
      double at = phase_ - (1.0 - frac) * step;                     // clock phase at the crossing
      at -= std::floor(at + 0.5);                                   // error, wrapped to [-0.5, 0.5)
      phase_ -= DCS_CLOCK_GAIN * at;
    }
    prev_ = x;
    primed_ = true;
    acc_ += x;
    if (phase_ >= 1.0) {
      phase_ -= 1.0;
      on_bit(acc_ > 0);
      acc_ = 0;
    }
  }
}

void DcsDetector::on_bit(bool bit) {
  reg_ = (reg_ >> 1) | ((uint32_t)bit << (DCS_WORD_BITS - 1));
  const int slot = (int)(bits_ % DCS_WORD_BITS);
  if (++bits_ < DCS_WORD_BITS) return;   // register not full yet
  const int m = lookup(reg_);
  // The same class at this bit phase one period ago extends the run; anything else restarts it.
  if (m >= 0 && hist_class_[slot] == m) hist_count_[slot]++;
  else hist_count_[slot] = m >= 0 ? 1 : 0;
  hist_class_[slot] = m;
  if (m >= 0 && hist_count_[slot] >= DCS_MATCH_PERIODS) locked_ = m;
  if (locked_ < 0) return;
  if (m == locked_) {
    since_lock_ = 0;
    code_ = DcsCode{DCS_CODES[locked_], false};
  } else {
    code_.reset();
    if (++since_lock_ > DCS_RELOCK_BITS) locked_ = -1;
  }
}
}  // namespace kc
