# Native DSP P1c — live hardware results — 2026-09-26

The operator OK'd the outage for this first live run of `kerchunk-dsp` (native C++ helper, branch
`feat/native-dsp-live`, head ade9bc7 at test time). The scanner service was stopped, both helpers
were run by hand against the real dongles and sound card, and then the service was restarted. Outage
was about 3.5 min; the service came back healthy.

## Scanner — KIOSK01

Setup: `--rtl-serial KIOSK01 --sink plughw:CARD=PCH,DEV=0 --close-call --audio-fd 3`, 2.4 Msps.
The helper started on the 2 m 11-channel group (60 s), then was retuned live to a 7-channel GMRS
window (30 s).

| Metric | native (P1c) | GNU Radio baseline |
|---|---|---|
| Process CPU (50 s) | **44 %** of one core | 223–234 % |
| Threads | **7** | 285 |
| Context switches | **~1 115 /s** | ~130 000 /s |
| Package temp | **68 → 60 °C** (falling during the run) | ~82–84 °C |

Per-thread CPU over 10 s:

| Thread | CPU |
|---|---|
| DSP/main | 38.2 % |
| ALSA writer | 3.0 % |
| event / tee / other | ~1 % |
| libusb | 0 % |

- **IQ drops:** 0.
- **Events:** power 443, closecall 8, open 6, tuned 2, audible 2, close 2, ready 1.
- **Both tunes applied.** One was the initial 2 m tune; the other was the live retune to GMRS.
- **2 m was quiet** during the test, so there were no opens on 2 m. All opens came from the GMRS window.
- **Close Call** fired on 461.5–462.0 MHz business frequencies in the GMRS window. These hits were expected: the hand-written test tune passed an empty `knownHz`. The real config lists those frequencies, so they would be suppressed in production.

## Weather — KIOSK03

Setup: `--rtl-serial KIOSK03 --rate 250000 --same-enable --sink none`, run at nice 19 for 20 s.

- **CPU:** 16 %, 7 threads, ~1 016 context switches/s.
- **multimon-ng:** the child process was running.
- **NWR carrier:** power −1.0 dB, quieting −35.3 dB (strongly quieted).
- **SAME:** no traffic on air, and none was expected.

## SIGTERM exit latency — bug, fixed

**Measured:** 24 987 ms from SIGTERM to exit. The helper only exited once the parent closed stdin.

**Cause:** the stdin reader is a detached thread, parked inside a blocking `std::getline(std::cin)`
and holding stdin's stream lock.
- `run_live` finished its teardown and returned.
- `main` then returned, which runs `exit()`.
- `exit()`'s stdio cleanup waits on that lock until EOF.

**Fix** (app/main.cpp): the live path no longer returns through `exit()`. `main` calls `run_live`
(which does all teardown), then `fflush(stdout)`, `fflush(stderr)`, `std::_Exit(rc)`. This also
covers the early-return paths during init, because the reader starts before the device opens. The
replay path is unchanged.

**Repro, no hardware:** a standalone program starts a detached thread blocked in
`std::getline(std::cin)`, sleeps 100 ms, then either returns from `main` or calls `_Exit`. It was run
as `sleep 5 | ./repro <mode>`, timing only the program:

| Mode | Time to exit |
|---|---|
| `return` from main | **5 005 ms** (held until the pipe's writer exited, i.e. EOF) |
| `fflush` + `_Exit` | **108 ms** (the program's own 100 ms sleep) |

The fixed binary has not yet been re-timed against SIGTERM on hardware. Check it at the next
scheduled live run.

## Observations / follow-ups

- **Live CPU vs replay.** The live DSP thread measured 38 %. In replay, real-time processing costs
  about 15 %. Likely cause: CPU frequency scaling at low duty (schedutil keeps clocks down, so the
  same work reads as more CPU %). This fits the temperature falling during the run. Worth
  confirming with a fixed governor, or with per-cycle counts rather than CPU %.
- **Parked lane slots.** The channelizer runs IFFTs for all 12 lane slots even when slots are
  parked. This explains the weather helper's 16 % at 250 kHz with a single useful lane. Follow-up:
  skip parked slots.
- **"PLL not locked!"** The R820T driver prints this once at open. It comes from librtlsdr, is
  harmless, and is also seen with GNU Radio.
