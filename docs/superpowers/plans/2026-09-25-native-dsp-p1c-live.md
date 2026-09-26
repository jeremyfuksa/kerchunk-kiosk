# Native DSP P1c — Live I/O Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `kerchunk-dsp` a live helper. It reads IQ from an RTL-SDR (addressed by serial), takes JSON commands on stdin and writes events on stdout, plays the speaker through ALSA, and feeds the fd-3 PCM tee and a multimon-ng SAME decoder. It is proven on the appliance's hardware for CPU, events, audio by ear, retune, and shutdown.

**Architecture:** The main thread is the DSP thread. It builds the `Engine` (FFTW planning happens before any other thread starts), calls `dsp_thread_init()`, and runs a `LiveLoop`. Each step of that loop drains commands (only between pushes), applies retune sequencing (generation tags plus a settle discard), and feeds at most one ≤10 ms IQ block.

Other threads:
- **USB reader:** librtlsdr async reads into an SPSC ring of IQ blocks.
- **ALSA writer:** reads from an SPSC sample ring. It pads with silence on underrun and trims latency on overrun.
- **fd pump:** non-blocking tee writes that drop data rather than wait.
- **multimon-ng:** a child process with its own pump and a reader thread.
- **stdin reader:** parses commands into an SPSC command queue.
- **event writer:** serializes events and flushes per line.

**Tech Stack:** C++17, librtlsdr (`librtlsdr-dev`), ALSA (`libasound2-dev`), POSIX (fork/exec, pipes, signals), nlohmann-json, the existing `kcdsp` library.

**Spec:** `docs/superpowers/specs/2026-09-25-native-dsp-engine-design.md` §1, §3, §4. The P1c MUST list is in this plan's Global Constraints; it comes from the P1b final review.

## Global Constraints

- **Threads.** The Engine is single-threaded: `command()`, `push_u8()` and `now()` run only on the DSP (main) thread. Commands drain **between** `push_u8` calls, never inside the hop sink. Each push is ≤10 ms of IQ.
- **FFTW.** All FFTW planning (Channelizer, CloseCall) happens in the Engine constructor, before any other thread starts. `dsp_thread_init()` runs on the DSP thread.
- **Retune.** `set_center` bumps a generation counter. Blocks with an older generation are discarded (the clock still advances). Then `RETUNE_SETTLE_MS` of new-generation samples is discarded to cover in-flight USB transfers. The tune is applied at the first sample after that.
- **The DSP thread never blocks on output.** Speaker, tee and SAME all go into SPSC rings; a full ring drops data. Events go to the writer thread, which does `fflush` per line.
- **Ring drops** advance the engine clock and reset the channelizer stream. They are reported as `power.drops`, plus a `log` at most every `DROP_LOG_EVERY_S`.
- **Device.**
  - RTL-SDR by EEPROM serial (`--rtl-serial`), falling back to index (`--rtl-index`).
  - Opening retries for up to 3 s while the device is busy.
  - More than 2 s with no samples is a stall: exit with status 3 and a stderr reason.
  - `ready` is emitted only after the device is open.
- **ALSA.** Device by name (`plughw:CARD=PCH,DEV=0`), S16_LE mono 48 kHz. `snd_pcm_recover` on errors. Repeated failure is logged once and the scanner keeps detecting. `--sink none` means no ALSA.
- **SAME.** `multimon-ng -t raw -a EAS -`. Lines containing `ZCZC` or `NNNN` become `{"ev":"same","raw":line}`. On exit, log `multimon-ng exited: SAME decoding stopped` and respawn once.
- **CLI (the Node spawn surface).**
  - Accepted: `--sink`, `--rate`, `--gain`, `--rtl-serial`, `--rtl-index`, `--audio-fd`, `--same-enable`, `--close-call`, `--open-db`, `--quiet-db` (native scale), `--hang-ms`, `--audio-lpf-hz`.
  - Accepted but ignored: `--detect-via`, `--lanes`, `--lane-modes`.
  - Replay-only: `--iq-file`, `--tune`, `--audio-out`, `--same-out`, `--realtime`.
  - Unknown args exit 2.
- **Commands.** A bad command line becomes `{"ev":"log","msg":"bad command line: <first 120 chars>"}`, with no exit. EOF on stdin is treated as `quit`.
- **Shutdown.** `quit`, stdin EOF, SIGTERM or SIGINT all exit within 500 ms. SIGPIPE is ignored.
- **Environment.**
  - Never stop services or touch the SDRs except in Task 5, and only after the operator OKs it. Python only via `/usr/bin/python3`. The zsh `$VAR` gotcha applies.
  - Every commit message ends with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.

## File Structure

- `kiosk/native/src/constants.hpp`: P1c constants (Task 1).
- `kiosk/native/src/spsc.hpp`: `SpscQueue<T>` (with in-place emplace/consume) and `SpscRing<T>` (bulk samples).
- `kiosk/native/src/engine.hpp/.cpp`: add `note_gap()` and drop reporting.
- `kiosk/native/src/live.hpp/.cpp`: `IqBlock`, `IqSource` interface, `LiveLoop`.
- `kiosk/native/src/outputs.hpp/.cpp`: `EventOut`, `FdPump`, `JitterPolicy`, `AlsaSink`.
- `kiosk/native/src/multimon.hpp/.cpp`: `Multimon`.
- `kiosk/native/src/rtl_source.hpp/.cpp`: `RtlSource` (librtlsdr).
- `kiosk/native/src/cli.hpp/.cpp`: `Cli` + `parse_cli()`.
- `kiosk/native/app/main.cpp`: split into replay and live paths.
- Tests: `kiosk/native/test/test_{spsc,live,outputs,multimon,cli}.cpp`.
- `kiosk/bench/RESULTS-2026-09-25-native-p1c.md`: live hardware proof.

---

### Task 1: SPSC primitives + P1c constants

**Files:** Create `kiosk/native/src/spsc.hpp`, `kiosk/native/test/test_spsc.cpp`; modify `kiosk/native/src/constants.hpp`.

**Interfaces (produces):**

```cpp
namespace kc {
template <class T> class SpscQueue {       // capacity rounded up to a power of two
 public:
  explicit SpscQueue(size_t capacity);
  bool try_push(T v);
  bool try_pop(T& out);
  template <class F> bool try_emplace(F&& fill);    // fill(T& slot) in place (producer)
  template <class F> bool try_consume(F&& use);     // use(const T& slot) in place (consumer)
  size_t size() const; size_t capacity() const;
};
template <class T> class SpscRing {        // bulk sample ring
 public:
  explicit SpscRing(size_t capacity);
  size_t write(const T* x, size_t n);      // producer; returns written (< n when full)
  size_t read(T* out, size_t n);           // consumer; returns read
  size_t discard(size_t n);                // consumer; drop oldest
  size_t size() const; size_t capacity() const;
};
}
```

