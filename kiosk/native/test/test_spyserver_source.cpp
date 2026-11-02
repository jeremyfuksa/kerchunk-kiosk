// SpyServerSource against a loopback fake server speaking the real frame layouts.
#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>

#include <atomic>
#include <chrono>
#include <cstring>
#include <mutex>
#include <thread>
#include <utility>
#include <vector>

#include "check.hpp"
#include "constants.hpp"
#include "spyserver_protocol.hpp"
#include "spyserver_source.hpp"

namespace {
using Clock = std::chrono::steady_clock;
void put(std::vector<uint8_t>& b, uint32_t v) {
  for (int i = 0; i < 4; i++) b.push_back((uint8_t)(v >> (8 * i)));
}
std::vector<uint8_t> frame(uint32_t type, const std::vector<uint32_t>& words) {
  std::vector<uint8_t> b;
  put(b, 0x02000782);
  put(b, type);
  put(b, 0);
  put(b, 0);
  put(b, (uint32_t)words.size() * 4);
  for (uint32_t w : words) put(b, w);
  return b;
}
void send_all(int fd, const std::vector<uint8_t>& b) {
  size_t off = 0;
  while (off < b.size()) {
    const ssize_t w = ::send(fd, b.data() + off, b.size() - off, MSG_NOSIGNAL);
    if (w <= 0) return;
    off += (size_t)w;
  }
}

class FakeServer {
 public:
  explicit FakeServer(uint32_t can_control = 1, uint32_t max_rate = 768000) : can_control_(can_control), max_rate_(max_rate) {
    lfd_ = ::socket(AF_INET, SOCK_STREAM, 0);
    sockaddr_in a{};
    a.sin_family = AF_INET;
    a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    ::bind(lfd_, (sockaddr*)&a, sizeof a);
    ::listen(lfd_, 1);
    socklen_t l = sizeof a;
    ::getsockname(lfd_, (sockaddr*)&a, &l);
    port_ = ntohs(a.sin_port);
    t_ = std::thread([this] { run(); });
  }
  ~FakeServer() { shutdown(); }
  int port() const { return port_; }
  void drop_client() { drop_ = true; }
  void shutdown() {
    stop_ = true;
    if (lfd_ >= 0) { ::shutdown(lfd_, SHUT_RDWR); ::close(lfd_); lfd_ = -1; }
    if (t_.joinable()) t_.join();
  }
  std::vector<std::pair<uint32_t, uint32_t>> settings() {
    std::lock_guard<std::mutex> g(m_);
    return settings_;
  }
  bool saw(uint32_t setting, uint32_t value) {
    for (auto& s : settings()) if (s.first == setting && s.second == value) return true;
    return false;
  }

