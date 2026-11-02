// SpyServer wire protocol: command encoding and a frame parser that tolerates any TCP split.
// Pure (no sockets). Hello, device-info and client-sync layouts were checked against a live v2.0.1922
// server on 2026-11-02. All integers are little-endian.
#pragma once
#include <cstddef>
#include <cstdint>
#include <functional>
#include <optional>
#include <string>
#include <vector>

namespace kc::spy {
inline constexpr uint32_t PROTOCOL_VERSION = (2u << 24) | 1700u;
inline constexpr uint32_t CMD_HELLO = 0, CMD_SET_SETTING = 2;

inline constexpr uint32_t STREAMING_MODE = 0, STREAMING_ENABLED = 1, GAIN = 2, IQ_FORMAT = 100, IQ_FREQUENCY = 101,
                          IQ_DECIMATION = 102, IQ_DIGITAL_GAIN = 103;
inline constexpr uint32_t STREAM_IQ_ONLY = 1, FORMAT_U8 = 1;
inline constexpr uint32_t MSG_DEVICE_INFO = 0, MSG_CLIENT_SYNC = 1, MSG_UINT8_IQ = 100;

inline constexpr size_t HEADER_BYTES = 20;
inline constexpr uint32_t MAX_BODY_BYTES = 2u * 1024 * 1024;

struct DeviceInfo {
  uint32_t device_type, serial, max_rate, max_bandwidth, decimation_stages, gain_stages, max_gain_index, min_hz, max_hz,
      resolution, min_iq_decimation, forced_iq_format;
};
struct ClientSync {
  uint32_t can_control, gain, device_center, iq_center, fft_center, min_iq_center, max_iq_center;
};
struct FrameHeader {
  uint32_t protocol, msg_type, stream_type, sequence, body_size, flags;   // flags: the type word's high 16 bits; IQ frames echo the digital gain
};

std::vector<uint8_t> encode_hello(const std::string& client_id);
std::vector<uint8_t> encode_setting(uint32_t setting, uint32_t value);
std::optional<DeviceInfo> parse_device_info(const uint8_t* body, size_t n);
std::optional<ClientSync> parse_client_sync(const uint8_t* body, size_t n);  // the server may send more than 28 bytes

class FrameParser {
 public:
  using OnFrame = std::function<void(const FrameHeader&, const uint8_t* body, size_t n)>;
  void feed(const uint8_t* p, size_t n, const OnFrame& f);
  // A body over MAX_BODY_BYTES means the stream is desynchronised; nothing more is delivered.
  bool failed() const { return failed_; }

 private:
  std::vector<uint8_t> buf_;
  bool failed_ = false;
};
}  // namespace kc::spy