- [ ] **Step 1: Constants.** Append inside `namespace kc` in `constants.hpp`:

```cpp
// ---- Live I/O (P1c)
inline constexpr int IQ_BLOCK_BYTES = 48000;       // max 10 ms of u8 IQ at 2.4 Msps (blocks are <= 10 ms at any rate)
inline constexpr int IQ_RING_BLOCKS = 64;          // ~640 ms of IQ buffering between USB and DSP
inline constexpr int RTL_BUF_NUM = 4;              // librtlsdr async buffers (small: bounds in-flight samples on retune)
inline constexpr int RTL_BUF_LEN = 16384;          // bytes per async buffer (~3.4 ms at 2.4 Msps; multiple of 512)
inline constexpr double RETUNE_SETTLE_MS = 20;     // new-generation samples discarded after a retune (in-flight USB)
inline constexpr double STALL_S = 2.0;             // no samples this long = SDR loss -> exit 3
inline constexpr double BUSY_RETRY_S = 3.0;        // retry rtlsdr_open this long (previous helper releasing)
inline constexpr int ALSA_PERIOD = 480;            // 10 ms at 48 kHz
inline constexpr unsigned ALSA_LATENCY_US = 60000; // requested device buffer latency
inline constexpr int AUDIO_RING = 32768;           // speaker ring (~680 ms)
inline constexpr int AUDIO_MAX_LAT = 7200;         // above 150 ms queued, trim ...
inline constexpr int AUDIO_TARGET_LAT = 2400;      // ... down to 50 ms (SDR vs ALSA clock drift)
inline constexpr int TEE_RING = 96000;             // fd-3 tee ring (2 s)
inline constexpr int SAME_RING = 44100;            // multimon ring (2 s at 22.05 kHz)
inline constexpr double DROP_LOG_EVERY_S = 10.0;   // rate limit for the IQ-drop log line
inline constexpr int CMD_QUEUE = 256;
```

- [ ] **Step 2: Failing tests** in `kiosk/native/test/test_spsc.cpp`:

```cpp
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
```

Run `cd /home/kiosk/kerchunk-kiosk/kiosk && npm run test:native`. Expected: FAIL to compile.

- [ ] **Step 3: `spsc.hpp`**

```cpp
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
```

- [ ] **Step 4:** Run `npm run test:native`. Expected: all pass, warning-free. Commit: `feat(native): SPSC queue/ring primitives + live I/O constants`.

---

### Task 2: Engine gap/drops + `LiveLoop` retune sequencing

**Files:** Modify `kiosk/native/src/engine.hpp`, `kiosk/native/src/engine.cpp`. Create `kiosk/native/src/live.hpp`, `kiosk/native/src/live.cpp`, `kiosk/native/test/test_live.cpp`.

**Interfaces (produces):**

```cpp
namespace kc {
// Engine additions:
//   void note_gap(long long nsamples, bool dropped);   // clock += n; reset_stream if tuned; count drops
struct IqBlock { uint32_t gen = 0; uint32_t n = 0; std::array<uint8_t, IQ_BLOCK_BYTES> data; };   // n = BYTES
class IqSource {
 public:
  virtual ~IqSource() = default;
  virtual bool consume(const std::function<void(const IqBlock&)>& use) = 0;   // non-blocking; false if none
  virtual void set_center(double hz) = 0;       // retune + bump generation
  virtual uint32_t generation() const = 0;
  virtual uint64_t take_dropped() = 0;          // IQ samples dropped since last call
};
class LiveLoop {
 public:
  LiveLoop(Engine& e, IqSource& src, SpscQueue<Command>& cmds, int rate);
  bool step();                 // drain cmds; drops; feed at most one block. true if a block was consumed
  bool quit() const;
};
}
```

- [ ] **Step 1: Engine additions.**

In `engine.hpp`, add a public method and private members:

```cpp
  // Input the DSP never saw (ring overrun, or retune discard): advance the clock by n samples and,
  // if a window is live, restart the channelizer stream so the gap can't smear across hops.
  // dropped=true counts toward power.drops and the rate-limited overrun log.
  void note_gap(long long nsamples, bool dropped);
```

```cpp
  long long drops_since_power_ = 0;
  double last_drop_log_ = -1e9;
```

In `engine.cpp`:

```cpp
void Engine::note_gap(long long n, bool dropped) {
  if (n <= 0) return;
  samples_ += n;
  pushed_ += n;
  if (tuned_) ch_.reset_stream();
  if (!dropped) return;
  drops_since_power_ += n;
  if (now() - last_drop_log_ >= DROP_LOG_EVERY_S) {
    last_drop_log_ = now();
    emit_({{"ev", "log"}, {"msg", "dropped " + std::to_string(n) + " IQ samples (DSP overrun)"}});
  }
}
```

Change the power emit in `poll()` to:

```cpp
  if (polls_ % POWER_EVERY_POLLS == 0) {
    nlohmann::json p = {{"ev", "power"}, {"levels", sc_.power_levels(readings_)}, {"noise", sc_.noise_levels(readings_)}};
    if (drops_since_power_ > 0) { p["drops"] = drops_since_power_; drops_since_power_ = 0; }
    emit_(p);
  }
```

(`ch_.reset_stream()` in `note_gap` leaves `fill_` at 0. The partial hop it drops was already counted by `pushed_`/`samples_` in `push_u8`, and `tune()` re-syncs.)

- [ ] **Step 2: Failing tests** in `kiosk/native/test/test_live.cpp`:

