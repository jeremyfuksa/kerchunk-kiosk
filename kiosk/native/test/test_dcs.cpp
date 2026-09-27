#include <cmath>
#include <optional>
#include <random>
#include <set>
#include <string>
#include <vector>

#include "check.hpp"
#include "constants.hpp"
#include "ctcss.hpp"
#include "dcs.hpp"
#include "subaudio.hpp"

namespace {
kc::DcsCode N(uint16_t c) { return {c, false}; }
kc::DcsCode I(uint16_t c) { return {c, true}; }

// Bit-reverse a 23-bit word: sdrtrunk stores the first-received bit as the MSB.
uint32_t rev23(uint32_t w) {
  uint32_t r = 0;
  for (int i = 0; i < 23; i++) r |= ((w >> i) & 1u) << (22 - i);
  return r;
}
// Remainder of a 23-bit word (bit i = coefficient of x^i) modulo the Golay generator 0xC75.
uint32_t mod_golay(uint32_t w) {
  for (int b = 22; b >= 11; b--)
    if ((w >> b) & 1u) w ^= 0xC75u << (b - 11);
  return w;
}

// Discriminator-scale signal (+-1.0 == FM_MAX_DEV_HZ) at LANE_RATE, like test_ctcss.cpp.
struct Disc {
  std::vector<float> x;
  explicit Disc(double seconds) : x((size_t)(seconds * kc::LANE_RATE), 0.f) {}
  // DCS NRZ, LSB of the on-air word first, 1 = +dev_hz (normal; an inverted code's word is already
  // flipped by dcs_word). rate_err scales the bit rate (encoder crystal error); t_off shifts the
  // word so the stream starts mid-word.
  Disc& dcs(kc::DcsCode c, double dev_hz, double t0 = 0, double t1 = 1e9, double rate_err = 0, double t_off = 0.37) {
    const uint32_t w = kc::dcs_word(c);
    const double a = dev_hz / kc::FM_MAX_DEV_HZ, br = kc::DCS_BITRATE * (1 + rate_err);
    for (size_t i = (size_t)(t0 * kc::LANE_RATE); i < x.size() && i < t1 * kc::LANE_RATE; i++) {
      const long long b = (long long)(((double)i / kc::LANE_RATE + t_off) * br);
      x[i] += (float)(((w >> (b % 23)) & 1u) ? a : -a);
    }
    return *this;
  }
  Disc& tone(double hz, double dev_hz) {
    const double a = dev_hz / kc::FM_MAX_DEV_HZ;
    for (size_t i = 0; i < x.size(); i++) x[i] += (float)(a * std::sin(2 * M_PI * hz * (double)i / kc::LANE_RATE));
    return *this;
  }
  Disc& offset(double hz) {   // carrier frequency error: DC on the discriminator
    for (auto& v : x) v += (float)(hz / kc::FM_MAX_DEV_HZ);
    return *this;
  }
  Disc& noise(double sigma, unsigned seed) {
    std::mt19937 g(seed);
    std::normal_distribution<float> d(0.f, (float)sigma);
    for (auto& v : x) v += d(g);
    return *this;
  }
  // Same voice model as test_ctcss.cpp: 300-3000 Hz partials, 4 Hz syllables, ~3 kHz peak dev.
  Disc& voice(unsigned seed) {
    std::mt19937 g(seed);
    std::uniform_real_distribution<double> ph(0, 2 * M_PI);
    const double f[] = {320, 470, 710, 1150, 1800, 2600};
    double p[6];
    for (double& v : p) v = ph(g);
    for (size_t i = 0; i < x.size(); i++) {
      const double t = (double)i / kc::LANE_RATE;
      const double env = 0.5 + 0.5 * std::sin(2 * M_PI * 4 * t);
      double s = 0;
      for (int k = 0; k < 6; k++) s += (0.3 + f[k] / 3000) * std::sin(2 * M_PI * f[k] * t + p[k]);
      x[i] += (float)(0.12 * env * s);
    }
    return *this;
  }
};

// Feed 10 ms pieces through the shared decimator (as Engine does); record code() after each.
struct Run {
  std::vector<std::optional<kc::DcsCode>> seen;
  double first = -1;
};
Run run(kc::DcsDetector& d, const Disc& s) {
  Run r;
  const int piece = kc::LANE_RATE / 100;
  kc::SubaudioDecimator dec;
  std::vector<float> sub(kc::SubaudioDecimator::max_out(piece));
  for (size_t i = 0; i < s.x.size(); i += piece) {
    const int ns = dec.push(&s.x[i], (int)std::min<size_t>(piece, s.x.size() - i), sub.data());
    d.push(sub.data(), ns);
    r.seen.push_back(d.code());
    if (d.code() && r.first < 0) r.first = (double)(i + piece) / kc::LANE_RATE;
  }
  return r;
}
// Fraction of pieces from `from` on that read exactly `c`; and whether any piece read anything else.
double hit_rate(const Run& r, kc::DcsCode c, size_t from) {
  size_t n = 0, hit = 0;
  for (size_t k = from; k < r.seen.size(); k++, n++) if (r.seen[k] && *r.seen[k] == c) hit++;
  return n ? (double)hit / (double)n : 0;
}
bool only(const Run& r, kc::DcsCode c) {
  for (auto& s : r.seen) if (s && *s != c) return false;
  return true;
}
bool never(const Run& r) {
  for (auto& s : r.seen) if (s) return false;
  return true;
}
}  // namespace

