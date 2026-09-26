# Deploying Kerchunk Kiosk

## CI

`.github/workflows/ci.yml` runs typecheck + tests + build on every pull
request and every push to `main`, on GitHub-hosted Linux. It never touches the
appliance.

## Deploy on the appliance (the real flow)

The appliance runs the backend straight from this repo checkout, so a deploy
is a pull + build + service restart:

```sh
git pull && (cd kiosk && npm run build) && sudo systemctl restart kerchunk-kiosk
```

**Only restart the service for backend changes** — every restart respawns the
GNU Radio helper (~2.7 cores of flowgraph rebuild), spikes thermals, and
interrupts live audio. For a frontend-only change:

```sh
cd kiosk
npm run build                     # vite does NOT typecheck; the full build does
curl -X POST localhost:8080/api/kiosk/reload
```

Two services: `kerchunk-kiosk` (backend) and `kerchunk-display` (the chromium
wall session). A wedged/stale wall page is fixed with
`sudo systemctl restart kerchunk-display` — don't bounce the backend for it.

## Native engine (kerchunk-dsp)

`WidebandEngine` has a second mode: instead of spawning GNU Radio's
`wideband_helper.py`, it spawns `kerchunk-dsp`, a standalone C++ DSP helper
(`kiosk/native/`) built with cmake. It's the GR replacement under A/B —
same `ScannerEngine` interface, same config, selected by an env var.

**Build deps** (apt): `cmake libfftw3-dev nlohmann-json3-dev libasound2-dev
librtlsdr-dev`.

`npm run build` now builds `kerchunk-dsp` (cmake, `--parallel 2`) and copies
it to `dist/backend/engine/` alongside the existing JS build — no separate
step needed, but it's a real C++ compile, not just `tsc`/`vite`: a thermal
cost like any other build.

**Switch to native:**

```sh
sudo systemctl edit kerchunk-kiosk
```

Add under `[Service]`:

```
Environment=KERCHUNK_ENGINE=native
```

Then:

```sh
sudo systemctl restart kerchunk-kiosk
```

**Before switching, snapshot the per-channel trims** — each engine persists
levels the other loads, so switching without a snapshot risks losing the
current engine's tuning. With `kerchunk-kiosk` stopped (hand-edit rule):

```sh
sudo cp /var/lib/kerchunk-kiosk/config.json /var/lib/kerchunk-kiosk/config.pre-native.json
```

**Rollback:** remove the drop-in (or set `Environment=KERCHUNK_ENGINE=wideband`)
and restart.

Notes:

- Under native, the weather radio runs its narrow front-end at 250 kHz
  (vs. 240 kHz under GR) — native lanes must land on a multiple of 50 kHz,
  GR's quad-rate front-end on a multiple of 48 kHz.
- The tuning knob is `scan.nativeQuietDb` (native's own dB scale, default −6
  — never mixed with GR's `noiseQuietDb`).

## Legacy: remote Pi deploy

`kiosk/scripts/deploy.sh` and the `.githooks/post-merge` auto-deploy hook are
from the earlier remote-Pi era: they SSH to a Pi (`KERCHUNK_PI_HOST`, default
`admin@192.168.1.54`), reset its clone to `origin/main`, build, install to
`/opt/kerchunk-kiosk`, and restart the services. `scripts/setup-pi.sh` at the
repo root is the matching Pi-era bench bootstrap. None of these are active on
the appliance (`core.hooksPath` is unset), and no Pi target currently exists —
they're kept for a possible future Pi-class install.
