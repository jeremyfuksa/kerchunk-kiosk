// Pure retry/timeout loop behind AlsaSink::open (no device is opened here).
#include <cerrno>
#include <chrono>

#include "check.hpp"
#include "outputs.hpp"

using kc::BusyRetry;

TEST(busy_retry_succeeds_after_busy_attempts) {
  int calls = 0, rc = 1;
  const auto r = BusyRetry::run([&] { return ++calls <= 3 ? -EBUSY : 0; }, {}, 1.0, 1, rc);
  CHECK(r == BusyRetry::Result::Ok);
  CHECK(calls == 4 && rc == 0);
}

TEST(busy_retry_eagain_counts_as_busy) {
  int calls = 0, rc = 1;
  const auto r = BusyRetry::run([&] { return ++calls <= 2 ? -EAGAIN : 0; }, {}, 1.0, 1, rc);
  CHECK(r == BusyRetry::Result::Ok && calls == 3);
}

TEST(busy_retry_times_out) {
  int calls = 0, rc = 0;
  const auto t0 = std::chrono::steady_clock::now();
  const auto r = BusyRetry::run([&] { ++calls; return -EBUSY; }, {}, 0.05, 5, rc);
  const double el = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
  CHECK(r == BusyRetry::Result::TimedOut);
  CHECK(rc == -EBUSY && calls >= 2);
  CHECK(el >= 0.05 && el < 1.0);
}

TEST(busy_retry_aborts_on_should_stop) {
  int calls = 0, rc = 0;
  const auto r = BusyRetry::run([&] { ++calls; return -EBUSY; }, [&] { return calls >= 2; }, 10.0, 1, rc);
  CHECK(r == BusyRetry::Result::Aborted);
  CHECK(calls == 2);
}

TEST(busy_retry_non_busy_error_fails_immediately) {
  int calls = 0, rc = 0;
  const auto r = BusyRetry::run([&] { ++calls; return -ENOENT; }, {}, 10.0, 1, rc);
  CHECK(r == BusyRetry::Result::Failed);
  CHECK(calls == 1 && rc == -ENOENT);
}