// ---- The codeword table, against published values (not just self-consistency).

TEST(dcs_words_match_published_codewords) {
  // UV-K5 firmware dcs.c: DCS_GetGolayCodeWord(023 N) = 0x763813 (bit 0 = first bit on air).
  CHECK(kc::dcs_word(N(023)) == 0x763813u);
  // sdrtrunk DCSCode (ETSI TS 103 236 values, first-received bit as MSB): N023, N047, N754.
  CHECK(rev23(kc::dcs_word(N(023))) == 6557239u);
  CHECK(rev23(kc::dcs_word(N(047))) == 7474680u);
  CHECK(rev23(kc::dcs_word(N(0754))) == 1822594u);
  CHECK(kc::dcs_word(I(023)) == (0x763813u ^ 0x7FFFFFu));
  for (uint16_t c : kc::DCS_CODES) {
    const uint32_t w = kc::dcs_word(N(c));
    CHECK(mod_golay(w) == 0);                        // a codeword of g(x) = 0xC75
    CHECK((w & 0x1FFu) == c && ((w >> 9) & 7u) == 4u);   // code bits C1..C9, then 0,0,1
  }
}

TEST(dcs_inversion_pairs_alias_to_one_normal_code) {
  // The standard inversion-pair table: 023 <-> 047, 025 <-> 244, 754 <-> 116.
  CHECK(kc::dcs_canonical(I(023)) == N(047));
  CHECK(kc::dcs_canonical(I(047)) == N(023));
  CHECK(kc::dcs_canonical(I(025)) == N(0244));
  CHECK(kc::dcs_canonical(I(0754)) == N(0116));
  CHECK(kc::dcs_canonical(N(023)) == N(023));
  std::set<int> normals;
  for (uint16_t c : kc::DCS_CODES) {
    const auto k = kc::dcs_canonical(I(c));
    CHECK(!k.inverted && kc::dcs_is_standard(k.code) && k.code != c);
    CHECK(kc::dcs_canonical(I(k.code)) == N(c));   // pairs are symmetric
    normals.insert(c);
  }
  CHECK(normals.size() == 104);
}

TEST(dcs_parse_and_format) {
  CHECK(kc::dcs_parse("023N") && *kc::dcs_parse("023N") == N(023));
  CHECK(kc::dcs_parse("754I") && *kc::dcs_parse("754I") == I(0754));
  CHECK(kc::dcs_format(N(023)) == "023N" && kc::dcs_format(I(0754)) == "754I");
  for (const char* bad : {"024N", "23N", "023", "023X", "0238", "023n", "", "0023N", "823N"})
    CHECK(!kc::dcs_parse(bad));
  for (uint16_t c : kc::DCS_CODES) {
    CHECK(kc::dcs_parse(kc::dcs_format(N(c))) == N(c));
    CHECK(kc::dcs_parse(kc::dcs_format(I(c))) == I(c));
  }
}

