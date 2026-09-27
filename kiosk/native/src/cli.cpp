#include "cli.hpp"

#include <cerrno>
#include <climits>
#include <cmath>
#include <cstdio>
#include <cstdlib>

namespace kc {
namespace {
bool to_double(const std::string& s, double& v) {
  char* end = nullptr;
  v = std::strtod(s.c_str(), &end);
  return end != s.c_str() && *end == '\0' && std::isfinite(v);   // nan/inf are never a valid knob
}
bool to_int(const std::string& s, int& v) {
  char* end = nullptr;
  errno = 0;
  const long x = std::strtol(s.c_str(), &end, 10);
  if (end == s.c_str() || *end != '\0' || errno == ERANGE || x < INT_MIN || x > INT_MAX) return false;
  v = (int)x;
  return true;
}
}  // namespace

bool parse_cli(int argc, const char* const* argv, Cli& c, std::string& err) {
  for (int i = 1; i < argc; i++) {
    const std::string k = argv[i];
    auto val = [&](std::string& out) {
      if (i + 1 >= argc) { err = "missing value for " + k; return false; }
      out = argv[++i];
      return true;
    };
    std::string v;
    // Closed-range numeric knob: "--flag must be a number in [lo, hi]" on any failure.
    auto ranged = [&](std::string& sv, double lo, double hi, double& out) {
      double x;
      if (!val(sv) || !to_double(sv, x) || !(x >= lo && x <= hi)) {
        char b[96];
        std::snprintf(b, sizeof b, " must be a number in [%g, %g]", lo, hi);
        err = k + b;
        return false;
      }
      out = x;
      return true;
    };
    double d;
    int n;
    if (k == "--close-call") c.eng.close_call = true;
    else if (k == "--same-enable") c.eng.same = true;
    else if (k == "--realtime") c.realtime = true;
    else if (k == "--sink") { if (!val(c.sink)) return false; }
    else if (k == "--gain") { if (!val(c.gain)) return false; if (c.gain != "auto" && !to_double(c.gain, d)) { err = "--gain must be auto or dB"; return false; } }
    else if (k == "--rtl-serial") { if (!val(c.rtl_serial)) return false; }
    else if (k == "--iq-file") { if (!val(c.iq_file)) return false; }
    else if (k == "--tune") { if (!val(c.tune_json)) return false; }
    else if (k == "--audio-out") { if (!val(c.audio_out)) return false; }
    else if (k == "--same-out") { if (!val(c.same_out)) return false; }
    else if (k == "--detect-via" || k == "--lane-modes") { if (!val(v)) return false; }   // GR-era: ignored
    else if (k == "--lanes") {
      if (!val(v) || !to_int(v, n) || n < 1 || n > MAX_LANES) { err = "--lanes must be an integer in [1, " + std::to_string(MAX_LANES) + "]"; return false; }
      c.eng.lanes = n;
    }
    else if (k == "--rtl-index") { if (!val(v) || !to_int(v, c.rtl_index) || c.rtl_index < 0) { err = "--rtl-index must be a non-negative integer"; return false; } }
    else if (k == "--audio-fd") { if (!val(v) || !to_int(v, c.audio_fd)) { err = "--audio-fd must be an integer"; return false; } }
    else if (k == "--rate") {
      if (!val(v) || !to_int(v, n) || n <= 0 || n % LANE_RATE != 0) { err = "--rate must be a positive multiple of 50000"; return false; }
      c.eng.rate = n;
    }
    else if (k == "--open-db") { if (!val(v) || !to_double(v, c.eng.squelch.open_db)) { err = "--open-db must be a number"; return false; } }
    else if (k == "--quiet-db") { if (!val(v) || !to_double(v, c.eng.squelch.quiet_db)) { err = "--quiet-db must be a number"; return false; } }
    else if (k == "--hang-ms") { if (!val(v) || !to_double(v, c.eng.squelch.hang_ms)) { err = "--hang-ms must be a number"; return false; } }
    else if (k == "--audio-lpf-hz") {
      if (!val(v) || !to_double(v, d) || !(d >= 1000 && d <= 24000)) { err = "--audio-lpf-hz must be a number in [1000, 24000]"; return false; }
      c.eng.speaker_lpf_hz = d;
    }
    else if (k == "--audio-hpf-hz") {
      if (!val(v) || !to_double(v, d) || !(d == 0 || (d >= 50 && d <= 1000))) { err = "--audio-hpf-hz must be 0 (off) or a number in [50, 1000]"; return false; }
      c.eng.speaker_hpf_hz = d;
    }
    else if (k == "--am-gain-db") {
      if (!val(v) || !to_double(v, d) || !(d >= -30 && d <= 20)) { err = "--am-gain-db must be a number in [-30, 20]"; return false; }
      c.eng.am_gain_db = d;
    }
    else if (k == "--agc-target-db") { if (!ranged(v, -40, -3, c.eng.agc.target_db)) return false; }
    else if (k == "--agc-max-gain-db") { if (!ranged(v, 0, 30, c.eng.agc.max_gain_db)) return false; }
    else if (k == "--agc-min-gain-db") { if (!ranged(v, -40, 0, c.eng.agc.min_gain_db)) return false; }
    else if (k == "--agc-attack-ms") { if (!ranged(v, 1, 200, c.eng.agc.attack_ms)) return false; }
    else if (k == "--agc-release-ms") { if (!ranged(v, 20, 5000, c.eng.agc.release_ms)) return false; }
    else if (k == "--agc-hold-below-db") { if (!ranged(v, -90, -20, c.eng.agc.hold_below_db)) return false; }
    else if (k == "--limiter-ceiling") {
      if (!val(v) || !to_double(v, d) || !(d > 0 && d <= 0.8)) { err = "--limiter-ceiling must be a number in (0, 0.8]"; return false; }
      c.eng.limiter_ceiling = d;
    }
    else if (k == "--limiter-release-ms") { if (!ranged(v, 5, 1000, c.eng.limiter_release_ms)) return false; }
    else { err = "unknown arg " + k; return false; }
  }
  return true;
}
}  // namespace kc
