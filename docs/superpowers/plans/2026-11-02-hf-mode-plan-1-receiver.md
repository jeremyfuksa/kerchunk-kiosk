# HF Mode Plan 1: SpyServer Receiver and Proofs — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Get real HF+ IQ from SpyServer into `kerchunk-dsp`, with speaker audio and a carrier survey running together, then prove or disprove the spec's two technical risks on the kiosk.

**Architecture:** A new `SpyServerSource` implements the existing `IqSource` seam and resamples 768 kHz to 750 kHz, because the channelizer only accepts multiples of 50 kHz. A new `CarrierSurvey` runs beside the lanes on the raw window, as `CloseCall` does. No Node, wall or admin changes: this plan is native only and leaves all current modes untouched.

**Tech Stack:** C++17, cmake, FFTW, POSIX sockets, the repo's `check.hpp` test macros.

**Spec:** `docs/superpowers/specs/2026-11-02-hf-mode-design.md`

## Why this is only the first plan

The spec covers several subsystems, and Tasks 4 and 5 can change the design of the rest. Later plans are written after the Task 5 gate:

- **Plan 2:** HF mode in Node: sweep, CB switch, rename, SAME break-in per the Task 5 decision.
- **Plan 3:** Schedule data and reception log, with admin view.
- **Plan 4:** Station first wall stage and inset map.
- **Separate small PR, any time:** active mode survives a restart.

## Global Constraints

- All native work builds and tests on Linux. It can't build on macOS because cmake requires ALSA, so run this on the kiosk (or rely on CI for tests only).
- Server: `sdr://airspy.local:5555` (`192.168.1.30`). `CanControl: 1`, max rate 768 kHz, 660 kHz usable.
- `Channelizer` requires `rate % 50000 == 0` (`native/src/channelizer.cpp:14`). HF rate is **750000**.
- `IqBlock` carries **u8** IQ of at most 10 ms (`native/src/live.hpp:21`).
- The appliance runs about 1 °C under its 90 °C trip. Build with `--parallel 2`. Stop and report if a proof pushes the box near the trip.
- The kiosk is a live radio. Every restart of `kerchunk-kiosk` interrupts audio, so bundle them. Don't add a new helper to the live service in this plan.
- Behaviour knobs are CLI flags here, and they move to config in Plan 2.
- Commit subjects are `type(scope): summary`. Work on a branch, and open the PR after the proofs.

## Review Focus

1. **SpyServer restarts or the Pi reboots mid-stream.** The helper should exit 3 so Node respawns, as an RTL stall does, and never hang silently. *(Task 3 test.)*
2. **A TCP read splits a frame anywhere, including inside a header.** No sample loss or misparse. *(Task 1 test.)*
3. **Server says `CanControl: 0`** (another client holds control). Open fails with a clear error, never a silently wrong window. *(Task 3 test.)*
4. **A huge station in the window.** Survey reports it, and the median floor isn't dragged up by it. *(Task 4 test.)*
5. **The centre spike and window edges.** No false carriers at DC or in the filter skirts. *(Task 4 test.)*

---

### Task 1: SpyServer wire protocol

**Files:**
- Create: `kiosk/native/src/spyserver_protocol.hpp`, `kiosk/native/src/spyserver_protocol.cpp`
- Test: `kiosk/native/test/test_spyserver_protocol.cpp`

**Interfaces:**
- Produces, in namespace `kc::spy`:
  - `std::vector<uint8_t> encode_hello(const std::string& client_id)`
  - `std::vector<uint8_t> encode_setting(uint32_t setting, uint32_t value)`
  - `struct DeviceInfo { uint32_t device_type, serial, max_rate, max_bandwidth, decimation_stages, gain_stages, max_gain_index, min_hz, max_hz, resolution, min_iq_decimation, forced_iq_format; }`
  - `struct ClientSync { uint32_t can_control, gain, device_center, iq_center, fft_center, min_iq_center, max_iq_center; }`
  - `class FrameParser { public: using OnFrame = std::function<void(const FrameHeader&, const uint8_t* body, size_t n)>; void feed(const uint8_t* p, size_t n, const OnFrame& f); bool failed() const; };`
  - Setting constants `STREAMING_MODE=0, STREAMING_ENABLED=1, GAIN=2, IQ_FORMAT=100, IQ_FREQUENCY=101, IQ_DECIMATION=102, IQ_DIGITAL_GAIN=103`; `STREAM_IQ_ONLY=1`, `FORMAT_U8=1`; message types `MSG_DEVICE_INFO=0, MSG_CLIENT_SYNC=1, MSG_UINT8_IQ=100`.

