// Per-lane power + quieting survey of a .cu8 capture, one CSV row per 100 ms:
// t, then for each lane: slow_db, quiet_db. Feeds kiosk/bench/native_p1b/quiet_calibrate.py.
#include <cstdio>
#include <cstdlib>
#include <string>
#include <vector>

#include "channelizer.hpp"
#include "demod.hpp"
#include "meters.hpp"

int main(int argc, char** argv) {
  std::string file;
  int rate = 2'400'000;
  std::vector<double> chans;
  for (int i = 1; i + 1 < argc; i += 2) {
    std::string k = argv[i], v = argv[i + 1];
    if (k == "--file") file = v;
    else if (k == "--rate") rate = std::atoi(v.c_str());
    else if (k == "--chan") chans.push_back(std::atof(v.c_str()));
    else { std::fprintf(stderr, "unknown arg %s\n", k.c_str()); return 2; }
  }
  if (file.empty() || chans.empty()) { std::fprintf(stderr, "usage: --file F --chan OFF ... [--rate HZ]\n"); return 2; }
  FILE* f = std::fopen(file.c_str(), "rb");
  if (!f) { std::perror(file.c_str()); return 1; }
  kc::Channelizer ch(rate);
  ch.set_lanes(chans);
  const size_t L = chans.size();
  std::vector<kc::ChunkPower> pw(L);
  std::vector<kc::FmDiscriminator> disc(L);
  std::vector<kc::QuietingMeter> q(L);
  long long lane_samples = 0, next_row = kc::LANE_RATE / 10;
  std::printf("t");
  for (double c : chans) std::printf(",p%.0f,q%.0f", c, c);
  std::printf("\n");
  std::vector<uint8_t> buf((size_t)rate / 100 * 2);
  size_t got;
  while ((got = std::fread(buf.data(), 1, buf.size(), f)) >= 2) {
    ch.push_u8(buf.data(), got / 2, [&](const kc::cf* out, int n_l, int per, const kc::cf*, int) {
      for (int l = 0; l < n_l; l++) {
        const kc::cf* y = out + l * per;
        pw[l].push(y, per);
        for (int d = 0; d < per; d++) q[l].push(disc[l].step(y[d]));
      }
      lane_samples += per;
      if (lane_samples >= next_row) {
        next_row += kc::LANE_RATE / 10;
        std::printf("%.2f", (double)lane_samples / kc::LANE_RATE);
        for (size_t l = 0; l < L; l++) std::printf(",%.2f,%.2f", pw[l].slow_db(), q[l].db());
        std::printf("\n");
      }
    });
  }
  std::fclose(f);
  return 0;
}
