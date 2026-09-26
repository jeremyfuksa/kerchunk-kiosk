// kerchunk-dsp — live SDR helper (RTL-SDR in; ALSA / fd-3 tee / multimon-ng / JSON events out),
// plus the replay mode (--iq-file) used by benches and tests.
#include <csignal>
#include <sys/resource.h>

#include <atomic>
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

#include "cli.hpp"
#include "engine.hpp"
#include "live.hpp"
#include "multimon.hpp"
#include "outputs.hpp"
#include "rt.hpp"
#include "rtl_source.hpp"

static double cpu_seconds() {
  rusage u{};
  getrusage(RUSAGE_SELF, &u);
  return u.ru_utime.tv_sec + u.ru_utime.tv_usec / 1e6 + u.ru_stime.tv_sec + u.ru_stime.tv_usec / 1e6;
}

static int run_replay(const kc::Cli& c) {
  const kc::EngineOptions& o = c.eng;
  std::optional<kc::TuneCmd> tune;
  if (!c.tune_json.empty()) {
    std::string err;
    auto cmd = kc::parse_command(c.tune_json, err);
    if (!cmd) { std::fprintf(stderr, "kerchunk-dsp: bad --tune: %s\n", err.c_str()); return 2; }
    if (!std::holds_alternative<kc::TuneCmd>(*cmd)) { std::fprintf(stderr, "kerchunk-dsp: --tune must be a tune command\n"); return 2; }
    tune = std::get<kc::TuneCmd>(*cmd);
  }
  kc::dsp_thread_init();
  std::ofstream aout, sout;
  if (!c.audio_out.empty()) {
    aout.open(c.audio_out, std::ios::binary);
    if (!aout) { std::fprintf(stderr, "kerchunk-dsp: cannot open --audio-out %s\n", c.audio_out.c_str()); return 2; }
  }
  if (!c.same_out.empty()) {
    sout.open(c.same_out, std::ios::binary);
    if (!sout) { std::fprintf(stderr, "kerchunk-dsp: cannot open --same-out %s\n", c.same_out.c_str()); return 2; }
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
  FILE* f = std::fopen(c.iq_file.c_str(), "rb");
  if (!f) { std::perror(c.iq_file.c_str()); return 1; }
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
    if (c.realtime) std::this_thread::sleep_until(wall0 + std::chrono::duration<double>((double)total / o.rate));
  }
  std::fclose(f);
  const double cpu = cpu_seconds() - c0, iq_s = (double)total / o.rate;
  std::fflush(stdout);
  std::fprintf(stderr, "REPLAY iq_s=%.2f cpu_s=%.3f core_pct=%.1f realtime=%d\n", iq_s, cpu, iq_s > 0 ? 100 * cpu / iq_s : 0.0, c.realtime ? 1 : 0);
  return 0;
}

static std::atomic<bool> g_stop{false};
static void on_signal(int) { g_stop = true; }