Hello layout and device-info and sync layouts were verified on 2026-11-02. The header is 20 bytes: protocol, msg type, stream type, sequence, body size, little-endian. The sync body measured 40 bytes, so parse the first 28 and ignore the rest. **Setting and IQ constants are from memory of the protocol**: the Task 3 live check confirms them.

- [ ] **Step 1: Write the failing tests**

```cpp
TEST(spy_hello_layout) {
  auto b = kc::spy::encode_hello("kc");
  CHECK(b.size() == 8 + 4 + 2);
  CHECK(u32(b, 0) == 0);            // CMD_HELLO
  CHECK(u32(b, 4) == 6);            // body size
  CHECK(u32(b, 8) == ((2u << 24) | 1700u));
}
TEST(spy_setting_layout) {
  auto b = kc::spy::encode_setting(kc::spy::IQ_FREQUENCY, 7345000);
  CHECK(u32(b, 0) == 2 && u32(b, 4) == 8 && u32(b, 8) == 101 && u32(b, 12) == 7345000);
}
TEST(spy_device_info_matches_measured_server) {
  // Measured 2026-11-02: type 2, max 768000, bandwidth 660000, 8 stages.
  auto d = kc::spy::parse_device_info(fixture_device_info().data(), 48);
  CHECK(d.device_type == 2 && d.max_rate == 768000 && d.max_bandwidth == 660000 && d.decimation_stages == 8);
}
TEST(spy_parser_handles_every_split_point) {
  auto stream = two_frames();               // sync frame + 100-byte IQ frame
  for (size_t cut = 0; cut <= stream.size(); cut++) {
    kc::spy::FrameParser p; std::vector<uint32_t> types; size_t iq = 0;
    auto f = [&](auto& h, auto*, size_t n) { types.push_back(h.msg_type); if (h.msg_type == 100) iq = n; };
    p.feed(stream.data(), cut, f);
    p.feed(stream.data() + cut, stream.size() - cut, f);
    CHECK(types.size() == 2 && types[1] == 100 && iq == 100);
  }
}
TEST(spy_parser_fails_on_absurd_body_size) {
  kc::spy::FrameParser p;
  auto bad = frame_with_body_size(0x7fffffff);
  p.feed(bad.data(), bad.size(), [](auto&, auto*, size_t) {});
  CHECK(p.failed());
}
```

- [ ] **Step 2: Run to verify they fail.** Run from `kiosk/`: `npm run test:native`. Expected: build error, `spyserver_protocol.hpp` not found.

- [ ] **Step 3: Implement** the interfaces above, plus `parse_device_info` and `parse_client_sync`. The parser masks the message type to its low 16 bits (the upper bits carry flags) and caps a body at 2 MiB.

- [ ] **Step 4: Run to verify they pass.** `npm run test:native`. Expected: all tests pass.

- [ ] **Step 5: Commit** `feat(dsp): SpyServer wire protocol parser`

### Task 2: 768 kHz to 750 kHz IQ resampling

**Files:**
- Create: `kiosk/native/src/iq_rate.hpp`, `kiosk/native/src/iq_rate.cpp`
- Test: `kiosk/native/test/test_iq_rate.cpp`

**Interfaces:**
- Consumes: `kc::Resampler` (`native/src/resampler.hpp`), one per rail.
- Produces: `class IqRateConverter { public: IqRateConverter(); size_t push(const uint8_t* iq, size_t nsamples, uint8_t* out, size_t out_cap_samples); void reset(); static constexpr int IN_RATE = 768000, OUT_RATE = 750000; };`

