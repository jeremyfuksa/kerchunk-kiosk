#include "outputs.hpp"

#include <fcntl.h>
#include <unistd.h>

#include <algorithm>
#include <cerrno>
#include <chrono>
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

void FdPump::set_fd(int fd, bool owned) {
  if (fd >= 0) fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK);
  std::lock_guard<std::mutex> g(fd_m_);
  if (pending_.load(std::memory_order_relaxed) && pending_owned_ && pending_fd_ >= 0 && pending_fd_ != fd) {
    ::close(pending_fd_);   // never adopted by the pump thread, so closing it here is safe
  }
  pending_fd_ = fd;
  pending_owned_ = owned;
  pending_.store(true, std::memory_order_release);
}

void FdPump::start() {
  running_ = true;
  t_ = std::thread([this] { run(); });
}

void FdPump::stop() {
  // Not gated on "was running_ true at entry": a pump that was never start()ed can still have an
  // owned pending fd sitting unclosed (set_fd() was called, but no thread ever ran to adopt it),
  // and stop() -- called explicitly, or from the destructor -- must not leak it. t_.joinable()
  // (rather than the exchange result) is what decides whether there's a thread to join.
  running_.store(false, std::memory_order_relaxed);
  if (t_.joinable()) t_.join();
  // The pump thread has exited (or never ran); touching cur_*/pending_* here is safe (no
  // concurrent producer of fd changes -- set_fd from another thread after stop() would be a
  // caller bug).
  if (cur_owned_ && cur_fd_ >= 0) { ::close(cur_fd_); cur_fd_ = -1; }
  std::lock_guard<std::mutex> g(fd_m_);
  if (pending_.exchange(false) && pending_owned_ && pending_fd_ >= 0 && pending_fd_ != cur_fd_) {
    ::close(pending_fd_);   // a set_fd() that arrived too late to ever be adopted must not leak
  }
}

void FdPump::run() {
  std::vector<int16_t> chunk(4800);
  std::vector<char> outbuf;
  while (running_) {
    if (pending_.load(std::memory_order_acquire)) {
      int nfd; bool nowned;
      {
        std::lock_guard<std::mutex> g(fd_m_);
        nfd = pending_fd_;
        nowned = pending_owned_;
        pending_.store(false, std::memory_order_release);
      }
      if (cur_owned_ && cur_fd_ >= 0 && cur_fd_ != nfd) ::close(cur_fd_);   // never while writing: only here, between chunks
      cur_fd_ = nfd;
      cur_owned_ = nowned;
      failed_logged_ = false;   // a failure on the new child/fd must be logged again
      have_carry_ = false;      // a stray byte from the old stream must not bleed into the new one
    }
    const size_t n = ring_.read(chunk.data(), chunk.size());
    if (n == 0) { std::this_thread::sleep_for(std::chrono::milliseconds(5)); continue; }
    const int fd = cur_fd_;
    if (fd < 0) continue;   // discard

    outbuf.clear();
    if (have_carry_) { outbuf.push_back((char)carry_byte_); have_carry_ = false; }
    const char* cp = (const char*)chunk.data();
    outbuf.insert(outbuf.end(), cp, cp + n * 2);

    const char* p = outbuf.data();
    size_t left = outbuf.size();
    while (left > 0) {
      const ssize_t k = ::write(fd, p, left);
      if (k > 0) { p += k; left -= (size_t)k; continue; }
      if (k < 0 && errno == EINTR) continue;
      if (k < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
        // Reader slow: drop, never block -- but only ever in whole samples. Any odd trailing byte
        // is held back as `carry_` and prepended to the next write so the receiver's int16 stream
        // never loses alignment (dropping mid-sample would permanently byte-shift everything after).
        dropped_.fetch_add(left / 2, std::memory_order_relaxed);
        if (left % 2) { have_carry_ = true; carry_byte_ = (unsigned char)p[left - 1]; }
        break;
      }
      if (!failed_logged_) { failed_logged_ = true; log_(name_ + " write failed: " + std::strerror(errno)); }
      dropped_.fetch_add(left / 2, std::memory_order_relaxed);
      if (left % 2) { have_carry_ = true; carry_byte_ = (unsigned char)p[left - 1]; }
      break;
    }
  }
}

bool AlsaSink::open(std::string& err, const std::function<bool()>& should_stop) {
  int rc = 0;
  const auto res = BusyRetry::run(
      [&] {
        const int r = snd_pcm_open(&pcm_, device_.c_str(), SND_PCM_STREAM_PLAYBACK, SND_PCM_NONBLOCK);
        if (r < 0) pcm_ = nullptr;
        return r;
      },
      should_stop, ALSA_BUSY_RETRY_S, ALSA_BUSY_RETRY_MS, rc);
  if (res == BusyRetry::Result::Aborted) { err = "aborted"; return false; }
  if (res == BusyRetry::Result::TimedOut) {
    char s[32];
    std::snprintf(s, sizeof s, "%g", ALSA_BUSY_RETRY_S);
    err = "ALSA device " + device_ + " busy for " + s + " s";
    return false;
  }
  if (res == BusyRetry::Result::Failed) { err = "ALSA open " + device_ + ": " + snd_strerror(rc); return false; }
  // Opened non-blocking only so a busy device can't hang open(); the writer thread wants blocking
  // writes (it paces itself on the card).
  rc = snd_pcm_nonblock(pcm_, 0);
  if (rc < 0) { err = "ALSA nonblock(0) " + device_ + ": " + snd_strerror(rc); snd_pcm_close(pcm_); pcm_ = nullptr; return false; }
  rc = snd_pcm_set_params(pcm_, SND_PCM_FORMAT_S16_LE, SND_PCM_ACCESS_RW_INTERLEAVED, 1, AUDIO_RATE, 1, ALSA_LATENCY_US);
  if (rc < 0) { err = "ALSA params: " + std::string(snd_strerror(rc)); snd_pcm_close(pcm_); pcm_ = nullptr; return false; }
  return true;
}

void AlsaSink::start() {
  if (!pcm_) return;   // open() never succeeded -- nothing to run
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
  bool underrun = false;
  double waited_ms = 0;
  int consecutive_fail = 0;
  bool logged = false;
  while (running_) {
    ring_.discard(JitterPolicy::drop_for(ring_.size()));   // SDR clock vs sound-card clock drift
    const AlsaPolicy::Action act = AlsaPolicy::decide(ring_.size(), underrun, waited_ms);
    if (act == AlsaPolicy::Action::Wait) {
      std::this_thread::sleep_for(std::chrono::milliseconds(1));
      waited_ms += 1.0;
      continue;
    }
    waited_ms = 0;
    if (act == AlsaPolicy::Action::Silence) {
      underrun = true;
      std::fill(buf.begin(), buf.end(), (int16_t)0);
    } else {   // Read: policy already guaranteed a full period is queued
      underrun = false;
      const size_t n = ring_.read(buf.data(), buf.size());
      if (n < buf.size()) std::fill(buf.begin() + (long)n, buf.end(), (int16_t)0);   // defensive
    }
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
