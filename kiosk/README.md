# Kerchunk Kiosk — application

The scanner application: TypeScript backend (engine control, HTTP/WS API,
config), kiosk dashboard + web admin frontends, and the C++ DSP helper
`kerchunk-dsp` (`native/`, built by `npm run build`). The default **wideband engine**
demodulates every channel in a ~2.4 MHz window simultaneously behind the
`ScannerEngine` interface; the original sequential `rtl_fm` engine remains as
`KERCHUNK_ENGINE=rtlfm` for Pi-class hardware.

Specs live in [../docs/superpowers/specs/](../docs/superpowers/specs/) —
start with the wideband engine (2026-06-03) and Close Call (2026-06-05).

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
cd kiosk && npm test      # vitest (fake engine/helper, no hardware)
npm run test:native       # C++ DSP unit tests
```

## Deploy

The appliance is set up once with `sudo bash scripts/setup-kiosk-ubuntu.sh`
(see the [root README](../README.md)). After that, deploying a change is
`git pull && npm run build && sudo systemctl restart kerchunk-kiosk` — but
only restart for backend changes; see [../docs/DEPLOY.md](../docs/DEPLOY.md)
for the frontend-only reload path and the restart-cost caveats.

## Squelch tuning

Squelch is per-channel power over an adaptive group noise floor **and** FM
quieting detection, with fade ramps, a speaker AGC/compressor that levels
every transmission, and a peak limiter. The defaults (thresholds, hang times,
fade/AGC/limiter constants) live in `native/src/constants.hpp`; the operator
knobs are `scan.openAboveFloorDb`, `scan.nativeQuietDb` (quieting, default −7
on the helper's own dB scale; lower = stricter), `scan.nativeAmGainDb`, and
the `audio.agc*` / `audio.limiter*` loudness knobs (see
[`docs/DEPLOY.md`](../docs/DEPLOY.md)) in config.
