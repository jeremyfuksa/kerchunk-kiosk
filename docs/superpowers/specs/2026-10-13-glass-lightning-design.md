# Glass lightning: the storm lights up from inside

Status: design approved in chat 2026-10-13; awaiting written-spec review.
Builds on: [`2026-10-01-weather-glass-design.md`](2026-10-01-weather-glass-design.md),
[`2026-10-02-fixed-stage-event-pacing-design.md`](2026-10-02-fixed-stage-event-pacing-design.md),
[`2026-10-02-glass-smoke-design.md`](2026-10-02-glass-smoke-design.md).

## Why

Lightning is **atmosphere, not awareness**. On the glass, a storm should
visibly flicker over the radar, as part of the painting. Precise strike
location doesn't matter (GLM is only good to ~8–10 km), and neither do
distance readouts or the storm card. That keeps scope small. This isn't a
safety feature.

## Decisions (from the brainstorm)

| Question | Decision |
|---|---|
| Purpose | Atmosphere (B), not situational awareness. |
| Data source | NOAA GOES-19 **GLM** (`GLM-L2-LCFA`, public S3 bucket `noaa-goes19`). Free and official. Blitzortung rejected (unofficial protocol, redistribution terms); commercial feeds rejected (paid). |
| Look | **Cloud bloom** (mockup A): a soft cool-white bloom the size of the flash, a few steps bright, then gone. No marks left behind. Picked over "bolt + scorch" and "crackle". |
| Pacing | **3 s tick** (`stepMs` 3000), 2 steps per bloom: ≈20 redraws/min during a storm, the rate the smoke stare test passed. 1.5 s (≈40/min) rejected as over budget; 6 s read as a pulse. |
| Timing | **Delayed replay**: each flash fires at its own strike time + `replayDelayMs` (75 s). The wall runs ~a minute behind the sky, but blooms keep the storm's natural rhythm instead of GLM's 20-s file clumps. |
| Architecture | Backend feed (A). The wall never parses HDF5. Browser-side S3 and a Python helper rejected. |

Mockups: `.superpowers/brainstorm/54561-1791945203/content/strike-look.html`,
`bloom-tick.html` (local only, gitignored). Both replay the 229 real flashes
that hit the wall's frame 02:20–02:30 UTC on 2026-10-14 over a screenshot of
the wall during that storm.

## Spike findings (2026-10-13)

- **Volume:** GLM writes one file per 20 s, the whole hemisphere every time,
  whether or not it's storming locally. Measured days: 0.96 GB (quiet,
  Jul 15), 1.72 GB (Oct 13), 2.51 GB (Jun 20) → **11–29 KB/s** average, files
  186 KB–1.3 MB.
- **Link:** S3 downloads ran ~1.2 MB/s on the kiosk (≈0.3 s per file). The
  IEM slowness doesn't apply.
- **Latency:** files land on S3 a median 10–20 s after their 20-s window
  closes (p95 19–31 s), so a flash is 20–50 s old when we can first see it.
- **Content:** the `flash_*` arrays are ~3% of each file. Range reads would
  cost ~27 requests / ~110 KB per file. Not worth it; we download whole files.
- **Encoding:** `flash_lat/lon` are float32, but `flash_time_offset_of_first_event`,
  `flash_energy` and `flash_area` are scaled int16 (`scale_factor`,
  `add_offset`, `_Unsigned`). The CF scaling **must** be applied.
- **Rate:** a storm over KC put ~23 flashes/min inside the wall's frame;
  median flash area ≈ 290 km² (~17 km across).

## Behaviour

### Backend: `src/backend/lightning/`

Same lifecycle shape as `RadarFeed`: `start()/stop()`, an injectable fetcher,
and failures never throw out of a poll.

