#include "multimon.hpp"

#include <fcntl.h>
#include <signal.h>
#include <sys/wait.h>
#include <unistd.h>

#include <cerrno>
#include <cstring>

namespace kc {

bool Multimon::spawn(std::string& err) {
  int in[2], out[2];
  if (pipe(in) != 0 || pipe(out) != 0) { err = std::string("pipe: ") + std::strerror(errno); return false; }
  const pid_t pid = fork();
  if (pid < 0) { err = std::string("fork: ") + std::strerror(errno); return false; }
  if (pid == 0) {
    dup2(in[0], 0);
    dup2(out[1], 1);
    const int devnull = ::open("/dev/null", O_WRONLY);
    if (devnull >= 0) dup2(devnull, 2);
    for (int fd = 3; fd < 256; fd++) close(fd);
    std::vector<char*> a;
    for (auto& s : argv_) a.push_back(const_cast<char*>(s.c_str()));
    a.push_back(nullptr);
    execvp(a[0], a.data());
    _exit(127);
  }
  close(in[0]);
  close(out[1]);
  pid_ = pid;
  pump_.set_fd(in[1]);                       // the pump now feeds the new child ...
  if (stdin_fd_ >= 0) close(stdin_fd_);      // ... so the previous child's stdin can go
  stdin_fd_ = in[1];
  out_fd_ = out[0];
  return true;
}

bool Multimon::start(std::string& err) {
  if (!spawn(err)) return false;
  running_ = true;
  pump_.start();
  t_ = std::thread([this] { reader(); });
  return true;
}

void Multimon::reader() {
  std::string line;
  char buf[512];
  while (running_) {
    const ssize_t k = read(out_fd_.load(), buf, sizeof buf);
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
    // EOF: the child exited. SAME is a weather-safety feature -- a silent death must be visible.
    if (!running_) return;
    log_("multimon-ng exited: SAME decoding stopped");
    close(out_fd_.exchange(-1));
    if (pid_ > 0) waitpid(pid_, nullptr, 0);
    pid_ = -1;
    line.clear();
    if (respawns_ >= 1) { pump_.set_fd(-1); return; }
    respawns_++;
    std::string err;
    if (!spawn(err)) { log_("multimon-ng respawn failed: " + err); pump_.set_fd(-1); return; }
  }
}

void Multimon::stop() {
  if (!running_.exchange(false)) return;
  pump_.stop();                              // stop writing before the child goes away
  if (pid_ > 0) kill(pid_, SIGTERM);
  if (t_.joinable()) t_.join();
  if (pid_ > 0) { waitpid(pid_, nullptr, 0); pid_ = -1; }
  const int of = out_fd_.exchange(-1);
  if (of >= 0) close(of);
  if (stdin_fd_ >= 0) { close(stdin_fd_); stdin_fd_ = -1; }
}
}  // namespace kc
