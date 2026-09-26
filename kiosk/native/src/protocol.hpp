// stdin commands / stdout events between Node (WidebandEngine.ts) and kerchunk-dsp.
// Shapes match wideband_helper.py exactly.
#pragma once
#include <nlohmann/json.hpp>
#include <optional>
#include <string>
#include <variant>
#include <vector>

#include "constants.hpp"

namespace kc {
struct ChannelCmd {
  std::string id;
  double freq_hz = 0;
  bool priority = false;
  double level_db = 0;
  std::string mode = "nfm";
  bool audible = true;
  bool background = false;
  std::optional<double> open_db, hang_ms;   // quietDb is parsed and ignored (decision C: GR scale)
};
struct TuneCmd {
  double center_hz = 0;
  std::vector<ChannelCmd> channels;
  bool monitor = false;
  bool close_call = false;
  double close_call_db = CC_DB_DEFAULT;
  std::vector<double> known_hz;
};
struct KnownCmd { std::vector<double> known_hz; };
struct SkipCmd { double holdoff_s = SKIP_HOLDOFF_S; };
struct AlertUnmuteCmd { std::string id; double hold_s = 30.0; };
struct QuitCmd {};
using Command = std::variant<TuneCmd, KnownCmd, SkipCmd, AlertUnmuteCmd, QuitCmd>;

// nullopt + err on malformed JSON, unknown cmd, or wrong field types. Never throws.
std::optional<Command> parse_command(const std::string& line, std::string& err);
nlohmann::json num(double v);
double round1(double v);
std::string to_line(const nlohmann::json& ev);
}  // namespace kc
