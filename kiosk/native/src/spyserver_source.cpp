#include "spyserver_source.hpp"

#include <netdb.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <unistd.h>

#include <algorithm>
#include <cerrno>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <cstring>
#include <memory>
#include <mutex>
#include <optional>

namespace kc {
namespace {
constexpr uint32_t BLOCK_BYTES = IqRateConverter::OUT_RATE / 100 * 2;   // 10 ms at 750 kHz
long long mono_ns() {
  return std::chrono::duration_cast<std::chrono::nanoseconds>(std::chrono::steady_clock::now().time_since_epoch()).count();
}
void set_timeouts(int fd, double seconds) {
  timeval tv{};
  tv.tv_sec = (time_t)seconds;
  tv.tv_usec = (suseconds_t)((seconds - (double)tv.tv_sec) * 1e6);
  ::setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof tv);
  ::setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof tv);
}
// One name lookup. It can't be cancelled, so it runs on a detached thread that may outlive the source:
// it shares only this, and whichever side comes second cleans up.
struct Lookup {
  std::mutex m;
  std::condition_variable cv;
  bool done = false, abandoned = false;
  int rc = 0;
  addrinfo* res = nullptr;
};
int default_resolve(const std::string& host, const std::string& port, addrinfo** out) {
  addrinfo hints{};
  hints.ai_family = AF_UNSPEC;
  hints.ai_socktype = SOCK_STREAM;
  return ::getaddrinfo(host.c_str(), port.c_str(), &hints, out);
}
}  // namespace

SpyServerSource::SpyServerSource(Options o, LogFn log) : o_(std::move(o)), log_(std::move(log)) {
  static_assert(BLOCK_BYTES <= IQ_BLOCK_BYTES, "10 ms at the HF rate must fit an IqBlock");
}

SpyServerSource::~SpyServerSource() { stop(); }

bool SpyServerSource::send_bytes(const std::vector<uint8_t>& b) {
  size_t off = 0;
  while (off < b.size()) {
    const ssize_t w = ::send(fd_, b.data() + off, b.size() - off, MSG_NOSIGNAL);
    if (w <= 0) {
      send_fail_ = "sent " + std::to_string(off) + " of " + std::to_string(b.size()) + " bytes: " + std::strerror(errno);
      return false;
    }
    off += (size_t)w;
  }
  return true;
}