Ratio is up 125, down 128. Use a cutoff of 340 kHz with a 35 kHz transition. That keeps the 660 kHz usable span (±330 kHz) and rejects images above 375 kHz.

- [ ] **Step 1: Write the failing tests**

```cpp
TEST(iq_rate_output_count_is_ratio) { /* push 768000 samples in 7680-sample blocks; total out within ±2 of 750000 */ }
TEST(iq_rate_keeps_tone_at_its_frequency) { /* +200 kHz tone in; FFT of output peaks at +200 kHz ±400 Hz */ }
TEST(iq_rate_passband_edge_within_1db) { /* +330 kHz tone level within 1 dB of the +50 kHz tone level */ }
TEST(iq_rate_no_aliasing_above_nyquist) { /* +380 kHz tone in; output level at least 40 dB below a +50 kHz tone */ }
TEST(iq_rate_reset_clears_history) { /* after reset, silence in (127) gives silence out within ±1 LSB */ }
TEST(iq_rate_cpu_is_realtime) { /* 10 s of IQ converts in under 1 s wall time */ }
```

- [ ] **Step 2: Run to verify they fail.** `npm run test:native`. Expected: build error.

- [ ] **Step 3: Implement.** Convert with `(b - 127.5) / 127.5`, resample each rail, then round and clamp back to u8.

- [ ] **Step 4: Run to verify they pass.** `npm run test:native`. Expected: all pass. If the CPU test fails on the kiosk, stop and report the measured time rather than loosening it.

- [ ] **Step 5: Commit** `feat(dsp): 768k to 750k IQ rate converter`

### Task 3: SpyServerSource and the `--spyserver` flag

**Files:**
- Create: `kiosk/native/src/spyserver_source.hpp`, `kiosk/native/src/spyserver_source.cpp`
- Modify: `kiosk/native/src/live.hpp:31` (add `DeviceSource`), `kiosk/native/src/rtl_source.hpp:15`, `kiosk/native/src/cli.hpp`, `kiosk/native/src/cli.cpp`, `kiosk/native/app/main.cpp` (`run_live`, source creation)
- Test: `kiosk/native/test/test_spyserver_source.cpp`, `kiosk/native/test/test_cli.cpp`

**Interfaces:**
- Consumes: Task 1 and Task 2.
- Produces:
  - `class DeviceSource : public IqSource { public: virtual bool open(std::string& err, const std::function<bool()>& should_stop) = 0; virtual void start() = 0; virtual void stop() = 0; virtual double seconds_since_rx() const = 0; };` `RtlSource` now derives from it, with no behaviour change.
  - `class SpyServerSource : public DeviceSource`, with `struct Options { std::string host; int port; int gain = -1; int digital_gain = 0; };`
  - `Cli`: `std::string spyserver; int spyserver_gain = -1; int spyserver_digital_gain = 0;`
  - CLI: `--spyserver host:port` forces `eng.rate = 750000`, and is rejected together with `--rtl-serial`. Also `--spyserver-gain <n>` and `--spyserver-digital-gain <n>`.
  - `main.cpp` holds a `std::unique_ptr<kc::DeviceSource>` chosen from the CLI. The stall message and exit 3 stay as they are.

Tests use a loopback fake server in the test file, speaking the Task 1 frames.

- [ ] **Step 1: Write the failing tests**

```cpp
TEST(spy_source_handshake_sends_iq_only_u8_768k) { /* fake records settings: STREAMING_MODE=1, IQ_FORMAT=1, IQ_DECIMATION=0, STREAMING_ENABLED=1 */ }
TEST(spy_source_blocks_are_10ms_at_750k) { /* every consumed block has n == 15000 bytes except generation-boundary flushes */ }
TEST(spy_source_set_center_sends_frequency_and_bumps_generation) { /* set_center(7345000) -> IQ_FREQUENCY sent; generation +1; no block mixes generations */ }
TEST(spy_source_open_fails_without_control) { /* fake sync can_control=0 -> open false, err contains "SpyServer: no control" */ }
TEST(spy_source_open_fails_when_unreachable) { /* closed port -> open false, err starts "failed to open SpyServer" */ }
TEST(spy_source_server_drop_stalls_rx) { /* fake closes socket -> seconds_since_rx() grows past STALL_S; stop() returns promptly */ }
TEST(cli_spyserver_sets_rate_and_excludes_rtl) { /* --spyserver h:5555 -> rate 750000; with --rtl-serial -> parse fails */ }
```

