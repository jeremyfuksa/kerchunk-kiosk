// RtlSource's USB-callback side, exercised with fake buffers on a source that is never opened
// (no rtlsdr_* call is made: dev_ stays null, start() is never called).
#include <vector>

#include "check.hpp"
#include "rtl_source.hpp"

namespace {
struct Got { uint32_t gen, n; uint8_t first; };
std::vector<Got> drain(kc::RtlSource& s) {
  std::vector<Got> out;
  while (s.consume([&](const kc::IqBlock& b) { out.push_back({b.gen, b.n, b.data[0]}); })) {}
  return out;
}
void feed(kc::RtlSource& s, int buffers, uint8_t& counter) {
  std::vector<unsigned char> buf(kc::RTL_BUF_LEN);
  for (int i = 0; i < buffers; i++) {
    for (auto& x : buf) x = counter++;
    kc::RtlSource::on_samples(buf.data(), (uint32_t)buf.size(), &s);
  }
}
}  // namespace

TEST(rtl_on_samples_coalesces_usb_transfers_into_10ms_blocks) {
  kc::RtlSource s({"", -1, 2'400'000, "auto"}, [](const std::string&) {});
  const uint32_t block = 48000;   // 10 ms of u8 IQ at 2.4 Msps
  uint8_t ctr = 0;
  feed(s, 6, ctr);                // 6 * 16384 = 98304 B = 2 full blocks + 2304 B pending
  auto got = drain(s);
  CHECK(got.size() == 2);
  for (auto& g : got) CHECK(g.n == block && g.n % 2 == 0 && g.gen == 0);
  if (got.size() == 2) CHECK(got[1].first == (uint8_t)(block % 256));   // contiguous: no bytes lost or duplicated
  CHECK(s.take_dropped() == 0);
}

TEST(rtl_on_samples_generation_change_flushes_partial_block) {
  kc::RtlSource s({"", -1, 250'000, "auto"}, [](const std::string&) {});
  const uint32_t block = 5000;    // 10 ms of u8 IQ at 250 ksps
  uint8_t ctr = 0;
  feed(s, 1, ctr);                // 16384 B = 3 full blocks + 1384 B pending (gen 0)
  s.set_center(146e6);            // unopened: no device call, generation bumps to 1
  feed(s, 1, ctr);                // flushes the 1384-B gen-0 partial first, then 16384 B of gen 1
  auto got = drain(s);
  // gen 0: 5000 5000 5000 1384 | gen 1: 5000 5000 5000 (+1384 pending)
  CHECK(got.size() == 7);
  if (got.size() == 7) {
    for (int i = 0; i < 3; i++) CHECK(got[i].gen == 0 && got[i].n == block);
    CHECK(got[3].gen == 0 && got[3].n == 16384 - 3 * block);
    for (int i = 4; i < 7; i++) CHECK(got[i].gen == 1 && got[i].n == block);
    CHECK(got[4].first == (uint8_t)(16384 % 256));   // gen-1 data starts exactly at the second buffer
  }
  for (auto& g : got) CHECK(g.n <= block && g.n % 2 == 0);
}

TEST(rtl_on_samples_counts_ring_overrun_as_dropped_samples) {
  kc::RtlSource s({"", -1, 2'400'000, "auto"}, [](const std::string&) {});
  uint8_t ctr = 0;
  // Ring holds IQ_RING_BLOCKS 48000-B blocks; feed 3 blocks more than that without consuming.
  const int bytes = (kc::IQ_RING_BLOCKS + 3) * 48000;
  feed(s, bytes / kc::RTL_BUF_LEN, ctr);
  const long long published = (long long)(bytes / kc::RTL_BUF_LEN) * kc::RTL_BUF_LEN / 48000;
  CHECK(s.take_dropped() == (uint64_t)(published - kc::IQ_RING_BLOCKS) * 24000);
  CHECK(drain(s).size() == (size_t)kc::IQ_RING_BLOCKS);
}
