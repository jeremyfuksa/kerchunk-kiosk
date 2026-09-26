#include <fcntl.h>
#include <unistd.h>

#include <chrono>
#include <cstdio>
#include <string>
#include <thread>
#include <vector>

#include "check.hpp"
#include "constants.hpp"
#include "outputs.hpp"

TEST(jitter_policy_trims_only_above_max) {
  CHECK(kc::JitterPolicy::drop_for(0) == 0);
  CHECK(kc::JitterPolicy::drop_for(kc::AUDIO_MAX_LAT) == 0);
  CHECK(kc::JitterPolicy::drop_for(kc::AUDIO_MAX_LAT + 1) == (size_t)(kc::AUDIO_MAX_LAT + 1 - kc::AUDIO_TARGET_LAT));
}

TEST(event_out_writes_one_flushed_line_per_event) {
  char path[] = "/tmp/kc-evout-XXXXXX";
  int fd = mkstemp(path);
  FILE* f = fdopen(fd, "w");
  {
    kc::EventOut out(f);
    out.start();
    out.emit({{"ev", "ready"}});
    std::thread other([&] { out.log("hello"); });
    other.join();
    out.stop();
  }
  std::fclose(f);
  FILE* r = std::fopen(path, "r");
  char line[256];
  std::vector<std::string> lines;
  while (std::fgets(line, sizeof line, r)) lines.push_back(line);
  std::fclose(r);
  unlink(path);
  CHECK(lines.size() == 2);
  CHECK(lines.size() == 2 && lines[0] == "{\"ev\":\"ready\"}\n" && lines[1] == "{\"ev\":\"log\",\"msg\":\"hello\"}\n");
}

TEST(fd_pump_delivers_and_drops_instead_of_blocking) {
  int p[2];
  CHECK(pipe(p) == 0);
  kc::FdPump pump(1 << 16, [](const std::string&) {}, "test");
  pump.set_fd(p[1]);
  pump.start();
  std::vector<int16_t> x(4000);
  for (int i = 0; i < 4000; i++) x[i] = (int16_t)i;
  pump.write(x.data(), x.size());
  std::this_thread::sleep_for(std::chrono::milliseconds(50));
  std::vector<int16_t> got(4000);
  size_t bytes = 0;
  while (bytes < 8000) { ssize_t k = read(p[0], (char*)got.data() + bytes, 8000 - bytes); if (k <= 0) break; bytes += (size_t)k; }
  CHECK(bytes == 8000 && got[3999] == 3999);
  // Nobody reads now: the pipe fills (64 KiB) and the pump must drop, not block the producer.
  std::vector<int16_t> big(200000, 1);
  auto t0 = std::chrono::steady_clock::now();
  for (int k = 0; k < 20; k++) pump.write(big.data(), big.size());
  auto ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
  CHECK(ms < 50);
  std::this_thread::sleep_for(std::chrono::milliseconds(100));
  pump.stop();
  CHECK(pump.dropped() > 0);
  close(p[0]);
  close(p[1]);
}