```cpp
#include <deque>
#include <string>
#include <vector>

#include "check.hpp"
#include "engine.hpp"
#include "live.hpp"

namespace {
constexpr int RATE = 250'000;
constexpr int BLOCK = RATE / 100 * 2;   // 10 ms of u8 IQ

struct FakeSource : kc::IqSource {
  std::deque<kc::IqBlock> q;
  uint32_t gen = 0;
  std::vector<double> centers;
  uint64_t dropped = 0;
  void add(int blocks, uint32_t g) {
    for (int i = 0; i < blocks; i++) {
      kc::IqBlock b;
      b.gen = g;
      b.n = BLOCK;
      for (int k = 0; k < BLOCK; k++) b.data[k] = 127;
      q.push_back(b);
    }
  }
  bool consume(const std::function<void(const kc::IqBlock&)>& use) override {
    if (q.empty()) return false;
    use(q.front());
    q.pop_front();
    return true;
  }
  void set_center(double hz) override { centers.push_back(hz); gen++; }
  uint32_t generation() const override { return gen; }
  uint64_t take_dropped() override { auto d = dropped; dropped = 0; return d; }
};

struct Rig {
  std::vector<nlohmann::json> ev;
  kc::EngineOptions o;
  std::unique_ptr<kc::Engine> e;
  FakeSource src;
  kc::SpscQueue<kc::Command> cmds{64};
  std::unique_ptr<kc::LiveLoop> loop;
  Rig() {
    o.rate = RATE;
    e = std::make_unique<kc::Engine>(o, [this](const nlohmann::json& j) { auto k = j; k["t"] = e->now(); ev.push_back(k); },
                                     nullptr, nullptr, nullptr);
    loop = std::make_unique<kc::LiveLoop>(*e, src, cmds, RATE);
  }
  void send(const std::string& line) { std::string err; auto c = kc::parse_command(line, err); CHECK(c.has_value()); if (c) cmds.try_push(*c); }
  void run() { while (loop->step()) {} }
  int count(const std::string& type) const { int n = 0; for (auto& j : ev) if (j["ev"] == type) n++; return n; }
};

const char* TUNE = R"({"cmd":"tune","centerHz":146000000,"channels":[{"id":"a","freqHz":146050000}]})";
}  // namespace

TEST(live_tune_waits_for_new_generation_and_settle) {
  Rig r;
  r.src.add(5, 0);                  // old-center blocks already queued
  r.send(TUNE);
  r.src.add(5, 1);                  // new-generation blocks (first 2 = settle discard)
  r.run();
  CHECK(r.src.centers.size() == 1 && r.src.centers[0] == 146000000);
  CHECK(r.count("tuned") == 1);
  double tuned_t = -1;
  for (auto& j : r.ev) if (j["ev"] == "tuned") tuned_t = j["t"].get<double>();
  CHECK_NEAR(tuned_t, 0.07, 1e-9);  // 5 old + 2 settle blocks (10 ms each) discarded before the tune applies
  CHECK_NEAR(r.e->now(), 0.10, 0.0015);   // all 10 blocks counted on the clock (hop-granular)
}

TEST(live_non_tune_commands_apply_immediately_and_quit) {
  Rig r;
  r.send(TUNE);
  r.src.add(10, 1);
  r.run();
  r.send(R"({"cmd":"quit"})");
  r.loop->step();
  CHECK(r.loop->quit());
}

TEST(live_drops_advance_clock_and_report) {
  Rig r;
  r.send(TUNE);
  r.src.add(3, 1);
  r.run();
  r.src.dropped = 2500;             // 10 ms lost in the ring
  r.src.add(40, 1);
  r.run();
  bool saw = false;
  for (auto& j : r.ev) if (j["ev"] == "power" && j.contains("drops")) { saw = true; CHECK(j["drops"].get<long long>() == 2500); }
  CHECK(saw);
  CHECK(r.count("log") == 1);       // rate-limited overrun log
  CHECK_NEAR(r.e->now(), 0.44, 0.0015);
}

TEST(live_retune_mid_stream_discards_old_generation) {
  Rig r;
  r.send(TUNE);
  r.src.add(10, 1);
  r.run();
  r.src.add(3, 1);                  // queued before the retune lands: old center
  r.send(R"({"cmd":"tune","centerHz":147000000,"channels":[{"id":"b","freqHz":147050000}]})");
  r.src.add(4, 2);
  r.run();
  CHECK(r.count("tuned") == 2);
  CHECK(r.src.centers.size() == 2 && r.src.centers[1] == 147000000);
}
```

Run `npm run test:native`. Expected: FAIL to compile.

- [ ] **Step 3: `live.hpp` / `live.cpp`**

```cpp
// Live DSP loop: the single place commands meet the sample stream. Runs on the DSP thread only.
#pragma once
#include <array>
#include <cstdint>
#include <functional>
#include <optional>

#include "constants.hpp"
#include "engine.hpp"
#include "protocol.hpp"
#include "spsc.hpp"

namespace kc {
struct IqBlock {
  uint32_t gen = 0;
  uint32_t n = 0;   // bytes (2 per complex sample)
  std::array<uint8_t, IQ_BLOCK_BYTES> data;
};

class IqSource {
 public:
  virtual ~IqSource() = default;
  virtual bool consume(const std::function<void(const IqBlock&)>& use) = 0;
  virtual void set_center(double hz) = 0;
  virtual uint32_t generation() const = 0;
  virtual uint64_t take_dropped() = 0;
};

class LiveLoop {
 public:
  LiveLoop(Engine& e, IqSource& src, SpscQueue<Command>& cmds, int rate);
  bool step();
  bool quit() const { return eng_.quit(); }

 private:
  Engine& eng_;
  IqSource& src_;
  SpscQueue<Command>& cmds_;
  std::optional<TuneCmd> pending_;
  uint32_t want_gen_ = 0;
  long long settle_left_ = 0;
  const long long settle_samples_;
};
}  // namespace kc
```

```cpp
#include "live.hpp"

#include <cmath>

namespace kc {

LiveLoop::LiveLoop(Engine& e, IqSource& src, SpscQueue<Command>& cmds, int rate)
    : eng_(e), src_(src), cmds_(cmds), settle_samples_((long long)std::llround(rate * RETUNE_SETTLE_MS / 1000.0)) {}

bool LiveLoop::step() {
  // Commands drain here, between pushes -- never inside a hop -- so a retune can't reset the
  // channelizer underneath an in-progress hop.
  Command c;
  while (cmds_.try_pop(c)) {
    if (auto* t = std::get_if<TuneCmd>(&c)) {
      src_.set_center(t->center_hz);        // retune now; samples from the old center are still in flight
      want_gen_ = src_.generation();
      pending_ = *t;
      settle_left_ = settle_samples_;
    } else {
      eng_.command(c);
    }
  }
  if (const uint64_t d = src_.take_dropped()) eng_.note_gap((long long)d, true);
  return src_.consume([this](const IqBlock& b) {
    const long long n = b.n / 2;
    if (pending_) {
      if (b.gen < want_gen_) { eng_.note_gap(n, false); return; }     // old center
      if (settle_left_ > 0) { settle_left_ -= n; eng_.note_gap(n, false); return; }   // in-flight USB
      eng_.command(Command{*pending_});
      pending_.reset();
    }
    eng_.push_u8(b.data.data(), (size_t)n);
  });
}
}  // namespace kc
```

- [ ] **Step 4:** Run `npm run test:native`. Expected: all pass. The expected `tuned` time of 0.07 s is 5 old-generation blocks plus the 2 settle blocks (20 ms = 5000 samples = 2 blocks of 2500). If the settle arithmetic differs by one block, re-derive it rather than change the constant, and report. Commit: `feat(native): LiveLoop — commands between pushes, generation+settle retune discard, drop accounting`.

---

