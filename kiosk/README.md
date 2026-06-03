# Kerchunk Kiosk

A Pi 4 + HD-display sibling to the headless pocket Kerchunk. Output-only
dashboard on the attached screen, HDMI audio, web admin from any device. v1 drives
`rtl_fm` one channel at a time and detects activity from PCM audio energy (a
hardware capture showed this `rtl_fm` build emits no usable per-channel stderr),
hopping the channel list itself; the radio sits behind a `ScannerEngine`
interface so a future parallel engine drops in cleanly.

See [the design spec](../docs/superpowers/specs/2026-06-02-kerchunk-kiosk-design.md).

## Develop on a Mac/PC (no dongle)

```sh
cd kiosk
npm install
# Terminal 1 — backend with the fake engine (no hardware needed):
USE_FAKE_ENGINE=1 KERCHUNK_CONFIG=/tmp/kc.json npm run dev:backend
# Terminal 2 — frontend dev server (proxies /api and /ws to :8080):
npm run dev:frontend
```

Open the Vite URL; `/` is the dashboard, `/admin` is the admin.

## Test

```sh
cd kiosk && npm test
```

## Deploy to a Pi 4

```sh
git clone <repo> && cd kerchunk-kiosk/kiosk
./scripts/setup-kiosk.sh   # installs deps, builds, installs services
```

Then browse to `http://<pi-ip>:8080/admin` to add channels.

## Known v1 limitations

- **Audio device is hardwired.** `aplay` plays to the default PCM device and
  `amixer` controls card 0 / `Master`. The `audio.sink` config field is recorded
  but not yet routed to a specific device. On a Pi where HDMI is not card 0,
  set the default ALSA device system-wide (e.g. via `/etc/asound.conf`) for now.
- **All channels are demodulated as wide FM** (`rtl_fm -M fm`). The per-channel
  `mode` (`nfm`/`am`) is stored but not yet applied — `nfm`/`am` channels will
  sound wrong until per-mode demodulation lands.
- **Squelch is energy-based, not rtl_fm's squelch.** `scan.squelchLevel` is the
  RMS open-threshold and `scan.dwellMs` is the silence hang-time before hopping;
  both are applied at startup. If the dashboard never shows ACTIVE on a channel
  you can hear, lower `squelchLevel`; if noise falsely triggers, raise it.