- [ ] **Step 2: Run to verify they fail.** `npm run test:native`. Expected: build error.

- [ ] **Step 3: Implement.** One reader thread does blocking socket reads into `FrameParser`, then `IqRateConverter`, then coalesces into the existing SPSC ring of 10 ms `IqBlock`s, as `RtlSource` does. Set `TCP_NODELAY` and a 2 s receive timeout. On a retune, reset the converter, flush the partial block and bump the generation. `RETUNE_SETTLE_MS` in `LiveLoop` still applies.

- [ ] **Step 4: Run to verify they pass.** `npm run test:native`. Expected: all pass, including the existing suite (the `RtlSource` change is behaviour-free).

- [ ] **Step 5: Live check on the kiosk, against the real server, with no audio.** This confirms the from-memory constants. `kerchunk-kiosk` keeps running, because this uses no ALSA and no RTL.

Run from `kiosk/`:
```sh
printf '%s\n' '{"cmd":"tune","centerHz":7350000,"channels":[{"id":"t","freqHz":7345000,"mode":"am"}]}' \
  | (cat; sleep 20) | timeout 20 native/build/kerchunk-dsp --spyserver airspy.local:5555 --sink none --lanes 2
```
Expected: a `ready` event, then `power` events with levels that move, no `dropped` logs and no exit 3. If the server rejects a setting or no IQ arrives, fix the Task 1 constants and add the corrected value to its tests.

- [ ] **Step 6: Commit** `feat(dsp): SpyServer IQ source behind --spyserver`

### Task 4: Carrier survey beside the lanes

**Files:**
- Create: `kiosk/native/src/carrier_survey.hpp`, `kiosk/native/src/carrier_survey.cpp`
- Modify: `kiosk/native/src/engine.hpp`, `kiosk/native/src/engine.cpp:213,243` (next to the `cc_` hooks), `kiosk/native/src/constants.hpp`, `kiosk/native/src/cli.cpp`
- Test: `kiosk/native/test/test_carrier_survey.cpp`

**Interfaces:**
- Produces:
  - `struct Carrier { long long hz; double db_above_floor; };`
  - `class CarrierSurvey { public: explicit CarrierSurvey(int rate); void reset(double center_hz); void push_raw(const cf* x, int n); std::vector<Carrier> take(double min_db, double* floor_db_out); };`
  - `EngineOptions`: `bool survey = false; double survey_db = 10.0;`; CLI `--survey`, `--survey-db <n>`.
  - Event, every `SURVEY_EVERY_S` (5.0): `{"ev":"carriers","center":7350000,"floorDb":-61.2,"carriers":[{"hz":7345000,"db":24.1}]}`.

`take()` averages power over the frames since the last call, finds the floor as the median, and reports local peaks at least `min_db` above it. Results snap to the 5 kHz broadcast raster. It reuses `CC_DC_FRAC` and `CC_EDGE_FRAC` exclusions and plans FFTW in the Engine constructor, like `cc_`. Unlike `CloseCall`, it has no known-frequency list or cooldown, and returns all peaks.

- [ ] **Step 1: Write the failing tests** (with `sig::tone` and `sig::noise` at rate 750000, centre 7350000)

