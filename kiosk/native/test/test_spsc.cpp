#include <thread>
#include <vector>

#include "check.hpp"
#include "spsc.hpp"

TEST(spsc_queue_fifo_and_full) {
  kc::SpscQueue<int> q(3);             // rounds to 4
  CHECK(q.capacity() == 4);
  for (int i = 0; i < 4; i++) CHECK(q.try_push(i));
  CHECK(!q.try_push(99));              // full
  int v = -1;
  for (int i = 0; i < 4; i++) { CHECK(q.try_pop(v)); CHECK(v == i); }
  CHECK(!q.try_pop(v));                // empty
}

TEST(spsc_queue_emplace_consume_in_place) {
  struct Big { int n = 0; int data[1000]; };
  kc::SpscQueue<Big> q(2);
  CHECK(q.try_emplace([](Big& b) { b.n = 7; b.data[999] = 42; }));
  int got = 0;
  CHECK(q.try_consume([&](const Big& b) { got = b.n + b.data[999]; }));
  CHECK(got == 49);
  CHECK(!q.try_consume([](const Big&) {}));
}

TEST(spsc_ring_bulk_wrap_discard) {
  kc::SpscRing<short> r(8);
  short a[6] = {1, 2, 3, 4, 5, 6}, b[8] = {};
  CHECK(r.write(a, 6) == 6);
  CHECK(r.read(b, 4) == 4 && b[0] == 1 && b[3] == 4);
  CHECK(r.write(a, 6) == 6);           // wraps
  CHECK(r.size() == 8);
  CHECK(r.write(a, 1) == 0);           // full
  CHECK(r.discard(3) == 3);            // drops 5, 6, 1
  CHECK(r.read(b, 8) == 5 && b[0] == 2 && b[4] == 6);
}

TEST(spsc_two_thread_stress_preserves_order) {
  kc::SpscRing<int> r(1024);
  const int N = 2'000'000;
  std::thread prod([&] {
    int next = 0, buf[64];
    while (next < N) {
      int k = 0;
      while (k < 64 && next + k < N) { buf[k] = next + k; k++; }
      next += (int)r.write(buf, (size_t)k);
    }
  });
  int expect = 0, bad = 0, buf[97];
  while (expect < N) {
    size_t n = r.read(buf, 97);
    for (size_t i = 0; i < n; i++) if (buf[i] != expect++) bad++;
  }
  prod.join();
  CHECK(bad == 0);
}
