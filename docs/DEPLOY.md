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

**Build deps** (apt): `cmake pkg-config libfftw3-dev nlohmann-json3-dev
libasound2-dev librtlsdr-dev`.

`npm run build` now builds `kerchunk-dsp` (cmake, `--parallel 2`) and copies
it to `dist/backend/engine/` alongside the existing JS build — no separate
step needed, but it's a real C++ compile, not just `tsc`/`vite`: a thermal
cost like any other build.

### Switch to native

One ordered sequence — the hand-edit rule (config is only ever edited with
the service stopped) applies here too, because **native starts writing
`levelTrimDb`/`rfDb` into the live config on its very first restart**: the
snapshot (step c) has to happen *before* that first native start, with the
service already stopped, or it snapshots nothing new.

```sh
# (a) Pull + build. Check the binary actually rebuilt (mtime) if you're not
#     sure `npm run build` picked up native source changes.
cd /home/kiosk/kerchunk-kiosk && git pull --ff-only && (cd kiosk && npm run build)
ls -l kiosk/dist/backend/engine/kerchunk-dsp

# (b) Stop the service — nothing below touches config or env while it's live.
sudo systemctl stop kerchunk-kiosk

# (c) Snapshot the per-channel trims BEFORE the first native start. Each
#     engine persists levels (levelTrimDb, rfDb) the other loads, so a
#     snapshot taken after native has already run once is too late.
sudo cp /var/lib/kerchunk-kiosk/config.json /var/lib/kerchunk-kiosk/config.pre-native.json

# (d) Flip the engine.
sudo systemctl edit kerchunk-kiosk
#   [Service]
#   Environment=KERCHUNK_ENGINE=native

# (e) Start it back up.
sudo systemctl start kerchunk-kiosk
```

**Verify it's native:**

```sh
journalctl -u kerchunk-kiosk -b | grep 'engine: native'
# scanner + weather helpers, both kerchunk-dsp; weather shows the 250 kHz
# rate + SAME flags; no wideband_helper.py process at all:
pgrep -a kerchunk-dsp
pgrep -af wideband_helper   # expect: empty
# scanner helper at normal priority, weather helper niced down:
ps -o pid,ni,cmd -C kerchunk-dsp
# watch a minute or two for watchdog/backoff noise — none of these should
# appear during ordinary operation:
journalctl -u kerchunk-kiosk -f   # grep -E 'respawn|no "ready" within|helper silent for|NO_DEVICE'
```

A channel edit or bank toggle through the admin UI should re-point the live
flowgraph (`retune`), not respawn it — confirm the scanner `kerchunk-dsp`
PID from `pgrep -a kerchunk-dsp` is unchanged after making one.

### Rollback

Also one ordered sequence. Flipping the env var back isn't enough on its
own: native's own accumulated `levelTrimDb`/`rfDb` are sitting in the live
config, so undo means restoring **only** those two fields per channel from
the snapshot — not the whole file, which would also discard any config
edits (new channels, banks, alerts, …) made during the A/B.

```sh
# (a) Stop the service (hand-edit rule).
sudo systemctl stop kerchunk-kiosk

# (b) Merge back the pre-native levelTrimDb/rfDb, channel-id by channel-id.
#     Only ids present in BOTH files are touched; anything added/removed
#     during the A/B keeps whatever it has in the live file.
jq --slurpfile snap /var/lib/kerchunk-kiosk/config.pre-native.json \
   '($snap[0].channels | map({(.id): {levelTrimDb, rfDb}}) | add) as $snapTrims
    | .channels |= map(
        if $snapTrims[.id] then
          .levelTrimDb = $snapTrims[.id].levelTrimDb
          | .rfDb = $snapTrims[.id].rfDb
          | (if $snapTrims[.id].levelTrimDb == null then del(.levelTrimDb) else . end)
          | (if $snapTrims[.id].rfDb == null then del(.rfDb) else . end)
        else . end)' \
   /var/lib/kerchunk-kiosk/config.json > /tmp/config.post-native.json \
&& sudo mv /tmp/config.post-native.json /var/lib/kerchunk-kiosk/config.json

# No jq on the box? Equivalent with the system python:
/usr/bin/python3 -c '
import json
live = json.load(open("/var/lib/kerchunk-kiosk/config.json"))
snap = json.load(open("/var/lib/kerchunk-kiosk/config.pre-native.json"))
trims = {c["id"]: {"levelTrimDb": c.get("levelTrimDb"), "rfDb": c.get("rfDb")} for c in snap["channels"]}
for ch in live["channels"]:
    t = trims.get(ch["id"])
    if t is None:
        continue
    for field in ("levelTrimDb", "rfDb"):
        if t[field] is None:
            ch.pop(field, None)
        else:
            ch[field] = t[field]
json.dump(live, open("/tmp/config.post-native.json", "w"), indent=2)
'
sudo mv /tmp/config.post-native.json /var/lib/kerchunk-kiosk/config.json

# (c) Remove the drop-in (or set it back to wideband).
sudo systemctl edit kerchunk-kiosk       # delete the Environment= line, or set it to wideband

# (d) Start it back up.
sudo systemctl start kerchunk-kiosk
```

Notes:

- Under native, the weather radio runs its narrow front-end at 250 kHz
  (vs. 240 kHz under GR) — native lanes must land on a multiple of 50 kHz,
  GR's quad-rate front-end on a multiple of 48 kHz.
- The tuning knob is `scan.nativeQuietDb` (native's own dB scale, default −6
  — never mixed with GR's `noiseQuietDb`).
- `scan.nativeAmGainDb` (dB, −30…+20, default 0) balances airband/AM loudness
  against FM by ear; passed to the helper as `--am-gain-db`. Changing either
  knob via `PUT /api/config` restarts only the cheap native helper.
- The two liveness watchdogs (no `"ready"` within `readyTimeoutMs`, and no
  helper event other than a log line within `silenceTimeoutMs`) are native-
  only and live as `DEFAULT_READY_TIMEOUT_MS`/`DEFAULT_SILENCE_TIMEOUT_MS` in
  `kiosk/src/backend/engine/WidebandEngine.ts` (overridable per
  `WidebandEngineOptions`, not currently exposed as a config knob).
- `rfDb` (the ERP power estimator's input) is an EMA the helper accumulates
  over transmissions — it's on the helper's own dB scale, so a fresh native
  or wideband process starts re-learning it from zero. For up to ~12 h after
  a switch or rollback, `location.powerWatts` estimates for recently-heard
  channels can be skewed while the EMA re-settles on the new engine's scale;
  it self-heals as more transmissions land, no action needed.

## Legacy: remote Pi deploy

`kiosk/scripts/deploy.sh` and the `.githooks/post-merge` auto-deploy hook are
from the earlier remote-Pi era: they SSH to a Pi (`KERCHUNK_PI_HOST`, default
`admin@192.168.1.54`), reset its clone to `origin/main`, build, install to
`/opt/kerchunk-kiosk`, and restart the services. `scripts/setup-pi.sh` at the
repo root is the matching Pi-era bench bootstrap. None of these are active on
the appliance (`core.hooksPath` is unset), and no Pi target currently exists —
they're kept for a possible future Pi-class install.
