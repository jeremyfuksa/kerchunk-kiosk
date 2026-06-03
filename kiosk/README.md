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