```cpp
TEST(survey_finds_each_tone_on_raster) { /* tones at 7300000, 7345000, 7500000 -> those three hz, and only those */ }
TEST(survey_db_is_relative_to_floor) { /* a tone 24 dB over noise reports 24 ±3 */ }
TEST(survey_big_station_does_not_lift_floor) { /* +60 dB tone: floor within 1 dB of the no-tone floor; a +15 dB tone still found */ }
TEST(survey_ignores_dc_and_edges) { /* tone at centre and at ±0.48*rate -> no carriers */ }
TEST(survey_reset_forgets_previous_window) { /* tone, reset(new centre), noise only -> empty */ }
TEST(engine_lane_audio_and_survey_run_together) {
  /* Engine with survey on, AM channel tuned at +50 kHz, second tone at -100 kHz.
     Speaker PCM is non-silent AND a carriers event lists both frequencies. */
}
```

- [ ] **Step 2: Run to verify they fail.** `npm run test:native`. Expected: build error.

- [ ] **Step 3: Implement** the interfaces above, emitting only when `survey` is on and the engine is tuned.

- [ ] **Step 4: Run to verify they pass.** `npm run test:native`. Expected: all pass. Survey off must leave output byte-identical, so existing tests must pass unchanged.

- [ ] **Step 5: Commit** `feat(dsp): carrier survey event alongside lane audio`

### Task 5: The two proofs (the gate for every later plan)

**Files:**
- Create: `docs/bench/2026-11-hf-proofs.md` with measurements
- Modify: `docs/superpowers/specs/2026-11-02-hf-mode-design.md` (decisions)

Run during a window the operator agrees to. Spike code in this task is throwaway unless the operator keeps it.

- [ ] **Step 1: Proof A, measuring and listening on real IQ.** With `kerchunk-kiosk` stopped, so the helper owns ALSA, run `kerchunk-dsp --spyserver airspy.local:5555 --sink plughw:CARD=PCH,DEV=0 --survey` on an evening band for 60 minutes, playing a survey-picked AM station. Log events to a file, and sample `sensors` every 30 s. Baseline: the same 60-minute temperature reading in normal map mode.

**Pass requires all of:** no exit 3; `dropped` logs under one per 10 minutes; audio that's acceptable by ear; helper core use reported; peak temperature no worse than map mode; surveyed carriers matching what's audible when spot-checked by hand.

Also try 8-bit digital gain values. HF has much wider dynamic range than u8 carries, so record whether weak stations survive beside strong ones. **If u8 fails here, stop and bring this to the operator:** the fix (widening `IqBlock` or the channelizer to s16) is a substantial change.

- [ ] **Step 2: Proof B, SAME break-in audio.** Measure these candidates against the spec's bar of up to about 2 s of silence, no overlay, banner kept:
  - **A, dual source in one helper:** spike a helper holding two prebuilt `Engine`s (2.4 M and 750 k) and one `AlsaSink`, opening KIOSK01 on demand. Measure open-to-audio time; `RtlSource::open` retries for up to `BUSY_RETRY_S` (3 s).
  - **B, weather helper feeds audio:** KIOSK03 is already on NWR. Spike its PCM (`--audio-fd`) into the scanner helper's speaker. It needs no source swap and no KIOSK01, so it may be near zero gap. Check audio quality at 250 kHz and `niceness: 19`, and that the extra demod doesn't load the weather helper. `feat/cb-fernsdr` already has a `--pcm-in-fd` to port.

Also measure on a recorded or test NWR transmission how long the SAME header runs before the voice message, because the operator's acceptance of a 2 s gap rests on that.

- [ ] **Step 3: Record results** in `docs/bench/2026-11-hf-proofs.md`, verbatim numbers included.

- [ ] **Step 4: Update the spec.** Replace constraint 1 and known-problem 5 with the decision. Choose B if it passes, since it's the smaller change and keeps KIOSK01 idle.

- [ ] **Step 5: Run the Definition of Done checks.** From `kiosk/`: `npm test`, `npm run test:native`, `npm run typecheck`, `npm run build`. Expected: all clean. Then restart `kerchunk-kiosk` and confirm normal map-mode audio by ear.

- [ ] **Step 6: Commit, push and open the PR.** `docs(hf): proof results and break-in decision`. Merge per `CLAUDE.md`, then write Plan 2 from the updated spec.
