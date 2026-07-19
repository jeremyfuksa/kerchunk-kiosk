# Kerchunk Kiosk

A software-defined radio scanner appliance. A repurposed laptop running Ubuntu,
an RTL-SDR dongle, and GNU Radio monitor **every channel in a 2 MHz window
simultaneously** — no scan latency, no missed bursts inside a band group — and
boot lid-closed straight into a fullscreen dashboard on an external monitor.

**v1.0 (MVP)** — live on hardware, operator-verified end to end.

## What it does

- **Wideband engine**: one persistent GNU Radio flowgraph samples a 2.4 MS/s
  I/Q window and demodulates up to 12 channels at once; the SDR is opened once
  per boot and retuned live between band groups (group-hop) — the USB
  re-open thrash that kills `rtl_fm`-style scanners is structurally gone.
- **Real squelch**: per-channel power over an adaptive group noise floor AND
  FM quieting detection (power without a quieted carrier never opens — rejects
  spurs, AGC pumping, data bursts). ~30 ms audio gate with fade ramps, hard
  limiter, per-channel loudness leveler.
- **Close Call**: an FFT watches the whole tuned window for strong
  transmissions on non-configured frequencies; discoveries preempt the
  speaker, get identified against RepeaterBook / RadioReference, and are filed
  as disabled channels for review. Skip key + permanent lockouts.
- **Priority channels** (preempt within a group), **weather-only mode**
  (squelch-free NOAA hold), **SKIP** key, per-channel enable/priority.
- **Kiosk dashboard**: now-playing (true speaker ownership), live signal
  meter, recent-activity log. **Web admin** from any device: inline-editable
  channel table, scan tuning knobs, volume (true dB fader), Close Call
  controls, lockouts.
- **Appliance**: systemd-managed, boots lid-closed to the dashboard on HDMI,
  never sleeps, survives ALSA device-order races, audio settings persist.

## Hardware

| Part | Notes |
|---|---|
| x86 laptop | Built-in UPS (battery); this build: 2014 MacBook Pro, Ubuntu 26.04 |
| RTL-SDR (RTL2832U + R820T) | ~2.4 MHz usable window, 24–1766 MHz |
| External monitor | Laptop runs lid-closed; internal panel disabled at boot |

## Setup

On a fresh Ubuntu install, from the repo:

```sh
sudo bash kiosk/scripts/setup-kiosk-ubuntu.sh
sudo reboot
```

Installs the SDR toolchain (GNU Radio + SoapySDR + rtl-sdr via apt),
blacklists the DVB kernel modules, configures the kiosk session (cage + snap
Chromium on tty1, lid ignored, sleep masked, internal panel off), seeds a
NOAA config, and enables the systemd units. After reboot: dashboard on the
monitor, admin at `http://<host>:8080/admin`.

Deploying changes: `git pull && (cd kiosk && npm run build) && sudo systemctl
restart kerchunk-kiosk`.

## Layout

- [`kiosk/`](kiosk/) — the application (TypeScript backend + frontends, GNU
  Radio DSP helper, systemd units, setup scripts, tests)
- [`docs/superpowers/specs/`](docs/superpowers/specs/) — design specs
  (wideband engine, Close Call, …)
- [`docs/Kerchunk Vision.md`](docs/Kerchunk%20Vision.md) — the original
  pocket-scanner vision this project pivoted from
- [`docs/Kerchunk Go Feasibility.md`](docs/Kerchunk%20Go%20Feasibility.md) —
  hardware feasibility study for the tiny in-car scanner (ESP32 vs Pi-class
  vs ESP32-P4 tracks, power/thermal budgets, sprint plans)
- [`bench/`](bench/), [`kiosk/bench/`](kiosk/bench/) — feasibility-spike
  protocols and measured results

## Development

```sh
cd kiosk
npm install
npm test                 # vitest, no hardware needed (fake engine/helper)
USE_FAKE_ENGINE=1 KERCHUNK_CONFIG=/tmp/kc.json npm run dev:backend
npm run dev:frontend     # vite dev server, proxies /api + /ws
```

Engine selection: `KERCHUNK_ENGINE=wideband|rtlfm|fake` (default `wideband`;
`rtlfm` is the sequential fallback for Pi-class hardware without GNU Radio).
The DSP helper requires the SYSTEM python (`/usr/bin/python3`) — GNU Radio's
bindings are not visible to pyenv/mise interpreters.

## Post-MVP backlog

Much of the original backlog has shipped: Close Call band-sweep
(`scan.sweepRanges`), AM demod, multi-SDR (a dedicated low-rate NOAA/SAME
weather receiver), remote audio streaming, opt-in transcription. The
polyphase channelizer was evaluated and declined (DSP-rewrite risk with no
driving need). Still open: RepeaterBook API token (pending approval), ADS-B
on a third SDR, further ambient/art skins, per-bank gain, trunking (P25).
The live backlog is [`docs/ROADMAP.md`](docs/ROADMAP.md).
