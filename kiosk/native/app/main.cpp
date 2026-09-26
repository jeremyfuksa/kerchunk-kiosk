// kerchunk-dsp — P1b: replay mode only (--iq-file). Live SDR/ALSA/fd-3 arrive in P1c.
#include <sys/resource.h>

#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <iostream>
#include <memory>
#include <optional>
#include <stdexcept>
#include <string>
#include <thread>
#include <variant>
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
    else if (k == "--audio-lpf-hz") {
      const std::string v = val();
      char* end = nullptr;
      const double hz = std::strtod(v.c_str(), &end);
      if (end == v.c_str() || *end != '\0' || !(hz >= 1000 && hz <= 24000)) {
        std::fprintf(stderr, "kerchunk-dsp: --audio-lpf-hz must be a number in [1000, 24000]\n");
        return 2;
      }
      o.speaker_lpf_hz = hz;
    }
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
  if (o.rate <= 0 || o.rate % kc::LANE_RATE != 0) {
    std::fprintf(stderr, "kerchunk-dsp: --rate must be a positive multiple of %d\n", kc::LANE_RATE);
    return 2;
  }
  std::optional<kc::TuneCmd> tune;
  if (!tune_json.empty()) {
    std::string err;
    auto c = kc::parse_command(tune_json, err);
    if (!c) { std::fprintf(stderr, "kerchunk-dsp: bad --tune: %s\n", err.c_str()); return 2; }
    if (!std::holds_alternative<kc::TuneCmd>(*c)) { std::fprintf(stderr, "kerchunk-dsp: --tune must be a tune command\n"); return 2; }
    tune = std::get<kc::TuneCmd>(*c);
  }
  kc::dsp_thread_init();
  std::ofstream aout, sout;
  if (!audio_out.empty()) {
    aout.open(audio_out, std::ios::binary);
    if (!aout) { std::fprintf(stderr, "kerchunk-dsp: cannot open --audio-out %s\n", audio_out.c_str()); return 2; }
  }
  if (!same_out.empty()) {
    sout.open(same_out, std::ios::binary);
    if (!sout) { std::fprintf(stderr, "kerchunk-dsp: cannot open --same-out %s\n", same_out.c_str()); return 2; }
  }
  kc::Engine* ep = nullptr;
  auto emit = [&](const nlohmann::json& j) {
    nlohmann::json e = j;
    if (ep) e["t"] = std::round(ep->now() * 1000.0) / 1000.0;
    std::fputs(kc::to_line(e).c_str(), stdout);
  };
  auto speaker = aout.is_open() ? kc::Engine::Pcm([&](const int16_t* p, int n) { aout.write((const char*)p, n * 2); }) : kc::Engine::Pcm();
  auto same = sout.is_open() ? kc::Engine::Pcm([&](const int16_t* p, int n) { sout.write((const char*)p, n * 2); }) : kc::Engine::Pcm();
  std::unique_ptr<kc::Engine> engp;
  try {
    engp = std::make_unique<kc::Engine>(o, emit, speaker, kc::Engine::Pcm(), same);
  } catch (const std::exception& ex) {
    std::fprintf(stderr, "kerchunk-dsp: engine init failed: %s\n", ex.what());
    return 2;
  }
  kc::Engine& eng = *engp;
  ep = &eng;
  std::fputs(kc::to_line({{"ev", "ready"}}).c_str(), stdout);
  if (tune) eng.command(kc::Command{*tune});
  FILE* f = std::fopen(iq_file.c_str(), "rb");
  if (!f) { std::perror(iq_file.c_str()); return 1; }
  std::vector<uint8_t> buf((size_t)o.rate / 100 * 2);
  long long total = 0;
  const auto wall0 = std::chrono::steady_clock::now();
  const double c0 = cpu_seconds();
  size_t carry = 0;   // an odd trailing byte (half an I/Q pair) waits for the next read
  size_t got;
  while (!eng.quit() && (got = std::fread(buf.data() + carry, 1, buf.size() - carry, f)) > 0) {
    const size_t have = carry + got, pairs = have / 2;
    if (pairs) eng.push_u8(buf.data(), pairs);
    carry = have % 2;
    if (carry) buf[0] = buf[have - 1];
    total += (long long)pairs;
    if (realtime) std::this_thread::sleep_until(wall0 + std::chrono::duration<double>((double)total / o.rate));
  }
  std::fclose(f);
  const double cpu = cpu_seconds() - c0, iq_s = (double)total / o.rate;
  std::fflush(stdout);
  std::fprintf(stderr, "REPLAY iq_s=%.2f cpu_s=%.3f core_pct=%.1f realtime=%d\n", iq_s, cpu, iq_s > 0 ? 100 * cpu / iq_s : 0.0, realtime ? 1 : 0);
  return 0;
}
