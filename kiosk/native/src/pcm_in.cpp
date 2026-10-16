#include "pcm_in.hpp"

#include <unistd.h>

#include <algorithm>
#include <cerrno>
#include <cstring>
#include <string>
#include <thread>

namespace kc {
PcmIn::PcmIn(double target_ms, double max_ms)
    : ring_(PCM_IN_RING),
      target_((size_t)(target_ms * LANE_RATE / 1000.0)),
      max_(std::max((size_t)(max_ms * LANE_RATE / 1000.0), (size_t)(target_ms * LANE_RATE / 1000.0) + 1)) {}

size_t PcmIn::write(const int16_t* x, size_t n) { return ring_.write(x, n); }

void PcmIn::pull(float* out, int n) {
  size_t have = ring_.size();
  if (!playing_) {
    if (have < std::max<size_t>(target_, 1)) { std::fill(out, out + n, 0.f); return; }
    playing_ = true;
  }
  if (have > max_) { ring_.discard(have - target_); have = ring_.size(); }
  if ((int)tmp_.size() < n) tmp_.resize(n);
  const size_t got = ring_.read(tmp_.data(), (size_t)n);
  for (size_t i = 0; i < got; i++) out[i] = tmp_[i] / 32768.f;
  std::fill(out + got, out + n, 0.f);
  if (got < (size_t)n) playing_ = false;
}

void PcmIn::reset() {
  ring_.discard(ring_.size());
  playing_ = false;
}

void PcmIn::start_reader(int fd, LogFn log) {
  std::thread([this, fd, log] {
    std::vector<uint8_t> buf(8192);
    size_t carry = 0;   // an odd trailing byte waits for its partner
    for (;;) {
      const ssize_t r = ::read(fd, buf.data() + carry, buf.size() - carry);
      if (r == 0) { log("pcm-in: EOF"); return; }
      if (r < 0) {
        if (errno == EINTR) continue;
        log(std::string("pcm-in: read failed: ") + std::strerror(errno));
        return;
      }
      const size_t bytes = carry + (size_t)r;
      const size_t whole = bytes / 2;
      write(reinterpret_cast<const int16_t*>(buf.data()), whole);
      carry = bytes % 2;
      if (carry) buf[0] = buf[bytes - 1];
    }
  }).detach();
}
}  // namespace kc
