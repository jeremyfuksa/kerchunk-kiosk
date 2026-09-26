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
