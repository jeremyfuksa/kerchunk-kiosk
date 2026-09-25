// Batch cost of the DSP core on a .cu8 replay. demod=all: discriminator + quieting + speech meter
// on EVERY lane (always-on design); one: only lane 0; none: channelizer + power only.
// Lane 0 additionally runs the full speaker path (deemph -> audio LPF -> 50k->48k) in all/one modes.
#include <sys/resource.h>

#include <algorithm>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <vector>

#include "channelizer.hpp"
#include "demod.hpp"
#include "fir.hpp"
#include "meters.hpp"
#include "resampler.hpp"

static double cpu_seconds() {
  rusage u{};
  getrusage(RUSAGE_SELF, &u);
  return u.ru_utime.tv_sec + u.ru_utime.tv_usec / 1e6 + u.ru_stime.tv_sec + u.ru_stime.tv_usec / 1e6;
}

int main(int argc, char** argv) {
  std::string file, demod = "all";
  int rate = 2'400'000;
  std::vector<double> chans;
  for (int i = 1; i < argc; i++) {
    std::string k = argv[i];
    if (i + 1 >= argc) { std::fprintf(stderr, "missing value for %s\n", k.c_str()); return 2; }
    std::string v = argv[++i];
    if (k == "--file") file = v;
    else if (k == "--rate") rate = std::atoi(v.c_str());
    else if (k == "--chan") chans.push_back(std::atof(v.c_str()));
    else if (k == "--demod") demod = v;
    else { std::fprintf(stderr, "unknown arg %s\n", k.c_str()); return 2; }
  }
  if (file.empty() || chans.empty() || (demod != "all" && demod != "one" && demod != "none")) {
    std::fprintf(stderr, "usage: --file F.cu8 --chan OFF [--chan ...] [--rate HZ] [--demod all|one|none]\n");
    return 2;
  }
  FILE* f = std::fopen(file.c_str(), "rb");
  if (!f) { std::perror(file.c_str()); return 1; }
  std::vector<uint8_t> raw;
  { uint8_t buf[1 << 16]; size_t r; while ((r = std::fread(buf, 1, sizeof buf, f)) > 0) raw.insert(raw.end(), buf, buf + r); }
  std::fclose(f);
  const size_t nsamp = raw.size() / 2;

  kc::Channelizer ch(rate);
  ch.set_lanes(chans);
  const int L = (int)chans.size();
  std::vector<kc::ChunkPower> power(L);
  std::vector<kc::FmDiscriminator> disc(L);
  std::vector<kc::QuietingMeter> quiet(L);
  std::vector<kc::MeanSquare> speech(L, kc::MeanSquare(kc::SPEECH_WINDOW));
  kc::Deemphasis de;
  kc::FirFilter audio_lpf(kc::design_lowpass(kc::LANE_RATE, kc::AUDIO_LPF_HZ, kc::AUDIO_LPF_TRANSITION_HZ));
  kc::Resampler to48(24, 25, kc::LANE_RATE, 20'000, 4'000);
  std::vector<float> lane_audio(kc::Channelizer::kLaneSamplesPerHop), out48;
  const int demod_lanes = demod == "all" ? L : demod == "one" ? 1 : 0;
  double sink_guard = 0;

  // Feed in 10 ms slices like the live engine will.
  const size_t slice = (size_t)rate / 100;
  double c0 = cpu_seconds();
  for (size_t pos = 0; pos < nsamp; pos += slice) {
    size_t n = std::min(slice, nsamp - pos);
    ch.push_u8(&raw[2 * pos], n, [&](const kc::cf* out, int n_l, int per, const kc::cf*, int) {
      for (int l = 0; l < n_l; l++) {
        const kc::cf* y = out + l * per;
        power[l].push(y, per);
        if (l >= demod_lanes) continue;
        for (int d = 0; d < per; d++) {
          float v = disc[l].step(y[d]);
          quiet[l].push(v);
          speech[l].push(v);
          if (l == 0) lane_audio[d] = audio_lpf.step(de.step(v));
        }
        if (l == 0) {
          out48.clear();
          to48.push(lane_audio.data(), per, out48);
          for (float s : out48) sink_guard += s;
        }
      }
    });
  }
  double cpu = cpu_seconds() - c0;
  for (int l = 0; l < L; l++) sink_guard += power[l].slow_db() + quiet[l].db() + speech[l].db();
  double iq_s = (double)nsamp / rate;
  std::printf("guard=%g\n", sink_guard);  // keeps every meter observable so nothing is elided
  std::printf("COST iq_s=%.2f cpu_s=%.3f core_pct=%.1f lanes=%d demod=%s\n", iq_s, cpu, 100 * cpu / iq_s, L, demod.c_str());
  return 0;
}
