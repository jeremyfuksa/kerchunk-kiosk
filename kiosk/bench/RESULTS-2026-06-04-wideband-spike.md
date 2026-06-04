# Wideband spike results — 2026-06-04

Per the gate in `docs/superpowers/specs/2026-06-03-wideband-scanner-design.md`:
prove GNU Radio + SoapySDR streams audio + per-channel detection on the
appliance before writing the implementation plan.

## Platform (changed from spec)

The appliance runs **Ubuntu 26.04 LTS**, not Fedora as the spec assumed —
same MacBook Pro hardware (i7-4770HQ, 4c/8t @ 2.2 GHz, 16 GB RAM). Ubuntu is
apt-based like the original Pi scripts, so packaging is *closer* to the
existing `setup-kiosk-pi.sh` than the spec's `dnf` path.

- Toolchain: `apt install rtl-sdr soapysdr-tools soapysdr-module-rtlsdr gnuradio`
  → GNU Radio **3.10.12.0** with `gr-soapy` built in. No source builds.
- GNU Radio's Python lives in **system python** (`/usr/bin/python3`,
  dist-packages). mise's python does NOT see it — the DSP helper must be
  invoked as `/usr/bin/python3`.
- Audio: **no PipeWire/PulseAudio** on this install — raw ALSA, exactly like
  the Pi. Existing sink-string code ports unchanged. Built-in analog out is
  `plughw:1,0` (CS4208); HDMI is card 0. Test tone + live demod audio
  confirmed audible by the operator.
- Dongle: RTL2838/R820T detected. Kernel `dvb_usb_rtl28xxu` grabs it on plug,
  but librtlsdr detaches it automatically; add a modprobe blacklist in the
  setup script for the appliance anyway.

## Spike 1: multi-channel window demod (`bench/wideband-spike.py`)

One soapy source, 2.4 MS/s window centered on the 7 NOAA WX channels
(162.400–162.550, all in one window, always transmitting). 7 freq-xlating
FIR channelizers + per-channel power probes; one channel NBFM-demodulated to
ALSA.

- **Per-channel detection: PASS.** Two simultaneous stations clearly
  distinguished above noise floor — 162.550 (KID77) at **+0.7 dB**, 162.400 at
  **−16 dB**, the other five at the −26…−31 dB floor. Simultaneous-transmission
  detection from one window confirmed.
- **Live audio: PASS.** NBFM demod of 162.550 played through `plughw:1,0`.
- **CPU: 169% of one core** (≈21% of the 8-thread machine) for 7 naive
  channelizers with tight 4 kHz transition filters. The real engine needs
  ≤4 channels/group and can use a PFB channelizer — ample headroom.

## Spike 2: retune without restart (`/tmp/retune-test.py`)

Open question #2 in the spec: can the group-hop retune the front-end without
killing the flowgraph?

- **PASS.** `soapy.source.set_frequency()` on the *running* flowgraph hopped
  WX (162) → VHF (146.8) → UHF (464.3) and back, 6 hops, samples flowing
  continuously, **zero device re-opens**. This eliminates the USB-thrash
  failure class entirely: the device is opened once at engine start and
  never re-opened, even across groups.

## Consequences for the implementation plan

1. DSP helper = GNU Radio **Python** flowgraph (spec's leaning, confirmed —
   CPU overhead is irrelevant on this machine), spawned as `/usr/bin/python3`.
2. Group-hop = `set_frequency` on the running source + reconfigure
   channel offsets — no process restart, no device re-open. The spec's
   "tear down the I/Q chain per group" fallback is unnecessary.
3. Setup script: new `setup-kiosk-ubuntu.sh` (or parameterized) — apt
   packages above + modprobe blacklist + ALSA sink default `plughw:1,0`.
4. Remaining gate item (not yet done): closed-lid HDMI kiosk display
   (`HandleLidSwitch=ignore`, compositor on HDMI output) — display porting,
   independent of the engine.
