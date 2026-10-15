# CB via FernSDR Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** CB mode listens through the operator's FernSDR receiver (Airspy HF+ on the LAN) instead of the RTL-SDR, watching all 40 channels at once, with audio still played by the parked `kerchunk-dsp` helper.

**Architecture:** Node opens one WebSocket to FernSDR, decodes plain NAC audio and plain WFC waterfall rows in TypeScript, picks the active channel from the waterfall (`cbWatch`), tunes the single audio stream to it, resamples to 50 kHz and writes s16 PCM to a new `--pcm-in-fd` pipe on the scanner helper. The helper, retuned to `{channels:[], pcmIn:true}` (a retune, never a respawn), plays that PCM through its existing AGC → 48 kHz → gate → limiter → ALSA/tee chain. The SDR CB path and the native LSB demod are removed.

**Tech Stack:** TypeScript (Node 24, ESM, `.js` imports, `strict` + `noUncheckedIndexedAccess`), `ws` 8 (already a dependency), vitest + supertest, C++17 helper with the in-repo `check.hpp` test harness, cmake.

**Spec:** `docs/superpowers/specs/2026-10-15-cb-fernsdr-design.md`

## Global Constraints

- All commands run from `kiosk/` unless stated (`cd /home/kiosk/kerchunk-kiosk/kiosk`).
- Relative TS imports carry `.js`. Indexed access is `T | undefined` — handle it.
- No new npm dependencies. WebSocket client = `import WebSocket from "ws"`.
- Receiver: `ws://192.168.1.30:8073/ws`, band `cb-radio`. Never touch `/admin` on it. Never open more than one connection per CbNet. Limits: 16 listeners / 32 connections per IP, control messages < 8 kB.
- `hello` capabilities: exactly `["audio-discontinuity"]` ∩ `welcome.capabilities` (plain NAC, JSON meters). `viewport` carries **no** `codec` (plain WFC).
- Close codes 4001 / 4002: never auto-reconnect.
- Helper lane rate `LANE_RATE` = 50 000 Hz: PCM into the helper is s16le mono at 50 kHz.
- Do-not-undo invariants (CLAUDE.md): SAME break-in is a `retune()`; the `breakIn` guard stays; the engine always drains fd 3; weather helper stays `niceness: 19` and never gets `--pcm-in-fd`.
- `/api/status`, `/api/logs`, `/api/weather` have an external consumer: changes are additive only.
- Every behaviour knob in config, defaults: `cb.fernsdr.url` `ws://192.168.1.30:8073/ws`, `band` `cb-radio`, `openDb` 10, `openRows` 2, `hangMs` 2000, `maxOpenMs` 180000, `bufferMs` 120, `maxBufferMs` 400, `backoffMaxMs` 60000; `cb.priority` [6,9,19]; `cb.ssbHangMs` 1500; `cb.channels` default all 40.
- Commit after each task on branch `feat/cb-fernsdr` with the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Engine work on the appliance: stop `kerchunk-kiosk` during native rebuild/test iterations is NOT needed (tests don't touch hardware); only Task 13 touches the live service.

## Review Focus

1. **Receiver unreachable at CB entry** (Pi down / wrong URL): CB mode still enters, the helper stays parked and silent, `/api/status.cb` reports `connected:false` with an error, retries back off — no crash, no tight reconnect loop. (Task 9 backoff test, Task 11 status test.)
2. **Leaving CB mid-transmission**: the open CB channel gets its `release` + `idle` so history durations close and the CB stage clears; no PCM is written after `stop()`. (Task 10 test.)
3. **Operator changes mode during a break-in that came from CB**: CbNet must end `stopped`, not stuck `paused` with an open socket. (Task 11 test.)
4. **Stale audio after a channel change**: frames from the previous channel are never played — dropped until `ack.tune >= request_id`. (Task 9 test.)
5. **A steady carrier on one CB channel**: it must not hold the speaker forever — `maxOpenMs` closes it and absorbs it into the baseline. (Task 8 test.)

---

### Task 1: Remove the native LSB demod

CB was the only user of `SsbDemod`, `SsbLevel`, the LSB energy squelch and `--ssb-gain-db` (PR #298). Keep `--ppm`, txstat `offsetHz` and the `Demod` enum refactor.

**Files:**
- Modify: `native/src/demod.hpp`, `native/src/demod.cpp`, `native/src/constants.hpp`, `native/src/audio.hpp`, `native/src/audio.cpp`, `native/src/engine.hpp`, `native/src/engine.cpp`, `native/src/scanner.hpp`, `native/src/scanner.cpp`, `native/src/cli.cpp`
- Test: `native/test/test_demod.cpp`, `native/test/test_audio.cpp`, `native/test/test_agc.cpp`, `native/test/test_engine.cpp`, `native/test/test_scanner.cpp`, `native/test/test_cli.cpp`

**Interfaces:**
- Produces: `enum class Demod { Fm, Am };` (Task 3 adds `Ext`). `SpeakerPath` constructor loses its trailing `float ssb_gain` parameter. `EngineOptions` loses `ssb_gain_db`.

- [ ] **Step 1: Delete the LSB tests first** (they are the spec of what goes away)

Run `grep -n -i "ssb\|lsb" native/test/*.cpp` and delete every TEST block whose name or body is about SSB/LSB: in `test_demod.cpp` (the `SsbDemod`/`SsbLevel` tests from df8c97d), `test_audio.cpp` (LSB speaker-source tests from edf76b2; restore any helper signature changed there to drop the `ssb_gain` argument), `test_agc.cpp` (two lines from edf76b2 passing `SSB_GAIN` — drop that argument), `test_engine.cpp` (the LSB lane tests from 239cf99), `test_scanner.cpp` (LSB floor / energy-squelch / gate-hold tests from eca3013 and fb88c1b — KEEP the `offsetHz` txstat test), `test_cli.cpp` (`cli_ssb_gain_db_range`). Leave `test_dcs.cpp` alone (its "LSB" is least-significant bit). Use `git show <sha> -- native/test/<file>` for each listed commit to find exactly the blocks it added.

- [ ] **Step 2: Remove the code**

`native/src/demod.hpp`: delete classes `SsbDemod` and `SsbLevel` and change the enum block to:

```cpp
// Lane demodulator kind, from the tune channel's "mode" ("am"; anything else is FM).
enum class Demod { Fm, Am };
inline Demod demod_for(const std::string& mode) { return mode == "am" ? Demod::Am : Demod::Fm; }
inline const char* demod_name(Demod d) { return d == Demod::Am ? "am" : "fm"; }
```

`native/src/demod.cpp`: delete `kSsbW`, `kSsbAtt`, `kSsbRel`, `ssb_aa()`, `ssb_ch()`, and the `SsbDemod::*` / `SsbLevel::*` definitions.

`native/src/constants.hpp`: delete the whole `// ---- SSB (LSB) lanes` block (`SSB_LO_HZ` … `SSB_GATE_HOLD_MS`).

`native/src/audio.hpp` / `audio.cpp`: remove the `float ssb_gain = SSB_GAIN` constructor parameter, members `ssb_gain_` and `ssb_`, the `ssb_.reset()` calls in `apply_target` and `switch_now`, and the `Demod::Lsb` branch in `process` so the per-sample block reads:

```cpp
    if (cur_lane_ >= 0 && x && disc) {
      if (cur_ == Demod::Am) a = am_.step(x[i]) * am_gain_;
      else a = hpf_.step(lpf_.step(de_.step(disc[i])));
      a = agc_.step(a, agc_frozen);
    }
```

and the `apply_target` re-prime comment reads `// Level-tracker re-prime on gate open (AM carrier): ...` with only the `Demod::Am` line.

`native/src/engine.hpp` / `engine.cpp`: remove `ssb_gain_db`, `ssb_`, `ssb_buf_`, the `ssb_[i].reset()` in `reset_lane`, the SSB_GAIN argument in the `spk_(...)` initializer, and in `on_hop` restore the plain forms:

```cpp
    const cf* y = lanes + i * per;
    power_[i].push(y, per);
```

```cpp
  if (f >= 0 && sc_.lane(f).parked()) {
    // (keep the existing comment)
    const cf* y = lanes + f * per;
    float* db = disc_buf_[f].data();
    for (int d = 0; d < per; d++) db[d] = disc_[f].step(y[d]);
  }
  if (f >= 0) spk_.process(lanes + f * per, disc_buf_[f].data(), per, out48_);
  else spk_.process(nullptr, nullptr, per, out48_);
```

`native/src/scanner.hpp` / `scanner.cpp`: remove `carrier_seen` and every `lsb` branch. In `Scanner::poll` the shared floor loop becomes `if (!L.parked() && L.floor_db) floor = ...;` followed by `if (!floor) return;`, delete `const bool lsb` / `const auto base`, replace every `*base` with `*floor`, the disc accumulation becomes `if (L.open && L.quiet) { T.disc_sum += r[i].disc_mean; T.disc_n++; }`, delete the SSB gate-hold block, and the quiet line becomes `if (!r[i].quiet_ready) L.quiet = false; else L.quiet = ...` (unchanged expression).

`native/src/cli.cpp`: delete the `--ssb-gain-db` branch.

- [ ] **Step 3: Build and run the native tests**

Run: `npm run test:native`
Expected: builds clean (no `-Werror` hits from unused includes), all tests PASS. Then `grep -rn -i "ssb\|Demod::Lsb" native/src native/app` → no hits.

- [ ] **Step 4: Commit**

```bash
git add native
git commit -m "refactor(dsp): remove the LSB demod (CB moves to FernSDR)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Native PCM-in jitter ring

**Files:**
- Create: `native/src/pcm_in.hpp`, `native/src/pcm_in.cpp`
- Modify: `native/src/constants.hpp`
- Test: `native/test/test_pcm_in.cpp` (CMake globs `test/*.cpp` and `src/*.cpp`; no CMake edit)

**Interfaces:**
- Produces:
  - `kc::PcmIn(double target_ms, double max_ms)`
  - `size_t PcmIn::write(const int16_t* x, size_t n)` — producer thread
  - `void PcmIn::pull(float* out, int n)` — DSP thread; fills `n` samples in [-1, 1)
  - `bool PcmIn::playing() const`
  - `void PcmIn::reset()` — DSP thread: drop buffered audio, back to priming
  - `void PcmIn::start_reader(int fd, LogFn log)` — detached reader thread
  - constants `PCM_TARGET_MS = 120`, `PCM_MAX_MS = 400`, `PCM_IN_RING = 1 << 16`

- [ ] **Step 1: Write the failing test** — `native/test/test_pcm_in.cpp`

```cpp
#include <vector>

#include "check.hpp"
#include "constants.hpp"
#include "pcm_in.hpp"

namespace {
std::vector<int16_t> ramp(int n, int16_t v) { return std::vector<int16_t>(n, v); }
const int MS = kc::LANE_RATE / 1000;   // samples per ms at the lane rate
}  // namespace

TEST(pcm_in_primes_then_plays) {
  kc::PcmIn p(20, 100);
  std::vector<float> out(64);
  auto a = ramp(10 * MS, 16384);
  p.write(a.data(), a.size());
  p.pull(out.data(), 64);
  CHECK(!p.playing());
  CHECK_NEAR(out[0], 0.0, 0);          // still priming: silence
  auto b = ramp(15 * MS, 16384);
  p.write(b.data(), b.size());         // 25 ms >= 20 ms target
  p.pull(out.data(), 64);
  CHECK(p.playing());
  CHECK_NEAR(out[0], 0.5, 1e-6);
}

TEST(pcm_in_underrun_plays_tail_then_reprimes) {
  kc::PcmIn p(1, 100);
  std::vector<float> out(64, 9.f);
  auto a = ramp(100, 16384);
  p.write(a.data(), a.size());
  p.pull(out.data(), 64);              // 100 buffered >= 50 target
  CHECK(p.playing());
  p.pull(out.data(), 64);              // only 36 left
  CHECK_NEAR(out[35], 0.5, 1e-6);
  CHECK_NEAR(out[36], 0.0, 0);         // zero-filled
  CHECK(!p.playing());                 // back to priming
}

TEST(pcm_in_overflow_drops_oldest_to_target) {
  kc::PcmIn p(10, 20);
  std::vector<float> out(64);
  auto old = ramp(25 * MS, 1000);
  auto fresh = ramp(10 * MS, 2000);
  p.write(old.data(), old.size());
  p.write(fresh.data(), fresh.size()); // 35 ms > 20 ms max
  p.pull(out.data(), 64);
  CHECK(p.playing());
  CHECK_NEAR(out[0], 2000.0 / 32768.0, 1e-6);   // trimmed back to the newest 10 ms
}

TEST(pcm_in_reset_drops_everything) {
  kc::PcmIn p(1, 100);
  std::vector<float> out(64);
  auto a = ramp(500, 16384);
  p.write(a.data(), a.size());
  p.pull(out.data(), 64);
  p.reset();
  CHECK(!p.playing());
  p.pull(out.data(), 64);
  CHECK_NEAR(out[0], 0.0, 0);
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test:native`
Expected: compile error, `pcm_in.hpp: No such file or directory`.

- [ ] **Step 3: Implement**

Append to `native/src/constants.hpp`:

```cpp
// ---- PCM-in (CB via FernSDR, spec docs/superpowers/specs/2026-10-15-cb-fernsdr-design.md).
// Node writes s16le mono at LANE_RATE to --pcm-in-fd; the speaker plays it while a tune has
// pcmIn. The ring absorbs the clock difference between the SDR (which paces the speaker) and the
// network receiver (which paces the PCM).
inline constexpr double PCM_TARGET_MS = 120;   // prime to this much before playing (--pcm-target-ms)
inline constexpr double PCM_MAX_MS = 400;      // above this, drop the oldest back to target (--pcm-max-ms)
inline constexpr size_t PCM_IN_RING = 1 << 16; // samples (~1.3 s at LANE_RATE)
```

`native/src/pcm_in.hpp`:

```cpp
// External speaker audio (CB via FernSDR): a jitter ring fed from a pipe by a reader thread and
// drained by the DSP thread in hop-sized pulls.
#pragma once
#include <cstdint>
#include <vector>

#include "constants.hpp"
#include "outputs.hpp"
#include "spsc.hpp"

namespace kc {
class PcmIn {
 public:
  PcmIn(double target_ms, double max_ms);
  size_t write(const int16_t* x, size_t n);   // producer: drops what doesn't fit
  // Consumer: n samples scaled to [-1, 1). Priming (or after an underrun) yields silence until
  // target_ms is buffered; a backlog over max_ms drops the oldest back to target_ms; an underrun
  // plays what is left, zero-fills, and returns to priming.
  void pull(float* out, int n);
  bool playing() const { return playing_; }
  void reset();                               // consumer: drop everything, back to priming
  // Detached thread: blocking reads from fd into the ring until EOF/error. Deliberately leaked
  // with the process, like the stdin reader in main.cpp.
  void start_reader(int fd, LogFn log);

 private:
  SpscRing<int16_t> ring_;
  size_t target_, max_;
  bool playing_ = false;
  std::vector<int16_t> tmp_;
};
}  // namespace kc
```

`native/src/pcm_in.cpp`:

```cpp
#include "pcm_in.hpp"

#include <unistd.h>

#include <algorithm>
#include <cerrno>
#include <cstring>
#include <string>
#include <thread>

namespace kc {
PcmIn::PcmIn(double target_ms, double max_ms)
    : ring_(PCM_IN_RING),
      target_((size_t)(target_ms * LANE_RATE / 1000.0)),
      max_(std::max((size_t)(max_ms * LANE_RATE / 1000.0), (size_t)(target_ms * LANE_RATE / 1000.0) + 1)) {}

size_t PcmIn::write(const int16_t* x, size_t n) { return ring_.write(x, n); }

void PcmIn::pull(float* out, int n) {
  size_t have = ring_.size();
  if (!playing_) {
    if (have < std::max<size_t>(target_, 1)) { std::fill(out, out + n, 0.f); return; }
    playing_ = true;
  }
  if (have > max_) { ring_.discard(have - target_); have = ring_.size(); }
  if ((int)tmp_.size() < n) tmp_.resize(n);
  const size_t got = ring_.read(tmp_.data(), (size_t)n);
  for (size_t i = 0; i < got; i++) out[i] = tmp_[i] / 32768.f;
  std::fill(out + got, out + n, 0.f);
  if (got < (size_t)n) playing_ = false;
}

void PcmIn::reset() {
  ring_.discard(ring_.size());
  playing_ = false;
}

void PcmIn::start_reader(int fd, LogFn log) {
  std::thread([this, fd, log] {
    std::vector<uint8_t> buf(8192);
    size_t carry = 0;   // an odd trailing byte waits for its partner
    for (;;) {
      const ssize_t r = ::read(fd, buf.data() + carry, buf.size() - carry);
      if (r == 0) { log("pcm-in: EOF"); return; }
      if (r < 0) {
        if (errno == EINTR) continue;
        log(std::string("pcm-in: read failed: ") + std::strerror(errno));
        return;
      }
      const size_t bytes = carry + (size_t)r;
      const size_t whole = bytes / 2;
      write(reinterpret_cast<const int16_t*>(buf.data()), whole);
      carry = bytes % 2;
      if (carry) buf[0] = buf[bytes - 1];
    }
  }).detach();
}
}  // namespace kc
```

- [ ] **Step 4: Run tests**

Run: `npm run test:native`
Expected: PASS (all four new tests plus the existing suite).

- [ ] **Step 5: Commit**

```bash
git add native
git commit -m "feat(dsp): PcmIn jitter ring for external speaker audio

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Helper plays PCM-in while a tune has `pcmIn`

**Files:**
- Modify: `native/src/demod.hpp`, `native/src/audio.hpp`, `native/src/audio.cpp`, `native/src/engine.hpp`, `native/src/engine.cpp`, `native/src/protocol.hpp`, `native/src/protocol.cpp`, `native/src/cli.hpp`, `native/src/cli.cpp`, `native/app/main.cpp`
- Test: `native/test/test_engine.cpp`, `native/test/test_protocol.cpp`, `native/test/test_cli.cpp`, `native/test/test_audio.cpp`

**Interfaces:**
- Consumes: `kc::PcmIn` (Task 2).
- Produces:
  - `enum class Demod { Fm, Am, Ext };` — `demod_name(Ext)` = `"ext"`; `demod_for` never returns `Ext`.
  - `void SpeakerPath::process(const cf* x, const float* disc, int n, std::vector<float>& out48, const float* ext = nullptr);`
  - `void Engine::set_pcm_in(PcmIn* p);`
  - `TuneCmd::pcm_in` (JSON `"pcmIn"`, default false).
  - CLI `--pcm-in-fd N` (≥ 0), `--pcm-target-ms` [20, 1000], `--pcm-max-ms` [50, 2000], max must exceed target. `Cli` fields `pcm_in_fd = -1`, `pcm_target_ms = PCM_TARGET_MS`, `pcm_max_ms = PCM_MAX_MS`.

- [ ] **Step 1: Write the failing tests**

Append to `native/test/test_engine.cpp`:

```cpp
#include "pcm_in.hpp"

TEST(engine_pcm_in_plays_external_audio_through_the_speaker_chain) {
  kc::EngineOptions o;
  o.rate = RATE;
  Rig r(o);
  kc::PcmIn pcm(20, 400);
  r.e.set_pcm_in(&pcm);
  r.tune(R"({"cmd":"tune","centerHz":146000000,"channels":[],"pcmIn":true})");
  std::vector<int16_t> tone(kc::LANE_RATE / 2);   // 0.5 s of 1 kHz at 0.25 FS
  for (size_t i = 0; i < tone.size(); i++) tone[i] = (int16_t)(8192 * std::sin(2 * M_PI * 1000 * i / kc::LANE_RATE));
  pcm.write(tone.data(), tone.size());
  r.feed(scene(0.6, 7));
  CHECK(r.pcm_rms(0.15, 0.4) > 0.05);   // audible (AGC/limiter applied)
  CHECK(r.of("open").empty());          // the scanner had no channels
}

TEST(engine_pcm_in_off_without_the_tune_flag) {
  kc::EngineOptions o;
  o.rate = RATE;
  Rig r(o);
  kc::PcmIn pcm(20, 400);
  r.e.set_pcm_in(&pcm);
  r.tune(R"({"cmd":"tune","centerHz":146000000,"channels":[]})");
  std::vector<int16_t> tone(kc::LANE_RATE / 2, 8192);
  pcm.write(tone.data(), tone.size());
  r.feed(scene(0.6, 8));
  CHECK(r.pcm_rms(0.15, 0.4) < 0.001);
}

TEST(engine_pcm_in_flag_without_a_ring_is_silent_and_safe) {
  kc::EngineOptions o;
  o.rate = RATE;
  Rig r(o);
  r.tune(R"({"cmd":"tune","centerHz":146000000,"channels":[],"pcmIn":true})");
  r.feed(scene(0.3, 9));
  CHECK(r.pcm_rms(0.05, 0.3) < 0.001);
}
```

Append to `native/test/test_protocol.cpp`:

```cpp
TEST(protocol_tune_pcm_in_flag) {
  std::string err;
  auto on = kc::parse_command(R"({"cmd":"tune","centerHz":1,"channels":[],"pcmIn":true})", err);
  CHECK(on.has_value());
  CHECK(std::get<kc::TuneCmd>(*on).pcm_in);
  auto off = kc::parse_command(R"({"cmd":"tune","centerHz":1,"channels":[]})", err);
  CHECK(!std::get<kc::TuneCmd>(*off).pcm_in);
}
```

Append to `native/test/test_cli.cpp` (use the file's existing `parse` helper):

```cpp
TEST(cli_pcm_in_flags) {
  kc::Cli c;
  std::string err;
  CHECK(parse({"--pcm-in-fd", "4", "--pcm-target-ms", "100", "--pcm-max-ms", "300"}, c, err));
  CHECK(c.pcm_in_fd == 4);
  CHECK_NEAR(c.pcm_target_ms, 100, 0);
  CHECK_NEAR(c.pcm_max_ms, 300, 0);
  kc::Cli d;
  CHECK(!parse({"--pcm-in-fd", "-1"}, d, err));
  kc::Cli e;
  CHECK(!parse({"--pcm-target-ms", "5"}, e, err));
  kc::Cli f;
  CHECK(!parse({"--pcm-target-ms", "300", "--pcm-max-ms", "200"}, f, err));   // max <= target
}
```

Append to `native/test/test_audio.cpp`:

```cpp
TEST(speaker_ext_source_feeds_the_agc_and_ignores_lanes) {
  auto sp = flat_path();
  sp.set_source(-1, kc::Demod::Ext);
  sp.set_gain(1.f);
  std::vector<float> ext(64, 0.25f), out;
  for (int k = 0; k < 50; k++) sp.process(nullptr, nullptr, 64, out, ext.data());
  CHECK(sp.feeding_lane() == -1);
  CHECK(sp.feeding_demod() == kc::Demod::Ext);
  CHECK(std::fabs(out.back()) > 0.2f);   // DC-ish 0.25 through a flat AGC, resampled
}
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm run test:native`
Expected: compile errors — `set_pcm_in`, `pcm_in`, `Demod::Ext`, `pcm_in_fd` undeclared.

- [ ] **Step 3: Implement**

`native/src/demod.hpp` enum block:

```cpp
// Lane demodulator kind, from the tune channel's "mode" ("am"; anything else is FM). Ext is the
// speaker's external PCM source (pcmIn tunes) — never a lane, never from a tune's mode.
enum class Demod { Fm, Am, Ext };
inline Demod demod_for(const std::string& mode) { return mode == "am" ? Demod::Am : Demod::Fm; }
inline const char* demod_name(Demod d) { return d == Demod::Am ? "am" : d == Demod::Ext ? "ext" : "fm"; }
```

`native/src/audio.hpp`: change the `process` declaration to
`void process(const cf* x, const float* disc, int n, std::vector<float>& out48, const float* ext = nullptr);`

`native/src/audio.cpp` `process` per-sample block:

```cpp
    float a = 0.f;
    if (cur_ == Demod::Ext) {
      if (ext) a = agc_.step(ext[i], agc_frozen);   // already demodulated by the receiver
    } else if (cur_lane_ >= 0 && x && disc) {
      if (cur_ == Demod::Am) a = am_.step(x[i]) * am_gain_;
      else a = hpf_.step(lpf_.step(de_.step(disc[i])));
      a = agc_.step(a, agc_frozen);
    }
    a50_[i] = a;
```

`native/src/protocol.hpp` `TuneCmd`: add `bool pcm_in = false;   // speaker plays --pcm-in-fd audio (CB via FernSDR)`.
`native/src/protocol.cpp` in the `tune` branch after `t.close_call_db`: `t.pcm_in = get_or<bool>(j, "pcmIn", false);`

`native/src/engine.hpp`: `#include "pcm_in.hpp"`; public `void set_pcm_in(PcmIn* p) { pcm_ = p; }`; private `void pcm_step(int n);`, members `PcmIn* pcm_ = nullptr; bool pcm_on_ = false; std::vector<float> ext_;`.

`native/src/engine.cpp`:

In `tune()` before `sc_.set_cc_audible(...)`:

```cpp
  pcm_on_ = t.pcm_in && pcm_ != nullptr;
  if (pcm_on_) pcm_->reset();   // never play audio queued before this tune
```

`sync_speaker()`:

```cpp
void Engine::sync_speaker() {
  if (pcm_on_) {   // external audio owns the speaker; pcm_step drives the gate
    spk_.set_source(-1, Demod::Ext);
    sync_active();
    return;
  }
  const int a = sc_.audible();
  spk_.set_source(a, a >= 0 ? sc_.lane(a).demod : Demod::Fm);
  spk_.set_gain(sc_.gate());
  sync_active();
}

void Engine::pcm_step(int n) {
  if ((int)ext_.size() < n) ext_.resize(n);
  pcm_->pull(ext_.data(), n);
  spk_.set_gain(pcm_->playing() ? 1.f : 0.f);
  spk_.process(nullptr, nullptr, n, out48_, ext_.data());
}
```

In `speak_silence`, replace `spk_.process(nullptr, nullptr, k, out48_);` with
`if (pcm_on_) pcm_step(k); else spk_.process(nullptr, nullptr, k, out48_);`

In `on_hop`, replace the speaker block (`const int f = spk_.feeding_lane();` through the `process` calls) with:

```cpp
  out48_.clear();
  if (pcm_on_) {
    pcm_step(per);
  } else {
    const int f = spk_.feeding_lane();
    if (f >= 0 && sc_.lane(f).parked()) {
      // (keep the existing comment block)
      const cf* y = lanes + f * per;
      float* db = disc_buf_[f].data();
      for (int d = 0; d < per; d++) db[d] = disc_[f].step(y[d]);
    }
    if (f >= 0) spk_.process(lanes + f * per, disc_buf_[f].data(), per, out48_);
    else spk_.process(nullptr, nullptr, per, out48_);
  }
  flush_audio();
```

`native/src/cli.hpp` `Cli`: add `int pcm_in_fd = -1;  double pcm_target_ms = PCM_TARGET_MS, pcm_max_ms = PCM_MAX_MS;`.
`native/src/cli.cpp`: add branches before the final `else`:

```cpp
    else if (k == "--pcm-in-fd") { if (!val(v) || !to_int(v, c.pcm_in_fd) || c.pcm_in_fd < 0) { err = "--pcm-in-fd must be a non-negative integer"; return false; } }
    else if (k == "--pcm-target-ms") { if (!ranged(v, 20, 1000, c.pcm_target_ms)) return false; }
    else if (k == "--pcm-max-ms") { if (!ranged(v, 50, 2000, c.pcm_max_ms)) return false; }
```

and after the loop, before `return true;`:

```cpp
  if (c.pcm_max_ms <= c.pcm_target_ms) { err = "--pcm-max-ms must exceed --pcm-target-ms"; return false; }
```

`native/app/main.cpp` in `run_live`, right after `in.detach();`:

```cpp
  if (c.pcm_in_fd >= 0) {
    // Deliberately leaked like events/cmds: its detached reader can outlive run_live.
    auto* pcm = new kc::PcmIn(c.pcm_target_ms, c.pcm_max_ms);
    pcm->start_reader(c.pcm_in_fd, log);
    eng->set_pcm_in(pcm);
  }
```

(`#include "pcm_in.hpp"` at the top of main.cpp.) `set_pcm_in` runs before `LiveLoop` starts stepping the engine, so no race.

- [ ] **Step 4: Run tests**

Run: `npm run test:native`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add native
git commit -m "feat(dsp): --pcm-in-fd: pcmIn tunes play external audio through the speaker chain

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Config — FernSDR knobs in, SDR CB path out

**Files:**
- Modify: `src/backend/config/schema.ts`, `src/backend/config/cb.ts`, `src/backend/server.ts` (`toScanConfig` only), `src/backend/engine/ScannerEngine.ts`, `src/backend/engine/WidebandEngine.ts` (drop `--ssb-gain-db` only), `src/frontend/dashboard/dashboard.ts` (`monitored` only)
- Test: `test/cbMode.test.ts`, `test/schema.test.ts`, `test/WidebandEngine.test.ts`

**Interfaces:**
- Produces (in `src/backend/config/cb.ts`):
  - `export const CB_PRIORITY_DEFAULT = [6, 9, 19] as const;`
  - `export const CB_FERNSDR_DEFAULTS: { url: string; band: string; openDb: number; openRows: number; hangMs: number; maxOpenMs: number; bufferMs: number; maxBufferMs: number; backoffMaxMs: number }`
  - `export interface CbNetConfig { url: string; band: string; channels: ScanChannel[]; priority: number[]; openDb: number; openRows: number; hangMs: number; ssbHangMs: number; maxOpenMs: number; backoffMaxMs: number }`
  - `export function cbNetConfig(cfg: Pick<Config, "cb">): CbNetConfig`
  - `cbChannels(numbers?, names?, modes?)` — third arg is now the modes map (no SSB squelch opts).
- `ScanConfig` gains `pcmIn?: boolean; pcmBufferMs?: number; pcmMaxBufferMs?: number;` and loses `nativeSsbGainDb`.
- `toScanConfig(cfg, "cb")` → `channels: []`, `pcmIn: true`. Every mode sets `pcmBufferMs` / `pcmMaxBufferMs` from `cfg.cb?.fernsdr` (defaults 120 / 400).
- Removed: `cbDefaultChannels`, `CbChannelOpts`, schema `cb.ssbOpenDb`, `scan.nativeSsbGainDb`.

- [ ] **Step 1: Rewrite the CB tests**

In `test/cbMode.test.ts`: update the import line to
`import { CB_FREQ_HZ, CB_ALL, cbChannels, cbNetConfig, cbNumberForFreq, cbLabel, CB_NAMES_DEFAULT } from "../src/backend/config/cb.js";`.
Delete the `describe("cbDefaultChannels")` block, the "LSB channels carry the SSB squelch" test and the `ssbOpenDb` part of "config.cb SSB knobs and radios[].ppm validate" (keep its `ssbHangMs` and `ppm` assertions). Replace the whole `describe("toScanConfig cb mode")` block with:

```ts
describe("toScanConfig cb mode", () => {
  const base = defaultConfig();
  it("parks the helper on PCM-in: no channels, no Close Call, no sweep", () => {
    const sc = toScanConfig(base, "cb");
    expect(sc.channels).toEqual([]);
    expect(sc.pcmIn).toBe(true);
    expect(sc.closeCall).toBe(false);
    expect(sc.sweepRanges).toEqual([]);
  });
  it("other modes never set pcmIn; every mode carries the PCM buffer knobs", () => {
    const sc = toScanConfig(base, "scan");
    expect(sc.pcmIn).toBe(false);
    expect([sc.pcmBufferMs, sc.pcmMaxBufferMs]).toEqual([120, 400]);
    const tuned = configSchema.parse({ ...base, cb: { fernsdr: { bufferMs: 150, maxBufferMs: 500 } } });
    expect([toScanConfig(tuned, "cb").pcmBufferMs, toScanConfig(tuned, "cb").pcmMaxBufferMs]).toEqual([150, 500]);
  });
  it("CB never enters the scan rotation or knownHz", () => {
    const sc = toScanConfig(base, "scan");
    expect(freqs(sc)).not.toContain(CB19);
    expect(sc.knownHz).not.toContain(CB19);
  });
});

describe("cbNetConfig", () => {
  it("defaults: all 40 channels, 38 LSB, priority 6/9/19, receiver knobs", () => {
    const c = cbNetConfig(defaultConfig());
    expect(c.channels.map((ch) => Number(ch.id.slice(3)))).toEqual(CB_ALL);
    expect(c.channels.find((ch) => ch.id === "cb_38")?.mode).toBe("lsb");
    expect(c.priority).toEqual([6, 9, 19]);
    expect(c).toMatchObject({ url: "ws://192.168.1.30:8073/ws", band: "cb-radio", openDb: 10, openRows: 2, hangMs: 2000, ssbHangMs: 1500, maxOpenMs: 180_000, backoffMaxMs: 60_000 });
  });
  it("honours config.cb", () => {
    const cfg = configSchema.parse({ ...defaultConfig(), cb: { channels: [19, 9], priority: [9], ssbHangMs: 900, modes: {}, fernsdr: { url: "ws://x:1/ws", openDb: 8 } } });
    const c = cbNetConfig(cfg);
    expect(c.channels.map((ch) => ch.id)).toEqual(["cb_9", "cb_19"]);
    expect(c.channels.every((ch) => ch.mode === "am")).toBe(true);
    expect(c).toMatchObject({ priority: [9], ssbHangMs: 900, url: "ws://x:1/ws", openDb: 8 });
  });
  it("rejects bad receiver knobs", () => {
    expect(() => configSchema.parse({ ...defaultConfig(), cb: { fernsdr: { url: "http://x" } } })).toThrow();
    expect(() => configSchema.parse({ ...defaultConfig(), cb: { fernsdr: { bufferMs: 300, maxBufferMs: 200 } } })).toThrow();
    expect(() => configSchema.parse({ ...defaultConfig(), cb: { priority: [41] } })).toThrow();
  });
});
```

In the "cbChannels" test, change any `cbChannels(nums, names, { modes })` call to `cbChannels(nums, names, modes)`.

In `test/schema.test.ts` replace the `nativeSsbGainDb` test with:

```ts
  it("strips the retired scan.nativeSsbGainDb and cb.ssbOpenDb", () => {
    const parsed = configSchema.parse({ ...base, scan: { ...base.scan, nativeSsbGainDb: -6 }, cb: { ssbOpenDb: 8 } });
    expect("nativeSsbGainDb" in parsed.scan).toBe(false);
    expect("ssbOpenDb" in (parsed.cb ?? {})).toBe(false);
  });
```

In `test/WidebandEngine.test.ts` delete the `forwards nativeSsbGainDb as --ssb-gain-db` test.

- [ ] **Step 2: Run to verify failures**

Run: `npx vitest run test/cbMode.test.ts test/schema.test.ts`
Expected: FAIL — `cbNetConfig` not exported, `pcmIn` undefined.

- [ ] **Step 3: Implement**

`src/backend/config/schema.ts`: delete `nativeSsbGainDb` (and its comment). Replace the `cb:` object with:

```ts
  // CB mode (POST /api/mode {mode:"cb"}): listening through the FernSDR
  // receiver on the LAN (spec 2026-10-15-cb-fernsdr). The scanner helper parks
  // and plays the receiver's audio; the waterfall watches every channel.
  cb: z.object({
    // Watched channels. Absent = all 40.
    channels: z.array(z.number().int().min(1).max(40)).min(1).optional(),
    // Channel number ("19") → name ("CB 19 · Highway"). Absent = CB_NAMES_DEFAULT.
    names: z.record(z.string().regex(/^([1-9]|[1-3]\d|40)$/), z.string().min(1).max(40)).optional(),
    // Channel number → receiver mode. Absent = CB_MODES_DEFAULT ({"38":"lsb"});
    // an explicit map replaces it (unlisted channels are AM).
    modes: z.record(z.string().regex(/^([1-9]|[1-3]\d|40)$/), z.enum(["am", "lsb"])).optional(),
    // Channels that pre-empt whatever is playing. Absent = 6/9/19.
    priority: z.array(z.number().int().min(1).max(40)).optional(),
    // Hang for LSB channels (SSB pauses between syllables). Absent = 1500.
    ssbHangMs: z.number().int().min(0).max(10_000).optional(),
    fernsdr: z.object({
      url: z.string().regex(/^wss?:\/\//).optional(),
      band: z.string().min(1).optional(),
      // dB over the channel's learned baseline, and consecutive waterfall
      // rows (~10/s) over it, to open a channel.
      openDb: z.number().min(3).max(40).optional(),
      openRows: z.number().int().min(1).max(10).optional(),
      hangMs: z.number().int().min(0).max(10_000).optional(),
      // A channel open this long is a carrier: close it and absorb it.
      maxOpenMs: z.number().int().min(10_000).max(3_600_000).optional(),
      // Helper PCM jitter buffer (--pcm-target-ms / --pcm-max-ms; respawns).
      bufferMs: z.number().int().min(20).max(1000).optional(),
      maxBufferMs: z.number().int().min(50).max(2000).optional(),
      backoffMaxMs: z.number().int().min(1000).max(600_000).optional(),
    }).refine((f) => (f.maxBufferMs ?? 400) > (f.bufferMs ?? 120), { message: "maxBufferMs must exceed bufferMs" }).optional(),
  }).optional(),
```

`src/backend/config/cb.ts`: update the header comment to say CB listens through FernSDR (spec 2026-10-15-cb-fernsdr); delete `CB_SSB_HANG_MS`'s comment reference to the helper but keep the constant; delete `CbChannelOpts` and `cbDefaultChannels`; replace `cbChannels` and add the new exports:

```ts
import type { Config } from "./schema.js";

/** Channels that pre-empt the audible one (operator: 6/9/19 matter most). */
export const CB_PRIORITY_DEFAULT = [6, 9, 19] as const;

/** config.cb.fernsdr defaults (spec 2026-10-15-cb-fernsdr). */
export const CB_FERNSDR_DEFAULTS = {
  url: "ws://192.168.1.30:8073/ws",
  band: "cb-radio",
  openDb: 10,
  openRows: 2,
  hangMs: 2000,
  maxOpenMs: 180_000,
  bufferMs: 120,
  maxBufferMs: 400,
  backoffMaxMs: 60_000,
} as const;

/** The CB channel set as events carry it: `cb_N` ids, labels, AM or the
 *  mode from `modes`. Always audible — picking CB mode is deliberate
 *  listening. No location: CB lands in history, never on the map. */
export function cbChannels(
  numbers: readonly number[] = CB_ALL,
  names: Readonly<Record<string, string>> = CB_NAMES_DEFAULT,
  modes: Readonly<Record<string, CbMode>> = CB_MODES_DEFAULT,
): ScanChannel[] {
  const out: ScanChannel[] = [];
  for (const n of [...new Set(numbers)].sort((a, b) => a - b)) {
    const freq = CB_FREQ_HZ[n];
    if (freq === undefined) continue;
    out.push({ id: `cb_${n}`, freq, alphaTag: cbLabel(n, names), mode: modes[String(n)] ?? "am", enabled: true, audible: true, tags: ["cb"] });
  }
  return out;
}

export interface CbNetConfig {
  url: string;
  band: string;
  channels: ScanChannel[];
  priority: number[];
  openDb: number;
  openRows: number;
  hangMs: number;
  ssbHangMs: number;
  maxOpenMs: number;
  backoffMaxMs: number;
}

/** Everything CbNet needs, resolved from config.cb with defaults. */
export function cbNetConfig(cfg: Pick<Config, "cb">): CbNetConfig {
  const cb = cfg.cb;
  const f = { ...CB_FERNSDR_DEFAULTS, ...(cb?.fernsdr ?? {}) };
  return {
    url: f.url, band: f.band,
    channels: cbChannels(cb?.channels ?? CB_ALL, cb?.names, cb?.modes),
    priority: [...(cb?.priority ?? CB_PRIORITY_DEFAULT)],
    openDb: f.openDb, openRows: f.openRows, hangMs: f.hangMs,
    ssbHangMs: cb?.ssbHangMs ?? CB_SSB_HANG_MS,
    maxOpenMs: f.maxOpenMs, backoffMaxMs: f.backoffMaxMs,
  };
}
```

(`{...defaults, ...cb.fernsdr}` — zod leaves absent optional keys out of the parsed object, so they don't overwrite defaults with `undefined`. If a test shows an `undefined` overwrite, filter undefined keys first.)

`src/backend/engine/ScannerEngine.ts` `ScanConfig`: delete `nativeSsbGainDb`; add

```ts
  // CB via FernSDR (spec 2026-10-15-cb-fernsdr): park the helper with no
  // lanes and play the --pcm-in-fd audio Node writes. Only the scanner
  // helper is built with the pipe.
  pcmIn?: boolean;
  // Helper PCM jitter buffer (--pcm-target-ms / --pcm-max-ms): spawn args,
  // so a change respawns through the PUT handler's scanChanged diff.
  pcmBufferMs?: number;
  pcmMaxBufferMs?: number;
```

`src/backend/server.ts` `toScanConfig`: replace the `mode === "cb" ? cbChannels(...)` arm with `: mode === "cb" ? []`, delete `nativeSsbGainDb: cfg.scan.nativeSsbGainDb,`, and add after `speakerAgc: {...},`:

```ts
    pcmIn: mode === "cb",
    pcmBufferMs: cfg.cb?.fernsdr?.bufferMs ?? CB_FERNSDR_DEFAULTS.bufferMs,
    pcmMaxBufferMs: cfg.cb?.fernsdr?.maxBufferMs ?? CB_FERNSDR_DEFAULTS.maxBufferMs,
```

Fix server.ts imports from `./config/cb.js` accordingly (drop `cbChannels`, `cbDefaultChannels` if no longer used; add `CB_FERNSDR_DEFAULTS`). `POST /api/test/tx` builds `cb_<n>` channels — switch it to `cbChannels([n], config.cb?.names, config.cb?.modes)[0]` if it used the old opts form.

`src/backend/engine/WidebandEngine.ts`: delete the `nativeSsbGainDb` / `--ssb-gain-db` line in `helperArgs`.

`src/frontend/dashboard/dashboard.ts` (lines ~220–230): replace both `cbDefaultChannels(...)` uses with `CB_ALL` / `cfg.cb?.channels ?? CB_ALL`, fixing the import; drop `DEFAULT_LANES_PER_GROUP` from the import if now unused.

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run test/cbMode.test.ts test/schema.test.ts test/WidebandEngine.test.ts && npm run typecheck`
Expected: PASS, typecheck clean. (The `POST /api/mode cb` and break-in tests in cbMode.test.ts still pass against FakeEngine.)

- [ ] **Step 5: Commit**

```bash
git add -A src test
git commit -m "feat(cb): config.cb.fernsdr + cb.priority; CB mode parks the helper on PCM-in; drop SDR CB/SSB knobs

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: WidebandEngine — PCM-in pipe and parked tune

**Files:**
- Modify: `src/backend/engine/WidebandEngine.ts`, `src/backend/engine/ScannerEngine.ts`, `src/backend/index.ts`, `test/fakes/fake-wideband-helper.sh`
- Test: `test/WidebandEngine.test.ts`

**Interfaces:**
- Consumes: `ScanConfig.pcmIn / pcmBufferMs / pcmMaxBufferMs` (Task 4).
- Produces:
  - `WidebandEngineOptions.pcmIn?: boolean` — build the fd-4 pipe and pass `--pcm-in-fd 4`.
  - `ScannerEngine.writePcm?(chunk: Buffer): void` — s16le 50 kHz mono; dropped while the pipe is backpressured or no helper is live.
  - Parked tune JSON: `{"cmd":"tune","centerHz":<last center or 27185000>,"channels":[],"pcmIn":true,"monitor":false,"closeCall":false,"closeCallDb":15,"knownHz":[]}`.

- [ ] **Step 1: Extend the fake helper**

In `test/fakes/fake-wideband-helper.sh` add to the header comment `#   FAKE_WB_PCM_FILE    - copy everything written to fd 4 (PCM-in) into this file` and, right after the `FAKE_WB_STDERR` line:

```bash
[ -n "${FAKE_WB_PCM_FILE:-}" ] && { cat <&4 > "$FAKE_WB_PCM_FILE" & }
```

- [ ] **Step 2: Write the failing tests** (append inside `describe("WidebandEngine")`)

```ts
  describe("PCM-in (CB via FernSDR)", () => {
    it("pcmIn engines spawn with --pcm-in-fd 4 and the buffer knobs; others don't", async () => {
      const args = tmpFile("args");
      const { engine } = makeEngine({ FAKE_WB_ARGS_FILE: args }, { pcmIn: true });
      await engine.start(cfg([VHF_A], { pcmBufferMs: 150, pcmMaxBufferMs: 500 }));
      await waitFor(() => lines(args).length >= 1, 1000);
      await engine.stop();
      expect(lines(args)[0]).toContain("--pcm-in-fd 4 --pcm-target-ms 150 --pcm-max-ms 500");
      const plainArgs = tmpFile("args");
      const plain = makeEngine({ FAKE_WB_ARGS_FILE: plainArgs });
      await plain.engine.start(cfg([VHF_A]));
      await waitFor(() => lines(plainArgs).length >= 1, 1000);
      await plain.engine.stop();
      expect(lines(plainArgs)[0]).not.toContain("--pcm-in-fd");
    });

    it("retune to pcmIn parks the LIVE helper (no respawn) and marks warm", async () => {
      const args = tmpFile("args");
      const tunes = tmpFile("tunes");
      const { engine, events } = makeEngine({ FAKE_WB_ARGS_FILE: args, FAKE_WB_TUNES_FILE: tunes }, { pcmIn: true });
      await engine.start(cfg([VHF_A]));
      await waitFor(() => lines(tunes).length >= 1, 1000);
      await engine.retune(cfg([], { pcmIn: true }));
      await waitFor(() => lines(tunes).length >= 2, 1000);
      await engine.stop();
      expect(lines(args)).toHaveLength(1);
      const parked = JSON.parse(lines(tunes)[1]!);
      expect(parked).toMatchObject({ cmd: "tune", channels: [], pcmIn: true, closeCall: false });
      expect(events.some((e) => e.type === "warmup" && e.phase === "ready")).toBe(true);
    });

    it("start() straight into pcmIn spawns a helper and sends the parked tune on ready", async () => {
      const tunes = tmpFile("tunes");
      const { engine } = makeEngine({ FAKE_WB_TUNES_FILE: tunes }, { pcmIn: true });
      await engine.start(cfg([], { pcmIn: true }));
      await waitFor(() => lines(tunes).length >= 1, 1000);
      await engine.stop();
      expect(JSON.parse(lines(tunes)[0]!)).toMatchObject({ channels: [], pcmIn: true });
    });

    it("an empty channel set WITHOUT pcmIn still releases the SDR (helperless)", async () => {
      const args = tmpFile("args");
      const { engine } = makeEngine({ FAKE_WB_ARGS_FILE: args }, { pcmIn: true });
      await engine.start(cfg([]));
      await new Promise((r) => setTimeout(r, 200));
      await engine.stop();
      expect(lines(args)).toHaveLength(0);
    });

    it("writePcm reaches the helper's fd 4", async () => {
      const pcm = tmpFile("pcm");
      const tunes = tmpFile("tunes");
      const { engine } = makeEngine({ FAKE_WB_PCM_FILE: pcm, FAKE_WB_TUNES_FILE: tunes }, { pcmIn: true });
      await engine.start(cfg([], { pcmIn: true }));
      await waitFor(() => lines(tunes).length >= 1, 1000);
      engine.writePcm(Buffer.from([1, 0, 2, 0]));
      await waitFor(() => existsSync(pcm) && readFileSync(pcm).length >= 4, 1000);
      await engine.stop();
      expect([...readFileSync(pcm)]).toEqual([1, 0, 2, 0]);
    });
  });
```

- [ ] **Step 3: Run to verify failures**

Run: `npx vitest run test/WidebandEngine.test.ts -t "PCM-in"`
Expected: FAIL (`writePcm` not a function / no `--pcm-in-fd`).

- [ ] **Step 4: Implement**

`ScannerEngine.ts` interface, after `retune?`:

```ts
  /** CB via FernSDR: s16le mono 50 kHz PCM for a helper parked on pcmIn.
   *  Best-effort (dropped while backpressured). Optional. */
  writePcm?(chunk: Buffer): void;
```

`WidebandEngine.ts`:
- `WidebandEngineOptions`: `/** Build the --pcm-in-fd pipe (the scanner only — CB via FernSDR). */ pcmIn?: boolean;`
- Fields: `private readonly pcmIn: boolean;` (set `opts.pcmIn === true` in the constructor), `private pcmBlocked = false;`, `private lastCenterHz: number | null = null;`, and a module constant `const PARK_CENTER_HZ = 27_185_000; // first-ever parked tune; any tunable center works`.
- `start()`: change the helperless branch condition to `if (this.groups.length === 0 && !(config.pcmIn && this.pcmIn)) {`.
- `retune()`: change `if (newGroups.length === 0) return this.start(config);` to `if (newGroups.length === 0 && !(config.pcmIn && this.pcmIn)) return this.start(config);`. After `this.resetRevisit();`, when `this.groups.length === 0` the existing `sendTune()` + `startDwellTimer()` calls now park (sendTune handles it, dwell timer returns early for ≤1 group).
- `helperArgs()`: after the `--audio-fd` line:

```ts
    // CB via FernSDR: the scanner always gets the PCM-in pipe so entering CB
    // is a retune, never a respawn. The weather helper never does.
    if (this.pcmIn) {
      args.push("--pcm-in-fd", "4",
        "--pcm-target-ms", String(cfg.pcmBufferMs ?? 120),
        "--pcm-max-ms", String(cfg.pcmMaxBufferMs ?? 400));
    }
```

- `spawnHelper()`: `stdio: this.pcmIn ? ["pipe", "pipe", "pipe", "pipe", "pipe"] : ["pipe", "pipe", "pipe", "pipe"],` then after the fd-3 handlers:

```ts
    this.pcmBlocked = false;
    child.stdio[4]?.on("error", () => { /* helper gone; the exit path restarts it */ });
```

- `sendTune()`: at the top, before `const group = ...`:

```ts
    if (this.config?.pcmIn && this.pcmIn && this.groups.length === 0) { this.sendParkedTune(); return; }
```

and record `this.lastCenterHz = group.centerHz + this.centerOffsetHz;` just before writing the tune.

- New methods:

```ts
  // CB via FernSDR: no lanes, the speaker plays fd 4. Keep the SDR where it
  // was (no needless retune); nothing to warm, so ready at once.
  private sendParkedTune(): void {
    if (!this.child?.stdin?.writable) return;
    this.releaseOpenOnHop();
    this.audibleId = null;
    this.holdStartedAt = 0;
    this.groupStartedAt = this.now();
    const centerHz = this.lastCenterHz ?? PARK_CENTER_HZ;
    this.child.stdin.write(JSON.stringify({
      cmd: "tune", centerHz, channels: [], pcmIn: true,
      monitor: false, closeCall: false, closeCallDb: this.config?.closeCallDb ?? 15, knownHz: [],
    }) + "\n");
    this.emit({ type: "tuned", freqHz: centerHz, channelIds: [], ts: this.now() });
    this.markFirstTune();
    this.markWarmReady();
  }

  writePcm(chunk: Buffer): void {
    const pipe = this.child?.stdio[4] as import("node:stream").Writable | null | undefined;
    if (!pipe || !pipe.writable || this.pcmBlocked) return;
    if (!pipe.write(chunk)) {
      this.pcmBlocked = true;
      pipe.once("drain", () => { this.pcmBlocked = false; });
    }
  }
```

(If `markFirstTune`/`markWarmReady` are already idempotent — check their bodies — call them as-is; otherwise guard with `firstTunedSeen` / `warmReadySeen`.)

`src/backend/index.ts`: add `pcmIn: true,` to the scanner `new WidebandEngine({...})` options (NOT the weather one).

- [ ] **Step 5: Run tests + typecheck**

Run: `npx vitest run test/WidebandEngine.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src test
git commit -m "feat(engine): scanner helper PCM-in pipe; pcmIn configs park the live helper

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: NAC audio decoder (with a real-receiver fixture)

**Files:**
- Create: `src/backend/fernsdr/bits.ts`, `src/backend/fernsdr/nac.ts`, `scripts/fernsdr-capture.mjs`, `test/fixtures/fernsdr/nac-frames.json`, `test/fixtures/fernsdr/nac-expected.json`
- Test: `test/fernsdr.nac.test.ts`

**Interfaces:**
- Produces:
  - `class BitReader { constructor(data: Uint8Array); overrun: boolean; bit(): number; bits(n: number): number; rice(k: number): number; signedRice(k: number): number; expGolomb(): number; signedExpGolomb(): number }`
  - `function zigzag(u: number): number`
  - `const FRAME_HOP = 128`
  - `class NacDecoder { decode(payload: Uint8Array): Float32Array | null; conceal(): Float32Array; reset(): void }` — `decode` returns 128 samples or `null` on a malformed frame (caller then calls `conceal()`).

- [ ] **Step 1: Capture a fixture from the receiver**

Create `scripts/fernsdr-capture.mjs` (committed — regenerates the fixture):

```js
// Capture plain-NAC audio frames + plain-WFC rows from a FernSDR receiver,
// exactly as CbNet negotiates them, for test/fixtures/fernsdr. Read-only
// listener; never touches /admin.
//   node scripts/fernsdr-capture.mjs ws://192.168.1.30:8073/ws cb-radio 27185000 am out.json
import WebSocket from "ws";
import { writeFileSync } from "node:fs";

const [url, band, freq, mode, out] = process.argv.slice(2);
const MAX_AUDIO = 300, MAX_ROWS = 40;
const ws = new WebSocket(url);
const cap = { audioConfig: [], audio: [], rows: [] };
ws.on("message", (data, isBinary) => {
  if (!isBinary) {
    const m = JSON.parse(String(data));
    if (m.type === "welcome") {
      const caps = (m.capabilities ?? []).filter((c) => c === "audio-discontinuity");
      const b = m.bands.find((x) => x.id === band);
      ws.send(JSON.stringify({ type: "hello", capabilities: caps }));
      ws.send(JSON.stringify({ type: "audio", enabled: true, rate: 12000 }));
      ws.send(JSON.stringify({ type: "tune", band, freq: Number(freq), mode, request_id: 1 }));
      ws.send(JSON.stringify({ type: "viewport", enabled: true, low: b.low, high: b.high, width: 456, fps: 10 }));
    } else if (m.type === "audio-config") cap.audioConfig.push(m);
    return;
  }
  const buf = Buffer.from(data);
  if (buf[0] === 1 && cap.audio.length < MAX_AUDIO) cap.audio.push(buf.toString("base64"));
  if (buf[0] === 2 && cap.rows.length < MAX_ROWS) cap.rows.push(buf.toString("base64"));
  if (cap.audio.length >= MAX_AUDIO && cap.rows.length >= MAX_ROWS) {
    ws.close(1000);
    writeFileSync(out, JSON.stringify(cap));
    console.log(`wrote ${out}: ${cap.audio.length} audio, ${cap.rows.length} rows`);
  }
});
ws.on("error", (e) => { console.error(e.message); process.exit(1); });
```

Run: `node scripts/fernsdr-capture.mjs ws://192.168.1.30:8073/ws cb-radio 27185000 am test/fixtures/fernsdr/nac-frames.json`
Expected: `wrote ...: 300 audio, 40 rows`. Then verify the formats are the plain ones:

```bash
node -e 'const c=require("./test/fixtures/fernsdr/nac-frames.json");const a=c.audio.map(b=>Buffer.from(b,"base64")[1]);const w=c.rows.map(b=>Buffer.from(b,"base64")[1]);console.log("audio flag bits1|3 set:",a.filter(f=>f&0b1010).length,"wfc flags set:",w.filter(f=>f).length, c.audioConfig)'
```

Expected: `audio flag bits1|3 set: 0 wfc flags set: 0`. **If either is nonzero, STOP** and report — the server is sending a format the plan doesn't decode.

- [ ] **Step 2: Produce expected output with the upstream reference decoder (scratchpad only, never committed)**

```bash
S=/tmp/claude-1000/-home-kiosk-kerchunk-kiosk/5aed92db-5ca8-44b2-9d58-fef59de60e61/scratchpad
mkdir -p $S/oracle-src $S/oracle
curl -s -o $S/oracle-src/fernsdr-probe.py https://raw.githubusercontent.com/Steven9101/FernSDR/main/tools/fernsdr-probe.py
cat > $S/oracle/oracle.py <<'EOF'
import base64, importlib.util, json, struct, sys
spec = importlib.util.spec_from_file_location("probe", sys.argv[1])
probe = importlib.util.module_from_spec(spec); spec.loader.exec_module(probe)
cap = json.load(open(sys.argv[2]))
nac = probe.NacDecoder(); frames = []
for b in cap["audio"]:
    p = base64.b64decode(b)
    out = nac.decode(p[4:], compact=False)
    frames.append(None if out is None else base64.b64encode(struct.pack("<128d", *out)).decode())
wfc = probe.WaterfallDecoder(); rows = []
for b in cap["rows"]:
    p = base64.b64decode(b)
    width = struct.unpack_from("<H", p, 20)[0]
    line = wfc.decode(p[22:], width, False, False, 1)
    rows.append(line)
json.dump({"frames": frames, "rows": rows}, open(sys.argv[3], "w"))
print(len(frames), "frames,", sum(f is None for f in frames), "malformed;", len(rows), "rows,", sum(r is None for r in rows), "undecodable")
EOF
python3 -I $S/oracle/oracle.py $S/oracle-src/fernsdr-probe.py test/fixtures/fernsdr/nac-frames.json test/fixtures/fernsdr/nac-expected.json
```

Expected: `300 frames, 0 malformed; 40 rows, N undecodable` (N small: temporal rows before the first intra row decode to `None`). Expected samples are float64 so the comparison is exact to ~1e-12.

- [ ] **Step 3: Write the failing test** — `test/fernsdr.nac.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BitReader, zigzag } from "../src/backend/fernsdr/bits.js";
import { NacDecoder, FRAME_HOP } from "../src/backend/fernsdr/nac.js";

const fx = (f: string) => JSON.parse(readFileSync(join(__dirname, "fixtures", "fernsdr", f), "utf8"));
const cap = fx("nac-frames.json") as { audio: string[] };
const expected = fx("nac-expected.json") as { frames: (string | null)[] };
const f64 = (b64: string) => { const b = Buffer.from(b64, "base64"); return Array.from({ length: FRAME_HOP }, (_, i) => b.readDoubleLE(i * 8)); };

describe("BitReader", () => {
  it("reads MSB-first bits, Rice with escape, Exp-Golomb, zig-zag", () => {
    const r = new BitReader(Uint8Array.from([0b1011_0000]));
    expect(r.bits(4)).toBe(0b1011);
    expect([zigzag(0), zigzag(1), zigzag(2), zigzag(3)]).toEqual([0, -1, 1, -2]);
    // rice k=1 of 5: q=2 -> "110", low bit "1"
    expect(new BitReader(Uint8Array.from([0b1101_0000])).rice(1)).toBe(5);
    // exp-golomb of 3: w=4 -> "00100"
    expect(new BitReader(Uint8Array.from([0b0010_0000])).expGolomb()).toBe(3);
    const short = new BitReader(Uint8Array.from([0xff]));
    short.bits(9);
    expect(short.overrun).toBe(true);
  });
});

describe("NacDecoder", () => {
  it("matches the upstream reference decoder on real receiver frames", () => {
    const d = new NacDecoder();
    let compared = 0;
    cap.audio.forEach((b64, i) => {
      const out = d.decode(Buffer.from(b64, "base64").subarray(4));
      const want = expected.frames[i];
      if (want === null || want === undefined) { expect(out).toBeNull(); return; }
      expect(out).not.toBeNull();
      const w = f64(want);
      for (let k = 0; k < FRAME_HOP; k++) expect(Math.abs(out![k]! - w[k]!)).toBeLessThan(1e-6);
      compared++;
    });
    expect(compared).toBeGreaterThan(250);
  });

  it("rejects a truncated frame", () => {
    const full = Buffer.from(cap.audio[10]!, "base64").subarray(4);
    expect(new NacDecoder().decode(full.subarray(0, 3))).toBeNull();
  });

  it("conceals by repeating the last spectrum at half amplitude, halving per loss", () => {
    const d = new NacDecoder();
    for (const b64 of cap.audio.slice(0, 40)) d.decode(Buffer.from(b64, "base64").subarray(4));
    const rms = (x: Float32Array) => Math.sqrt(x.reduce((s, v) => s + v * v, 0) / x.length);
    const a = rms(d.conceal()), b = rms(d.conceal()), c = rms(d.conceal());
    expect(b).toBeLessThan(a);
    expect(c).toBeLessThan(b);
    d.reset();
    expect(rms(d.conceal())).toBe(0);
  });
});
```

- [ ] **Step 4: Run to verify it fails**

Run: `npx vitest run test/fernsdr.nac.test.ts`
Expected: FAIL — cannot resolve `../src/backend/fernsdr/bits.js`.

- [ ] **Step 5: Implement**

`src/backend/fernsdr/bits.ts`:

```ts
// MSB-first bit reader for FernSDR's NAC and WFC bitstreams (upstream
// docs/CODEC.md "Shared conventions"). Reading past the end sets `overrun`
// and yields zeros; callers must discard the frame.
const RICE_ESCAPE = 24;

export function zigzag(u: number): number {
  return u % 2 === 0 ? u / 2 : -(u + 1) / 2;
}

export class BitReader {
  overrun = false;
  private pos = 0;
  constructor(private readonly data: Uint8Array) {}

  bit(): number {
    if (this.pos >= this.data.length * 8) { this.overrun = true; return 0; }
    const v = ((this.data[this.pos >> 3] ?? 0) >> (7 - (this.pos & 7))) & 1;
    this.pos++;
    return v;
  }

  /** Up to 32 bits, as a non-negative number (no 32-bit sign wrap). */
  bits(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) v = v * 2 + this.bit();
    return v;
  }

  rice(k: number): number {
    let q = 0;
    while (this.bit()) {
      q++;
      if (q >= RICE_ESCAPE) { this.bit(); return this.bits(32); }
      if (this.overrun) return 0;
    }
    return q * 2 ** k + (k ? this.bits(k) : 0);
  }

  signedRice(k: number): number { return zigzag(this.rice(k)); }

  expGolomb(): number {
    let lead = 0;
    while (!this.bit()) {
      lead++;
      if (lead > 32 || this.overrun) { this.overrun = true; return 0; }
    }
    let v = 1;
    for (let i = 0; i < lead; i++) v = v * 2 + this.bit();
    return v - 1;
  }

  signedExpGolomb(): number { return zigzag(this.expGolomb()); }
}
```

`src/backend/fernsdr/nac.ts`:

```ts
// Plain NAC decoder (FernSDR's MDCT audio codec, upstream docs/CODEC.md):
// dequantise, inverse MDCT, sine window, overlap-add. CbNet never negotiates
// nac2/nac3, so only the original frame layout is decoded. The direct
// 256x128 IMDCT is ~32k multiply-adds a frame — trivial at ~111 frames/s.
import { BitReader } from "./bits.js";

export const FRAME_HOP = 128;
const BAND_WIDTHS = [4, 4, 4, 4, 4, 4, 4, 4, 8, 8, 8, 8, 8, 8, 16, 16, 16];
const BAND_STARTS = BAND_WIDTHS.map((_, b) => BAND_WIDTHS.slice(0, b).reduce((s, w) => s + w, 0));
const EXPONENT_REFERENCE = -40;
const MAX_COEFFICIENT = 1e7;   // larger is not receiver audio: reject the frame

const riceK = (quality: number): number => Math.max(0, Math.min(20, Math.floor(quality / 4) - 1));

const M = FRAME_HOP;
const WINDOW = Float64Array.from({ length: 2 * M }, (_, n) => Math.sin((Math.PI / (2 * M)) * (n + 0.5)));
const COSINE = (() => {
  const t = new Float64Array(2 * M * M);
  for (let n = 0; n < 2 * M; n++)
    for (let k = 0; k < M; k++) t[n * M + k] = Math.cos((Math.PI / M) * (n + 0.5 + M / 2) * (k + 0.5));
  return t;
})();

export class NacDecoder {
  private overlap = new Float64Array(M);
  private last: Float64Array | null = null;
  private concealGain = 1;

  /** One plain NAC frame → 128 samples, or null when malformed. */
  decode(payload: Uint8Array): Float32Array | null {
    const r = new BitReader(payload);
    const quality = r.bits(6);
    const active = BAND_WIDTHS.map(() => r.bit());
    const exps = new Array<number>(BAND_WIDTHS.length).fill(0);
    let prev = EXPONENT_REFERENCE;
    for (let b = 0; b < BAND_WIDTHS.length; b++) {
      if (!active[b]) continue;
      prev += r.signedExpGolomb();
      if (prev < -200 || prev > 200 || r.overrun) return null;
      exps[b] = prev;
    }
    const k = riceK(quality);
    const coeffs = new Float64Array(M);
    for (let b = 0; b < BAND_WIDTHS.length; b++) {
      if (!active[b]) continue;
      const step = 2 ** (((exps[b] ?? 0) - quality) * 0.25);
      const start = BAND_STARTS[b] ?? 0;
      for (let i = 0; i < (BAND_WIDTHS[b] ?? 0); i++) {
        const v = r.signedRice(k) * step;
        if (Math.abs(v) > MAX_COEFFICIENT) return null;
        coeffs[start + i] = v;
      }
    }
    if (r.overrun) return null;
    this.last = coeffs;
    this.concealGain = 1;
    return this.synthesise(coeffs);
  }

  /** One frame of concealment: the previous spectrum at half amplitude,
   *  halving again per consecutive loss. Keeps the sample clock intact. */
  conceal(): Float32Array {
    this.concealGain *= 0.5;
    const c = new Float64Array(M);
    if (this.last) for (let i = 0; i < M; i++) c[i] = (this.last[i] ?? 0) * this.concealGain;
    return this.synthesise(c);
  }

  /** Discontinuity / retune: drop the MDCT overlap and concealment memory. */
  reset(): void {
    this.overlap.fill(0);
    this.last = null;
    this.concealGain = 1;
  }

  private synthesise(c: Float64Array): Float32Array {
    const out = new Float32Array(M);
    const scale = 2 / M;
    for (let n = 0; n < 2 * M; n++) {
      let acc = 0;
      const row = n * M;
      for (let k = 0; k < M; k++) {
        const v = c[k] ?? 0;
        if (v) acc += v * (COSINE[row + k] ?? 0);
      }
      const value = acc * scale * (WINDOW[n] ?? 0);
      if (n < M) out[n] = (this.overlap[n] ?? 0) + value;
      else this.overlap[n - M] = value;
    }
    return out;
  }
}
```

- [ ] **Step 6: Run tests**

Run: `npx vitest run test/fernsdr.nac.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/backend/fernsdr scripts/fernsdr-capture.mjs test/fernsdr.nac.test.ts test/fixtures/fernsdr
git commit -m "feat(fernsdr): plain NAC decoder, verified against the upstream reference on live frames

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: WFC row decoder and the 50 kHz resampler

**Files:**
- Create: `src/backend/fernsdr/wfc.ts`, `src/backend/fernsdr/resample.ts`
- Test: `test/fernsdr.wfc.test.ts`

**Interfaces:**
- Consumes: `BitReader` (Task 6), fixtures from Task 6.
- Produces:
  - `interface WaterfallFrame { flags: number; seq: number; lowHz: number; highHz: number; width: number; payload: Uint8Array }`
  - `function parseWaterfallFrame(buf: Uint8Array): WaterfallFrame | null` (null if shorter than 22 bytes)
  - `class WfcDecoder { decode(payload: Uint8Array, width: number): number[] | null; reset(): void }` — dB levels.
  - `class Resampler { constructor(inRate: number, outRate?: number /* 50_000 */); readonly inRate: number; push(x: Float32Array): Float32Array }`
  - `function toS16le(x: Float32Array): Buffer`

- [ ] **Step 1: Write the failing test** — `test/fernsdr.wfc.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { WfcDecoder, parseWaterfallFrame } from "../src/backend/fernsdr/wfc.js";
import { Resampler, toS16le } from "../src/backend/fernsdr/resample.js";

const fx = (f: string) => JSON.parse(readFileSync(join(__dirname, "fixtures", "fernsdr", f), "utf8"));
const cap = fx("nac-frames.json") as { rows: string[] };
const expected = fx("nac-expected.json") as { rows: (number[] | null)[] };

describe("WFC rows", () => {
  it("parse the header and match the upstream reference decoder", () => {
    const d = new WfcDecoder();
    let compared = 0;
    cap.rows.forEach((b64, i) => {
      const f = parseWaterfallFrame(Buffer.from(b64, "base64"))!;
      expect(f.highHz).toBeGreaterThan(f.lowHz);
      const line = d.decode(f.payload, f.width);
      const want = expected.rows[i];
      if (want === null || want === undefined) { expect(line).toBeNull(); return; }
      expect(line).toEqual(want);
      compared++;
    });
    expect(compared).toBeGreaterThan(20);
  });

  it("rejects a temporal row with no history", () => {
    const d = new WfcDecoder();
    // mode bit 0 (temporal), k=0, one residual "0" -> needs a previous row
    expect(d.decode(Uint8Array.from([0b0000_0000, 0]), 1)).toBeNull();
  });

  it("decodes an intra row from the -100 dB seed", () => {
    // mode 1, k=0000, three Rice-k0 zero residuals => [-100,-100,-100]
    expect(new WfcDecoder().decode(Uint8Array.from([0b1000_0000, 0b0000_0000]), 3)).toEqual([-100, -100, -100]);
  });

  it("short frames are null", () => {
    expect(parseWaterfallFrame(Uint8Array.from([2, 0, 0]))).toBeNull();
  });
});

describe("Resampler", () => {
  it("emits ~outRate/inRate samples per input and preserves DC", () => {
    const r = new Resampler(14_250);
    let n = 0, last = 0;
    for (let i = 0; i < 100; i++) { const y = r.push(new Float32Array(128).fill(0.5)); n += y.length; if (y.length) last = y[y.length - 1]!; }
    expect(Math.abs(n - (12_800 * 50_000) / 14_250)).toBeLessThan(4);
    expect(last).toBeCloseTo(0.5, 6);
  });

  it("keeps a 1 kHz tone at 1 kHz", () => {
    const r = new Resampler(14_250);
    const x = Float32Array.from({ length: 14_250 }, (_, i) => Math.sin((2 * Math.PI * 1000 * i) / 14_250));
    const y = r.push(x);
    let crossings = 0;
    for (let i = 1000; i < y.length; i++) if ((y[i - 1]! < 0) !== (y[i]! < 0)) crossings++;
    const seconds = (y.length - 1000) / 50_000;
    expect(crossings / 2 / seconds).toBeGreaterThan(990);
    expect(crossings / 2 / seconds).toBeLessThan(1010);
  });

  it("toS16le clamps and scales", () => {
    expect([...toS16le(Float32Array.from([0, 1, -1, 2]))]).toEqual([0, 0, 0xff, 0x7f, 0x01, 0x80, 0xff, 0x7f]);
  });
});
```

(Intra-row byte check: mode bit `1`, k = `0000`, then three Rice-k0 zeros `000` → `1000 0000 0` = bytes `0x80, 0x00`.)

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/fernsdr.wfc.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`src/backend/fernsdr/wfc.ts`:

```ts
// Plain waterfall rows (upstream docs/CODEC.md "The waterfall line codec"):
// 1-bit mode (0 temporal, 1 intra from a -100 dB seed), 4-bit Rice k, one
// signed Rice residual per bin, 1 dB units. CbNet never negotiates
// wfc2..wfc5, so frames with any flag bit set are not decoded here.
import { BitReader } from "./bits.js";

export interface WaterfallFrame { flags: number; seq: number; lowHz: number; highHz: number; width: number; payload: Uint8Array }

export function parseWaterfallFrame(buf: Uint8Array): WaterfallFrame | null {
  if (buf.length < 22) return null;
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  return {
    flags: v.getUint8(1), seq: v.getUint16(2, true),
    lowHz: v.getFloat64(4, true), highHz: v.getFloat64(12, true),
    width: v.getUint16(20, true), payload: buf.subarray(22),
  };
}

const LOW = -200, HIGH = 100, SEED = -100;

export class WfcDecoder {
  private prev: number[] | null = null;

  decode(payload: Uint8Array, width: number): number[] | null {
    if (payload.length === 0 || width < 1 || width > 4096) { this.prev = null; return null; }
    const r = new BitReader(payload);
    const mode = r.bit();
    const k = r.bits(4);
    const prev = this.prev;
    if (mode === 0 && (!prev || prev.length !== width)) { this.prev = null; return null; }
    const line = new Array<number>(width);
    for (let i = 0; i < width; i++) {
      const pred = mode === 1 ? (i ? line[i - 1]! : SEED) : prev![i]!;
      const v = pred + r.signedRice(k);
      if (v < LOW || v > HIGH || r.overrun) { this.prev = null; return null; }
      line[i] = v;
    }
    this.prev = line;
    return line;
  }

  reset(): void { this.prev = null; }
}
```

`src/backend/fernsdr/resample.ts`:

```ts
// Receiver audio (any rate, e.g. 14 250 Hz) → the helper's 50 kHz lane rate.
// Catmull-Rom cubic interpolation, streaming across chunks. The helper's own
// 50→48 kHz resampler and speaker chain follow, so this only needs to be
// clean in the voice band.
export const LANE_RATE = 50_000;

export class Resampler {
  private buf: number[] = [0, 0, 0];   // the last 3 input samples
  private pos = 1;                       // next output position, in buf index units
  private readonly step: number;
  constructor(readonly inRate: number, readonly outRate = LANE_RATE) {
    this.step = inRate / outRate;
  }

  push(x: Float32Array): Float32Array {
    const b = this.buf.concat(Array.from(x));
    const out: number[] = [];
    while (Math.floor(this.pos) + 2 < b.length) {
      const i = Math.floor(this.pos), f = this.pos - i;
      const y0 = b[i - 1]!, y1 = b[i]!, y2 = b[i + 1]!, y3 = b[i + 2]!;
      out.push(y1 + 0.5 * f * (y2 - y0 + f * (2 * y0 - 5 * y1 + 4 * y2 - y3 + f * (3 * (y1 - y2) + y3 - y0))));
      this.pos += this.step;
    }
    this.buf = b.slice(b.length - 3);
    this.pos -= b.length - 3;
    return Float32Array.from(out);
  }
}

export function toS16le(x: Float32Array): Buffer {
  const out = Buffer.alloc(x.length * 2);
  for (let i = 0; i < x.length; i++) {
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round((x[i] ?? 0) * 32767))), i * 2);
  }
  return out;
}
```

Check against the test: `toS16le([-1])` → `round(-32767)` = -32767 = `0x8001` → bytes `01 80` ✓; `2` clamps to 32767 = `ff 7f` ✓.

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/fernsdr.wfc.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/backend/fernsdr test/fernsdr.wfc.test.ts
git commit -m "feat(fernsdr): plain WFC row decoder and 50 kHz resampler

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: `cbWatch` — channel activity from waterfall rows (pure)

**Files:**
- Create: `src/backend/fernsdr/cbWatch.ts`
- Test: `test/cbWatch.test.ts`

**Interfaces:**
- Produces:
  - `interface CbWatchChannel { n: number; freq: number; priority: boolean; hangMs: number }`
  - `interface CbWatchOpts { openDb: number; openRows: number; maxOpenMs: number; baselineAlpha?: number /* 0.05 */; closeHystDb?: number /* 3 */ }`
  - `interface WatchRow { lowHz: number; highHz: number; levels: ArrayLike<number> }`
  - `type CbTransition = { kind: "open" | "close"; n: number; ts: number } | { kind: "audible"; n: number | null; ts: number }`
  - `class CbWatch { constructor(channels: CbWatchChannel[], opts: CbWatchOpts); row(r: WatchRow, ts: number): CbTransition[]; closeAll(ts: number): CbTransition[]; readonly audible: number | null; openChannels(): number[] }`
  - `function channelLevel(r: WatchRow, freq: number, halfWidthHz?: number /* 3000 */): number | null` — max over bins within ±3 kHz minus the row median.

Behaviour: baseline per channel starts at its first level; EMA (`baselineAlpha`) only on rows where the channel is closed and below threshold. Opens after `openRows` consecutive rows with `level − baseline ≥ openDb`. While open, rows ≥ `openDb − closeHystDb` refresh it; it closes `hangMs` after the last such row, or at `maxOpenMs` after opening — which also resets its baseline to the current level (absorbs a carrier). Audible = held until it closes; a priority channel opening pre-empts a non-priority audible one; otherwise the next audible is a priority open channel first, then the earliest-opened. Transition order per row: closes, opens, then at most one `audible`.

- [ ] **Step 1: Write the failing test** — `test/cbWatch.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { CbWatch, channelLevel, type CbWatchChannel, type WatchRow } from "../src/backend/fernsdr/cbWatch.js";