- **`LightningFeed`** polls every `pollMs` (20 s). It lists
  `GLM-L2-LCFA/<yyyy>/<ddd>/<hh>/` with `start-after` = the last key it
  processed, also listing the previous hour when the current hour is under a
  minute old (files straddle the boundary). Listing follows
  `NextContinuationToken`. Each new key is downloaded in full with a
  per-request timeout and parsed.
  - **First poll after boot:** only keys whose scan start is within the last
    `replayDelayMs + 45 s` (≈2 min), enough to fill the replay window. Nothing
    older is replayed.
  - **After an outage:** if more than `maxCatchupFiles` (6) keys are new, it
    takes only the newest 6. It never works through a backlog.
- **`glm.ts`**: `parseGlm(bytes, box) → Flash[]`. It reads `flash_lat`,
  `flash_lon`, `flash_time_offset_of_first_event`, `flash_energy`,
  `flash_area` and `product_time`, applies CF scale/offset/unsigned, and keeps
  flashes inside `box`.

  ```ts
  interface Flash { t: number /* epoch ms, first event */; lat: number; lon: number; energyFj: number; areaKm2: number }
  ```

  The box is the QTH ± `spanDeg / 2` (default 4° × 3°, the same as radar's
  crop).
- **HDF5 reader:** the plan's first task tries **jsfive** (pure JS, small) on
  real GLM files and checks its output against h5py. If it can't read GLM's
  gzip-chunked NetCDF4, fall back to **h5wasm** (official HDF5 build, ~15 MB
  in `node_modules`). The choice is recorded in the plan.
- **Buffer:** flashes with `t > now − bufferMs` (5 min), time-ordered.
- **Stale:** no file processed for `staleMs` (3 min).
- **Push:** after each file with ≥1 in-box flash, the server broadcasts
  `{ type: "lightning", flashes: Flash[], ts }`.
- **Route:** `GET /api/lightning?since=<epoch ms>` → `{ flashes, stale, latestEnd }`
  (`latestEnd` = scan-end time of the newest processed file, or null).
  It returns 404 when disabled. `since` is clamped to the buffer.
- **Untouched:** `/api/status`, `/api/logs`, `/api/weather` keep their shapes
  (external consumer). `docs/API.md` documents the new route and WS event.
- **Failure handling:** a listing error, download error, timeout or parse
  failure is logged once per kind with the key and skipped, and the next poll
  carries on. A dead feed only means no blooms.
- **Wiring:** `index.ts` builds it when `display.lightning.enabled` and a QTH
  is configured, and passes it as `ServerDeps.lightning`. `server.ts` starts
  it, stops it on close, and wires the broadcast, mirroring radar.

### Frontend

- **`map/lightningSync.ts`** works like `RadarSync`. On load it calls
  `GET /api/lightning?since=now − replayDelayMs − 30 s`. On each WS
  `lightning` event it merges flashes, deduplicating on `(t, lat, lon)`. A
  60-s backstop poll covers events missed across a backend restart.
- **`map/lightningState.ts`** is a pure scheduler (no WebGL, unit-tested):
  - `add(flash)`: fire time = `t + replayDelayMs`, snapped up to the next
    tick of the shared epoch grid `gridTick(·, stepMs)`. With `stepMs` 3000
    and `smokeStepMs` 6000, every other lightning tick is a smoke tick, so
    their redraws coincide.
  - **Late flashes:** if a flash's fire tick has already passed when it
    arrives, it fires on the next tick only if it's ≤ one tick late, and is
    dropped otherwise. That way a reconnect can't dump blooms.
  - `frame(now) → { blooms, nextChangeAt }`. A bloom is visible for
    `bloomSteps` ticks starting at its fire tick, at level
    `1 − i / bloomSteps` (2 steps → 1, 0.5). `nextChangeAt` is the next tick
    while anything is blooming, otherwise the earliest pending fire tick,
    otherwise `null`. **Waiting flashes cost no redraws.** Expired flashes are
    pruned.
  - Strongest `maxBlooms` (32) per frame, ranked by intensity.
