# Weather Glass — a GPU art layer for the kiosk map

Date: 2026-10-01 · Status: approved; PR 1 (#282/#283/#284) and PR 2 (#285) shipped. **Amended 2026-10-02 by [`2026-10-02-fixed-stage-event-pacing-design.md`](2026-10-02-fixed-stage-event-pacing-design.md):** fixed camera (no push), event-paced redraws, still hold rim; planned PR 4 dropped; radar source is now QC'd MRMS (#284).

## Why

The kiosk's data art (Google `Circle` rings, decaying blip circles, a punch
zoom) was the best idea under the GNU Radio thermal ceiling. The native DSP
engine freed ~2 cores (the box now idles ~58 °C, not ~89 °C), so the wall can
afford continuous GPU rendering. Two problems to solve:

1. The art is flat and only exists while someone transmits. KC traffic is
   sparse, so most of the time the wall shows a still map.
2. Radar loads tile by tile. It is a Google `ImageMapType`; every refresh
   pops and re-pushes the layer, so all tiles re-fetch independently and
   patch in. At the kiosk's zoom the low-z tiles are also visibly blocky,
   and drizzle/clutter paints the whole screen green.

## Decisions (from the brainstorm)

| Question | Decision |
|---|---|
| Relation to the map | The Google base map stays the stage; the art is a layer on top of it. |
| Quiet state | Ambient motion: a slow drifting haze, so the wall is never static. |
| Direction | **A — Weather Glass** (luminous), picked over Isobars and Halftone from live shader mockups. |
| Radar | **Real data only.** Raw NEXRAD reflectivity as a texture, restyled by palette. |
| Between scans | **Crossfade only.** Every radar pixel is a real measurement or a blend of two real scans: no shimmer, no refraction, no motion interpolation. |
| Camera | Keep the push toward the speaker, but gentler and on one eased curve. |
| Rendering | `WebGLOverlayView` inside Google Maps (one GL pass in Google's context). |
| Other radar products | Retired (nowCOAST, MRMS). Only IEM's composite gives raw values. |

## 1. The Glass layer (rendering)

A new `src/frontend/map/glassLayer.ts` built on `google.maps.WebGLOverlayView`.
Each frame it draws, in Google's GL context, back to front:

1. **Haze.** Faint domain-warped noise in sea-glass teal across the viewport,
   drifting slowly. This is the ambient motion. Strength is
   `display.glass.hazeIntensity`.
2. **Radar.** The real reflectivity grid (Section 2), drawn on a
   georeferenced mesh over its lat/lon bounds and reprojected to Web Mercator
   in the vertex stage. A subdivided mesh, because the source grid is
   equirectangular. The texture is filtered smoothly, so there are no blocky
   pixels. The Weather Glass palette is applied by dBZ (Section 3). The layer
   crossfades from the previous scan to the current one over
   `display.glass.radarFadeMs`. Shape, edges and location are exactly what
   NEXRAD measured.
3. **Transmissions.** Live fronts plus afterglows (Section 3). These replace
   both Google `Circle` systems: the live tx rings and the decaying blip
   circles.

**Stays as DOM/Google objects:** service pins, the home pin, aircraft, the
edge glow (activity without a location), and the clock and corner overlays.
Pins stay clickable on `/map`. The blip-circle info windows go away; the pins
carry the same information.

**Code shape**

- `glassLayer.ts` — WebGLOverlayView lifecycle, programs, textures, uniform
  upload, frame pacing.
- `glassShaders.ts` — GLSL ES 3.00 source. Compile-time caps
  `MAX_FRONTS = 8` and `MAX_GLOWS = 32`.
- `glassState.ts` — **pure**, no DOM or GL. The transmission/afterglow
  lifecycle produces the uniform arrays for a given `now`, plus the radar
  crossfade progress. Modelled on `blips.ts`.
- `map.ts` — loses the `ImageMapType`, the `RADAR` table and the `Circle`
  code. Its existing WS handlers feed `glassState`. `BlipField`
  (`blips.ts`) and `txRing.ts` become dead code and are deleted with their
  tests; `glassState` latches each front's radius itself.
- Smooth filtering means a cubic B-spline reconstruction of the dBZ grid
  (four bilinear taps). It smooths between measured samples; it never moves
  or invents echoes.

**Frame pacing.** Ambient motion means continuous rendering; the
`createIdleLoop` suspend is replaced by a capped redraw (`requestRedraw()` on
a timer):

- `display.glass.maxFps` (default 30) is the steady rate.
- `display.glass.txFps` (default 60) applies while any front is in its grow
  phase.

**`/map` gets the same layer**, so there is one code path.

**When it can't run.** With no `googleMapsMapId` (raster map) or no WebGL2,
the layer does not mount: the map shows pins only. The existing
`reportRenderDiag` journal line gains a `glass=on|off(<reason>)` field. The
no-key layout is unchanged.

## 2. The radar pipeline

**Source.** IEM national composite
`https://mesonet.agron.iastate.edu/data/gis/images/4326/USCOMP/n0q_0.png`:

- an 8-bit palette-indexed PNG on a 0.005° grid, with the origin (world
  file) at 126 °W, 50 °N;
- about 4.6 MB, refreshed every 5 minutes.

Each index is reflectivity at 0.5 dBZ steps: index 0 is no echo, otherwise
`dBZ = −32 + 0.5·index`. The mapping is pinned by a unit test against IEM's
published n0q legend, so the scale is never guessed. If the legend
contradicts the formula, the legend wins and the formula is corrected.

**Module: `src/backend/radar/`**

- `pngIndexed.ts` — a streaming decoder for indexed PNGs. It parses IHDR,
  inflates IDAT with async `node:zlib` (threadpool, not the event loop), and
  un-filters rows (None/Sub/Up/Average/Paeth). It keeps only the crop window
  and destroys the stream once past the crop's last row (KC sits about 40 %
  down the image). No new dependency.
