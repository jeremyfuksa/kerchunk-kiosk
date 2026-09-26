// kerchunk-dsp — P1b: replay mode only (--iq-file). Live SDR/ALSA/fd-3 arrive in P1c.
#include <sys/resource.h>

#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <iostream>
#include <string>
#include <thread>
#include <vector>

#include "engine.hpp"
#include "rt.hpp"

static double cpu_seconds() {
  rusage u{};
  getrusage(RUSAGE_SELF, &u);
  return u.ru_utime.tv_sec + u.ru_utime.tv_usec / 1e6 + u.ru_stime.tv_sec + u.ru_stime.tv_usec / 1e6;
}

int main(int argc, char** argv) {
  kc::EngineOptions o;
  std::string iq_file, tune_json, audio_out, same_out;
  bool realtime = false;
  for (int i = 1; i < argc; i++) {
    std::string k = argv[i];
    auto val = [&]() -> std::string {
      if (i + 1 >= argc) { std::fprintf(stderr, "kerchunk-dsp: missing value for %s\n", k.c_str()); std::exit(2); }
      return argv[++i];
    };
    if (k == "--iq-file") iq_file = val();
    else if (k == "--tune") tune_json = val();
    else if (k == "--rate") o.rate = std::atoi(val().c_str());
    else if (k == "--open-db") o.squelch.open_db = std::atof(val().c_str());
    else if (k == "--quiet-db") o.squelch.quiet_db = std::atof(val().c_str());   // native scale only
    else if (k == "--hang-ms") o.squelch.hang_ms = std::atof(val().c_str());
    else if (k == "--close-call") o.close_call = true;
    else if (k == "--same-enable") o.same = true;
    else if (k == "--audio-out") audio_out = val();
    else if (k == "--same-out") same_out = val();
    else if (k == "--realtime") realtime = true;
    else { std::fprintf(stderr, "kerchunk-dsp: unknown arg %s\n", k.c_str()); return 2; }
  }
  if (iq_file.empty()) {
    std::fprintf(stderr, "kerchunk-dsp: live SDR input arrives in P1c; use --iq-file\n");
    return 2;
  }
  kc::dsp_thread_init();
  std::ofstream aout, sout;
  if (!audio_out.empty()) aout.open(audio_out, std::ios::binary);
  if (!same_out.empty()) sout.open(same_out, std::ios::binary);
  kc::Engine* ep = nullptr;
  auto emit = [&](const nlohmann::json& j) {
    nlohmann::json e = j;
    if (ep) e["t"] = std::round(ep->now() * 1000.0) / 1000.0;
    std::fputs(kc::to_line(e).c_str(), stdout);
  };
  auto speaker = aout.is_open() ? kc::Engine::Pcm([&](const int16_t* p, int n) { aout.write((const char*)p, n * 2); }) : kc::Engine::Pcm();
  auto same = sout.is_open() ? kc::Engine::Pcm([&](const int16_t* p, int n) { sout.write((const char*)p, n * 2); }) : kc::Engine::Pcm();
  kc::Engine eng(o, emit, speaker, kc::Engine::Pcm(), same);
  ep = &eng;
  std::fputs(kc::to_line({{"ev", "ready"}}).c_str(), stdout);
  if (!tune_json.empty()) {
    std::string err;
    auto c = kc::parse_command(tune_json, err);
    if (!c) { std::fprintf(stderr, "kerchunk-dsp: bad --tune: %s\n", err.c_str()); return 2; }
    eng.command(*c);
  }
  FILE* f = std::fopen(iq_file.c_str(), "rb");
  if (!f) { std::perror(iq_file.c_str()); return 1; }
  std::vector<uint8_t> buf((size_t)o.rate / 100 * 2);
  long long total = 0;
  const auto wall0 = std::chrono::steady_clock::now();
  const double c0 = cpu_seconds();
  size_t got;
  while (!eng.quit() && (got = std::fread(buf.data(), 1, buf.size(), f)) >= 2) {
    eng.push_u8(buf.data(), got / 2);
    total += (long long)(got / 2);
    if (realtime) std::this_thread::sleep_until(wall0 + std::chrono::duration<double>((double)total / o.rate));
  }
  std::fclose(f);
  const double cpu = cpu_seconds() - c0, iq_s = (double)total / o.rate;
  std::fflush(stdout);
  std::fprintf(stderr, "REPLAY iq_s=%.2f cpu_s=%.3f core_pct=%.1f realtime=%d\n", iq_s, cpu, iq_s > 0 ? 100 * cpu / iq_s : 0.0, realtime ? 1 : 0);
  return 0;
}
