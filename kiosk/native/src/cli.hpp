// Command-line surface: what WidebandEngine.ts spawns (live) plus the replay-only flags.
#pragma once
#include <string>

#include "constants.hpp"
#include "engine.hpp"

namespace kc {
struct Cli {
  EngineOptions eng;
  std::string sink = "none";
  std::string gain = "auto";
  std::string rtl_serial;
  int rtl_index = -1;
  int ppm = 0;   // tuner frequency correction (--ppm, rtlsdr_set_freq_correction)
  // --spyserver host:port replaces the RTL-SDR and forces eng.rate to 750000.
  std::string spyserver_host;
  int spyserver_port = 0;
  int spyserver_gain = -1;           // gain index; -1 = leave the server's setting
  int spyserver_digital_gain = SPY_DIGITAL_GAIN_DEFAULT;
  int audio_buffer_ms = 0;   // speaker queue for network IQ; 0 = the USB tuning
  int audio_fd = -1;
  std::string iq_file, tune_json, audio_out, same_out;
  bool realtime = false;
};
bool parse_cli(int argc, const char* const* argv, Cli& out, std::string& err);
}  // namespace kc
