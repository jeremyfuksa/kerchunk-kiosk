#include "protocol.hpp"

#include <cmath>

namespace kc {
using nlohmann::json;

namespace {
template <class T>
T get_or(const json& j, const char* key, T dflt) {
  auto it = j.find(key);
  if (it == j.end() || it->is_null()) return dflt;
  return it->get<T>();
}
std::optional<double> opt_num(const json& j, const char* key) {
  auto it = j.find(key);
  if (it == j.end() || it->is_null()) return std::nullopt;
  return it->get<double>();
}
std::vector<double> num_list(const json& j, const char* key) {
  std::vector<double> out;
  auto it = j.find(key);
  if (it == j.end() || it->is_null()) return out;
  for (const auto& v : *it) out.push_back(v.get<double>());
  return out;
}
}  // namespace

std::optional<Command> parse_command(const std::string& line, std::string& err) {
  try {
    json j = json::parse(line);
    if (!j.is_object()) { err = "command is not an object"; return std::nullopt; }
    const std::string cmd = get_or<std::string>(j, "cmd", "");
    if (cmd == "quit") return Command{QuitCmd{}};
    if (cmd == "known") return Command{KnownCmd{num_list(j, "knownHz")}};
    if (cmd == "skip") return Command{SkipCmd{get_or<double>(j, "holdoffS", SKIP_HOLDOFF_S)}};
    if (cmd == "alert_unmute") return Command{AlertUnmuteCmd{j.at("id").get<std::string>(), get_or<double>(j, "holdS", 30.0)}};
    if (cmd == "tune") {
      TuneCmd t;
      t.center_hz = j.at("centerHz").get<double>();
      t.monitor = get_or<bool>(j, "monitor", false);
      t.close_call = get_or<bool>(j, "closeCall", false);
      t.close_call_db = get_or<double>(j, "closeCallDb", CC_DB_DEFAULT);
      t.known_hz = num_list(j, "knownHz");
      if (auto it = j.find("channels"); it != j.end() && !it->is_null()) {
        for (const auto& c : *it) {
          ChannelCmd ch;
          ch.id = c.at("id").get<std::string>();
          ch.freq_hz = c.at("freqHz").get<double>();
          ch.priority = get_or<bool>(c, "priority", false);
          ch.level_db = get_or<double>(c, "levelDb", 0.0);
          ch.mode = get_or<std::string>(c, "mode", "nfm");
          ch.audible = get_or<bool>(c, "audible", true);
          ch.background = get_or<bool>(c, "background", false);
          ch.open_db = opt_num(c, "openDb");
          ch.hang_ms = opt_num(c, "hangMs");
          t.channels.push_back(std::move(ch));
        }
      }
      return Command{std::move(t)};
    }
    err = "unknown cmd '" + cmd + "'";
    return std::nullopt;
  } catch (const std::exception& e) {
    err = e.what();
    return std::nullopt;
  }
}

json num(double v) {
  if (std::isfinite(v) && std::fabs(v) < 9e15 && v == std::floor(v)) return json((long long)v);
  return json(v);
}

double round1(double v) { return std::round(v * 10.0) / 10.0; }

std::string to_line(const json& ev) { return ev.dump() + "\n"; }
}  // namespace kc