 private:
  void run() {
    const int fd = ::accept(lfd_, nullptr, nullptr);
    if (fd < 0) return;
    std::vector<uint8_t> in;
    bool greeted = false, streaming = false;
    std::vector<uint8_t> iq = frame(kc::spy::MSG_UINT8_IQ, std::vector<uint32_t>(1920, 0x7f7f7f7fu));  // 3840 samples, 5 ms
    while (!stop_ && !drop_) {
      uint8_t buf[256];
      const ssize_t r = ::recv(fd, buf, sizeof buf, MSG_DONTWAIT);
      if (r == 0) break;
      if (r > 0) in.insert(in.end(), buf, buf + r);
      while (in.size() >= 8) {
        uint32_t cmd, size;
        std::memcpy(&cmd, in.data(), 4);
        std::memcpy(&size, in.data() + 4, 4);
        if (in.size() < 8 + (size_t)size) break;
        if (cmd == kc::spy::CMD_HELLO) greeted = true;
        if (cmd == kc::spy::CMD_SET_SETTING) {
          uint32_t k, v;
          std::memcpy(&k, in.data() + 8, 4);
          std::memcpy(&v, in.data() + 12, 4);
          std::lock_guard<std::mutex> g(m_);
          settings_.push_back({k, v});
          if (k == kc::spy::STREAMING_ENABLED) streaming = v != 0;
        }
        in.erase(in.begin(), in.begin() + 8 + (std::ptrdiff_t)size);
      }
      if (greeted) {
        greeted = false;
        send_all(fd, frame(kc::spy::MSG_DEVICE_INFO, {2, 942747699, max_rate_, 660000, 8, 0, 8, 0, 1700000000, 16, 0, 0}));
        send_all(fd, frame(kc::spy::MSG_CLIENT_SYNC, {can_control_, 5, 100000000, 100000000, 100000000, 330000, 1699670000, 330000, 1699670000, 0}));
      }
      if (streaming) send_all(fd, iq);
      std::this_thread::sleep_for(std::chrono::milliseconds(5));
    }
    ::close(fd);
  }
  uint32_t can_control_, max_rate_;
  int lfd_ = -1, port_ = 0;
  std::thread t_;
  std::atomic<bool> stop_{false}, drop_{false};
  std::mutex m_;
  std::vector<std::pair<uint32_t, uint32_t>> settings_;
};

kc::LogFn quiet() { return [](const std::string&) {}; }

// Consumes for up to `seconds`, collecting (gen, bytes) until `want` blocks arrive.
std::vector<std::pair<uint32_t, uint32_t>> collect(kc::SpyServerSource& s, size_t want, double seconds = 3.0) {
  std::vector<std::pair<uint32_t, uint32_t>> got;
  const auto end = Clock::now() + std::chrono::duration<double>(seconds);
  while (got.size() < want && Clock::now() < end) {
    if (!s.consume([&](const kc::IqBlock& b) { got.push_back({b.gen, b.n}); }))
      std::this_thread::sleep_for(std::chrono::milliseconds(1));
  }
  return got;
}
template <typename Pred>
bool eventually(Pred p, double seconds = 2.0) {
  const auto end = Clock::now() + std::chrono::duration<double>(seconds);
  while (Clock::now() < end) {
    if (p()) return true;
    std::this_thread::sleep_for(std::chrono::milliseconds(2));
  }
  return p();
}
}  // namespace

TEST(spy_source_handshake_sends_iq_only_u8_768k) {
  FakeServer f;
  kc::SpyServerSource s({"127.0.0.1", f.port()}, quiet());
  std::string err;
  CHECK(s.open(err, {}));
  s.start();
  CHECK(eventually([&] { return f.saw(kc::spy::STREAMING_ENABLED, 1); }));
  CHECK(f.saw(kc::spy::STREAMING_MODE, kc::spy::STREAM_IQ_ONLY));
  CHECK(f.saw(kc::spy::IQ_FORMAT, kc::spy::FORMAT_U8));
  CHECK(f.saw(kc::spy::IQ_DECIMATION, 0));
  s.stop();
}

TEST(spy_source_gain_settings_are_only_sent_when_asked) {
  {
    FakeServer f;
    kc::SpyServerSource s({"127.0.0.1", f.port()}, quiet());
    std::string err;
    CHECK(s.open(err, {}));
    s.start();
    CHECK(eventually([&] { return f.saw(kc::spy::STREAMING_ENABLED, 1); }));
    for (auto& p : f.settings()) CHECK(p.first != kc::spy::GAIN && p.first != kc::spy::IQ_DIGITAL_GAIN);
    s.stop();
  }
  FakeServer f;
  kc::SpyServerSource s({"127.0.0.1", f.port(), 3, 4}, quiet());
  std::string err;
  CHECK(s.open(err, {}));
  s.start();
  CHECK(eventually([&] { return f.saw(kc::spy::STREAMING_ENABLED, 1); }));
  CHECK(f.saw(kc::spy::GAIN, 3) && f.saw(kc::spy::IQ_DIGITAL_GAIN, 4));
  s.stop();
}

