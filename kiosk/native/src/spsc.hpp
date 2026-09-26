// Lock-free single-producer / single-consumer primitives for the live helper's thread boundaries.
#pragma once
#include <algorithm>
#include <atomic>
#include <cstddef>
#include <utility>
#include <vector>

namespace kc {
namespace spsc_detail {
inline size_t round_pow2(size_t n) { size_t c = 1; while (c < n) c <<= 1; return c; }
}

template <class T>
class SpscQueue {
 public:
  explicit SpscQueue(size_t capacity) : cap_(spsc_detail::round_pow2(capacity)), mask_(cap_ - 1), slots_(cap_) {}
  bool try_push(T v) {
    return try_emplace([&](T& s) { s = std::move(v); });
  }
  bool try_pop(T& out) {
    return try_consume_mut([&](T& s) { out = std::move(s); });
  }
  template <class F>
  bool try_emplace(F&& fill) {
    const size_t h = head_.load(std::memory_order_relaxed);
    if (h - tail_.load(std::memory_order_acquire) == cap_) return false;
    fill(slots_[h & mask_]);
    head_.store(h + 1, std::memory_order_release);
    return true;
  }
  template <class F>
  bool try_consume(F&& use) {
    return try_consume_mut([&](T& s) { use(static_cast<const T&>(s)); });
  }
  size_t size() const { return head_.load(std::memory_order_acquire) - tail_.load(std::memory_order_acquire); }
  size_t capacity() const { return cap_; }

 private:
  template <class F>
  bool try_consume_mut(F&& use) {
    const size_t t = tail_.load(std::memory_order_relaxed);
    if (t == head_.load(std::memory_order_acquire)) return false;
    use(slots_[t & mask_]);
    tail_.store(t + 1, std::memory_order_release);
    return true;
  }
  const size_t cap_, mask_;
  std::vector<T> slots_;
  alignas(64) std::atomic<size_t> head_{0};
  alignas(64) std::atomic<size_t> tail_{0};
};

template <class T>
class SpscRing {
 public:
  explicit SpscRing(size_t capacity) : cap_(spsc_detail::round_pow2(capacity)), mask_(cap_ - 1), buf_(cap_) {}
  size_t write(const T* x, size_t n) {
    const size_t h = head_.load(std::memory_order_relaxed);
    const size_t space = cap_ - (h - tail_.load(std::memory_order_acquire));
    n = std::min(n, space);
    for (size_t i = 0; i < n; i++) buf_[(h + i) & mask_] = x[i];
    head_.store(h + n, std::memory_order_release);
    return n;
  }
  size_t read(T* out, size_t n) {
    const size_t t = tail_.load(std::memory_order_relaxed);
    n = std::min(n, head_.load(std::memory_order_acquire) - t);
    for (size_t i = 0; i < n; i++) out[i] = buf_[(t + i) & mask_];
    tail_.store(t + n, std::memory_order_release);
    return n;
  }
  size_t discard(size_t n) {
    const size_t t = tail_.load(std::memory_order_relaxed);
    n = std::min(n, head_.load(std::memory_order_acquire) - t);
    tail_.store(t + n, std::memory_order_release);
    return n;
  }
  size_t size() const { return head_.load(std::memory_order_acquire) - tail_.load(std::memory_order_acquire); }
  size_t capacity() const { return cap_; }

 private:
  const size_t cap_, mask_;
  std::vector<T> buf_;
  alignas(64) std::atomic<size_t> head_{0};
  alignas(64) std::atomic<size_t> tail_{0};
};
}  // namespace kc
