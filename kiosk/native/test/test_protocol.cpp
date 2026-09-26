#include <variant>

#include "check.hpp"
#include "protocol.hpp"

TEST(protocol_parses_full_tune) {
  std::string err;
  auto c = kc::parse_command(
      R"({"cmd":"tune","centerHz":146033750,"channels":[{"id":"a","freqHz":146520000,"priority":true,)"
      R"("levelDb":-2.5,"mode":"am","audible":false,"openDb":12,"quietDb":-86,"hangMs":1500},)"
      R"({"id":"nwr","freqHz":162550000,"background":true}],"monitor":false,"closeCall":true,"closeCallDb":18,"knownHz":[1,2]})",
      err);
  CHECK(c.has_value());
  const auto& t = std::get<kc::TuneCmd>(*c);
  CHECK_NEAR(t.center_hz, 146033750, 0);
  CHECK(t.channels.size() == 2);
  CHECK(t.channels[0].id == "a" && t.channels[0].priority && t.channels[0].mode == "am" && !t.channels[0].audible);
  CHECK_NEAR(*t.channels[0].open_db, 12, 0);
  CHECK_NEAR(*t.channels[0].hang_ms, 1500, 0);
  CHECK_NEAR(t.channels[0].level_db, -2.5, 0);
  CHECK(t.channels[1].background && !t.channels[1].open_db);
  CHECK(t.close_call && t.known_hz.size() == 2);
  CHECK_NEAR(t.close_call_db, 18, 0);
}

TEST(protocol_parses_small_commands_and_defaults) {
  std::string err;
  CHECK(std::holds_alternative<kc::QuitCmd>(*kc::parse_command(R"({"cmd":"quit"})", err)));
  auto s = kc::parse_command(R"({"cmd":"skip"})", err);
  CHECK_NEAR(std::get<kc::SkipCmd>(*s).holdoff_s, kc::SKIP_HOLDOFF_S, 0);
  auto s2 = kc::parse_command(R"({"cmd":"skip","holdoffS":3600})", err);
  CHECK_NEAR(std::get<kc::SkipCmd>(*s2).holdoff_s, 3600, 0);
  auto a = kc::parse_command(R"({"cmd":"alert_unmute","id":"x","holdS":45})", err);
  CHECK(std::get<kc::AlertUnmuteCmd>(*a).id == "x");
  auto k = kc::parse_command(R"({"cmd":"known","knownHz":[5,6,7]})", err);
  CHECK(std::get<kc::KnownCmd>(*k).known_hz.size() == 3);
}

TEST(protocol_rejects_garbage_without_throwing) {
  std::string err;
  CHECK(!kc::parse_command("not json", err));
  CHECK(!err.empty());
  CHECK(!kc::parse_command(R"({"cmd":"launch"})", err));
  CHECK(!kc::parse_command(R"({"cmd":"tune","centerHz":"x"})", err));
  CHECK(!kc::parse_command(R"([1,2])", err));
}

TEST(protocol_event_formatting) {
  CHECK(kc::to_line({{"ev", "tuned"}, {"centerHz", kc::num(146033750.0)}}) == "{\"centerHz\":146033750,\"ev\":\"tuned\"}\n");
  CHECK(kc::to_line({{"ev", "audible"}, {"id", nullptr}}) == "{\"ev\":\"audible\",\"id\":null}\n");
  CHECK_NEAR(kc::round1(-42.349), -42.3, 1e-9);
  CHECK(kc::num(1.5).is_number_float());
}
