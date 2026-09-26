// Minimal test harness: TEST(name) registers a case; CHECK* record failures and keep going.
#pragma once
#include <cmath>
#include <cstdio>
#include <functional>
#include <string>
#include <utility>
#include <vector>

namespace check {
struct Case { const char* name; std::function<void()> fn; };
inline std::vector<Case>& registry() { static std::vector<Case> r; return r; }
inline int& failures() { static int f = 0; return f; }
struct Reg { Reg(const char* n, std::function<void()> f) { registry().push_back({n, std::move(f)}); } };
inline void fail(const char* file, int line, const std::string& msg) {
  std::fprintf(stderr, "  FAIL %s:%d: %s\n", file, line, msg.c_str());
  ++failures();
}
}  // namespace check

#define KC_CAT2(a, b) a##b
#define KC_CAT(a, b) KC_CAT2(a, b)
#define TEST(name) \
  static void name(); \
  static check::Reg KC_CAT(reg_, name)(#name, name); \
  static void name()
#define CHECK(cond) \
  do { if (!(cond)) check::fail(__FILE__, __LINE__, #cond); } while (0)
#define CHECK_NEAR(a, b, tol) \
  do { \
    double kc_a_ = (a), kc_b_ = (b); \
    if (!(std::fabs(kc_a_ - kc_b_) <= (tol))) \
      check::fail(__FILE__, __LINE__, std::string(#a " ~ " #b ": ") + std::to_string(kc_a_) + " vs " + std::to_string(kc_b_)); \
  } while (0)
#define CHECK_THROWS(expr) \
  do { \
    bool kc_t_ = false; \
    try { (void)(expr); } catch (...) { kc_t_ = true; } \
    if (!kc_t_) check::fail(__FILE__, __LINE__, "expected throw: " #expr); \
  } while (0)