bool SpyServerSource::open(std::string& err, const std::function<bool()>& should_stop) {
  const std::string pre = "failed to open SpyServer (" + o_.host + ":" + std::to_string(o_.port) + "): ";
  auto lookup = std::make_shared<Lookup>();
  std::thread([lookup, resolve = o_.resolve ? o_.resolve : default_resolve, host = o_.host, port = std::to_string(o_.port)] {
    addrinfo* found = nullptr;
    const int rc = resolve(host, port, &found);
    std::lock_guard<std::mutex> g(lookup->m);
    if (lookup->abandoned) {
      if (found) ::freeaddrinfo(found);
      return;
    }
    lookup->rc = rc;
    lookup->res = found;
    lookup->done = true;
    lookup->cv.notify_one();
  }).detach();
  addrinfo* res = nullptr;
  {
    const auto give_up = mono_ns() + (long long)(SPY_RESOLVE_TIMEOUT_S * 1e9);
    std::unique_lock<std::mutex> lock(lookup->m);
    while (!lookup->done) {
      const bool stopping = should_stop && should_stop();
      if (stopping || mono_ns() > give_up) {
        lookup->abandoned = true;
        err = stopping ? "aborted" : pre + "address lookup timed out";
        return false;
      }
      lookup->cv.wait_for(lock, std::chrono::milliseconds(10));
    }
    if (lookup->rc != 0) {
      err = pre + ::gai_strerror(lookup->rc);
      return false;
    }
    res = lookup->res;
  }
  for (addrinfo* a = res; a && fd_ < 0; a = a->ai_next) {
    const int fd = ::socket(a->ai_family, a->ai_socktype, a->ai_protocol);
    if (fd < 0) continue;
    set_timeouts(fd, SPY_CONNECT_TIMEOUT_S);   // bounds a blocking connect too (Linux)
    if (::connect(fd, a->ai_addr, a->ai_addrlen) == 0) fd_ = fd;
    else ::close(fd);
  }
  ::freeaddrinfo(res);
  if (fd_ < 0) { err = pre + "connect failed"; return false; }
  const int one = 1;
  ::setsockopt(fd_, IPPROTO_TCP, TCP_NODELAY, &one, sizeof one);

  const auto fail = [&](const std::string& why) {
    err = why;
    ::close(fd_);
    fd_ = -1;
    return false;
  };
  if (!send_bytes(spy::encode_hello("kerchunk"))) return fail(pre + "hello not sent: " + send_fail_);

  std::optional<spy::DeviceInfo> info;
  std::optional<spy::ClientSync> sync;
  const auto deadline = mono_ns() + (long long)(SPY_CONNECT_TIMEOUT_S * 1e9);
  uint8_t buf[4096];
  while (!(info && sync)) {
    if (should_stop && should_stop()) return fail("aborted");
    if (mono_ns() > deadline) return fail(pre + "no handshake from server");
    const ssize_t r = ::recv(fd_, buf, sizeof buf, 0);
    if (r == 0) return fail(pre + "server closed the connection");
    if (r < 0) continue;   // timeout or EINTR: the deadline above decides
    parser_.feed(buf, (size_t)r, [&](const spy::FrameHeader& h, const uint8_t* body, size_t n) {
      if (h.msg_type == spy::MSG_DEVICE_INFO) info = spy::parse_device_info(body, n);
      if (h.msg_type == spy::MSG_CLIENT_SYNC) sync = spy::parse_client_sync(body, n);
    });
    if (parser_.failed()) return fail(pre + "malformed handshake");
  }
  if (info->max_rate != (uint32_t)IqRateConverter::IN_RATE)
    return fail("SpyServer: unexpected device rate " + std::to_string(info->max_rate) + " (need " +
                std::to_string(IqRateConverter::IN_RATE) + ")");
  if (info->forced_iq_format != 0 && info->forced_iq_format != spy::FORMAT_U8)
    return fail("SpyServer: server forces IQ format " + std::to_string(info->forced_iq_format) + " (need u8)");
  if (info->min_iq_decimation != 0)
    return fail("SpyServer: server sets minimum IQ decimation " + std::to_string(info->min_iq_decimation) + " (need 0)");
  if (!sync->can_control) return fail("SpyServer: no control (another client holds the radio)");

  bool ok = send_bytes(spy::encode_setting(spy::STREAMING_MODE, spy::STREAM_IQ_ONLY)) &&
            send_bytes(spy::encode_setting(spy::IQ_FORMAT, spy::FORMAT_U8)) &&
            send_bytes(spy::encode_setting(spy::IQ_DECIMATION, 0));
  if (ok && o_.gain >= 0) {
    // Only the device knows its maximum. A level isn't worth losing the radio over, so cap it and say so.
    const uint32_t gain = std::min((uint32_t)o_.gain, info->max_gain_index);
    if (gain != (uint32_t)o_.gain)
      log_("SpyServer: gain index " + std::to_string(o_.gain) + " is over the device's maximum, using " + std::to_string(gain));
    ok = send_bytes(spy::encode_setting(spy::GAIN, gain));
  }
  if (ok) ok = send_bytes(spy::encode_setting(spy::IQ_DIGITAL_GAIN, (uint32_t)o_.digital_gain));
  if (!ok) return fail(pre + "settings not sent: " + send_fail_);
  set_timeouts(fd_, SPY_IO_TIMEOUT_S);
  return true;
}

void SpyServerSource::publish_acc() {
  const uint32_t n = acc_n_;
  if (n) {
    const bool ok = ring_.try_emplace([&](IqBlock& b) {
      b.gen = acc_.gen;
      b.n = n;
      std::memcpy(b.data.data(), acc_.data.data(), n);
    });
    if (!ok) dropped_.fetch_add(n / 2, std::memory_order_relaxed);   // DSP fell behind
  }
  acc_n_ = 0;
}

