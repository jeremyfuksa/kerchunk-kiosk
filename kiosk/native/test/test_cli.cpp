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
  CHECK(c.eng.lanes == 12);
}

TEST(cli_rejects_bad_values_and_unknown) {
  kc::Cli c;
  std::string err;
  CHECK(!parse({"--bogus"}, c, err));
  CHECK(!parse({"--rate", "2048000"}, c, err));
  CHECK(!parse({"--rate", "abc"}, c, err));
  CHECK(!parse({"--audio-lpf-hz", "999"}, c, err));
  CHECK(!parse({"--audio-hpf-hz", "20"}, c, err));
  CHECK(!parse({"--audio-hpf-hz", "1001"}, c, err));
  CHECK(!parse({"--am-gain-db", "25"}, c, err));
  CHECK(!parse({"--am-gain-db", "abc"}, c, err));
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
    kc::Cli c2;
    CHECK(parse({"--am-gain-db", "-6"}, c2, err));
    CHECK_NEAR(c2.eng.am_gain_db, -6, 0);
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

TEST(cli_speaker_agc_and_limiter_knobs) {
  kc::Cli c;
  std::string err;
  CHECK(parse({"--agc-target-db", "-20", "--agc-max-gain-db", "12", "--agc-min-gain-db", "-10", "--agc-attack-ms", "5",
               "--agc-release-ms", "800", "--agc-hold-below-db", "-60", "--limiter-ceiling", "0.6",
               "--limiter-release-ms", "80"}, c, err));
  CHECK_NEAR(c.eng.agc.target_db, -20, 0);
  CHECK_NEAR(c.eng.agc.max_gain_db, 12, 0);
  CHECK_NEAR(c.eng.agc.min_gain_db, -10, 0);
  CHECK_NEAR(c.eng.agc.attack_ms, 5, 0);
  CHECK_NEAR(c.eng.agc.release_ms, 800, 0);
  CHECK_NEAR(c.eng.agc.hold_below_db, -60, 0);
  CHECK_NEAR(c.eng.limiter_ceiling, 0.6, 0);
  CHECK_NEAR(c.eng.limiter_release_ms, 80, 0);
  kc::Cli d;   // defaults when omitted
  CHECK(parse({}, d, err));
  CHECK_NEAR(d.eng.agc.target_db, kc::AGC_TARGET_DB, 0);
  CHECK_NEAR(d.eng.limiter_ceiling, kc::LIMITER_CEILING, 0);
  const std::vector<std::vector<const char*>> bad = {
      {"--agc-target-db", "-2"},        {"--agc-target-db", "-41"},     {"--agc-max-gain-db", "31"},
      {"--agc-max-gain-db", "-1"},      {"--agc-min-gain-db", "1"},     {"--agc-min-gain-db", "-41"},
      {"--agc-attack-ms", "0.5"},       {"--agc-attack-ms", "201"},     {"--agc-release-ms", "19"},
      {"--agc-release-ms", "5001"},     {"--agc-hold-below-db", "-19"}, {"--agc-hold-below-db", "-91"},
      {"--limiter-ceiling", "0"},       {"--limiter-ceiling", "0.81"},  {"--limiter-release-ms", "4"},
      {"--limiter-release-ms", "1001"}, {"--agc-target-db", "abc"},     {"--limiter-ceiling"},
  };
  for (const auto& a : bad) {
    kc::Cli e;
    std::string m;
    CHECK(!parse(a, e, m));
    CHECK(m.find(a[0]) != std::string::npos);
  }
}

TEST(cli_lanes_range) {
  {
    kc::Cli c;
    std::string err;
    CHECK(c.eng.lanes == kc::DEFAULT_LANES);   // omitted = today's 12
    CHECK(parse({"--lanes", "1"}, c, err) && c.eng.lanes == 1);
    kc::Cli c2;
    CHECK(parse({"--lanes", "64"}, c2, err) && c2.eng.lanes == 64);
  }
  for (const char* v : {"0", "65", "-1", "abc", "12.5", ""}) {
    kc::Cli c;
    std::string err;
    CHECK(!parse({"--lanes", v}, c, err));
    CHECK(err.find("--lanes") != std::string::npos);
  }
}
