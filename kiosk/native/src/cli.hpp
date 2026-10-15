// Command-line surface: what WidebandEngine.ts spawns (live) plus the replay-only flags.
#pragma once
#include <string>

#include "engine.hpp"

namespace kc {
struct Cli {
  EngineOptions eng;
  std::string sink = "none";
  std::string gain = "auto";
  std::string rtl_serial;
  int rtl_index = -1;
  int ppm = 0;   // tuner frequency correction (--ppm, rtlsdr_set_freq_correction)
  int audio_fd = -1;
  std::string iq_file, tune_json, audio_out, same_out;
  bool realtime = false;
  int pcm_in_fd = -1;   // --pcm-in-fd: s16le mono 50 kHz external speaker audio
  double pcm_target_ms = PCM_TARGET_MS, pcm_max_ms = PCM_MAX_MS;
};
bool parse_cli(int argc, const char* const* argv, Cli& out, std::string& err);
}  // namespace kc
