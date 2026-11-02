#include "spyserver_protocol.hpp"

namespace kc::spy {
namespace {
void put(std::vector<uint8_t>& b, uint32_t v) {
  for (int i = 0; i < 4; i++) b.push_back((uint8_t)(v >> (8 * i)));
}
uint32_t get(const uint8_t* p, size_t word) {
  p += word * 4;
  return (uint32_t)p[0] | (uint32_t)p[1] << 8 | (uint32_t)p[2] << 16 | (uint32_t)p[3] << 24;
}
}  // namespace

std::vector<uint8_t> encode_hello(const std::string& client_id) {
  std::vector<uint8_t> b;
  put(b, CMD_HELLO);
  put(b, (uint32_t)(4 + client_id.size()));
  put(b, PROTOCOL_VERSION);
  b.insert(b.end(), client_id.begin(), client_id.end());
  return b;
}

std::vector<uint8_t> encode_setting(uint32_t setting, uint32_t value) {
  std::vector<uint8_t> b;
  put(b, CMD_SET_SETTING);
  put(b, 8);
  put(b, setting);
  put(b, value);
  return b;
}

std::optional<DeviceInfo> parse_device_info(const uint8_t* p, size_t n) {
  if (n < 48) return std::nullopt;
  return DeviceInfo{get(p, 0), get(p, 1), get(p, 2), get(p, 3), get(p, 4),  get(p, 5),
                    get(p, 6), get(p, 7), get(p, 8), get(p, 9), get(p, 10), get(p, 11)};
}

std::optional<ClientSync> parse_client_sync(const uint8_t* p, size_t n) {
  if (n < 28) return std::nullopt;
  return ClientSync{get(p, 0), get(p, 1), get(p, 2), get(p, 3), get(p, 4), get(p, 5), get(p, 6)};
}

void FrameParser::feed(const uint8_t* p, size_t n, const OnFrame& f) {
  if (failed_) return;
  buf_.insert(buf_.end(), p, p + n);
  size_t at = 0;
  while (buf_.size() - at >= HEADER_BYTES) {
    const uint8_t* h = buf_.data() + at;
    const FrameHeader hdr{get(h, 0), get(h, 1) & 0xffff, get(h, 2), get(h, 3), get(h, 4)};
    if (hdr.body_size > MAX_BODY_BYTES) {
      failed_ = true;
      buf_.clear();
      return;
    }
    if (buf_.size() - at < HEADER_BYTES + hdr.body_size) break;
    f(hdr, h + HEADER_BYTES, hdr.body_size);
    at += HEADER_BYTES + hdr.body_size;
  }
  buf_.erase(buf_.begin(), buf_.begin() + (std::ptrdiff_t)at);
}
}  // namespace kc::spy
