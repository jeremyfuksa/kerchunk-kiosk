#include "check.hpp"
#include "cli.hpp"

namespace {
bool parse(std::vector<const char*> a, kc::Cli& c, std::string& err) {
  a.insert(a.begin(), "kerchunk-dsp");
  return kc::parse_cli((int)a.size(), a.data(), c, err);
}
}  // namespace

TEST(cli_accepts_node_spawn_surface) {
  kc::Cli c;
  std::string err;
  CHECK(parse({"--sink", "plughw:CARD=PCH,DEV=0", "--hang-ms", "2000", "--rtl-serial", "KIOSK01", "--open-db", "9",
               "--rate", "2400000", "--detect-via", "lane", "--close-call", "--audio-fd", "3", "--same-enable",
               "--gain", "auto", "--quiet-db", "-6", "--lanes", "12", "--lane-modes", "bbbbfffffffb"}, c, err));
  CHECK(c.sink == "plughw:CARD=PCH,DEV=0" && c.rtl_serial == "KIOSK01" && c.audio_fd == 3);
  CHECK(c.eng.close_call && c.eng.same);
  CHECK_NEAR(c.eng.squelch.hang_ms, 2000, 0);
  CHECK_NEAR(c.eng.squelch.quiet_db, -6, 0);
  CHECK(c.eng.rate == 2400000);
}

TEST(cli_rejects_bad_values_and_unknown) {
  kc::Cli c;
  std::string err;
  CHECK(!parse({"--bogus"}, c, err));
  CHECK(!parse({"--rate", "2048000"}, c, err));
  CHECK(!parse({"--rate", "abc"}, c, err));
  CHECK(!parse({"--audio-lpf-hz", "999"}, c, err));
  CHECK(!parse({"--audio-fd", "x"}, c, err));
  CHECK(!parse({"--sink"}, c, err));          // missing value
  CHECK(!err.empty());
}

TEST(cli_replay_flags) {
  kc::Cli c;
  std::string err;
  CHECK(parse({"--iq-file", "/tmp/x.cu8", "--tune", "{}", "--realtime", "--audio-out", "/tmp/a"}, c, err));
  CHECK(c.iq_file == "/tmp/x.cu8" && c.realtime && c.audio_out == "/tmp/a");
}

TEST(cli_rtl_index_gain_and_numeric_ranges) {
  {
    kc::Cli c;
    std::string err;
    CHECK(parse({"--rtl-index", "1", "--gain", "38.6", "--audio-lpf-hz", "3500", "--rate", "250000"}, c, err));
    CHECK(c.rtl_index == 1 && c.gain == "38.6" && c.eng.rate == 250000);
    CHECK_NEAR(c.eng.speaker_lpf_hz, 3500, 0);
  }
  const std::vector<std::vector<const char*>> bad = {
      {"--rtl-index", "-1"},
      {"--rtl-index", "99999999999"},   // long -> int overflow
      {"--rate", "4294967296"},         // overflow
      {"--audio-fd", "3000000000"},     // overflow
      {"--gain", "abc"},
      {"--gain", "nan"},
      {"--gain", "inf"},
      {"--gain"},
  };
  for (const auto& a : bad) {
    kc::Cli c;
    std::string err;
    CHECK(!parse(a, c, err));
    CHECK(!err.empty());
  }
}