- **`glassLayer.ts`:** a new **bloom pass**. Draw order becomes radar →
  bloom → smoke → fronts. Each bloom is an additive radial Gaussian at the
  flash point:
  - radius = `√(areaKm2 / π)` km × `bloomScale`;
  - intensity = `bloomIntensity × level × e`, where
    `e = min(1, 0.35 + log10(1 + energyFj) / 3)`, the mockup's curve;
  - colour: a cool-white core `(0.92, 0.94, 1.0)` fading to periwinkle
    `(0.72, 0.78, 1.0)`.

  The layer's existing next-change calculation takes `min()` with
  `lightningState.frame().nextChangeAt`. Lightning draws whether or not
  radar is on. It needs the Google WebGL glass, so no Maps key means no
  lightning (as with smoke).

### Test route

`POST /api/test/lightning` (alongside `/api/test/alert`) replays a canned
flash set (checked-in JSON of tonight's 229 flashes, timestamps re-based to
now) through the same broadcast path, for previews and the thermal A/B.
`{ clear: true }` drops pending test flashes.

## Knobs

Backend, read at boot. Changing them needs a `kerchunk-kiosk` restart:

```
display.lightning.enabled          true
display.lightning.satellite        "goes19"   // bucket noaa-<satellite>
display.lightning.pollMs           20000      // 10000…120000
display.lightning.bufferMs         300000
display.lightning.staleMs          180000
display.lightning.fetchTimeoutMs   30000
display.lightning.maxCatchupFiles  6
display.lightning.spanDeg          { w: 4, h: 3 }
```

Wall, applied on `kiosk/reload`:

```
display.glass.lightning.enabled         true
display.glass.lightning.stepMs          3000    // 1000…60000; redraws/min ≈ 60000/stepMs while storming
display.glass.lightning.replayDelayMs   75000   // 0…300000
display.glass.lightning.bloomSteps      2       // 1…6
display.glass.lightning.bloomIntensity  0.75    // 0…1.5
display.glass.lightning.bloomScale      1.0     // 0.2…3, × flash radius
display.glass.lightning.maxBlooms       32      // 1…64
```

## Testing

- **`glm.ts`:** one real GLM file checked in as a fixture (~250 KB, flashes
  over KC, from 2026-10-14 02:2x UTC). Asserts the flash count, the in-box
  count, and spot values for lat/lon/time/energy/area against h5py output
  for the same file (recorded in the test).
- **`LightningFeed`:** with a fake fetcher, covers listing pagination,
  `start-after` resume, the hour rollover, the boot window, the
  `maxCatchupFiles` skip, a bad file being skipped, the stale flag, and
  buffer pruning.
- **`lightningState`:** with fake clocks, covers grid alignment with smoke
  ticks, fire = first tick ≥ `t + delay`, the 2-step levels, late-flash grace
  and drop, `nextChangeAt` (null when idle, pending fire tick while waiting),
  and the `maxBlooms` cap.
- **Server:** `/api/lightning?since=`, 404 when disabled, the WS broadcast and
  the test route, all with a fake feed.

## Proof on hardware

1. **Feed:** one hour live. Backend CPU is essentially unchanged, and bytes
   match the spike (11–30 KB/s). Check the `[lightning]` logs for steady
   polls.
2. **Thermal A/B:** replay via `POST /api/test/lightning` in a loop (or a real
   storm). Compare package temperature and chromium CPU with
   `glass.lightning.enabled` on vs off, as in the smoke stare test. Pass:
   ≈20 redraws/min during a storm, 0 extra when quiet, and no temperature
   step beyond what smoke at 3 s showed.
3. **Look:** the operator watches the replay. A `grim` capture confirms the
   blooms sit on the radar cores.

## Rollout

- **PR 1:** backend: `lightning/` module, config, route, WS event, `API.md`.
  It's invisible on the wall.
- **PR 2:** frontend: sync, scheduler, bloom pass, test route. The thermal
  A/B gates its merge.

## Out of scope

Nearest-strike distance, storm-card integration, strike marks or history,
audio, and any SDR or sensor hardware.