### Task 3: Outputs — `EventOut`, `FdPump`, `JitterPolicy`, `AlsaSink`, `Multimon`

**Files:** Create `kiosk/native/src/outputs.hpp`, `outputs.cpp`, `multimon.hpp`, `multimon.cpp`, `kiosk/native/test/test_outputs.cpp`, `test_multimon.cpp`. Modify `kiosk/native/CMakeLists.txt` (link `asound`) and `.github/workflows/ci.yml` (apt: `libasound2-dev librtlsdr-dev`).

**Interfaces (produces):**

```cpp
namespace kc {
using LogFn = std::function<void(const std::string&)>;
class EventOut {                       // any thread may emit; one writer thread writes + flushes per line
 public:
  explicit EventOut(FILE* out);
  void start(); void stop();           // stop() drains what's queued
  void emit(const nlohmann::json& ev);
  void log(const std::string& msg);    // emits {"ev":"log","msg":msg}
};
struct JitterPolicy { static size_t drop_for(size_t queued); };   // > AUDIO_MAX_LAT -> queued - AUDIO_TARGET_LAT, else 0
class FdPump {                          // non-blocking fd writer for int16 PCM; drops rather than blocks
 public:
  FdPump(size_t capacity, LogFn log, std::string name);
  void set_fd(int fd);                  // sets O_NONBLOCK; -1 = discard
  size_t write(const int16_t* x, size_t n);   // producer (DSP thread)
  void start(); void stop();
  uint64_t dropped() const;
};
class AlsaSink {
 public:
  AlsaSink(std::string device, LogFn log);
  bool open(std::string& err);
  void start(); void stop();
  size_t write(const int16_t* x, size_t n);   // producer (DSP thread); drops when full
};
class Multimon {
 public:
  using Emit = std::function<void(const nlohmann::json&)>;
  Multimon(std::vector<std::string> argv, Emit emit, LogFn log);   // argv default {"multimon-ng","-t","raw","-a","EAS","-"}
  bool start(std::string& err);
  size_t write(const int16_t* x, size_t n);   // producer (DSP thread), non-blocking
  void stop();
  static bool is_same_line(const std::string& line);
};
}
```

- [ ] **Step 1: Deps.** Run `sudo apt-get install -y libasound2-dev librtlsdr-dev`. In `CMakeLists.txt`, after the nlohmann `find_package`, add:

```cmake
pkg_check_modules(ALSA REQUIRED IMPORTED_TARGET alsa)
pkg_check_modules(RTLSDR REQUIRED IMPORTED_TARGET librtlsdr)
```

and change the library link to:

```cmake
target_link_libraries(kcdsp PUBLIC PkgConfig::FFTW3F nlohmann_json::nlohmann_json PkgConfig::ALSA PkgConfig::RTLSDR Threads::Threads m)
```

`Threads` must be found before `kcdsp`, so move `find_package(Threads REQUIRED)` above `add_library` if it isn't already. In `.github/workflows/ci.yml`, add `libasound2-dev librtlsdr-dev` to the `native` job's apt line.

- [ ] **Step 2: Failing tests.**

`kiosk/native/test/test_outputs.cpp`:

```cpp
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
```

`kiosk/native/test/test_multimon.cpp`:

```cpp
#include <chrono>
#include <cstring>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "check.hpp"
#include "multimon.hpp"

namespace {
struct Sink {
  std::mutex m;
  std::vector<nlohmann::json> ev;
  std::vector<std::string> logs;
  kc::Multimon::Emit emit() { return [this](const nlohmann::json& j) { std::lock_guard<std::mutex> g(m); ev.push_back(j); }; }
  kc::LogFn log() { return [this](const std::string& s) { std::lock_guard<std::mutex> g(m); logs.push_back(s); }; }
  bool wait_events(size_t n, int ms) {
    for (int i = 0; i < ms / 10; i++) { { std::lock_guard<std::mutex> g(m); if (ev.size() >= n) return true; } std::this_thread::sleep_for(std::chrono::milliseconds(10)); }
    return false;
  }
};
}  // namespace

TEST(multimon_same_line_filter) {
  CHECK(kc::Multimon::is_same_line("EAS: ZCZC-WXR-TOR-029047+0030-2701234-KEAX/NWS-"));
  CHECK(kc::Multimon::is_same_line("EAS: NNNN"));
  CHECK(!kc::Multimon::is_same_line("multimon-ng 1.3.0"));
}

TEST(multimon_pipes_lines_through_child) {
  Sink s;
  kc::Multimon mm({"cat"}, s.emit(), s.log());   // cat echoes our "PCM" bytes back as text lines
  std::string err;
  CHECK(mm.start(err));
  const char* text = "EAS: ZCZC-WXR-TOR-029047+0030-2701234-KEAX/NWS-\nnoise line\n";
  std::vector<int16_t> pcm((std::strlen(text) + 1) / 2, 0);
  std::memcpy(pcm.data(), text, std::strlen(text));
  mm.write(pcm.data(), pcm.size());
  CHECK(s.wait_events(1, 2000));
  mm.stop();
  std::lock_guard<std::mutex> g(s.m);
  CHECK(s.ev.size() == 1);
  CHECK(!s.ev.empty() && s.ev[0]["ev"] == "same" && s.ev[0]["raw"].get<std::string>().find("ZCZC") != std::string::npos);
}

TEST(multimon_respawns_once_then_gives_up) {
  Sink s;
  kc::Multimon mm({"sh", "-c", "echo 'EAS: NNNN'"}, s.emit(), s.log());
  std::string err;
  CHECK(mm.start(err));
  CHECK(s.wait_events(2, 3000));                 // first run + one respawn
  std::this_thread::sleep_for(std::chrono::milliseconds(300));
  mm.stop();
  std::lock_guard<std::mutex> g(s.m);
  CHECK(s.ev.size() == 2);
  int exited = 0;
  for (auto& l : s.logs) if (l == "multimon-ng exited: SAME decoding stopped") exited++;
  CHECK(exited == 2);
}
```

Run `npm run test:native`. Expected: FAIL to compile.

- [ ] **Step 3: `outputs.hpp` / `outputs.cpp`**