static int run_live(const kc::Cli& c) {
  // SIGPIPE is ignored process-wide in main(); only the shutdown signals are handled here.
  std::signal(SIGTERM, on_signal);
  std::signal(SIGINT, on_signal);
  // `events` and `cmds` are touched by the detached stdin reader, which can outlive this function
  // (it is parked in getline until the parent closes stdin). Deliberately leaked so a late line or
  // EOF after shutdown never touches a destroyed object; the process exits right after we return.
  // Early returns during init (failure, or g_stop) rely on the locals' destructors: RtlSource and
  // AlsaSink close their devices; events was never started, so nothing reached stdout.
  auto* events_p = new kc::EventOut(stdout);
  auto* cmds_p = new kc::SpscQueue<kc::Command>(kc::CMD_QUEUE);
  kc::EventOut& events = *events_p;
  kc::SpscQueue<kc::Command>& cmds = *cmds_p;
  kc::LogFn log = [&events](const std::string& m) { events.log(m); };
  std::unique_ptr<kc::AlsaSink> alsa;
  std::unique_ptr<kc::FdPump> tee;
  std::unique_ptr<kc::Multimon> mm;
  // Engine first: all FFTW planning happens here, before any other thread exists.
  std::unique_ptr<kc::Engine> eng;
  try {
    eng = std::make_unique<kc::Engine>(
        c.eng, [&events](const nlohmann::json& j) { events.emit(j); },
        [&alsa](const int16_t* p, int n) { if (alsa) alsa->write(p, (size_t)n); },
        [&tee](const int16_t* p, int n) { if (tee) tee->write(p, (size_t)n); },
        [&mm](const int16_t* p, int n) { if (mm) mm->write(p, (size_t)n); });
  } catch (const std::exception& ex) {
    std::fprintf(stderr, "kerchunk-dsp: engine init failed: %s\n", ex.what());
    return 2;
  }
  kc::dsp_thread_init();
  // stdin reader starts now (after FFTW planning) so a quit/EOF during the rest of init -- notably
  // the <= BUSY_RETRY_S open retry -- is honoured promptly via g_stop, like SIGTERM/SIGINT.
  std::thread in([events_p, cmds_p] {
    std::string line;
    while (std::getline(std::cin, line)) {
      if (line.find_first_not_of(" \t\r") == std::string::npos) continue;
      std::string perr;
      auto cmd = kc::parse_command(line, perr);
      if (!cmd) { events_p->log("bad command line: " + line.substr(0, 120)); continue; }
      // quit also raises g_stop directly: it can never be lost to a full queue or to init not
      // having reached the loop yet.
      if (std::holds_alternative<kc::QuitCmd>(*cmd)) g_stop = true;
      if (!cmds_p->try_push(*cmd)) events_p->log("command queue full; dropped a command");
    }
    g_stop = true;   // EOF = parent went away (a flag, not a queued quit: can't be dropped)
  });
  in.detach();   // blocked in getline; process exit ends it
  kc::RtlSource src({c.rtl_serial, c.rtl_index, c.eng.rate, c.gain}, log);
  std::string err;
  if (!src.open(err, [] { return g_stop.load(); })) {
    if (g_stop) return 0;   // asked to stop while waiting for the dongle: a clean exit, not an error
    std::fprintf(stderr, "kerchunk-dsp: %s\n", err.c_str());
    return 1;
  }
  if (g_stop) return 0;
  if (c.sink != "none") {
    alsa = std::make_unique<kc::AlsaSink>(c.sink, log);
    if (!alsa->open(err)) { std::fprintf(stderr, "kerchunk-dsp: %s\n", err.c_str()); return 1; }
  }
  if (g_stop) return 0;
  events.start();
  if (c.audio_fd >= 0) {
    tee = std::make_unique<kc::FdPump>(kc::TEE_RING, log, "audio tee");
    tee->set_fd(c.audio_fd, /*owned=*/false);   // fd 3 belongs to the parent's spawn, not the pump
    tee->start();
  }
  if (c.eng.same) {
    mm = std::make_unique<kc::Multimon>(std::vector<std::string>{"multimon-ng", "-t", "raw", "-a", "EAS", "-"},
                                        [&events](const nlohmann::json& j) { events.emit(j); }, log);
    if (!mm->start(err)) { events.log("multimon-ng not started: SAME decoding disabled (" + err + ")"); mm.reset(); }
  }
  if (alsa) alsa->start();
  src.start();
  events.emit({{"ev", "ready"}});   // device open, threads up: Node sends its first tune now
  kc::LiveLoop loop(*eng, src, cmds, c.eng.rate);
  int rc = 0;
  while (!g_stop && !loop.quit()) {
    if (!loop.step()) {
      if (src.seconds_since_rx() > kc::STALL_S) {
        std::fprintf(stderr, "kerchunk-dsp: SDR stalled (no samples for %.1f s)\n", kc::STALL_S);
        rc = 3;
        break;
      }
      std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
  }
  src.stop();
  if (mm) mm->stop();
  if (tee) tee->stop();
  if (alsa) alsa->stop();
  events.stop();
  return rc;
}

int main(int argc, char** argv) {
  // Process-wide: a reader that goes away (fd-3 tee, multimon-ng's stdin) must surface as EPIPE on
  // the writing thread, never kill the helper. Installed once, here, rather than per-FdPump::start
  // so it isn't repeatedly re-armed across start/stop cycles.
  std::signal(SIGPIPE, SIG_IGN);
  kc::Cli c;
  std::string err;
  if (!kc::parse_cli(argc, const_cast<const char* const*>(argv), c, err)) {
    std::fprintf(stderr, "kerchunk-dsp: %s\n", err.c_str());
    return 2;
  }
  return c.iq_file.empty() ? run_live(c) : run_replay(c);
}
