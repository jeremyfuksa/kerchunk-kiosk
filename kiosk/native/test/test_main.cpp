// Runs every registered TEST; optional argv[1] = substring filter. Exit 1 on any failure.
#include <csignal>
#include <cstdio>
#include <cstring>
#include "check.hpp"

int main(int argc, char** argv) {
  // FdPump/Multimon tests write to pipes with no reader on the other end; without this the
  // default SIGPIPE disposition would kill the test binary instead of surfacing EPIPE.
  std::signal(SIGPIPE, SIG_IGN);
  const char* filter = argc > 1 ? argv[1] : nullptr;
  int ran = 0;
  for (auto& c : check::registry()) {
    if (filter && !std::strstr(c.name, filter)) continue;
    int before = check::failures();
    c.fn();
    ++ran;
    std::printf("%s %s\n", check::failures() == before ? "ok  " : "FAIL", c.name);
  }
  std::printf("%d tests, %d failed checks\n", ran, check::failures());
  return check::failures() == 0 && ran > 0 ? 0 : 1;
}