```cpp
// Output side of the live helper: event serialization, non-blocking fd pumps, and the ALSA writer.
#pragma once
#include <alsa/asoundlib.h>

#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <cstdio>
#include <deque>
#include <functional>
#include <mutex>
#include <nlohmann/json.hpp>
#include <string>
#include <thread>

#include "constants.hpp"
#include "spsc.hpp"

namespace kc {
using LogFn = std::function<void(const std::string&)>;

class EventOut {
 public:
  explicit EventOut(FILE* out) : out_(out) {}
  ~EventOut() { stop(); }
  void start();
  void stop();
  void emit(const nlohmann::json& ev);
  void log(const std::string& msg) { emit({{"ev", "log"}, {"msg", msg}}); }

 private:
  void run();
  FILE* out_;
  std::mutex m_;
  std::condition_variable cv_;
  std::deque<std::string> q_;
  bool running_ = false, stopping_ = false;
  std::thread t_;
};

struct JitterPolicy {
  static size_t drop_for(size_t queued) {
    return queued > (size_t)AUDIO_MAX_LAT ? queued - (size_t)AUDIO_TARGET_LAT : 0;
  }
};

class FdPump {
 public:
  FdPump(size_t capacity, LogFn log, std::string name) : ring_(capacity), log_(std::move(log)), name_(std::move(name)) {}
  ~FdPump() { stop(); }
  void set_fd(int fd);
  size_t write(const int16_t* x, size_t n) {
    const size_t w = ring_.write(x, n);
    if (w < n) dropped_.fetch_add(n - w, std::memory_order_relaxed);
    return w;
  }
  void start();
  void stop();
  uint64_t dropped() const { return dropped_.load(); }

 private:
  void run();
  SpscRing<int16_t> ring_;
  LogFn log_;
  std::string name_;
  std::atomic<int> fd_{-1};
  std::atomic<bool> running_{false};
  std::atomic<uint64_t> dropped_{0};
  bool failed_logged_ = false;
  std::thread t_;
};

class AlsaSink {
 public:
  AlsaSink(std::string device, LogFn log) : device_(std::move(device)), log_(std::move(log)), ring_(AUDIO_RING) {}
  ~AlsaSink() { stop(); }
  bool open(std::string& err);
  void start();
  void stop();
  size_t write(const int16_t* x, size_t n) { return ring_.write(x, n); }

 private:
  void run();
  std::string device_;
  LogFn log_;
  SpscRing<int16_t> ring_;
  snd_pcm_t* pcm_ = nullptr;
  std::atomic<bool> running_{false};
  std::thread t_;
};
}  // namespace kc
```

```cpp
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
```

- [ ] **Step 4: `multimon.hpp` / `multimon.cpp`**

```cpp
// SAME/EAS decoding via a multimon-ng child: PCM in on stdin (non-blocking pump), text lines out.
#pragma once
#include <sys/types.h>

#include <atomic>
#include <nlohmann/json.hpp>
#include <string>
#include <thread>
#include <vector>

#include "outputs.hpp"

namespace kc {
class Multimon {
 public:
  using Emit = std::function<void(const nlohmann::json&)>;
  Multimon(std::vector<std::string> argv, Emit emit, LogFn log)
      : argv_(std::move(argv)), emit_(std::move(emit)), log_(std::move(log)), pump_(SAME_RING, log_, "multimon-ng") {}
  ~Multimon() { stop(); }
  bool start(std::string& err);
  size_t write(const int16_t* x, size_t n) { return pump_.write(x, n); }
  void stop();
  static bool is_same_line(const std::string& l) { return l.find("ZCZC") != std::string::npos || l.find("NNNN") != std::string::npos; }

 private:
  bool spawn(std::string& err);
  void reader();
  std::vector<std::string> argv_;
  Emit emit_;
  LogFn log_;
  FdPump pump_;
  std::atomic<pid_t> pid_{-1};
  std::atomic<int> out_fd_{-1};
  std::atomic<bool> running_{false};
  int respawns_ = 0;
  std::thread t_;
};
}  // namespace kc
```

```cpp
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
```

