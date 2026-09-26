#include "multimon.hpp"

#include <fcntl.h>
#include <signal.h>
#include <sys/wait.h>
#include <unistd.h>

#include <cerrno>
#include <chrono>
#include <csignal>
#include <cstring>

namespace kc {
namespace {
// close_range (Linux 5.9+ / glibc 2.34+) closes every fd >= lowfd in one syscall; older
// glibc/kernels fall back to the classic probe loop. Both branches are async-signal-safe (plain
// syscalls only), so this is safe to call between fork() and execvp() in the child.
#if defined(__GLIBC__) && defined(__GLIBC_MINOR__) && (__GLIBC__ > 2 || (__GLIBC__ == 2 && __GLIBC_MINOR__ >= 34))
void close_fds_from(int lowfd) {
  if (close_range((unsigned)lowfd, ~0u, 0) == 0) return;
  for (int fd = lowfd; fd < 256; fd++) close(fd);
}
#else
void close_fds_from(int lowfd) {
  for (int fd = lowfd; fd < 256; fd++) close(fd);
}
#endif
}  // namespace

bool Multimon::spawn(std::string& err) {
  int in[2], out[2];
  if (pipe2(in, O_CLOEXEC) != 0) { err = std::string("pipe: ") + std::strerror(errno); return false; }
  if (pipe2(out, O_CLOEXEC) != 0) {
    err = std::string("pipe: ") + std::strerror(errno);
    close(in[0]); close(in[1]);
    return false;
  }
  // Build argv before fork(): between fork() and execvp() only async-signal-safe calls are safe
  // in a multithreaded process, so no allocation (std::vector/std::string growth) may happen in
  // the child -- everything the child touches is prepared here, in the parent, first.
  std::vector<char*> a;
  a.reserve(argv_.size() + 1);
  for (auto& s : argv_) a.push_back(const_cast<char*>(s.c_str()));
  a.push_back(nullptr);

  const pid_t pid = fork();
  if (pid < 0) {
    err = std::string("fork: ") + std::strerror(errno);
    close(in[0]); close(in[1]); close(out[0]); close(out[1]);
    return false;
  }
  if (pid == 0) {
    // Child: async-signal-safe calls only, until execvp (or _exit on failure).
    setpgid(0, 0);   // its own process group -- so stop() can signal it *and* any grandchildren (e.g. a `sleep` inside a shell loop) together
    std::signal(SIGPIPE, SIG_DFL);   // the parent process ignores SIGPIPE; the child must not inherit that
    dup2(in[0], 0);
    dup2(out[1], 1);
    const int devnull = ::open("/dev/null", O_WRONLY);
    if (devnull >= 0) dup2(devnull, 2);
    close_fds_from(3);
    execvp(a[0], a.data());
    _exit(127);
  }
  setpgid(pid, pid);   // also from the parent: closes the race where stop() could signal before the child's own setpgid runs
  close(in[0]);
  close(out[1]);
  pid_ = pid;
  spawned_at_ = std::chrono::steady_clock::now();
  out_fd_ = out[0];
  pump_.set_fd(in[1], /*owned=*/true);   // the pump now owns this fd; it closes the previous one itself
  return true;
}

bool Multimon::start(std::string& err) {
  std::lock_guard<std::mutex> g(life_m_);
  if (!spawn(err)) return false;
  running_ = true;
  pump_.start();
  t_ = std::thread([this] { reader(); });
  return true;
}

void Multimon::reader() {
  std::string line;
  char buf[512];
  for (;;) {
    int fd;
    {
      std::lock_guard<std::mutex> g(life_m_);
      if (!running_) return;
      fd = out_fd_.load(std::memory_order_relaxed);
    }
    const ssize_t k = read(fd, buf, sizeof buf);
    if (k > 0) {
      for (ssize_t i = 0; i < k; i++) {
        if (buf[i] == '\n') {
          if (is_same_line(line)) emit_({{"ev", "same"}, {"raw", line}});
          line.clear();
        } else {
          line.push_back(buf[i]);
        }
      }
      continue;
    }
    if (k < 0 && errno == EINTR) continue;
    // EOF (child exited) or the fd went away because stop() tore it down under us.
    std::lock_guard<std::mutex> g(life_m_);
    if (!running_) return;   // stop() got here first; it owns reaping the pid it captured
    log_("multimon-ng exited: SAME decoding stopped");   // SAME is a weather-safety feature -- a silent death must be visible
    const int of = out_fd_.exchange(-1);
    if (of >= 0) close(of);
    if (pid_ > 0) { waitpid(pid_, nullptr, 0); pid_ = -1; }
    line.clear();
    const double ran_s = std::chrono::duration<double>(std::chrono::steady_clock::now() - spawned_at_).count();
    if (ran_s >= healthy_s_) respawns_ = 0;   // it was healthy: this is a fresh failure, not a crash loop
    if (respawns_ >= max_respawns_) {
      log_("multimon-ng keeps exiting (" + std::to_string(respawns_) + " quick restarts): giving up, SAME decoding is OFF until the helper restarts");
      pump_.set_fd(-1); running_ = false; return;
    }
    respawns_++;
    std::string err;
    if (!spawn(err)) { log_("multimon-ng respawn failed: " + err); pump_.set_fd(-1); running_ = false; return; }
  }
}

void Multimon::stop() {
  // Deliberately not gated on "was running_ true at entry": reader()'s give-up path also flips
  // running_ to false itself (from the reader thread, after already reaping its own pid), and t_
  // must still be joined here in that case -- a joinable std::thread destructing (via Multimon's
  // own destructor, later) calls std::terminate. Every step below is cheap and idempotent, so
  // running the full sequence unconditionally is safe whether the child is alive, already gave
  // up, or stop() is simply called twice.
  pid_t pid_to_reap = -1;
  {
    std::lock_guard<std::mutex> g(life_m_);
    running_.store(false, std::memory_order_relaxed);
    pid_to_reap = pid_;
    if (pid_to_reap > 0) kill(-pid_to_reap, SIGTERM);   // whole process group: a grandchild (e.g. `sleep`) must not outlive the shell that spawned it
  }
  pump_.stop();                          // idempotent; closes whatever fd it currently owns -> EOF
  if (pid_to_reap > 0) {
    // Bounded wait for a clean exit; escalate to SIGKILL rather than let a wedged/TERM-ignoring
    // child (or a stale pid) hang shutdown. This must run *before* joining the reader thread
    // below: the reader is blocked in a plain read() on the child's stdout, which only unblocks
    // once every fd referencing that pipe's write end is closed -- i.e. once every process
    // holding it open (the child, and any grandchild it spawned) actually dies. Joining first
    // would deadlock against a child that ignores SIGTERM.
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(300);
    for (;;) {
      const pid_t r = waitpid(pid_to_reap, nullptr, WNOHANG);
      if (r == pid_to_reap || r < 0) break;
      if (std::chrono::steady_clock::now() >= deadline) {
        kill(-pid_to_reap, SIGKILL);   // whole group -- see the SIGTERM above
        waitpid(pid_to_reap, nullptr, 0);
        break;
      }
      std::this_thread::sleep_for(std::chrono::milliseconds(5));
    }
  }
  if (t_.joinable()) t_.join();          // now unblocks: the child is dead, its stdout write end is closed
  const int of = out_fd_.exchange(-1);
  if (of >= 0) close(of);
  pid_ = -1;
}
}  // namespace kc