// ---- Detection on a synthetic discriminator.

TEST(dcs_detects_several_codes) {
  const kc::DcsCode codes[] = {N(023), N(0754), N(0411), N(0143), N(0265)};
  unsigned seed = 1;
  for (auto c : codes) {
    kc::DcsDetector d;
    auto r = run(d, Disc(2.0).dcs(c, 600).noise(0.05, seed++));
    CHECK(r.first > 0 && r.first <= 0.7);
    CHECK(hit_rate(r, c, 70) == 1.0);   // from 700 ms on: steady
    CHECK(only(r, c));
  }
}

TEST(dcs_normal_and_inverted_distinguished) {
  kc::DcsDetector a, b;
  auto rn = run(a, Disc(2.0).dcs(N(023), 600).noise(0.05, 11));
  auto ri = run(b, Disc(2.0).dcs(I(023), 600).noise(0.05, 12));
  CHECK(hit_rate(rn, N(023), 70) == 1.0 && only(rn, N(023)));
  // 023I is on air what 047N is: the detector reports that canonical normal code, never 023N.
  CHECK(hit_rate(ri, kc::dcs_canonical(I(023)), 70) == 1.0 && only(ri, N(047)));
}

TEST(dcs_under_voice_noise_and_offset) {
  kc::DcsDetector d;
  auto r = run(d, Disc(5.0).dcs(N(0245), 600).voice(4).noise(0.3, 5).offset(1500));
  CHECK(r.first > 0 && r.first <= 1.0);
  CHECK(only(r, N(0245)));
  CHECK(hit_rate(r, N(0245), 100) > 0.9);   // bit errors may blank a few 10 ms pieces, never a wrong code
}

TEST(dcs_low_deviation_and_rate_error) {
  for (double err : {-0.01, 0.01}) {
    kc::DcsDetector d;
    auto r = run(d, Disc(3.0).dcs(N(0632), 400, 0, 1e9, err).voice(7).noise(0.1, 8));
    CHECK(r.first > 0 && r.first <= 1.0);
    CHECK(only(r, N(0632)) && hit_rate(r, N(0632), 100) > 0.9);
  }
}

TEST(dcs_no_code_never_detects) {
  kc::DcsDetector a, b, c, e;
  CHECK(never(run(a, Disc(20.0).voice(6).noise(0.05, 7))));
  CHECK(never(run(b, Disc(20.0).noise(0.5, 8))));   // unquieted: heavy discriminator noise
  CHECK(never(run(c, Disc(5.0))));                  // dead-silent carrier
  CHECK(never(run(e, Disc(5.0).offset(2000))));     // silent, off-frequency
  for (float hz : kc::CTCSS_TONES) {                // a CTCSS user is never a DCS code
    kc::DcsDetector d;
    CHECK(never(run(d, Disc(2.0).tone(hz, 600).voice(9).noise(0.05, 10))));
  }
}

TEST(dcs_loss_clears_and_reset_forgets) {
  kc::DcsDetector d;
  auto r = run(d, Disc(3.0).dcs(N(0212), 600, 0, 1.5).noise(0.05, 14));
  CHECK(r.seen[140] && *r.seen[140] == N(0212));
  size_t cleared = 0;
  for (size_t k = 150; k < r.seen.size(); k++) if (!r.seen[k]) { cleared = k; break; }
  CHECK(cleared > 0 && cleared <= 150 + 25);   // within ~250 ms of key-up (<= one word + filters)
  CHECK(never(Run{{r.seen.begin() + 180, r.seen.end()}, -1}));
  kc::DcsDetector e;
  run(e, Disc(1.0).dcs(N(023), 600));
  CHECK(e.code().has_value());
  e.reset();
  CHECK(!e.code().has_value());
  CHECK(never(run(e, Disc(0.3).dcs(N(023), 600))));   // needs two fresh periods after reset
}