const LOW = 26_957_000, HIGH = 27_413_000, W = 456;   // ~1 kHz bins
const binOf = (f: number) => Math.floor(((f - LOW) / (HIGH - LOW)) * W);
function row(hot: Record<number, number> = {}, floor = -100): WatchRow {
  const levels = new Array<number>(W).fill(floor);
  for (const [f, db] of Object.entries(hot)) levels[binOf(Number(f))] = db;
  return { lowHz: LOW, highHz: HIGH, levels };
}
const CH: CbWatchChannel[] = [
  { n: 6, freq: 27_025_000, priority: true, hangMs: 2000 },
  { n: 14, freq: 27_125_000, priority: false, hangMs: 2000 },
  { n: 23, freq: 27_255_000, priority: false, hangMs: 2000 },
  { n: 38, freq: 27_385_000, priority: false, hangMs: 1500 },
];
const opts = { openDb: 10, openRows: 2, maxOpenMs: 180_000 };
const feed = (w: CbWatch, r: WatchRow, t0: number, rows: number) => {
  const out = [];
  for (let i = 0; i < rows; i++) out.push(...w.row(r, t0 + i * 100));
  return out;
};

describe("channelLevel", () => {
  it("is max-within-±3 kHz minus the row median; null outside the row", () => {
    expect(channelLevel(row({ 27_125_000: -70 }), 27_125_000)).toBe(30);
    expect(channelLevel(row({ 27_129_500: -70 }), 27_125_000)).toBe(0);   // 4.5 kHz away
    expect(channelLevel(row(), 28_000_000)).toBeNull();
  });
});