void SpyServerSource::on_iq(uint32_t flags, const uint8_t* iq, size_t bytes) {
  const uint32_t g = gen_.load(std::memory_order_acquire);
  if (g != reader_gen_) {
    // A retune landed: no block may mix generations, and the converter's history is the old center.
    publish_acc();
    conv_.reset();
    reader_gen_ = g;
    waiting_marker_ = true;
  }
  acc_.gen = g;
  const size_t in = bytes / 2;
  if (waiting_marker_) {
    if (flags != want_gain_.load(std::memory_order_acquire)) {
      discarded_in_.fetch_add(in, std::memory_order_relaxed);
      return;
    }
    waiting_marker_ = false;
    drop_frames_ = SPY_RETUNE_DROP_FRAMES;
  }
  last_rx_ns_.store(mono_ns(), std::memory_order_relaxed);
  if (drop_frames_ > 0) {
    drop_frames_--;
    discarded_in_.fetch_add(in, std::memory_order_relaxed);
    return;
  }
  const size_t cap = conv_.max_out(in);
  if (out_.size() < cap * 2) out_.resize(cap * 2);
  const size_t got = conv_.push(iq, in, out_.data(), cap);
  for (size_t off = 0; off < got * 2;) {
    const uint32_t take = (uint32_t)std::min<size_t>(BLOCK_BYTES - acc_n_, got * 2 - off);
    std::memcpy(acc_.data.data() + acc_n_, out_.data() + off, take);
    acc_n_ += take;
    off += take;
    if (acc_n_ == BLOCK_BYTES) publish_acc();
  }
}

uint64_t SpyServerSource::take_discarded() {
  // The reader counts what the server sent; the Engine's clock runs at the converter's output rate.
  const uint64_t scaled = discarded_in_.exchange(0, std::memory_order_relaxed) * IqRateConverter::OUT_RATE + discard_rem_;
  discard_rem_ = scaled % IqRateConverter::IN_RATE;
  return scaled / IqRateConverter::IN_RATE;
}

void SpyServerSource::start() {
  running_ = true;
  last_rx_ns_ = mono_ns();
  // Before the reader exists, on the thread that retunes: the first tune can't overtake this or cut into it.
  if (!send_bytes(spy::encode_setting(spy::STREAMING_ENABLED, 1))) log_("SpyServer: could not start streaming: " + send_fail_);
  t_ = std::thread([this] {
    std::vector<uint8_t> buf(64 * 1024);
    while (running_.load()) {
      const ssize_t r = ::recv(fd_, buf.data(), buf.size(), 0);
      if (r == 0) break;   // server went away: seconds_since_rx grows and the helper exits 3
      if (r < 0) {
        if (errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR) continue;
        break;
      }
      parser_.feed(buf.data(), (size_t)r, [this](const spy::FrameHeader& h, const uint8_t* body, size_t n) {
        if (h.msg_type == spy::MSG_UINT8_IQ) on_iq(h.flags, body, n);
      });
      if (parser_.failed()) break;
    }
    if (running_.load()) log_("SpyServer: stream ended while running");
  });
}

void SpyServerSource::stop() {
  running_ = false;
  if (fd_ >= 0) ::shutdown(fd_, SHUT_RDWR);   // wakes a blocked recv
  if (t_.joinable()) t_.join();
  if (fd_ >= 0) { ::close(fd_); fd_ = -1; }
}

bool SpyServerSource::set_center(double hz) {
  const auto f = (uint32_t)std::llround(hz);
  marker_step_ = (marker_step_ + 1) % SPY_MARKER_STEPS;
  const auto gain = (uint32_t)(o_.digital_gain + marker_step_);
  if (fd_ >= 0 && !(send_bytes(spy::encode_setting(spy::IQ_FREQUENCY, f)) &&
                    send_bytes(spy::encode_setting(spy::IQ_DIGITAL_GAIN, gain)))) {
    log_("SpyServer: retune to " + std::to_string(f) + " not sent: " + send_fail_);
    return false;   // generation untouched: nothing new is coming from this center
  }
  want_gain_.store(gain, std::memory_order_release);
  gen_.fetch_add(1, std::memory_order_acq_rel);
  return true;
}

double SpyServerSource::seconds_since_rx() const { return (mono_ns() - last_rx_ns_.load()) / 1e9; }
}  // namespace kc