- `crop.ts` — pure. World-file parameters plus QTH plus
  `display.radar.spanDeg` give the pixel window and the `{n,s,e,w}` bounds.
- `RadarFeed.ts` — runs every `display.radar.refreshMs`:
  - first fetches the sidecar `n0q_0.json` (tiny), whose `meta.valid` is the
    scan time;
  - downloads the 4.6 MB PNG only when that `scanTime` advances, then
    decodes and crops it;
  - holds the latest good scan `{scanTime, fetchedAt, bounds, width, height,
    bytes}`;
  - on any error (including an image whose dimensions no longer match the
    grid), keeps the last good scan and retries on the next tick;
  - emits `{type:"radar", scanTime}` on the WS only when `scanTime` advances.
  - The fetch and clock are injected for tests.
- The crop centre is the QTH (`display.weatherLat/Lon`). The default span is
  4° wide × 3° tall (~800 × 600 px), which covers the home framing plus the
  camera push.

**Cost.** About 4.6 MB of WAN per 5 min (~1.3 GB/day) and a sub-second burst
of threadpool work in the backend. The scanner helper's audio thread is
untouched.

**Routes** (all new; the three external-consumer routes are unchanged):

- `GET /api/radar` returns
  `{ scanTime, fetchedAt, bounds:{n,s,e,w}, width, height, stale }`. It
  returns 404 when `display.radar.enabled` is false, and 503 before the first
  scan.
- `GET /api/radar/frame` returns raw row-major index bytes (`width·height`),
  `application/octet-stream`, gzip'd, `ETag: <scanTime>`.
- `docs/API.md` documents both routes and the `radar` WS event.

**Frontend.** On page load, on each `radar` event, and every
`radar.refreshMs` as a backstop for a missed WS event, the page fetches the
meta and the frame and uploads it as an `R8` texture into the "next" slot.
Index → dBZ happens in the shader. On first load the scan fades in from
empty. If the bounds changed, the mesh is
rebuilt.

**Failure: never fake it, never freeze it.** When `scanTime` is older than
`display.radar.staleMs` (default 20 min), `stale: true` makes the layer fade
the radar out completely. Old weather shown as current is the dishonest case.
With no WAN at boot there is no radar until the first scan arrives.

**Config migration.** `display.radarProduct` is removed and the
nowCOAST/MRMS paths deleted. The schema strips the old key, the same
treatment `levelTrimDb` got, so existing configs still load.

## 3. Transmissions, camera, palette

**A transmission's life** (`glassState`):

1. **Key-up** (`active` with a location):
   - a core flash of about 300 ms;
   - then a light front expands from the site to its coverage radius over
     `display.glass.txGrowMs` (default 900 ms, ease-out), trailed by two
     faint secondary ripples.

   The radius comes from the existing latched `heldTxRadius()`.
2. **Hold** (open → `release`):
   - the front settles into a soft rim at the radius, breathing on a period
     of about 3 s, with a steady core;
   - the rim's brightness follows the audible channel's live `signal` dBFS,
     normalised over a fixed dBFS window held as constants in `glassState.ts`
     (other open channels hold at a fixed brightness);
   - `TX_TTL_MS` (60 s) and its re-arm on `signal` are unchanged.
3. **Release** (`release`, or `idle` for all):
   - over about 1.5 s the rim dissolves into an **afterglow**, a soft disc
     filling the footprint;
   - the afterglow is brighter with the site's hit count in the window (the
     same 1–6 ramp the blips use today) and fades over `BLIP_LIFETIME_MS`
     (60 s);
   - the last-hour history backfill seeds pre-decayed afterglows, as it seeds
     blips now.
4. **No location / Close Call:** the edge glow is unchanged.

Past the caps, the oldest front or afterglow is dropped.

**Camera.** Today `panTo` and `setZoom(+2)` animate on two different curves,
then `fitBounds` jumps back. The new version drives one eased tween of
center + fractional zoom through `map.moveCamera()`:

- on `audible` with a location: push `display.camera.pushZoom` (default +1)
  over `display.camera.pushMs` (default 2500, ease-in-out);
- hold for `display.camera.holdMs` (default 12 000);
- drift back to the framed home view (`framedBounds()` → camera) over
  `display.camera.returnMs` (default 4000);