describe("CbWatch", () => {
  it("needs openRows consecutive rows over the baseline to open, then speaks it", () => {
    const w = new CbWatch(CH, opts);
    feed(w, row(), 0, 10);
    expect(w.row(row({ 27_125_000: -80 }), 1000)).toEqual([]);   // 1 row: not yet
    expect(w.row(row({ 27_125_000: -80 }), 1100)).toEqual([
      { kind: "open", n: 14, ts: 1100 },
      { kind: "audible", n: 14, ts: 1100 },
    ]);
  });

  it("one noisy row between quiet rows never opens", () => {
    const w = new CbWatch(CH, opts);
    feed(w, row(), 0, 10);
    expect([...w.row(row({ 27_125_000: -80 }), 1000), ...w.row(row(), 1100), ...w.row(row({ 27_125_000: -80 }), 1200)]).toEqual([]);
  });

  it("closes after its hang (LSB channels use their own) and goes silent", () => {
    const w = new CbWatch(CH, opts);
    feed(w, row(), 0, 10);
    feed(w, row({ 27_385_000: -80 }), 1000, 3);   // 38 opens at 1100
    const quiet = feed(w, row(), 1300, 20);       // last hot row at 1200; hang 1500
    const close = quiet.find((t) => t.kind === "close");
    expect(close).toEqual({ kind: "close", n: 38, ts: 2700 });
    expect(quiet).toContainEqual({ kind: "audible", n: null, ts: 2700 });
  });

  it("a priority channel pre-empts; the other stays open (history) but silent", () => {
    const w = new CbWatch(CH, opts);
    feed(w, row(), 0, 10);
    feed(w, row({ 27_125_000: -80 }), 1000, 2);
    const t = feed(w, row({ 27_125_000: -80, 27_025_000: -80 }), 1200, 2);
    expect(t).toContainEqual({ kind: "open", n: 6, ts: 1300 });
    expect(t).toContainEqual({ kind: "audible", n: 6, ts: 1300 });
    expect(w.openChannels().sort()).toEqual([6, 14]);
  });

  it("a non-priority channel does not steal the speaker", () => {
    const w = new CbWatch(CH, opts);
    feed(w, row(), 0, 10);
    feed(w, row({ 27_125_000: -80 }), 1000, 2);
    const t = feed(w, row({ 27_125_000: -80, 27_255_000: -80 }), 1200, 2);   // ch 23 (out of order freq)
    expect(t).toContainEqual({ kind: "open", n: 23, ts: 1300 });
    expect(t.some((x) => x.kind === "audible")).toBe(false);
    expect(w.audible).toBe(14);
  });

  it("a steady carrier closes at maxOpenMs and is absorbed into the baseline", () => {
    const w = new CbWatch(CH, { ...opts, maxOpenMs: 10_000 });
    feed(w, row(), 0, 10);
    const t = feed(w, row({ 27_125_000: -80 }), 1000, 150);   // 15 s of carrier
    expect(t.filter((x) => x.kind === "open" && x.n === 14)).toHaveLength(1);
    expect(t).toContainEqual({ kind: "close", n: 14, ts: 11_100 });
  });

  it("baseline absorbs a slow floor rise while closed", () => {
    const w = new CbWatch(CH, opts);
    for (let i = 0; i < 200; i++) w.row(row({ 27_125_000: -100 + Math.min(8, i * 0.1) }), i * 100);
    expect(w.openChannels()).toEqual([]);
  });

  it("closeAll releases everything (pause/stop)", () => {
    const w = new CbWatch(CH, opts);
    feed(w, row(), 0, 10);
    feed(w, row({ 27_125_000: -80 }), 1000, 2);
    expect(w.closeAll(5000)).toEqual([
      { kind: "close", n: 14, ts: 5000 },
      { kind: "audible", n: null, ts: 5000 },
    ]);
    expect(w.audible).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/cbWatch.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — `src/backend/fernsdr/cbWatch.ts`

```ts
// CB channel activity from FernSDR waterfall rows (spec 2026-10-15-cb-fernsdr,
// "Channel selection"). Pure: rows in, open/close/audible transitions out.
export interface CbWatchChannel { n: number; freq: number; priority: boolean; hangMs: number }
export interface CbWatchOpts { openDb: number; openRows: number; maxOpenMs: number; baselineAlpha?: number; closeHystDb?: number }
export interface WatchRow { lowHz: number; highHz: number; levels: ArrayLike<number> }
export type CbTransition = { kind: "open" | "close"; n: number; ts: number } | { kind: "audible"; n: number | null; ts: number };

const HALF_WIDTH_HZ = 3000;

function median(levels: ArrayLike<number>): number {
  const s = Array.from(levels).sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? 0;
}

/** Max level within ±halfWidth of freq, minus the row median; null when the
 *  channel isn't inside the row. Uses the row's own edges and width. */
export function channelLevel(r: WatchRow, freq: number, halfWidthHz = HALF_WIDTH_HZ, med = median(r.levels)): number | null {
  const width = r.levels.length;
  if (width === 0 || freq < r.lowHz || freq > r.highHz) return null;
  const binHz = (r.highHz - r.lowHz) / width;
  const lo = Math.max(0, Math.ceil((freq - halfWidthHz - r.lowHz) / binHz - 0.5));
  const hi = Math.min(width - 1, Math.floor((freq + halfWidthHz - r.lowHz) / binHz - 0.5));
  if (hi < lo) return null;
  let max = -Infinity;
  for (let i = lo; i <= hi; i++) max = Math.max(max, r.levels[i] ?? -Infinity);
  return max - med;
}

interface ChState { ch: CbWatchChannel; baseline: number | null; above: number; open: boolean; openedAt: number; lastHot: number }

export class CbWatch {
  private readonly st: ChState[];
  private readonly alpha: number;
  private readonly hyst: number;
  private _audible: number | null = null;

  constructor(channels: CbWatchChannel[], private readonly opts: CbWatchOpts) {
    this.st = channels.map((ch) => ({ ch, baseline: null, above: 0, open: false, openedAt: 0, lastHot: 0 }));
    this.alpha = opts.baselineAlpha ?? 0.05;
    this.hyst = opts.closeHystDb ?? 3;
  }

  get audible(): number | null { return this._audible; }
  openChannels(): number[] { return this.st.filter((s) => s.open).map((s) => s.ch.n); }

  row(r: WatchRow, ts: number): CbTransition[] {
    const med = median(r.levels);
    const closes: CbTransition[] = [], opens: CbTransition[] = [];
    let preempt: number | null = null;
    for (const s of this.st) {
      const level = channelLevel(r, s.ch.freq, HALF_WIDTH_HZ, med);
      if (level === null) continue;
      if (s.baseline === null) { s.baseline = level; continue; }
      const over = level - s.baseline;
      if (s.open) {
        if (over >= this.opts.openDb - this.hyst) s.lastHot = ts;
        if (ts - s.openedAt >= this.opts.maxOpenMs) {
          s.open = false; s.above = 0; s.baseline = level;   // a carrier: absorb it
          closes.push({ kind: "close", n: s.ch.n, ts });
        } else if (ts - s.lastHot >= s.ch.hangMs) {
          s.open = false; s.above = 0;
          closes.push({ kind: "close", n: s.ch.n, ts });
        }
      } else if (over >= this.opts.openDb) {
        if (++s.above >= this.opts.openRows) {
          s.open = true; s.openedAt = ts; s.lastHot = ts;
          opens.push({ kind: "open", n: s.ch.n, ts });
          if (s.ch.priority) preempt ??= s.ch.n;
        }
      } else {
        s.above = 0;
        s.baseline += this.alpha * (level - s.baseline);
      }
    }
    return [...closes, ...opens, ...this.pickAudible(ts, preempt)];
  }

  closeAll(ts: number): CbTransition[] {
    const out: CbTransition[] = [];
    for (const s of this.st) {
      if (!s.open) continue;
      s.open = false; s.above = 0;
      out.push({ kind: "close", n: s.ch.n, ts });
    }
    if (this._audible !== null) { this._audible = null; out.push({ kind: "audible", n: null, ts }); }
    return out;
  }

  private pickAudible(ts: number, preempt: number | null): CbTransition[] {
    const cur = this.st.find((s) => s.ch.n === this._audible);
    let next = this._audible;
    if (!cur?.open) {
      const open = this.st.filter((s) => s.open);
      const pri = open.filter((s) => s.ch.priority);
      const pool = pri.length ? pri : open;
      next = pool.sort((a, b) => a.openedAt - b.openedAt)[0]?.ch.n ?? null;
    } else if (preempt !== null && !cur.ch.priority) {
      next = preempt;
    }
    if (next === this._audible) return [];
    this._audible = next;
    return [{ kind: "audible", n: next, ts }];
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/cbWatch.test.ts && npm run typecheck`
Expected: PASS. If the "hang" test's exact `ts` is off by one row, fix the implementation (close fires on the first row where `ts − lastHot ≥ hangMs`), not the test.

- [ ] **Step 5: Commit**

```bash
git add src/backend/fernsdr/cbWatch.ts test/cbWatch.test.ts
git commit -m "feat(fernsdr): cbWatch — per-channel baselines, open rows, hang, priority, carrier cap

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: `FernClient` — WebSocket session

**Files:**
- Create: `src/backend/fernsdr/client.ts`
- Test: `test/fernsdr.client.test.ts`

**Interfaces:**
- Consumes: `NacDecoder`, `FRAME_HOP` (Task 6); `WfcDecoder`, `parseWaterfallFrame` (Task 7).
- Produces:
  - `interface FernBand { id: string; low: number; high: number; center: number }`
  - `type FernEvent = { type: "connected"; band: FernBand } | { type: "disconnected"; reason: string; retrying: boolean } | { type: "row"; lowHz: number; highHz: number; levels: number[] } | { type: "audio"; samples: Float32Array; rate: number } | { type: "meter"; dbfs: number }`
  - `interface FernClientOpts { url: string; band: string; backoffMaxMs: number; backoffBaseMs?: number /* 1000 */; random?: () => number; log?: (m: string) => void }`
  - `class FernClient { constructor(opts: FernClientOpts, onEvent: (e: FernEvent) => void); start(): void; stop(): void; tune(freq: number, mode: "am" | "lsb"): void; readonly connected: boolean; readonly error: string | null }`

Behaviour:
- On `welcome`: find `opts.band` (missing → `error = "band <id> not on the receiver"`, close, retry with backoff). Send in order: `hello` (`["audio-discontinuity"]` ∩ caps), `audio {enabled:true, rate:12000}`, `dsp {squelch:-200, agc:"auto"}`, `viewport {enabled:true, low, high, width:456, fps:10}` (band edges from welcome), then re-send the current tune if any. Emit `connected`; reset backoff attempt.
- `tune()` stores `{freq, mode}`, increments `request_id`, sends `{type:"tune", band, freq, mode, request_id}` when connected, and arms the audio gate: audio is dropped until a `state` with `ack.tune >= request_id`, at which point the NAC decoder resets and sequence tracking restarts.
- `audio-config` maps `generation → rate`. Audio frames: generation from flags bits 4–7 (unknown generation → drop); bit 2 discontinuity → decoder reset, no concealment for the gap; otherwise a forward sequence gap `g` (1 ≤ g < 1000, computed `(seq − last − 1) & 0xffff`) emits `g` concealed frames first; a backward/duplicate frame (`g ≥ 0x8000`) is dropped; malformed → one concealed frame. Each decoded/concealed frame → `{type:"audio", samples, rate}`.
- Waterfall frames with `flags !== 0` are dropped (WFC decoder reset); others decode → `row` event.
- JSON `meter` → `{type:"meter", dbfs}`; `inactivity` → send `{"type":"active"}`; `error` → log only.
- Close: 4001 → `error = "receiver listener timeout"`, 4002 → `error = "disconnected by the receiver operator"`, no retry. Any other close / connect error → `error` set, retry after `min(backoffMaxMs, backoffBaseMs·2^attempt) · (0.5 + random()/2)`. `stop()` cancels retries and closes with 1000.

- [ ] **Step 1: Write the failing test** — `test/fernsdr.client.test.ts`

```ts
import { describe, it, expect, afterEach } from "vitest";
import { WebSocketServer, type WebSocket as WsSocket } from "ws";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FernClient, type FernEvent } from "../src/backend/fernsdr/client.js";

const cap = JSON.parse(readFileSync(join(__dirname, "fixtures", "fernsdr", "nac-frames.json"), "utf8")) as { audio: string[]; rows: string[] };
const frame = (i: number, seq: number, gen = 1, flags = 0) => {
  const b = Buffer.from(Buffer.from(cap.audio[i]!, "base64"));
  b[1] = (gen << 4) | flags;
  b.writeUInt16LE(seq, 2);
  return b;
};
const WELCOME = { type: "welcome", capabilities: ["meter-v1", "nac2", "nac3", "wfc4", "audio-discontinuity"], bands: [{ id: "cb-radio", center: 27185000, low: 26957000, high: 27413000 }] };

let wss: WebSocketServer | null = null;
let client: FernClient | null = null;
afterEach(() => { client?.stop(); wss?.close(); wss = null; client = null; });

async function setup(onConn: (s: WsSocket, msgs: any[]) => void, over: Partial<ConstructorParameters<typeof FernClient>[0]> = {}) {
  wss = new WebSocketServer({ port: 0 });
  await new Promise((r) => wss!.once("listening", r));
  const port = (wss.address() as { port: number }).port;
  const msgs: any[] = [];
  let conns = 0;
  wss.on("connection", (s) => {
    conns++;
    s.on("message", (d, bin) => { if (!bin) msgs.push(JSON.parse(String(d))); });
    s.send(JSON.stringify(WELCOME));
    onConn(s, msgs);
  });
  const events: FernEvent[] = [];
  client = new FernClient({ url: `ws://127.0.0.1:${port}/ws`, band: "cb-radio", backoffMaxMs: 200, backoffBaseMs: 20, random: () => 1, ...over }, (e) => events.push(e));
  client.start();
  return { msgs, events, conns: () => conns };
}
const until = async (p: () => boolean, ms = 2000) => { const end = Date.now() + ms; while (!p() && Date.now() < end) await new Promise((r) => setTimeout(r, 10)); return p(); };

describe("FernClient", () => {
  it("handshakes with plain capabilities and a codec-less viewport from the band edges", async () => {
    const { msgs, events } = await setup(() => {});
    await until(() => msgs.length >= 4);
    expect(msgs.slice(0, 4)).toEqual([
      { type: "hello", capabilities: ["audio-discontinuity"] },
      { type: "audio", enabled: true, rate: 12000 },
      { type: "dsp", squelch: -200, agc: "auto" },
      { type: "viewport", enabled: true, low: 26957000, high: 27413000, width: 456, fps: 10 },
    ]);
    expect(events[0]).toEqual({ type: "connected", band: WELCOME.bands[0] });
    expect(client!.connected).toBe(true);
  });

  it("drops audio until state.ack.tune catches up, then decodes at the configured rate", async () => {
    let sock: WsSocket | null = null;
    const { msgs, events } = await setup((s) => { sock = s; });
    await until(() => msgs.length >= 4);
    client!.tune(27_185_000, "am");
    await until(() => msgs.some((m) => m.type === "tune"));
    expect(msgs.find((m) => m.type === "tune")).toEqual({ type: "tune", band: "cb-radio", freq: 27185000, mode: "am", request_id: 1 });
    sock!.send(JSON.stringify({ type: "audio-config", generation: 1, rate: 14250, frame_samples: 128, bitrate: 48000 }));
    sock!.send(frame(0, 10));                                     // old channel: dropped
    sock!.send(JSON.stringify({ type: "state", ack: { tune: 1 } }));
    sock!.send(frame(1, 11));
    await until(() => events.some((e) => e.type === "audio"));
    const audio = events.filter((e) => e.type === "audio");
    expect(audio).toHaveLength(1);
    expect(audio[0]).toMatchObject({ rate: 14250 });
  });

  it("conceals sequence gaps, skips concealment on discontinuity, drops duplicates", async () => {
    let sock: WsSocket | null = null;
    const { msgs, events } = await setup((s) => { sock = s; });
    await until(() => msgs.length >= 4);
    client!.tune(27_185_000, "am");
    sock!.send(JSON.stringify({ type: "audio-config", generation: 1, rate: 14250, frame_samples: 128, bitrate: 48000 }));
    sock!.send(JSON.stringify({ type: "state", ack: { tune: 1 } }));
    sock!.send(frame(0, 100));
    sock!.send(frame(1, 103));          // 2 lost -> 2 concealed + 1
    sock!.send(frame(2, 103));          // duplicate -> dropped
    sock!.send(frame(3, 200, 1, 0b100)); // discontinuity -> no concealment
    await until(() => events.filter((e) => e.type === "audio").length >= 5);
    await new Promise((r) => setTimeout(r, 50));
    expect(events.filter((e) => e.type === "audio")).toHaveLength(5);
  });

  it("emits decoded waterfall rows and meters; answers inactivity", async () => {
    let sock: WsSocket | null = null;
    const { msgs, events } = await setup((s) => { sock = s; });
    await until(() => msgs.length >= 4);
    for (const r of cap.rows) sock!.send(Buffer.from(r, "base64"));
    sock!.send(JSON.stringify({ type: "meter", dbfs: -92.4 }));
    sock!.send(JSON.stringify({ type: "inactivity", seconds: 60 }));
    await until(() => msgs.some((m) => m.type === "active") && events.some((e) => e.type === "meter"));
    expect(events.some((e) => e.type === "row" && e.levels.length > 0)).toBe(true);
    expect(events).toContainEqual({ type: "meter", dbfs: -92.4 });
  });

  it("reconnects with backoff after an ordinary close and replays the tune", async () => {
    let first = true;
    const { msgs, conns } = await setup((s) => { if (first) { first = false; setTimeout(() => s.close(1011), 30); } });
    await until(() => msgs.length >= 4);
    client!.tune(27_065_000, "am");
    await until(() => conns() >= 2);
    await until(() => msgs.filter((m) => m.type === "tune").length >= 2);
    expect(msgs.filter((m) => m.type === "tune").at(-1)).toMatchObject({ freq: 27065000 });
  });

  it("never reconnects after 4001 or 4002", async () => {
    for (const code of [4001, 4002]) {
      const { conns, events } = await setup((s) => setTimeout(() => s.close(code), 20));
      await until(() => events.some((e) => e.type === "disconnected"));
      await new Promise((r) => setTimeout(r, 300));
      expect(conns()).toBe(1);
      expect(events.find((e) => e.type === "disconnected")).toMatchObject({ retrying: false });
      expect(client!.error).toMatch(code === 4001 ? /timeout/ : /operator/);
      client!.stop(); wss!.close(); client = null; wss = null;
    }
  });

  it("an unreachable receiver sets error and keeps retrying", async () => {
    const events: FernEvent[] = [];
    client = new FernClient({ url: "ws://127.0.0.1:1/ws", band: "cb-radio", backoffMaxMs: 100, backoffBaseMs: 20, random: () => 1 }, (e) => events.push(e));
    client.start();
    await until(() => events.filter((e) => e.type === "disconnected").length >= 2);
    expect(client.connected).toBe(false);
    expect(client.error).toBeTruthy();
    expect(events.every((e) => e.type !== "disconnected" || e.retrying)).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/fernsdr.client.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — `src/backend/fernsdr/client.ts`

```ts
// FernSDR listener session (upstream docs/PROTOCOL.md): one WebSocket,
// plain NAC audio + plain WFC rows + JSON meters. Reconnects with backoff
// and jitter, replaying its settings; never after close 4001/4002.
import WebSocket from "ws";
import { NacDecoder } from "./nac.js";
import { WfcDecoder, parseWaterfallFrame } from "./wfc.js";

export interface FernBand { id: string; low: number; high: number; center: number }
export type FernEvent =
  | { type: "connected"; band: FernBand }
  | { type: "disconnected"; reason: string; retrying: boolean }
  | { type: "row"; lowHz: number; highHz: number; levels: number[] }
  | { type: "audio"; samples: Float32Array; rate: number }
  | { type: "meter"; dbfs: number };
export interface FernClientOpts { url: string; band: string; backoffMaxMs: number; backoffBaseMs?: number; random?: () => number; log?: (m: string) => void }

const CAPABILITIES = ["audio-discontinuity"];
const VIEW_WIDTH = 456;   // ~1 kHz bins over the 456 kHz CB band
const VIEW_FPS = 10;
const NO_RETRY: Record<number, string> = { 4001: "receiver listener timeout", 4002: "disconnected by the receiver operator" };

export class FernClient {
  private ws: WebSocket | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private attempt = 0;
  private running = false;
  private _connected = false;
  private _error: string | null = null;
  private band: FernBand | null = null;
  private target: { freq: number; mode: "am" | "lsb" } | null = null;
  private requestId = 0;
  private ackedTune = 0;
  private rates = new Map<number, number>();
  private lastSeq: number | null = null;
  private readonly nac = new NacDecoder();
  private readonly wfc = new WfcDecoder();

  constructor(private readonly opts: FernClientOpts, private readonly onEvent: (e: FernEvent) => void) {}

  get connected(): boolean { return this._connected; }
  get error(): string | null { return this._error; }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.connect();
  }

  stop(): void {
    this.running = false;
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    const ws = this.ws;
    this.ws = null;
    this._connected = false;
    ws?.removeAllListeners();
    ws?.on("error", () => {});
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) ws.close(1000);
  }

  tune(freq: number, mode: "am" | "lsb"): void {
    this.target = { freq, mode };
    this.requestId++;
    this.sendTune();
  }

  private sendTune(): void {
    if (!this.target || !this._connected || !this.band) return;
    this.send({ type: "tune", band: this.band.id, freq: this.target.freq, mode: this.target.mode, request_id: this.requestId });
  }

  private send(m: object): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  private connect(): void {
    const ws = new WebSocket(this.opts.url);
    this.ws = ws;
    ws.on("message", (data, isBinary) => {
      if (this.ws !== ws) return;
      if (isBinary) this.onBinary(data as Buffer);
      else this.onText(String(data));
    });
    ws.on("error", (e) => { if (this.ws === ws) this._error = e.message; });
    ws.on("close", (code, reasonBuf) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this._connected = false;
      const reason = NO_RETRY[code] ?? (this._error ?? (String(reasonBuf) || `closed (${code})`));
      this._error = reason;
      const retrying = this.running && !(code in NO_RETRY);
      this.onEvent({ type: "disconnected", reason, retrying });
      if (retrying) this.scheduleRetry();
      else this.running = false;
    });
  }

  private scheduleRetry(): void {
    const base = this.opts.backoffBaseMs ?? 1000;
    const delay = Math.min(this.opts.backoffMaxMs, base * 2 ** this.attempt) * (0.5 + (this.opts.random ?? Math.random)() / 2);
    this.attempt++;
    this.retryTimer = setTimeout(() => { this.retryTimer = null; if (this.running) this.connect(); }, delay);
  }

  private onText(text: string): void {
    let m: any;
    try { m = JSON.parse(text); } catch { return; }
    switch (m?.type) {
      case "welcome": return this.onWelcome(m);
      case "state":
        if (typeof m.ack?.tune === "number" && m.ack.tune > this.ackedTune) {
          const caughtUp = m.ack.tune >= this.requestId && this.ackedTune < this.requestId;
          this.ackedTune = m.ack.tune;
          if (caughtUp) { this.nac.reset(); this.lastSeq = null; }
        }
        return;
      case "audio-config":
        if (typeof m.generation === "number" && typeof m.rate === "number") this.rates.set(m.generation & 0xf, m.rate);
        return;
      case "meter":
        if (typeof m.dbfs === "number") this.onEvent({ type: "meter", dbfs: m.dbfs });
        return;
      case "inactivity": return this.send({ type: "active" });
      case "error": this.opts.log?.(`[fernsdr] server error: ${m.message}`); return;
      default: return;   // chat, station, theme, rds, band-status
    }
  }

  private onWelcome(m: any): void {
    const band = (m.bands ?? []).find((b: any) => b?.id === this.opts.band);
    if (!band) {
      this._error = `band ${this.opts.band} not on the receiver`;
      this.ws?.close(1000);
      return;
    }
    this.band = { id: band.id, low: band.low, high: band.high, center: band.center };
    const caps = CAPABILITIES.filter((c) => (m.capabilities ?? []).includes(c));
    this.rates.clear();
    this.ackedTune = 0;
    this.lastSeq = null;
    this.nac.reset();
    this.wfc.reset();
    this._connected = true;
    this._error = null;
    this.attempt = 0;
    this.send({ type: "hello", capabilities: caps });
    this.send({ type: "audio", enabled: true, rate: 12000 });
    this.send({ type: "dsp", squelch: -200, agc: "auto" });
    this.send({ type: "viewport", enabled: true, low: band.low, high: band.high, width: VIEW_WIDTH, fps: VIEW_FPS });
    // request_ids restart per connection: re-send the current tune as id 1+.
    if (this.target) { this.requestId = Math.max(1, this.requestId); this.sendTune(); }
    this.onEvent({ type: "connected", band: this.band });
  }

  private onBinary(buf: Buffer): void {
    if (buf.length < 2) return;
    if (buf[0] === 0x01) return this.onAudio(buf);
    if (buf[0] === 0x02) {
      const f = parseWaterfallFrame(buf);
      if (!f) return;
      if (f.flags !== 0) { this.wfc.reset(); return; }   // never negotiated: not ours to decode
      const levels = this.wfc.decode(f.payload, f.width);
      if (levels) this.onEvent({ type: "row", lowHz: f.lowHz, highHz: f.highHz, levels });
    }
  }

  private onAudio(buf: Buffer): void {
    if (buf.length < 4) return;
    if (this.ackedTune < this.requestId) return;   // still the previous channel's audio
    const flags = buf[1]!;
    const rate = this.rates.get(flags >> 4);
    if (rate === undefined) return;
    const seq = buf.readUInt16LE(2);
    if (flags & 0b100) {
      this.nac.reset();
    } else if (this.lastSeq !== null) {
      const gap = (seq - this.lastSeq - 1) & 0xffff;
      if (gap >= 0x8000) return;   // duplicate or late
      if (gap > 0 && gap < 1000) for (let i = 0; i < gap; i++) this.onEvent({ type: "audio", samples: this.nac.conceal(), rate });
    }
    this.lastSeq = seq;
    const out = this.nac.decode(buf.subarray(4)) ?? this.nac.conceal();
    this.onEvent({ type: "audio", samples: out, rate });
  }
}
```

Note the duplicate test: `seq 103` twice → second has gap `(103−103−1)&0xffff = 0xffff ≥ 0x8000` → dropped ✓. The audio gate: `ackedTune` starts 0 and `requestId` 0, so before any `tune()` audio is accepted — fine (nothing is audible yet, CbNet ignores it).

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/fernsdr.client.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/backend/fernsdr/client.ts test/fernsdr.client.test.ts
git commit -m "feat(fernsdr): FernClient WebSocket session (ack-gated audio, concealment, backoff)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: `CbNet` — orchestrator and engine events

**Files:**
- Create: `src/backend/fernsdr/cbNet.ts`
- Test: `test/cbNet.test.ts`

**Interfaces:**
- Consumes: `CbNetConfig`, `cbChannels` (Task 4); `CbWatch` (Task 8); `FernClient`, `FernEvent`, `FernClientOpts` (Task 9); `Resampler`, `toS16le` (Task 7); `EngineEvent`, `EngineListener` (ScannerEngine.ts).
- Produces:
  - `interface CbSource { start(cfg: CbNetConfig): void; pause(): void; stop(): void; status(): { connected: boolean; error: string | null }; on(l: EngineListener): void; off(l: EngineListener): void }`
  - `interface FernClientLike { start(): void; stop(): void; tune(freq: number, mode: "am" | "lsb"): void; readonly connected: boolean; readonly error: string | null }`
  - `class CbNet implements CbSource { constructor(deps: { writePcm: (chunk: Buffer) => void; now?: () => number; clientFactory?: (opts: FernClientOpts, onEvent: (e: FernEvent) => void) => FernClientLike; log?: (m: string) => void }) }`
- Events (same shapes the helper path produced): `active {channel, freq, ts}`, `release {channelId, ts}`, `idle {ts}` (when the last open channel closes), `audible {channel | null, ts}`, `signal {dbfs, ts}` (only while audible, ≤ 4/s). Channel objects come from `cfg.channels` (`cb_N` ids, `tags:["cb"]`).

Behaviour: `start(cfg)` — stopped → build client + watch, `client.start()`; paused → state running (watch kept); running with a different `url`/`band` → stop + start; otherwise rebuild the watch only if channels/priority/thresholds changed (`JSON.stringify` compare), emitting `closeAll` releases first. `pause()` → emit releases (`closeAll`), state paused; rows are ignored while paused. `stop()` → releases, `client.stop()`, state stopped. Audio is written only while running and `watch.audible !== null`; a rate change makes a new `Resampler`.

- [ ] **Step 1: Write the failing test** — `test/cbNet.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { CbNet, type FernClientLike } from "../src/backend/fernsdr/cbNet.js";
import { cbNetConfig } from "../src/backend/config/cb.js";
import { defaultConfig } from "../src/backend/config/schema.js";
import type { FernEvent, FernClientOpts } from "../src/backend/fernsdr/client.js";
import type { EngineEvent } from "../src/backend/engine/ScannerEngine.js";

const LOW = 26_957_000, HIGH = 27_413_000, W = 456;
const row = (hot: number[] = []): FernEvent => {
  const levels = new Array<number>(W).fill(-100);
  for (const f of hot) levels[Math.floor(((f - LOW) / (HIGH - LOW)) * W)] = -70;
  return { type: "row", lowHz: LOW, highHz: HIGH, levels };
};

function rig() {
  const clients: Array<{ opts: FernClientOpts; emit: (e: FernEvent) => void; tunes: [number, string][]; started: number; stopped: number }> = [];
  const pcm: Buffer[] = [];
  let t = 0;
  const net = new CbNet({
    writePcm: (b) => pcm.push(b),
    now: () => t,
    clientFactory: (opts, onEvent) => {
      const c = { opts, emit: onEvent, tunes: [] as [number, string][], started: 0, stopped: 0 };
      clients.push(c);
      const like: FernClientLike = {
        start: () => { c.started++; }, stop: () => { c.stopped++; },
        tune: (f, m) => { c.tunes.push([f, m]); },
        get connected() { return true; }, get error() { return null; },
      };
      return like;
    },
  });
  const events: EngineEvent[] = [];
  net.on((e) => events.push(e));
  const rows = (hot: number[], n: number) => { for (let i = 0; i < n; i++) { t += 100; clients.at(-1)!.emit(row(hot)); } };
  return { net, clients, pcm, events, rows, tick: (ms: number) => { t += ms; } };
}
const cfg = cbNetConfig(defaultConfig());
const CB19 = 27_185_000, CB38 = 27_385_000;

describe("CbNet", () => {
  it("opens a channel from the waterfall: tunes the receiver, emits active + audible", () => {
    const r = rig();
    r.net.start(cfg);
    r.rows([], 10);
    r.rows([CB19], 2);
    expect(r.clients[0]!.tunes).toEqual([[CB19, "am"]]);
    const active = r.events.find((e) => e.type === "active");
    expect(active).toMatchObject({ type: "active", freq: CB19, channel: { id: "cb_19", tags: ["cb"] } });
    expect(r.events.find((e) => e.type === "audible")).toMatchObject({ channel: { id: "cb_19" } });
  });

  it("38 tunes as LSB", () => {
    const r = rig();
    r.net.start(cfg);
    r.rows([], 10);
    r.rows([CB38], 2);
    expect(r.clients[0]!.tunes).toEqual([[CB38, "lsb"]]);
  });

  it("writes resampled PCM only while a channel is audible", () => {
    const r = rig();
    r.net.start(cfg);
    const audio: FernEvent = { type: "audio", samples: new Float32Array(128).fill(0.1), rate: 14_250 };
    r.clients[0]!.emit(audio);
    expect(r.pcm).toHaveLength(0);
    r.rows([], 10);
    r.rows([CB19], 2);
    for (let i = 0; i < 4; i++) r.clients[0]!.emit(audio);
    expect(r.pcm.length).toBeGreaterThan(0);
    const bytes = r.pcm.reduce((s, b) => s + b.length, 0);
    expect(Math.abs(bytes / 2 - (512 * 50_000) / 14_250)).toBeLessThan(6);
  });

  it("meter → signal only while audible", () => {
    const r = rig();
    r.net.start(cfg);
    r.clients[0]!.emit({ type: "meter", dbfs: -90 });
    expect(r.events.some((e) => e.type === "signal")).toBe(false);
    r.rows([], 10);
    r.rows([CB19], 2);
    r.tick(300);
    r.clients[0]!.emit({ type: "meter", dbfs: -60 });
    expect(r.events.find((e) => e.type === "signal")).toMatchObject({ dbfs: -60 });
  });

  it("close emits release then idle and audible null", () => {
    const r = rig();
    r.net.start(cfg);
    r.rows([], 10);
    r.rows([CB19], 2);
    r.rows([], 30);
    const tail = r.events.map((e) => e.type);
    expect(tail.slice(-3).sort()).toEqual(["audible", "idle", "release"]);
  });

  it("stop mid-transmission releases, closes the client, and writes no more PCM", () => {
    const r = rig();
    r.net.start(cfg);
    r.rows([], 10);
    r.rows([CB19], 2);
    r.net.stop();
    expect(r.events.some((e) => e.type === "release" && e.channelId === "cb_19")).toBe(true);
    expect(r.clients[0]!.stopped).toBe(1);
    const before = r.pcm.length;
    r.clients[0]!.emit({ type: "audio", samples: new Float32Array(128), rate: 14_250 });
    expect(r.pcm.length).toBe(before);
    expect(r.net.status()).toEqual({ connected: false, error: null });
  });

  it("pause keeps the client, releases, ignores rows; start resumes on the same client", () => {
    const r = rig();
    r.net.start(cfg);
    r.rows([], 10);
    r.rows([CB19], 2);
    r.net.pause();
    expect(r.clients[0]!.stopped).toBe(0);
    expect(r.events.some((e) => e.type === "release")).toBe(true);
    const n = r.events.length;
    r.rows([CB19], 5);
    expect(r.events.length).toBe(n);
    r.net.start(cfg);
    expect(r.clients).toHaveLength(1);
  });

  it("a url change reconnects; a same-config start is a no-op", () => {
    const r = rig();
    r.net.start(cfg);
    r.net.start(cfg);
    expect(r.clients).toHaveLength(1);
    r.net.start({ ...cfg, url: "ws://other:1/ws" });
    expect(r.clients).toHaveLength(2);
    expect(r.clients[0]!.stopped).toBe(1);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/cbNet.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — `src/backend/fernsdr/cbNet.ts`

```ts
// CB via FernSDR (spec 2026-10-15-cb-fernsdr): owns the receiver session and
// the channel watch, emits the same engine events the SDR CB path did, and
// feeds the audible channel's audio to the parked helper as 50 kHz s16 PCM.
import type { Channel } from "../config/schema.js";
import type { CbNetConfig } from "../config/cb.js";
import type { EngineEvent, EngineListener } from "../engine/ScannerEngine.js";
import { CbWatch, type CbTransition } from "./cbWatch.js";
import { FernClient, type FernClientOpts, type FernEvent } from "./client.js";
import { Resampler, toS16le } from "./resample.js";

export interface CbSource {
  start(cfg: CbNetConfig): void;
  pause(): void;
  stop(): void;
  status(): { connected: boolean; error: string | null };
  on(l: EngineListener): void;
  off(l: EngineListener): void;
}
export interface FernClientLike { start(): void; stop(): void; tune(freq: number, mode: "am" | "lsb"): void; readonly connected: boolean; readonly error: string | null }
interface CbNetDeps {
  writePcm: (chunk: Buffer) => void;
  now?: () => number;
  clientFactory?: (opts: FernClientOpts, onEvent: (e: FernEvent) => void) => FernClientLike;
  log?: (m: string) => void;
}

const SIGNAL_EVERY_MS = 250;

export class CbNet implements CbSource {
  private state: "stopped" | "running" | "paused" = "stopped";
  private cfg: CbNetConfig | null = null;
  private client: FernClientLike | null = null;
  private watch: CbWatch | null = null;
  private resampler: Resampler | null = null;
  private lastSignalAt = -Infinity;
  private readonly listeners = new Set<EngineListener>();
  private readonly now: () => number;

  constructor(private readonly deps: CbNetDeps) {
    this.now = deps.now ?? Date.now;
  }

  on(l: EngineListener): void { this.listeners.add(l); }
  off(l: EngineListener): void { this.listeners.delete(l); }

  status(): { connected: boolean; error: string | null } {
    if (this.state === "stopped" || !this.client) return { connected: false, error: null };
    return { connected: this.client.connected, error: this.client.connected ? null : this.client.error };
  }

  start(cfg: CbNetConfig): void {
    if (this.state !== "stopped" && this.cfg && (cfg.url !== this.cfg.url || cfg.band !== this.cfg.band)) this.stop();
    if (this.state === "stopped") {
      this.cfg = cfg;
      this.watch = this.makeWatch(cfg);
      const factory = this.deps.clientFactory ?? ((o, e) => new FernClient(o, e));
      this.client = factory({ url: cfg.url, band: cfg.band, backoffMaxMs: cfg.backoffMaxMs, log: this.deps.log }, (e) => this.onFern(e));
      this.state = "running";
      this.client.start();
      return;
    }
    if (watchKey(cfg) !== watchKey(this.cfg!)) {
      this.apply(this.watch?.closeAll(this.now()) ?? []);
      this.watch = this.makeWatch(cfg);
    }
    this.cfg = cfg;
    this.state = "running";
  }

  pause(): void {
    if (this.state !== "running") return;
    this.apply(this.watch?.closeAll(this.now()) ?? []);
    this.state = "paused";
  }

  stop(): void {
    if (this.state === "stopped") return;
    this.apply(this.watch?.closeAll(this.now()) ?? []);
    this.client?.stop();
    this.client = null;
    this.watch = null;
    this.resampler = null;
    this.state = "stopped";
  }

  private makeWatch(cfg: CbNetConfig): CbWatch {
    return new CbWatch(
      cfg.channels.map((c) => ({
        n: Number(c.id.slice(3)), freq: c.freq,
        priority: cfg.priority.includes(Number(c.id.slice(3))),
        hangMs: c.mode === "lsb" ? cfg.ssbHangMs : cfg.hangMs,
      })),
      { openDb: cfg.openDb, openRows: cfg.openRows, maxOpenMs: cfg.maxOpenMs },
    );
  }

  private channel(n: number): Channel | undefined {
    return this.cfg?.channels.find((c) => c.id === `cb_${n}`);
  }

  private onFern(e: FernEvent): void {
    if (this.state !== "running" || !this.watch) return;
    if (e.type === "row") {
      this.apply(this.watch.row(e, this.now()));
    } else if (e.type === "audio") {
      if (this.watch.audible === null) return;
      if (!this.resampler || this.resampler.inRate !== e.rate) this.resampler = new Resampler(e.rate);
      const y = this.resampler.push(e.samples);
      if (y.length) this.deps.writePcm(toS16le(y));
    } else if (e.type === "meter") {
      const t = this.now();
      if (this.watch.audible === null || t - this.lastSignalAt < SIGNAL_EVERY_MS) return;
      this.lastSignalAt = t;
      this.emit({ type: "signal", dbfs: e.dbfs, ts: t });
    }
  }

  private apply(ts: CbTransition[]): void {
    for (const t of ts) {
      if (t.kind === "open") {
        const ch = this.channel(t.n);
        if (ch) this.emit({ type: "active", channel: ch, freq: ch.freq, ts: t.ts });
      } else if (t.kind === "close") {
        this.emit({ type: "release", channelId: `cb_${t.n}`, ts: t.ts });
        if ((this.watch?.openChannels().length ?? 0) === 0) this.emit({ type: "idle", ts: t.ts });
      } else {
        const ch = t.n === null ? null : this.channel(t.n) ?? null;
        if (ch) this.client?.tune(ch.freq, ch.mode === "lsb" ? "lsb" : "am");
        this.resampler = null;   // fresh stream per channel
        this.emit({ type: "audible", channel: ch, ts: t.ts });
      }
    }
  }

  private emit(e: EngineEvent): void {
    for (const l of this.listeners) l(e);
  }
}

const watchKey = (c: CbNetConfig): string =>
  JSON.stringify([c.channels.map((x) => [x.id, x.mode]), c.priority, c.openDb, c.openRows, c.hangMs, c.ssbHangMs, c.maxOpenMs]);
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/cbNet.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/backend/fernsdr/cbNet.ts test/cbNet.test.ts
git commit -m "feat(fernsdr): CbNet orchestrator — watch, tune, PCM to the helper, engine events

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Server wiring, status, boot

**Files:**
- Create: `src/backend/fernsdr/withEventSource.ts`
- Modify: `src/backend/server.ts`, `src/backend/index.ts`, `docs/API.md` (repo root `../docs/API.md`)
- Test: `test/cbFernsdr.server.test.ts`

**Interfaces:**
- Consumes: `CbSource` (Task 10), `cbNetConfig` (Task 4), `ScannerEngine.writePcm` (Task 5).
- Produces:
  - `ServerDeps.cb?: CbSource`
  - `function withEventSource(engine: ScannerEngine, extra?: Pick<CbSource, "on" | "off">): ScannerEngine`
  - `/api/status` adds `cb: { connected: boolean; error: string | null } | null` (null when no CbSource is wired); in CB mode `scanCount` = watched CB channel count.

- [ ] **Step 1: Write the failing test** — `test/cbFernsdr.server.test.ts`

```ts
import { describe, it, expect, afterEach } from "vitest";
import request from "supertest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../src/backend/server.js";
import { ConfigStore } from "../src/backend/config/ConfigStore.js";
import { ActivityLog } from "../src/backend/activityLog.js";
import { WsHub } from "../src/backend/ws.js";
import { FakeEngine } from "../src/backend/engine/FakeEngine.js";
import type { CbSource } from "../src/backend/fernsdr/cbNet.js";
import type { EngineListener } from "../src/backend/engine/ScannerEngine.js";

const TOR = "EAS: ZCZC-WXR-TOR-029047+0030-1561800-KEAX/NWS-";
const EOM = "EAS: NNNN";

class FakeCb implements CbSource {
  calls: string[] = [];
  connected = false;
  error: string | null = "connect ECONNREFUSED";
  listeners = new Set<EngineListener>();
  start() { this.calls.push("start"); }
  pause() { this.calls.push("pause"); }
  stop() { this.calls.push("stop"); }
  status() { return { connected: this.connected, error: this.error }; }
  on(l: EngineListener) { this.listeners.add(l); }
  off(l: EngineListener) { this.listeners.delete(l); }
  emit(e: Parameters<EngineListener>[0]) { for (const l of this.listeners) l(e); }
}

let dir: string;
function makeApp() {
  dir = mkdtempSync(join(tmpdir(), "ksrv-cbnet-"));
  const configStore = new ConfigStore(join(dir, "config.json"));
  const engine = new FakeEngine();
  const cb = new FakeCb();
  const history = { recorded: [] as any[], record(r: any) { this.recorded.push(r); return 1; }, release() {}, query: () => [], heardFreqs: () => [], sites: () => [], stats: () => ({}), deleteAlert() {}, clearAlerts() {} } as any;
  const { server } = createServer({ configStore, engine, cb, history, activityLog: new ActivityLog(100), wsHub: new WsHub(), staticDir: dir });
  return { server, engine, cb, history, configStore };
}
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

describe("CB via FernSDR — server", () => {
  it("entering CB starts the source and parks the engine on pcmIn; leaving stops it", async () => {
    const { server, engine, cb } = makeApp();
    await request(server).post("/api/mode").send({ mode: "cb" }).expect(200);
    expect(cb.calls.at(-1)).toBe("start");
    expect(engine.lastConfig?.pcmIn).toBe(true);
    await request(server).post("/api/mode").send({ mode: "scan" }).expect(200);
    expect(cb.calls.at(-1)).toBe("stop");
    expect(engine.lastConfig?.pcmIn).toBe(false);
  });

  it("status reports the receiver and the watched channel count", async () => {
    const { server } = makeApp();
    await request(server).post("/api/mode").send({ mode: "cb" }).expect(200);
    const s = await request(server).get("/api/status").expect(200);
    expect(s.body.cb).toEqual({ connected: false, error: "connect ECONNREFUSED" });
    expect(s.body.scanCount).toBe(40);
  });

  it("CB events reach history like engine events", async () => {
    const { server, cb, history } = makeApp();
    await request(server).post("/api/mode").send({ mode: "cb" }).expect(200);
    cb.emit({ type: "active", channel: { id: "cb_19", freq: 27185000, alphaTag: "CB 19 · Highway", mode: "am", enabled: true, tags: ["cb"] }, freq: 27185000, ts: Date.now() });
    expect(history.recorded.some((r: any) => r.channelId === "cb_19")).toBe(true);
  });

  it("a break-in from CB pauses the source and resumes it after EOM", async () => {
    const { server, engine, cb, configStore } = makeApp();
    configStore.save({ ...configStore.load(), weatherChannel: { id: "wx_1", freq: 162550000, alphaTag: "NOAA", mode: "nfm", enabled: true } });
    // (if createServer reads config once at construction, build the app after saving instead)
    await request(server).post("/api/mode").send({ mode: "cb" }).expect(200);
    engine.emit({ type: "same", raw: TOR, ts: Date.now() });
    await new Promise((r) => setTimeout(r, 20));
    expect(cb.calls.at(-1)).toBe("pause");
    expect(engine.lastConfig?.pcmIn).toBe(false);
    engine.emit({ type: "same", raw: EOM, ts: Date.now() });
    // EOM_GRACE_MS is 8 s: use fake timers as test/cbMode.test.ts's break-in test does.
  });

  it("an operator mode change during a CB break-in ends stopped, not paused", async () => {
    const { server, engine, cb } = makeApp();
    await request(server).post("/api/mode").send({ mode: "cb" }).expect(200);
    engine.emit({ type: "same", raw: TOR, ts: Date.now() });
    await request(server).post("/api/mode").send({ mode: "scan" }).expect(200);
    expect(cb.calls.at(-1)).toBe("stop");
  });
});
```

Before running, open `test/cbMode.test.ts` `describe("SAME break-in from CB mode")` and copy its exact setup (how it configures the weather channel, alert FIPS, fake timers, and how it reads the engine's last config — `FakeEngine` may name it differently than `lastConfig`; use the real name) into the two break-in tests above, completing the EOM test with `vi.advanceTimersByTime(8_100)` then `expect(cb.calls.at(-1)).toBe("start")` and `expect(engine.<lastConfig>?.pcmIn).toBe(true)`. Same for the history fake: match `ServerDeps["history"]`.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/cbFernsdr.server.test.ts`
Expected: FAIL — `cb` not in ServerDeps / `status.cb` undefined.

- [ ] **Step 3: Implement**

`src/backend/fernsdr/withEventSource.ts`:

```ts
// Merge a second event source (CbNet) into the engine the server listens
// to, so every engine.on(...) consumer — history, WS, glass, alerts — sees
// CB events without knowing where they came from.
import type { ScannerEngine, EngineListener } from "../engine/ScannerEngine.js";

export function withEventSource(engine: ScannerEngine, extra?: { on(l: EngineListener): void; off(l: EngineListener): void }): ScannerEngine {
  if (!extra) return engine;
  return new Proxy(engine, {
    get(target, prop) {
      if (prop === "on") return (l: EngineListener) => { target.on(l); extra.on(l); };
      if (prop === "off") return (l: EngineListener) => { target.off(l); extra.off(l); };
      const v = Reflect.get(target, prop, target);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}
```

`src/backend/server.ts`:
- Imports: `import type { CbSource } from "./fernsdr/cbNet.js";`, `import { withEventSource } from "./fernsdr/withEventSource.js";`, add `cbNetConfig` to the `./config/cb.js` import.
- `ServerDeps`: `/** CB via FernSDR (spec 2026-10-15-cb-fernsdr). Absent = CB mode parks silent. */ cb?: CbSource;`
- Line 213: change `const { configStore, engine, activityLog, staticDir } = deps;` to

```ts
  const { configStore, activityLog, staticDir } = deps;
  const engine = withEventSource(deps.engine, deps.cb);
```

- Replace `switchMode` with:

```ts
  const switchMode = (cfg: ScanConfig): Promise<void> => {
    const p = engine.retune ? engine.retune(cfg) : engine.stop().then(() => engine.start(cfg));
    syncCb();
    return p;
  };
  // CB via FernSDR follows the mode: listening in CB, held open (paused)
  // only while a SAME break-in that interrupted CB is playing, otherwise off.
  function syncCb(): void {
    if (!deps.cb) return;
    if (mode === "cb") deps.cb.start(cbNetConfig(config));
    else if (mode === "weather" && breakIn && breakInFrom === "cb") deps.cb.pause();
    else deps.cb.stop();
  }
```

(`syncCb` is a hoisted function declaration; `breakIn` / `breakInFrom` are declared with `let` above `switchMode` at lines ~539–541 — confirm; if declared later, move `syncCb`'s body to read them at call time, which it already does.)
- In the PUT `/api/config` handler, after the `if (scanChanged) {...} else {...}` block, add `syncCb(); // cb.* edits apply on the live session (start() is idempotent)`.
- `/api/status`: change `scanCount` to

```ts
        scanCount: mode === "cb"
          ? cbNetConfig(config).channels.length
          : toScanConfig(config, mode, monitorChannel).channels.length,
```

and add after `breakIn,`:

```ts
        // CB via FernSDR: is the receiver session up? null when not wired.
        cb: deps.cb ? deps.cb.status() : null,
```

`src/backend/index.ts`: after the scanner `engine` is constructed:

```ts
// CB via FernSDR (spec 2026-10-15-cb-fernsdr): the receiver's audio plays
// through the parked scanner helper's PCM-in pipe.
const cb = engine instanceof WidebandEngine
  ? new CbNet({ writePcm: (chunk) => engine.writePcm(chunk), log: (m) => console.log(m) })
  : undefined;
```

and pass `cb` into the `createServer({...})` call. Import `CbNet` from `./fernsdr/cbNet.js`.

`docs/API.md` (repo root): in the `GET /api/status` section, document `cb: {connected, error} | null` ("CB via FernSDR receiver session; null when the backend has no CB source") and that `scanCount` in CB mode is the watched CB channel count.

- [ ] **Step 4: Run tests + typecheck + full suite**

Run: `npx vitest run test/cbFernsdr.server.test.ts test/cbMode.test.ts && npm run typecheck && npm test`
Expected: PASS everywhere.

- [ ] **Step 5: Commit**

```bash
git add src test ../docs/API.md
git commit -m "feat(cb): wire CbNet into the server — mode sync, break-in pause, /api/status.cb

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Frontend — offline state and the channel's mode

**Files:**
- Modify: `src/frontend/lib/api.ts`, `src/frontend/dashboard/cbView.ts`, `src/frontend/dashboard/dashboard.ts`, `src/frontend/admin/live.ts`, `src/frontend/admin/liveStore.ts` (only if `withStatus` lives there)
- Test: `test/cbView.test.ts`, `test/admin.live.test.ts`

**Interfaces:**
- Consumes: `/api/status.cb` (Task 11).
- Produces: `CbViewInput.offline?: string | null`, `CbViewInput.liveMode?: string | null`; `LiveState.cbOffline: string | null`.

- [ ] **Step 1: Write the failing tests**

Append to `test/cbView.test.ts` (reuse the file's existing base-input helper; call it `base` here):

```ts
  it("receiver offline shows in the readout (engine errors still win)", () => {
    const v = cbView({ ...base, offline: "connect ECONNREFUSED 192.168.1.30:8073" });
    expect(v.readout).toMatchObject({ state: "error", meta: "Receiver offline" });
    expect(cbView({ ...base, offline: "x", error: "kerchunk-dsp: boom" }).readout.meta).toBe("Radio error");
  });
  it("the live meta names the channel's mode", () => {
    const v = cbView({ ...base, liveFreq: 27_385_000, liveMode: "lsb" });
    expect(v.readout.meta).toBe("CB · LSB · Live");
    expect(cbView({ ...base, liveFreq: 27_185_000 }).readout.meta).toBe("CB · AM · Live");
  });
```

Append to `test/admin.live.test.ts` (reuse its LiveState fixture; call it `s`):

```ts
  it("CB mode with the receiver offline says so", () => {
    expect(lcdView({ ...s, mode: "cb", nowPlaying: null, cbOffline: "connect ECONNREFUSED" })).toMatchObject({ meta: "CB only", name: "Receiver offline" });
  });
```

- [ ] **Step 2: Run to verify failures**

Run: `npx vitest run test/cbView.test.ts test/admin.live.test.ts`
Expected: FAIL (type errors / wrong meta).

- [ ] **Step 3: Implement**

`src/frontend/lib/api.ts` `getStatus` type: add `cb?: { connected: boolean; error: string | null } | null`.

`src/frontend/dashboard/cbView.ts`: add `offline?: string | null; liveMode?: string | null;` to `CbViewInput`; in `cbView`:

```ts
  if (i.error) {
    readout = { state: "error", meta: "Radio error", metaRight: "", num: "", name: friendlyError(i.error), freq: "" };
  } else if (i.offline) {
    readout = { state: "error", meta: "Receiver offline", metaRight: "", num: "", name: "Retrying the CB receiver", freq: "" };
  } else if (liveN !== null) {
    readout = { state: "live", meta: `CB · ${(i.liveMode ?? "am").toUpperCase()} · Live`, metaRight: i.muted ? "Muted" : "", num: String(liveN), name: name(liveN), freq: fmtFreq(freqOf(liveN)) };
```

(rest unchanged; `listening` text stays `CB only · Listening on N channels`).

`src/frontend/dashboard/dashboard.ts`: keep `let cbOffline: string | null = null;` set in `paintStatus` from `s.cb && !s.cb.connected ? (s.cb.error ?? "offline") : null` (include it in the `changed` comparison), and pass `offline: cbOffline, liveMode: state.nowPlaying?.mode ?? null` into the `cbView({...})` call (find it with `grep -n "cbView(" src/frontend/dashboard/dashboard.ts`; `state.nowPlaying` is the channel from the `audible` reducer — confirm it carries `mode`).

`src/frontend/admin/live.ts`: add `cbOffline: string | null` to `LiveState` (initial `null`), set it in `withStatus` from `st.cb && !st.cb.connected ? (st.cb.error ?? "offline") : null`, and in `lcdView`'s CB branch use `name: s.cbOffline ? "Receiver offline" : "Listening to CB…"` for the idle case.

- [ ] **Step 4: Run tests, typecheck, frontend build**

Run: `npx vitest run test/cbView.test.ts test/admin.live.test.ts test/dashboard.cornerView.test.ts && npm run typecheck && npm run build:frontend`
Expected: PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add src test
git commit -m "feat(cb): wall + admin show the receiver offline and the live channel's mode

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: Docs, definition of done, hardware proof, PR

**Files:**
- Modify: `CLAUDE.md` (repo root), `docs/ROADMAP.md`

- [ ] **Step 1: Update CLAUDE.md**

In "Conventions that bite": delete `config.scan.nativeSsbGainDb (--ssb-gain-db, the LSB pre-gain into the AGC),`. In "Architecture notes", replace the **CB mode** bullet with:

```markdown
- **CB mode** (`POST /api/mode {mode:"cb"}`, spec 2026-10-15-cb-fernsdr): listens through
  the operator's FernSDR receiver (Airspy HF+ on the LAN, `config.cb.fernsdr.url`, band
  `cb-radio`) — never the RTL-SDRs, never in the scan rotation or on the map. Node
  (`src/backend/fernsdr/`) decodes plain NAC audio + WFC waterfall rows, `cbWatch` picks the
  channel (all 40 at once; `cb.priority` 6/9/19 pre-empt; `cb.fernsdr.openDb` / `openRows` /
  `hangMs` / `maxOpenMs`, LSB hang `cb.ssbHangMs`), and the scanner helper — retuned to
  `{channels:[], pcmIn:true}`, never respawned — plays it from `--pcm-in-fd 4` through the
  usual AGC/limiter (`cb.fernsdr.bufferMs` / `maxBufferMs` = `--pcm-target-ms` / `--pcm-max-ms`).
  A break-in from CB pauses the session (socket kept) and retunes the helper to NWR as usual.
  Receiver down → `/api/status.cb.connected:false`, "Receiver offline" on the wall; never
  reconnects after close 4001/4002. LSB channels: `config.cb.modes` (default `{"38":"lsb"}`).
  Kiosk knobs: `display.cb.fadeStepsMin` / `stepTickMs` / `logRows`.
```

In `docs/ROADMAP.md`, add one line under the CB entry: "CB moved to the FernSDR HF receiver (spec 2026-10-15-cb-fernsdr); SDR CB path and native LSB demod removed."

- [ ] **Step 2: Definition of done — run every check**

```bash
npm test
npm run test:native
npm run typecheck
npm run build
```

Expected: all PASS / clean. Record the counts for the PR body.

- [ ] **Step 3: Prove on hardware**

```bash
git -C .. branch --show-current     # must be feat/cb-fernsdr
sudo systemctl restart kerchunk-kiosk
sleep 15
pgrep -f "kerchunk-dsp.*--pcm-in-fd 4" && echo "scanner helper has the pipe"
pgrep -f "kerchunk-dsp" -a | grep -v pcm-in   # the weather helper: no --pcm-in-fd
H=$(pgrep -f "kerchunk-dsp.*--pcm-in-fd 4")
curl -s -XPOST localhost:8080/api/mode -H 'content-type: application/json' -d '{"mode":"cb"}'
sleep 5
curl -s localhost:8080/api/status | grep -o '"cb":{[^}]*}'    # expect "connected":true
[ "$(pgrep -f 'kerchunk-dsp.*--pcm-in-fd 4')" = "$H" ] && echo "no respawn on CB entry"
curl -s http://192.168.1.30:8073/api/status | grep -o '"id":"cb-radio"[^}]*"listeners":[0-9]*'   # our listener counted
journalctl -u kerchunk-kiosk --since "2 min ago" | grep -i fernsdr
```

Then:
1. Listen by ear for a live CB transmission (ask the operator to confirm audio quality vs the old SDR path); check `GET /api/history?tag=cb` shows the hit with a duration.
2. Screenshot the wall: `XDG_RUNTIME_DIR=/run/user/1000 WAYLAND_DISPLAY=wayland-0 grim /tmp/claude-1000/kiosk.png` and Read it — CB stage up, live readout shows `CB · AM · Live` during a hit.
3. Break-in path (real SAME can't be forced): `POST /api/mode {"mode":"weather"}` then `{"mode":"cb"}`; confirm the helper PID is unchanged across both, audio switches NWR ↔ CB, and `/api/status.cb` goes `connected:true` again.
4. Offline: `sudo iptables -I OUTPUT -d 192.168.1.30 -p tcp --dport 8073 -j REJECT`; within ~5 s `/api/status.cb` → `connected:false`, wall shows "Receiver offline"; `sudo iptables -D OUTPUT -d 192.168.1.30 -p tcp --dport 8073 -j REJECT`; confirm it reconnects (backoff ≤ 60 s).
5. Back to scan: `POST /api/mode {"mode":"scan"}`; FernSDR listener count drops by one; scanning resumes with no warm-up overlay.
6. `sensors` / thermal: note package temperature before vs after 10 min in CB mode (parked helper should run cooler than 12-lane CB).

Report each result honestly in the PR body; anything not verified (e.g. no CB traffic heard) is flagged as owed.

- [ ] **Step 4: Commit docs, push, open the PR**

```bash
git add ../CLAUDE.md ../docs/ROADMAP.md
git commit -m "docs: CB via FernSDR

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push -u origin feat/cb-fernsdr
gh pr create --title "CB mode via the FernSDR HF receiver" --body "$(cat <<'EOF'
## What
CB mode now listens through the FernSDR receiver (Airspy HF+) on the LAN instead of the RTL-SDR.
Spec: docs/superpowers/specs/2026-10-15-cb-fernsdr-design.md · Plan: docs/superpowers/plans/2026-10-15-cb-fernsdr.md

- Node FernSDR client (plain NAC + WFC decoders, verified against the upstream reference on live frames)
- cbWatch: all 40 channels from the waterfall, priority 6/9/19, carrier cap
- kerchunk-dsp `--pcm-in-fd`: parked helper plays the receiver audio through the existing AGC/limiter; CB entry/exit and break-ins stay retunes
- `/api/status.cb` (additive); wall/admin "Receiver offline"
- Removed: SDR CB path, native LSB demod, `scan.nativeSsbGainDb`, `cb.ssbOpenDb`

## Knobs
`config.cb.fernsdr.{url,band,openDb,openRows,hangMs,maxOpenMs,bufferMs,maxBufferMs,backoffMaxMs}`, `config.cb.priority`, `config.cb.ssbHangMs`, `config.cb.modes`, `config.cb.channels`.

## Verification
(fill in: npm test / test:native / typecheck / build results, and each hardware step from Task 13 Step 3)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

After the operator approves and it merges: `gh pr merge <n> --merge --delete-branch && git checkout main && git pull --ff-only && git fetch --prune && git branch -d feat/cb-fernsdr`.
