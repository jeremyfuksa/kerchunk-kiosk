#include <cmath>
#include <vector>

#include "audio.hpp"
#include "check.hpp"
#include "constants.hpp"
#include "demod.hpp"
#include "signals.hpp"

namespace {
// Feed n lane samples of x through a SpeakerPath in 64-sample hops (as the engine does).
std::vector<float> run(kc::SpeakerPath& sp, const std::vector<sig::cf>& x, int lane) {
  kc::FmDiscriminator d;
  std::vector<float> out, disc(64);
  for (size_t i = 0; i + 64 <= x.size(); i += 64) {
    for (int k = 0; k < 64; k++) disc[k] = d.step(x[i + k]);
    bool feed = sp.feeding_lane() == lane;
    sp.process(feed ? &x[i] : nullptr, feed ? disc.data() : nullptr, 64, out);
  }
  return out;
}
}  // namespace

TEST(speaker_fm_level_and_rate) {
  kc::SpeakerPath sp;
  sp.set_source(0, false);
  sp.set_gain(1.0f);
  auto x = sig::fm_tone(kc::LANE_RATE, kc::LANE_RATE, 0, 3000, 1000, 0.3);
  auto y = run(sp, x, 0);
  CHECK(std::abs((int)y.size() - kc::AUDIO_RATE) <= 64);
  // 3 kHz dev -> 0.6 peak; 75 us de-emphasis at 1 kHz ~ -0.86 dB.
  CHECK_NEAR(sig::rms(y.data() + 4800, y.size() - 4800), 0.6 / std::sqrt(2.0) * 0.906, 0.02);
  CHECK(sp.speech_db() > -10 && sp.speech_db() < -7);   // ~-8.3 dB (0.384 rms)
}

TEST(speaker_gain_ramps_on_open_and_rail_clamps) {
  kc::SpeakerPath sp;
  sp.set_source(0, false);
  auto x = sig::tone(kc::LANE_RATE, kc::LANE_RATE / 2, 2500, 0.3);   // constant +0.5 discriminator output
  auto y0 = run(sp, x, 0);                                            // gain 0: silence
  CHECK(sig::rms(y0.data(), y0.size()) < 1e-6);
  sp.set_gain(4.0f);                                                  // 0.5 * 4 = 2 -> rail
  auto y = run(sp, x, 0);
  float peak = 0;
  for (float v : y) peak = std::max(peak, std::fabs(v));
  CHECK(peak <= kc::RAIL + 1e-6f);
  CHECK(std::fabs(y[10]) < std::fabs(y[kc::FADE_SAMPLES + 100]));   // ramping up, not a step
}

TEST(speaker_source_switch_fades_out_first) {
  kc::SpeakerPath sp;
  sp.set_source(0, false);
  sp.set_gain(1.0f);
  auto x = sig::fm_tone(kc::LANE_RATE, kc::LANE_RATE / 5, 0, 3000, 1000, 0.3);
  run(sp, x, 0);
  sp.set_source(1, false);
  CHECK(sp.feeding_lane() == 0);                  // still fading the old source
  std::vector<float> out, disc(64, 0.f);
  int hops = 0;
  while (sp.feeding_lane() == 0 && hops < 20) { sp.process(&x[0], disc.data(), 64, out); hops++; }
  CHECK(sp.feeding_lane() == 1);
  CHECK(hops >= 4 && hops <= 8);                  // ~6 ms fade = ~5 hops of 1.28 ms
}

TEST(speaker_silence_without_source_keeps_rate) {
  kc::SpeakerPath sp;
  std::vector<float> out;
  for (int i = 0; i < 781; i++) sp.process(nullptr, nullptr, 64, out);   // ~1 s
  CHECK(std::abs((int)out.size() - kc::AUDIO_RATE) <= 64);
  CHECK(sig::rms(out.data(), out.size()) == 0.0);
}

TEST(speaker_am_reprimes_on_open) {
  // Long near-silence on an AM lane, then a strong 50%-modulated carrier as the gate opens:
  // without re-priming, env/carrier starts huge (carrier tracked the noise) and slams the rail.
  kc::SpeakerPath sp;
  sp.set_source(0, true);
  std::vector<sig::cf> x(kc::LANE_RATE);
  for (size_t i = 0; i < x.size(); i++) {
    double a = i < x.size() / 2 ? 0.0005 : 0.2 * (1 + 0.5 * std::sin(2 * M_PI * 1000 * i / kc::LANE_RATE));
    x[i] = sig::cf((float)a, 0.f);
  }
  std::vector<float> out, disc(64, 0.f);
  const size_t half = x.size() / 2;
  for (size_t i = 0; i + 64 <= half; i += 64) sp.process(&x[i], disc.data(), 64, out);
  sp.set_gain(1.0f);
  out.clear();
  for (size_t i = half; i + 64 <= x.size(); i += 64) sp.process(&x[i], disc.data(), 64, out);
  const size_t first10ms = kc::AUDIO_RATE / 100;
  CHECK(sig::rms(out.data(), first10ms) < 0.4);   // not rail-slammed (0.8)
  CHECK_NEAR(sig::rms(out.data() + 4800, out.size() - 4800), 0.5 / std::sqrt(2.0) * kc::AM_GAIN, 0.04);
}

