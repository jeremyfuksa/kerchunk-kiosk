#include <cstdint>
#include <cstring>
#include <vector>

#include "check.hpp"
#include "spyserver_protocol.hpp"

namespace {
uint32_t u32(const std::vector<uint8_t>& b, size_t at) {
  uint32_t v;
  std::memcpy(&v, b.data() + at, 4);
  return v;
}
void put(std::vector<uint8_t>& b, uint32_t v) {
  for (int i = 0; i < 4; i++) b.push_back((uint8_t)(v >> (8 * i)));
}
std::vector<uint8_t> frame(uint32_t type, uint32_t declared_size, size_t body_bytes) {
  std::vector<uint8_t> b;
  put(b, 0x02000782);  // protocol id measured from the live server, 2026-11-02
  put(b, type);
  put(b, 1);
  put(b, 7);
  put(b, declared_size);
  b.insert(b.end(), body_bytes, 0x55);
  return b;
}
// Values measured from the live server, 2026-11-02.
std::vector<uint8_t> fixture_device_info() {
  std::vector<uint8_t> b;
  for (uint32_t v : {2u, 942747699u, 768000u, 660000u, 8u, 0u, 8u, 0u, 1700000000u, 16u, 0u, 0u}) put(b, v);
  return b;
}
}  // namespace

TEST(spy_hello_layout) {
  auto b = kc::spy::encode_hello("kc");
  CHECK(b.size() == 8 + 4 + 2);
  CHECK(u32(b, 0) == 0);  // CMD_HELLO
  CHECK(u32(b, 4) == 6);  // body size
  CHECK(u32(b, 8) == ((2u << 24) | 1700u));
  CHECK(b[12] == 'k' && b[13] == 'c');
}

TEST(spy_setting_layout) {
  auto b = kc::spy::encode_setting(kc::spy::IQ_FREQUENCY, 7345000);
  CHECK(b.size() == 16);
  CHECK(u32(b, 0) == 2 && u32(b, 4) == 8 && u32(b, 8) == 101 && u32(b, 12) == 7345000);
}

TEST(spy_device_info_matches_measured_server) {
  auto f = fixture_device_info();
  auto d = kc::spy::parse_device_info(f.data(), f.size());
  CHECK(d.has_value());
  CHECK(d->device_type == 2 && d->max_rate == 768000 && d->max_bandwidth == 660000 && d->decimation_stages == 8);
  CHECK(d->serial == 942747699u && d->max_hz == 1700000000u && d->resolution == 16);
}

TEST(spy_device_info_rejects_short_body) {
  auto f = fixture_device_info();
  CHECK(!kc::spy::parse_device_info(f.data(), 47).has_value());
}

TEST(spy_client_sync_reads_measured_40_byte_body) {
  std::vector<uint8_t> b;
  for (uint32_t v : {1u, 5u, 100000000u, 100000000u, 100000000u, 330000u, 1699670000u, 330000u, 1699670000u, 0u}) put(b, v);
  auto s = kc::spy::parse_client_sync(b.data(), b.size());
  CHECK(s.has_value());
  CHECK(s->can_control == 1 && s->gain == 5 && s->iq_center == 100000000u);
  CHECK(s->min_iq_center == 330000u && s->max_iq_center == 1699670000u);
}

TEST(spy_parser_handles_every_split_point) {
  auto stream = frame(kc::spy::MSG_CLIENT_SYNC, 40, 40);
  auto iq = frame(kc::spy::MSG_UINT8_IQ, 100, 100);
  stream.insert(stream.end(), iq.begin(), iq.end());
  for (size_t cut = 0; cut <= stream.size(); cut++) {
    kc::spy::FrameParser p;
    std::vector<uint32_t> types;
    size_t iq_n = 0;
    uint8_t iq_first = 0;
    auto f = [&](const kc::spy::FrameHeader& h, const uint8_t* body, size_t n) {
      types.push_back(h.msg_type);
      if (h.msg_type == kc::spy::MSG_UINT8_IQ) { iq_n = n; iq_first = body[0]; }
    };
    p.feed(stream.data(), cut, f);
    p.feed(stream.data() + cut, stream.size() - cut, f);
    CHECK(types.size() == 2 && types[0] == kc::spy::MSG_CLIENT_SYNC && types[1] == kc::spy::MSG_UINT8_IQ);
    CHECK(iq_n == 100 && iq_first == 0x55);
    CHECK(!p.failed());
  }
}

TEST(spy_parser_masks_flag_bits_in_message_type) {
  auto s = frame(0x00010000u | kc::spy::MSG_UINT8_IQ, 4, 4);
  kc::spy::FrameParser p;
  uint32_t got = 0, flags = 0;
  p.feed(s.data(), s.size(), [&](const kc::spy::FrameHeader& h, const uint8_t*, size_t) { got = h.msg_type; flags = h.flags; });
  CHECK(got == kc::spy::MSG_UINT8_IQ);
  CHECK(flags == 1);
}

TEST(spy_parser_fails_on_absurd_body_size) {
  kc::spy::FrameParser p;
  auto bad = frame(kc::spy::MSG_UINT8_IQ, 0x7fffffff, 0);
  int calls = 0;
  p.feed(bad.data(), bad.size(), [&](const kc::spy::FrameHeader&, const uint8_t*, size_t) { calls++; });
  CHECK(p.failed());
  CHECK(calls == 0);
}
