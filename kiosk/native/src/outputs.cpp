#include "outputs.hpp"

#include <fcntl.h>
#include <unistd.h>

#include <algorithm>
#include <cerrno>
#include <chrono>
#include <csignal>
#include <cstring>
#include <vector>

#include "protocol.hpp"

namespace kc {

void EventOut::start() {
  running_ = true;
  t_ = std::thread([this] { run(); });
}

void EventOut::emit(const nlohmann::json& ev) {
  std::string line = to_line(ev);
  {
    std::lock_guard<std::mutex> g(m_);
    q_.push_back(std::move(line));
  }
  cv_.notify_one();
}

void EventOut::run() {
  std::unique_lock<std::mutex> lk(m_);
  for (;;) {
    cv_.wait(lk, [this] { return !q_.empty() || stopping_; });
    while (!q_.empty()) {
      std::string s = std::move(q_.front());
      q_.pop_front();
      lk.unlock();
      std::fputs(s.c_str(), out_);
      std::fflush(out_);   // Node reads line-by-line; an unflushed pipe delays events by seconds
      lk.lock();
    }
    if (stopping_) return;
  }
}

void EventOut::stop() {
  if (!running_) return;
  {
    std::lock_guard<std::mutex> g(m_);
    stopping_ = true;
  }
  cv_.notify_one();
  t_.join();
  running_ = false;
}

void FdPump::set_fd(int fd) {
  if (fd >= 0) fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK);
  fd_.store(fd);
}

void FdPump::start() {
  std::signal(SIGPIPE, SIG_IGN);   // a reader that went away must surface as EPIPE, never kill the helper
  running_ = true;
  t_ = std::thread([this] { run(); });
}

void FdPump::stop() {
  if (!running_.exchange(false)) return;
  t_.join();
}

void FdPump::run() {
  std::vector<int16_t> chunk(4800);
  while (running_) {
    const size_t n = ring_.read(chunk.data(), chunk.size());
    if (n == 0) { std::this_thread::sleep_for(std::chrono::milliseconds(5)); continue; }
    const int fd = fd_.load();
    if (fd < 0) continue;   // discard
    const char* p = (const char*)chunk.data();
    size_t left = n * 2;
    while (left > 0) {
      const ssize_t k = ::write(fd, p, left);
      if (k > 0) { p += k; left -= (size_t)k; continue; }
      if (k < 0 && errno == EINTR) continue;
      if (k < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {   // reader slow: drop, never block
        dropped_.fetch_add(left / 2, std::memory_order_relaxed);
        break;
      }
      if (!failed_logged_) { failed_logged_ = true; log_(name_ + " write failed: " + std::strerror(errno)); }
      dropped_.fetch_add(left / 2, std::memory_order_relaxed);
      break;
    }
  }
}

bool AlsaSink::open(std::string& err) {
  int rc = snd_pcm_open(&pcm_, device_.c_str(), SND_PCM_STREAM_PLAYBACK, 0);
  if (rc < 0) { err = "ALSA open " + device_ + ": " + snd_strerror(rc); pcm_ = nullptr; return false; }
  rc = snd_pcm_set_params(pcm_, SND_PCM_FORMAT_S16_LE, SND_PCM_ACCESS_RW_INTERLEAVED, 1, AUDIO_RATE, 1, ALSA_LATENCY_US);
  if (rc < 0) { err = "ALSA params: " + std::string(snd_strerror(rc)); snd_pcm_close(pcm_); pcm_ = nullptr; return false; }
  return true;
}

void AlsaSink::start() {
  running_ = true;
  t_ = std::thread([this] { run(); });
}

void AlsaSink::stop() {
  if (!running_.exchange(false)) { if (pcm_) { snd_pcm_close(pcm_); pcm_ = nullptr; } return; }
  t_.join();
  snd_pcm_drop(pcm_);
  snd_pcm_close(pcm_);
  pcm_ = nullptr;
}

void AlsaSink::run() {
  std::vector<int16_t> buf(ALSA_PERIOD);
  int consecutive_fail = 0;
  bool logged = false;
  while (running_) {
    ring_.discard(JitterPolicy::drop_for(ring_.size()));   // SDR clock vs sound-card clock drift
    const size_t n = ring_.read(buf.data(), buf.size());
    std::fill(buf.begin() + (long)n, buf.end(), (int16_t)0);  // underrun: play silence, never stall
    snd_pcm_sframes_t w = snd_pcm_writei(pcm_, buf.data(), buf.size());
    if (w < 0) w = snd_pcm_recover(pcm_, (int)w, 1);
    if (w < 0) {
      if (!logged) { logged = true; log_(std::string("ALSA write failed: ") + snd_strerror((int)w) + " (detection continues)"); }
      if (++consecutive_fail > 50) std::this_thread::sleep_for(std::chrono::milliseconds(10));
    } else {
      consecutive_fail = 0;
    }
  }
}
}  // namespace kc