TEST(same_path_rate_and_scale) {
  kc::SamePath sp;
  std::vector<float> disc(kc::LANE_RATE);
  for (size_t i = 0; i < disc.size(); i++) disc[i] = 0.5f * (float)std::sin(2 * M_PI * 1000 * i / kc::LANE_RATE);
  std::vector<int16_t> out;
  for (size_t i = 0; i + 64 <= disc.size(); i += 64) sp.push(&disc[i], 64, out);
  CHECK(std::abs((int)out.size() - kc::SAME_RATE) <= 32);
  double s = 0;
  for (size_t i = 2000; i < out.size(); i++) s += (double)out[i] * out[i];
  double rms = std::sqrt(s / (out.size() - 2000)) / kc::SAME_S16_SCALE;
  CHECK_NEAR(rms, 0.5 / std::sqrt(2.0) * 0.906, 0.03);   // de-emphasis at 1 kHz
}

TEST(to_s16_clamps_and_scales) {
  std::vector<int16_t> o;
  float x[4] = {0.f, 0.5f, 2.f, -2.f};
  kc::to_s16(x, 4, 32767.f, o);
  CHECK(o.size() == 4 && o[0] == 0 && o[1] == 16384 && o[2] == 32767 && o[3] == -32768);
}

TEST(speaker_cut_ramps_held_sample_to_zero) {
  // Retune cut: GR faded out before a retune; a hard reset() would step from full scale to 0.
  kc::SpeakerPath sp;
  sp.set_source(0, false);
  sp.set_gain(1.0f);
  auto x = sig::fm_tone(kc::LANE_RATE, kc::LANE_RATE / 2, 0, 3000, 1000, 0.3);
  auto y = run(sp, x, 0);
  float steady = 0;   // max |delta| between consecutive samples in steady state
  for (size_t i = 4801; i < y.size(); i++) steady = std::max(steady, std::fabs(y[i] - y[i - 1]));
  // Cut on a sample well away from a zero crossing so a hard cut would be a real step.
  std::vector<float> disc(64);
  kc::FmDiscriminator d;
  size_t k = 0;
  while (std::fabs(y.back()) < 0.3f && k + 64 <= x.size()) {
    for (int j = 0; j < 64; j++) disc[j] = d.step(x[k + j]);
    sp.process(&x[k], disc.data(), 64, y);
    k += 64;
  }
  const float last = y.back();
  CHECK(std::fabs(last) >= 0.3f);
  sp.cut();
  CHECK(sp.feeding_lane() == -1);
  std::vector<float> out;
  for (int i = 0; i < 20; i++) sp.process(nullptr, nullptr, 64, out);
  CHECK(out.size() > (size_t)kc::FADE_SAMPLES + 100);
  CHECK(std::fabs(out[0] - last) <= std::max(steady, std::fabs(last) / kc::FADE_SAMPLES * 2));
  float worst = std::fabs(out[0] - last);
  for (int i = 1; i < kc::FADE_SAMPLES; i++) worst = std::max(worst, std::fabs(out[i] - out[i - 1]));
  CHECK(worst <= std::fabs(last) / kc::FADE_SAMPLES * 1.01f);
  bool zero = true;
  for (size_t i = kc::FADE_SAMPLES; i < out.size(); i++) zero = zero && out[i] == 0.f;
  CHECK(zero);
}

TEST(speaker_lpf_knob_passes_or_cuts_hf) {
  // 10 kHz tone straight into the discriminator input: GR-parity 20 kHz LPF passes it, a
  // voiceband 3.5 kHz knob setting removes it.
  std::vector<float> disc(kc::LANE_RATE / 2);
  for (size_t i = 0; i < disc.size(); i++) disc[i] = 0.5f * (float)std::sin(2 * M_PI * 10000 * i / kc::LANE_RATE);
  std::vector<kc::cf> x(disc.size());
  auto hf_rms = [&](kc::SpeakerPath& sp) {
    sp.set_source(0, false);
    sp.set_gain(1.0f);
    std::vector<float> out;
    for (size_t i = 0; i + 64 <= disc.size(); i += 64) sp.process(&x[i], &disc[i], 64, out);
    return sig::rms(out.data() + 4800, out.size() - 4800);
  };
  kc::SpeakerPath wide, narrow(3500);
  CHECK(hf_rms(wide) > 0.01);     // de-emphasized ~-13.6 dB but present (~0.074 rms)
  CHECK(hf_rms(narrow) < 0.002);
  CHECK_THROWS(kc::SpeakerPath(0));
  CHECK_THROWS(kc::SpeakerPath(kc::LANE_RATE / 2));
}