In `multimon.hpp`, add the member `int stdin_fd_ = -1;` (the current child's stdin, owned here; the pump only borrows it).

- [ ] **Step 5:** Run `npm run test:native`. Expected: all pass, warning-free. Validate the `ci.yml` YAML. Commit: `feat(native): live outputs — EventOut, non-blocking FdPump, ALSA sink with drift trim, multimon-ng child with one respawn`.

---

### Task 4: `RtlSource` + CLI + live `main`

**Files:** Create `kiosk/native/src/rtl_source.hpp`, `rtl_source.cpp`, `cli.hpp`, `cli.cpp`, `kiosk/native/test/test_cli.cpp`. Modify `kiosk/native/app/main.cpp`.

**Interfaces (produces):**

```cpp
namespace kc {
struct Cli {
  EngineOptions eng;
  std::string sink = "none", gain = "auto", rtl_serial; int rtl_index = -1; int audio_fd = -1;
  std::string iq_file, tune_json, audio_out, same_out; bool realtime = false;
};
bool parse_cli(int argc, const char* const* argv, Cli& out, std::string& err);   // false -> exit 2 with err
class RtlSource : public IqSource {
 public:
  struct Options { std::string serial; int index = -1; int rate = 2'400'000; std::string gain = "auto"; };
  RtlSource(Options o, LogFn log);
  ~RtlSource();
  bool open(std::string& err);      // busy-retry BUSY_RETRY_S
  void start(); void stop();
  double seconds_since_rx() const;
  // IqSource
};
}
```

- [ ] **Step 1: Failing CLI tests** in `kiosk/native/test/test_cli.cpp`:

```cpp
#include "check.hpp"
#include "cli.hpp"

namespace {
bool parse(std::vector<const char*> a, kc::Cli& c, std::string& err) {
  a.insert(a.begin(), "kerchunk-dsp");
  return kc::parse_cli((int)a.size(), a.data(), c, err);
}
}  // namespace

TEST(cli_accepts_node_spawn_surface) {
  kc::Cli c;
  std::string err;
  CHECK(parse({"--sink", "plughw:CARD=PCH,DEV=0", "--hang-ms", "2000", "--rtl-serial", "KIOSK01", "--open-db", "9",
               "--rate", "2400000", "--detect-via", "lane", "--close-call", "--audio-fd", "3", "--same-enable",
               "--gain", "auto", "--quiet-db", "-6", "--lanes", "12", "--lane-modes", "bbbbfffffffb"}, c, err));
  CHECK(c.sink == "plughw:CARD=PCH,DEV=0" && c.rtl_serial == "KIOSK01" && c.audio_fd == 3);
  CHECK(c.eng.close_call && c.eng.same);
  CHECK_NEAR(c.eng.squelch.hang_ms, 2000, 0);
  CHECK_NEAR(c.eng.squelch.quiet_db, -6, 0);
  CHECK(c.eng.rate == 2400000);
}

TEST(cli_rejects_bad_values_and_unknown) {
  kc::Cli c;
  std::string err;
  CHECK(!parse({"--bogus"}, c, err));
  CHECK(!parse({"--rate", "2048000"}, c, err));
  CHECK(!parse({"--rate", "abc"}, c, err));
  CHECK(!parse({"--audio-lpf-hz", "999"}, c, err));
  CHECK(!parse({"--audio-fd", "x"}, c, err));
  CHECK(!parse({"--sink"}, c, err));          // missing value
  CHECK(!err.empty());
}

TEST(cli_replay_flags) {
  kc::Cli c;
  std::string err;
  CHECK(parse({"--iq-file", "/tmp/x.cu8", "--tune", "{}", "--realtime", "--audio-out", "/tmp/a"}, c, err));
  CHECK(c.iq_file == "/tmp/x.cu8" && c.realtime && c.audio_out == "/tmp/a");
}
```

- [ ] **Step 2: `cli.hpp` / `cli.cpp`**

```cpp
// Command-line surface: what WidebandEngine.ts spawns (live) plus the replay-only flags.
#pragma once
#include <string>

#include "engine.hpp"

namespace kc {
struct Cli {
  EngineOptions eng;
  std::string sink = "none";
  std::string gain = "auto";
  std::string rtl_serial;
  int rtl_index = -1;
  int audio_fd = -1;
  std::string iq_file, tune_json, audio_out, same_out;
  bool realtime = false;
};
bool parse_cli(int argc, const char* const* argv, Cli& out, std::string& err);
}  // namespace kc
```

```cpp
#include "cli.hpp"

#include <cstdlib>

namespace kc {
namespace {
bool to_double(const std::string& s, double& v) {
  char* end = nullptr;
  v = std::strtod(s.c_str(), &end);
  return end != s.c_str() && *end == '\0';
}
bool to_int(const std::string& s, int& v) {
  char* end = nullptr;
  long x = std::strtol(s.c_str(), &end, 10);
  if (end == s.c_str() || *end != '\0') return false;
  v = (int)x;
  return true;
}
}  // namespace

bool parse_cli(int argc, const char* const* argv, Cli& c, std::string& err) {
  for (int i = 1; i < argc; i++) {
    const std::string k = argv[i];
    auto val = [&](std::string& out) {
      if (i + 1 >= argc) { err = "missing value for " + k; return false; }
      out = argv[++i];
      return true;
    };
    std::string v;
    double d;
    int n;
    if (k == "--close-call") c.eng.close_call = true;
    else if (k == "--same-enable") c.eng.same = true;
    else if (k == "--realtime") c.realtime = true;
    else if (k == "--sink") { if (!val(c.sink)) return false; }
    else if (k == "--gain") { if (!val(c.gain)) return false; if (c.gain != "auto" && !to_double(c.gain, d)) { err = "--gain must be auto or dB"; return false; } }
    else if (k == "--rtl-serial") { if (!val(c.rtl_serial)) return false; }
    else if (k == "--iq-file") { if (!val(c.iq_file)) return false; }
    else if (k == "--tune") { if (!val(c.tune_json)) return false; }
    else if (k == "--audio-out") { if (!val(c.audio_out)) return false; }
    else if (k == "--same-out") { if (!val(c.same_out)) return false; }
    else if (k == "--detect-via" || k == "--lanes" || k == "--lane-modes") { if (!val(v)) return false; }   // GR-era: ignored
    else if (k == "--rtl-index") { if (!val(v) || !to_int(v, c.rtl_index)) { err = "--rtl-index must be an integer"; return false; } }
    else if (k == "--audio-fd") { if (!val(v) || !to_int(v, c.audio_fd)) { err = "--audio-fd must be an integer"; return false; } }
    else if (k == "--rate") {
      if (!val(v) || !to_int(v, n) || n <= 0 || n % LANE_RATE != 0) { err = "--rate must be a positive multiple of 50000"; return false; }
      c.eng.rate = n;
    }
    else if (k == "--open-db") { if (!val(v) || !to_double(v, c.eng.squelch.open_db)) { err = "--open-db must be a number"; return false; } }
    else if (k == "--quiet-db") { if (!val(v) || !to_double(v, c.eng.squelch.quiet_db)) { err = "--quiet-db must be a number"; return false; } }
    else if (k == "--hang-ms") { if (!val(v) || !to_double(v, c.eng.squelch.hang_ms)) { err = "--hang-ms must be a number"; return false; } }
    else if (k == "--audio-lpf-hz") {
      if (!val(v) || !to_double(v, d) || !(d >= 1000 && d <= 24000)) { err = "--audio-lpf-hz must be a number in [1000, 24000]"; return false; }
      c.eng.speaker_lpf_hz = d;
    }
    else { err = "unknown arg " + k; return false; }
  }
  return true;
}
}  // namespace kc
```

- [ ] **Step 3: `rtl_source.hpp` / `rtl_source.cpp`**

```cpp
// RTL-SDR input: librtlsdr async reads -> SPSC ring of <= 10 ms IQ blocks tagged with a generation.
#pragma once
#include <rtl-sdr.h>

#include <atomic>
#include <string>
#include <thread>

#include "live.hpp"
#include "outputs.hpp"

namespace kc {
class RtlSource : public IqSource {
 public:
  struct Options { std::string serial; int index = -1; int rate = 2'400'000; std::string gain = "auto"; };
  RtlSource(Options o, LogFn log);
  ~RtlSource() override;
  bool open(std::string& err);
  void start();
  void stop();
  double seconds_since_rx() const;
  bool consume(const std::function<void(const IqBlock&)>& use) override { return ring_.try_consume(use); }
  void set_center(double hz) override;
  uint32_t generation() const override { return gen_.load(); }
  uint64_t take_dropped() override { return dropped_.exchange(0); }

 private:
  static void on_samples(unsigned char* buf, uint32_t len, void* ctx);
  Options o_;
  LogFn log_;
  rtlsdr_dev_t* dev_ = nullptr;
  SpscQueue<IqBlock> ring_{IQ_RING_BLOCKS};
  std::atomic<uint32_t> gen_{0};
  std::atomic<uint64_t> dropped_{0};
  std::atomic<long long> last_rx_ns_{0};
  size_t block_bytes_;
  std::thread t_;
  std::atomic<bool> running_{false};
};
}  // namespace kc
```

```cpp
#include "rtl_source.hpp"

#include <chrono>
#include <cmath>
#include <cstdlib>
#include <cstring>

namespace kc {
namespace {
long long mono_ns() {
  return std::chrono::duration_cast<std::chrono::nanoseconds>(std::chrono::steady_clock::now().time_since_epoch()).count();
}
}  // namespace

RtlSource::RtlSource(Options o, LogFn log)
    : o_(std::move(o)), log_(std::move(log)),
      block_bytes_(std::min<size_t>(IQ_BLOCK_BYTES, (size_t)o_.rate / 100 * 2)) {}

RtlSource::~RtlSource() { stop(); }

bool RtlSource::open(std::string& err) {
  int index = o_.index >= 0 ? o_.index : 0;
  if (!o_.serial.empty()) {
    index = rtlsdr_get_index_by_serial(o_.serial.c_str());
    if (index < 0) { err = "no RTL-SDR with serial " + o_.serial; return false; }
  }
  const auto t0 = std::chrono::steady_clock::now();
  int rc;
  // The previous helper may still hold the dongle while it exits: retry briefly before failing.
  while ((rc = rtlsdr_open(&dev_, (uint32_t)index)) < 0) {
    if (std::chrono::steady_clock::now() - t0 > std::chrono::duration<double>(BUSY_RETRY_S)) {
      err = "rtlsdr_open(" + std::to_string(index) + ") failed: " + std::to_string(rc);
      dev_ = nullptr;
      return false;
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(200));
  }
  if (rtlsdr_set_sample_rate(dev_, (uint32_t)o_.rate) < 0) { err = "set_sample_rate failed"; return false; }
  if (o_.gain == "auto") {
    rtlsdr_set_tuner_gain_mode(dev_, 0);
  } else {
    rtlsdr_set_tuner_gain_mode(dev_, 1);
    rtlsdr_set_tuner_gain(dev_, (int)std::lround(std::atof(o_.gain.c_str()) * 10.0));
  }
  rtlsdr_reset_buffer(dev_);
  return true;
}

void RtlSource::on_samples(unsigned char* buf, uint32_t len, void* ctx) {
  auto* self = static_cast<RtlSource*>(ctx);
  self->last_rx_ns_.store(mono_ns(), std::memory_order_relaxed);
  const uint32_t g = self->gen_.load(std::memory_order_acquire);
  for (uint32_t off = 0; off < len;) {
    const uint32_t n = (uint32_t)std::min<size_t>(self->block_bytes_, len - off) & ~1u;
    if (n == 0) break;
    const bool ok = self->ring_.try_emplace([&](IqBlock& b) {
      b.gen = g;
      b.n = n;
      std::memcpy(b.data.data(), buf + off, n);
    });
    if (!ok) self->dropped_.fetch_add(n / 2, std::memory_order_relaxed);   // DSP fell behind
    off += n;
  }
}

void RtlSource::start() {
  running_ = true;
  last_rx_ns_ = mono_ns();
  t_ = std::thread([this] { rtlsdr_read_async(dev_, &RtlSource::on_samples, this, RTL_BUF_NUM, RTL_BUF_LEN); });
}

void RtlSource::stop() {
  if (running_.exchange(false)) {
    rtlsdr_cancel_async(dev_);
    if (t_.joinable()) t_.join();
  }
  if (dev_) { rtlsdr_close(dev_); dev_ = nullptr; }
}

void RtlSource::set_center(double hz) {
  if (dev_ && rtlsdr_set_center_freq(dev_, (uint32_t)std::llround(hz)) < 0) log_("rtlsdr_set_center_freq failed");
  gen_.fetch_add(1, std::memory_order_acq_rel);
}

double RtlSource::seconds_since_rx() const { return (mono_ns() - last_rx_ns_.load()) / 1e9; }
}  // namespace kc
```

(`rtl_source.cpp` also needs `#include <algorithm>` for `std::min`.)

- [ ] **Step 4: `main.cpp` — split into replay and live**

Rewrite `kiosk/native/app/main.cpp`:
- Parse with `kc::parse_cli`; on failure print `kerchunk-dsp: <err>` to stderr and exit 2.
- If `c.iq_file` is non-empty, run the **existing replay path unchanged**. Move it into `static int run_replay(const kc::Cli&)`, keeping its behaviour and messages but reading options from `Cli`.
- Otherwise call `static int run_live(const kc::Cli&)`:

```cpp
static std::atomic<bool> g_stop{false};
static void on_signal(int) { g_stop = true; }

static int run_live(const kc::Cli& c) {
  std::signal(SIGPIPE, SIG_IGN);
  std::signal(SIGTERM, on_signal);
  std::signal(SIGINT, on_signal);
  kc::EventOut events(stdout);
  kc::LogFn log = [&](const std::string& m) { events.log(m); };
  std::unique_ptr<kc::AlsaSink> alsa;
  std::unique_ptr<kc::FdPump> tee;
  std::unique_ptr<kc::Multimon> mm;
  // Engine first: all FFTW planning happens here, before any other thread exists.
  std::unique_ptr<kc::Engine> eng;
  try {
    eng = std::make_unique<kc::Engine>(
        c.eng, [&](const nlohmann::json& j) { events.emit(j); },
        [&](const int16_t* p, int n) { if (alsa) alsa->write(p, (size_t)n); },
        [&](const int16_t* p, int n) { if (tee) tee->write(p, (size_t)n); },
        [&](const int16_t* p, int n) { if (mm) mm->write(p, (size_t)n); });
  } catch (const std::exception& ex) {
    std::fprintf(stderr, "kerchunk-dsp: engine init failed: %s\n", ex.what());
    return 2;
  }
  kc::dsp_thread_init();
  kc::RtlSource src({c.rtl_serial, c.rtl_index, c.eng.rate, c.gain}, log);
  std::string err;
  if (!src.open(err)) { std::fprintf(stderr, "kerchunk-dsp: %s\n", err.c_str()); return 1; }
  if (c.sink != "none") {
    alsa = std::make_unique<kc::AlsaSink>(c.sink, log);
    if (!alsa->open(err)) { std::fprintf(stderr, "kerchunk-dsp: %s\n", err.c_str()); return 1; }
  }
  events.start();
  if (c.audio_fd >= 0) {
    tee = std::make_unique<kc::FdPump>(kc::TEE_RING, log, "audio tee");
    tee->set_fd(c.audio_fd);
    tee->start();
  }
  if (c.eng.same) {
    mm = std::make_unique<kc::Multimon>(std::vector<std::string>{"multimon-ng", "-t", "raw", "-a", "EAS", "-"},
                                        [&](const nlohmann::json& j) { events.emit(j); }, log);
    if (!mm->start(err)) { events.log("multimon-ng not started: SAME decoding disabled (" + err + ")"); mm.reset(); }
  }
  if (alsa) alsa->start();
  src.start();
  events.emit({{"ev", "ready"}});   // device open, threads up: Node sends its first tune now
  kc::SpscQueue<kc::Command> cmds(kc::CMD_QUEUE);
  std::thread in([&] {
    std::string line;
    while (std::getline(std::cin, line)) {
      if (line.find_first_not_of(" \t\r") == std::string::npos) continue;
      std::string perr;
      auto cmd = kc::parse_command(line, perr);
      if (!cmd) { events.log("bad command line: " + line.substr(0, 120)); continue; }
      if (!cmds.try_push(*cmd)) events.log("command queue full; dropped a command");
    }
    cmds.try_push(kc::Command{kc::QuitCmd{}});   // EOF = parent went away
  });
  in.detach();   // blocked in getline; process exit ends it
  kc::LiveLoop loop(*eng, src, cmds, c.eng.rate);
  int rc = 0;
  while (!g_stop && !loop.quit()) {
    if (!loop.step()) {
      if (src.seconds_since_rx() > kc::STALL_S) {
        std::fprintf(stderr, "kerchunk-dsp: SDR stalled (no samples for %.1f s)\n", kc::STALL_S);
        rc = 3;
        break;
      }
      std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
  }
  src.stop();
  if (mm) mm->stop();
  if (tee) tee->stop();
  if (alsa) alsa->stop();
  events.stop();
  return rc;
}
```

`main()`: `kc::Cli c; std::string err; if (!kc::parse_cli(argc, argv, c, err)) { fprintf(stderr, "kerchunk-dsp: %s\n", err.c_str()); return 2; } return c.iq_file.empty() ? run_live(c) : run_replay(c);`.

Includes: `<atomic> <csignal> <iostream> <thread>` plus `cli.hpp live.hpp outputs.hpp multimon.hpp rtl_source.hpp`. `argv` is `char**`. Pass it as `const char* const*` (`kc::parse_cli(argc, const_cast<const char* const*>(argv), ...)` or change the signature to take `char**`, whichever compiles cleanly).

- [ ] **Step 5: Build, test, no-hardware smoke**

Run `npm run test:native`. Expected: all pass, warning-free. Then, **without touching hardware**:
- `native/build/kerchunk-dsp --bogus; echo $?` → 2.
- `native/build/kerchunk-dsp --iq-file /home/kiosk/kiosk-iq/noise10s.cu8 --tune '{"cmd":"tune","centerHz":146000000,"channels":[]}' | tail -1` → the replay still works (REPLAY on stderr).

Do NOT run the live path; it would open the SDRs. Commit: `feat(native): live mode — RtlSource (serial, busy-retry, generation), CLI surface, threaded I/O, shutdown`.

---

### Task 5: Live hardware proof (operator OK required, ~3 min scanner outage)

**Files:** Create `kiosk/bench/RESULTS-2026-09-25-native-p1c.md`.

- [ ] **Step 1: Ask the operator.** "Stopping kerchunk-kiosk for about 3 minutes to run kerchunk-dsp live on KIOSK01 (and KIOSK03). You'll hear the native engine on the speaker during the test. OK?" Do not continue without a yes.

- [ ] **Step 2: Run live** (the controller runs this, not a subagent):

```bash
sudo systemctl stop kerchunk-kiosk
cd /home/kiosk/kerchunk-kiosk/kiosk
T2M='{"cmd":"tune","centerHz":146033750,"channels":[{"id":"c145130000","freqHz":145130000},{"id":"c145150000","freqHz":145150000},{"id":"c145310000","freqHz":145310000},{"id":"c145470000","freqHz":145470000},{"id":"c146520000","freqHz":146520000},{"id":"c146625000","freqHz":146625000},{"id":"c146637500","freqHz":146637500},{"id":"c146700000","freqHz":146700000},{"id":"c146762500","freqHz":146762500},{"id":"c146790000","freqHz":146790000},{"id":"c146937500","freqHz":146937500}],"closeCall":true,"closeCallDb":15,"knownHz":[145130000,145150000,145310000,145470000,146520000,146625000,146637500,146700000,146762500,146790000,146937500]}'
TGM='{"cmd":"tune","centerHz":462350000,"channels":[{"id":"g462562500","freqHz":462562500},{"id":"g462587500","freqHz":462587500},{"id":"g462612500","freqHz":462612500},{"id":"g462637500","freqHz":462637500},{"id":"g462662500","freqHz":462662500},{"id":"g462687500","freqHz":462687500},{"id":"g462712500","freqHz":462712500}],"closeCall":true,"closeCallDb":15,"knownHz":[]}'
( echo "$T2M"; sleep 60; echo "$TGM"; sleep 30; echo '{"cmd":"quit"}' ) | \
  native/build/kerchunk-dsp --sink plughw:CARD=PCH,DEV=0 --rtl-serial KIOSK01 --hang-ms 2000 --open-db 9 --close-call --audio-fd 3 \
  3>/dev/null > /home/kiosk/kiosk-iq/live-events.jsonl 2> /home/kiosk/kiosk-iq/live-stderr.txt &
sleep 5
P=$(pgrep -f 'kerchunk-dsp --sink plughw')
/tmp/claude-1000/meas.sh-native 60 "$P"   # CPU%, threads, ctx/s, temp over 60 s (script below)
wait
```

Here `meas.sh-native` is a copy of `/tmp/claude-1000/meas.sh` that takes the PID as its second argument instead of `pgrep`-ing the GR helper. Write it before starting. After the run, also measure shutdown latency: start it again with only `echo "$T2M"; sleep 5` on stdin followed by `kill -TERM`, and time until exit (it must be under 500 ms).

Weather check, concurrent or right after, 20 s:

```bash
( echo '{"cmd":"tune","centerHz":162610000,"channels":[{"id":"nwr","freqHz":162550000,"background":true}],"monitor":false}'; sleep 20; echo '{"cmd":"quit"}' ) | \
  nice -n 19 native/build/kerchunk-dsp --sink none --rtl-serial KIOSK03 --rate 250000 --same-enable > /home/kiosk/kiosk-iq/live-wx.jsonl 2>&1
```

Then **restart the service**: `sudo systemctl start kerchunk-kiosk`, and confirm `systemctl is-active` shows `active` and `/api/status` shows `running`.

- [ ] **Step 3: Record results** in `kiosk/bench/RESULTS-2026-09-25-native-p1c.md`:
- live CPU%, threads, ctx/s, temp (native vs GR's 223–234%, 285 threads, ~130k ctx/s)
- event counts, opens/closes, any drops/logs
- retune behaviour (tuned timing after the GMRS tune)
- SIGTERM exit latency
- weather-run events (SAME lines if any; multimon running)
- the operator's by-ear notes (ask them)

Commit: `bench(native): live hardware proof (P1c)`.

---

## After P1c (not in this plan)

**P2 (Node integration)**, from the memory must-list:
- `KERCHUNK_ENGINE=native` spawns `kerchunk-dsp` (built into `dist/` by `build:backend`).
- Don't forward GR `--quiet-db`; add `scan.nativeQuietDb` instead.
- Weather `WEATHER_RATE_HZ` → 250000.
- Drop `--lanes`/`--lane-modes` on the native path.
- Snapshot trims around the A/B. Update docs.

**P3:** live A/B by ear.