TEST(spy_source_blocks_are_10ms_at_750k) {
  FakeServer f;
  kc::SpyServerSource s({"127.0.0.1", f.port()}, quiet());
  std::string err;
  CHECK(s.open(err, {}));
  s.start();
  auto got = collect(s, 5);
  CHECK(got.size() == 5);
  for (auto& b : got) CHECK(b.second == 15000);
  s.stop();
}

TEST(spy_source_set_center_sends_frequency_and_bumps_generation) {
  FakeServer f;
  kc::SpyServerSource s({"127.0.0.1", f.port()}, quiet());
  std::string err;
  CHECK(s.open(err, {}));
  s.start();
  collect(s, 2);
  const uint32_t g0 = s.generation();
  CHECK(s.set_center(7345000));
  CHECK(s.generation() == g0 + 1);
  CHECK(eventually([&] { return f.saw(kc::spy::IQ_FREQUENCY, 7345000); }));
  bool saw_new = false;
  uint32_t last = g0;
  for (auto& b : collect(s, 200)) {
    CHECK(b.first >= last);  // generations never go backwards
    last = b.first;
    saw_new = saw_new || b.first == g0 + 1;
  }
  CHECK(saw_new);
  s.stop();
}

TEST(spy_source_holds_new_generation_back_while_old_center_drains) {
  FakeServer f;
  kc::SpyServerSource s({"127.0.0.1", f.port()}, quiet());
  std::string err;
  CHECK(s.open(err, {}));
  s.start();
  collect(s, 1);
  const uint32_t g = s.generation() + 1;
  CHECK(s.set_center(7345000));
  const auto t0 = Clock::now();
  bool arrived = false;
  while (!arrived && Clock::now() - t0 < std::chrono::seconds(2)) {
    if (!s.consume([&](const kc::IqBlock& b) { arrived = b.gen == g; }))
      std::this_thread::sleep_for(std::chrono::milliseconds(1));
  }
  CHECK(arrived);
  const double ms = std::chrono::duration<double, std::milli>(Clock::now() - t0).count();
  CHECK(ms >= kc::SPY_RETUNE_DISCARD_MS - 5);
  s.stop();
}

TEST(spy_source_open_fails_without_control) {
  FakeServer f(0);
  kc::SpyServerSource s({"127.0.0.1", f.port()}, quiet());
  std::string err;
  CHECK(!s.open(err, {}));
  CHECK(err.find("SpyServer: no control") != std::string::npos);
}

TEST(spy_source_open_fails_on_unexpected_rate) {
  FakeServer f(1, 912000);
  kc::SpyServerSource s({"127.0.0.1", f.port()}, quiet());
  std::string err;
  CHECK(!s.open(err, {}));
  CHECK(err.find("912000") != std::string::npos);
}

TEST(spy_source_open_fails_when_unreachable) {
  int port;
  {
    FakeServer f;
    port = f.port();
    f.shutdown();
  }
  kc::SpyServerSource s({"127.0.0.1", port}, quiet());
  std::string err;
  CHECK(!s.open(err, {}));
  CHECK(err.rfind("failed to open SpyServer", 0) == 0);
}

TEST(spy_source_server_drop_stalls_rx) {
  FakeServer f;
  kc::SpyServerSource s({"127.0.0.1", f.port()}, quiet());
  std::string err;
  CHECK(s.open(err, {}));
  s.start();
  collect(s, 1);
  f.drop_client();
  CHECK(eventually([&] { return s.seconds_since_rx() > kc::STALL_S; }, kc::STALL_S + 1.0));
  const auto t0 = Clock::now();
  s.stop();
  CHECK(Clock::now() - t0 < std::chrono::seconds(1));
}

TEST(spy_source_stop_is_prompt_while_streaming) {
  FakeServer f;
  kc::SpyServerSource s({"127.0.0.1", f.port()}, quiet());
  std::string err;
  CHECK(s.open(err, {}));
  s.start();
  collect(s, 1);
  const auto t0 = Clock::now();
  s.stop();
  CHECK(Clock::now() - t0 < std::chrono::seconds(1));
}