- a new speaker mid-tween retargets from the current camera, with no snap;
- kiosk only — `/map` never moves itself.

The tween math lives in a pure `cameraTween.ts`.

**Palette (keyed to real dBZ):**

| dBZ | Look |
|---|---|
| < `display.glass.radarMinDbz` (15) | invisible (drizzle, ground clutter) |
| 15–35 | sea-glass |
| 35–50 | amber |
| ≥ 50 | rose |

Alpha rises with intensity. Overall strength is `display.glass.radarOpacity`
(0.6). Transmission colours are `colorFor()` service colours, lifted slightly
for glow on the dark map.

## 4. Knobs

All live in `src/backend/config/schema.ts` under `display`. All are
optional with defaults and stated in the PRs.

| Key | Default | What it does |
|---|---|---|
| `radar.enabled` | true | turn the radar feed and layer off |
| `radar.refreshMs` | 300000 | fetch cadence |
| `radar.staleMs` | 1200000 | age at which the radar fades out |
| `radar.spanDeg` | `{w:4,h:3}` | crop box around the QTH |
| `glass.maxFps` | 30 | steady render rate |
| `glass.txFps` | 60 | render rate while a front grows |
| `glass.hazeIntensity` | 0.35 | ambient haze (0 = off) |
| `glass.radarOpacity` | 0.6 | radar strength |
| `glass.radarMinDbz` | 15 | invisible below this |
| `glass.radarFadeMs` | 20000 | crossfade between scans |
| `glass.txGrowMs` | 900 | front expand time |
| `camera.pushZoom` | 1 | zoom levels in on a speaker |
| `camera.pushMs` | 2500 | push duration |
| `camera.holdMs` | 12000 | quiet time before returning |
| `camera.returnMs` | 4000 | return duration |

`glass.*` and `camera.*` reach the page on its next load, so a config change
is followed by `POST /api/kiosk/reload`. That matches existing display
fields. `radar.*` is read by the backend at boot (like `aircraft.*`), so a
change there needs a `kerchunk-kiosk` restart.

## 5. Testing and proof

**Unit (vitest, headless):**

- `pngIndexed`: a fixture PNG exercising all five filter types; crops at the
  image edges; the early stop past the crop.
- n0q mapping: against IEM's legend; index 0 is no echo.
- `crop`: world file + QTH + span → window and bounds.
- `RadarFeed` (fake fetch and clock):
  - an unchanged `meta.valid` skips the PNG download;
  - keeping the last good scan on error;
  - the stale flip;
  - the `radar` event only on a new `scanTime`.
- Routes: meta, frame bytes and ETag; 404 when disabled; 503 before the
  first scan.
- Schema: a config with `radarProduct` loads and is stripped; new defaults
  apply.
- `glassState`:
  - grow → hold → release → afterglow timing;
  - signal brightness and TTL re-arm;
  - the caps and drop order;
  - backfill seeding;
  - crossfade progress.
- `cameraTween`: easing, retargeting mid-flight, and the return path.

**Preview driver.** `POST /api/test/tx {channelId, holdMs}` broadcasts a
synthetic `active` → `audible` → `release` for a located channel. It touches
the WS only, never the engine or audio, like `/api/test/alert`. A script
cycles fronts across the city while the operator watches.

**On the wall:**

- `grim` screenshots of the live wall at each PR;
- a before/after thermal check: package temperature and chromium CPU over
  10 minutes at the 30 fps default, against the pre-change baseline;
- the `[kiosk] map rendering=… fps … glass=…` diagnostic line confirms
  pacing.

Definition of done per CLAUDE.md applies to each PR: `npm test`,
`test:native`, `typecheck`, full `build`, on-hardware proof, knobs stated.

## 6. Rollout: four PRs, each proven on the wall before merge

1. **Radar backend:**
   - `backend/radar/*` and the routes;
   - the `radar` WS event and the `display.radar.*` keys;
   - the `docs/API.md` update.

   Nothing visible changes. Proven by curling a real frame and checking a
   known echo's position against the current tile layer.
2. **Glass layer: haze + radar:**
   - `glassLayer`, `glassShaders`, and the `glass.*` radar/haze knobs;
   - replaces `ImageMapType`, retiring `radarProduct` and `RADAR`.

   This is the PR where radar stops loading tile by tile.
3. **Glass transmissions:**
   - `glassState`: fronts, hold, afterglow, signal brightness;
   - `/api/test/tx`;
   - replaces both `Circle` systems.
4. **Gentle camera:** `cameraTween`, `moveCamera`, `camera.*`.

Backend restarts are needed only for PRs 1 and 3 (routes). PRs 2 and 4 are
frontend build + `kiosk/reload`.

**Docs:** ROADMAP Idea 3 records the shipped direction; CLAUDE.md
architecture notes gain the glass layer and the radar feed.

## Out of scope

- Motion-interpolated radar.
- Looping the last hour.
- Any other radar product.
- Changes to the wall/art skins.
- Changes to pins or aircraft.
