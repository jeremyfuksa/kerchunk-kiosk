# HF wall: The Atlas Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the HF wall stage with the Atlas: a full-screen Robinson globe in space with a real greyline, tonight's reception drawn on it, and a hit animation, then a zoom between map mode and HF.

**Architecture:** Pure modules (`sun`, `greyline`, `atlas`) decide everything and are unit-tested. `hfView` keeps owning the readout. The stage is four stacked composited layers: sky, land and dots, traces, and live. Only the live layer animates. A new `statusChanged` WebSocket event makes the wall poll at once, through the existing sequential poller, so hits and zooms start on time.

**Tech Stack:** Vanilla TS, SVG, Web Animations API, vitest, `lucide-static`.

**Spec:** `docs/superpowers/specs/2026-11-03-hf-atlas-wall-design.md`. Prototype for the look: `docs/superpowers/specs/assets/2026-11-03-hf-atlas-prototype.html`.

## Global Constraints

- The spec's colours, band altitudes, glow values and hit timings are exact unless marked "tune".
- No standing animation, no `backdrop-filter`, no full-screen overlay above anything animating. The Google map never moves its camera.
- All HTTP from the wall stays on the existing sequential poller.
- `/api/status`, `/api/logs` and `/api/weather` shapes don't change. Other mode stages don't change.
- ESM `.js` imports, `strict` + `noUncheckedIndexedAccess`, Lucide icons only.
- PR A is Tasks 1–5. PR B is Task 6, so the Atlas can ship without the zoom. Each is proven on the kiosk first.

## Review Focus

1. A wall that reloads mid-station draws the held state with no animation, and doesn't count that station as a new hit.
2. A next hit during a fade, or several status changes in a row, leaves exactly one live ring and line.
3. A SAME break-in from HF and back: the stage returns held, with no replayed hit and no lost traces.
4. The schedule name arriving late: same `listenHz`, candidate gains a location. That starts the hit once.
5. Noon rollover with a station playing: old traces and dots go, the live station's ring stays.

---

### Task 1: Sun and greyline geometry

**Files:**
- Create: `kiosk/src/frontend/dashboard/sun.ts`, `kiosk/src/frontend/dashboard/greyline.ts`
- Test: `kiosk/test/hfGreyline.test.ts`

**Interfaces:**
- Consumes: `robinson(lat, lon)` from `robinson.ts`.
- Produces:
  - `subsolar(ts: number): { lat: number; lon: number }`, `sunAltitude(lat, lon, sub): number` (degrees)
  - `GREYLINE_BANDS: ReadonlyArray<{ alt: number; color: string }>` with the spec's six
  - `nightBandPath(alt: number, sub): string`, in map units
  - `globeOutline(): string`, `STAGE_VIEWBOX = "0 -55.6 2000 1124.5"`, `skySvg(ts: number): string`, `greylineSvg(ts: number): string` (the part of the sky that redraws)

For each 3° of longitude find the latitude interval where altitude is below `alt`, and build polygons from runs of non-empty columns, so that equinoxes work. An interval edge that isn't at a pole and lies past the steepening latitude is pushed away: distance past it × 6. Start with 35°S and 55°N. Task 5 checks those values.

`skySvg` holds the space fill, about 520 stars from a fixed seed, the spec's halo stacks, and the clipped day fill, sun glow and bands. Port `stack()` from the prototype.

- [ ] **Step 1: Write failing tests**
  - `subsolar_nov_3_0911_utc`: lat within 1° of −15, lon within 3° of 46.4.
  - `subsolar_june_solstice_noon_utc`: lat within 1° of 23.4, lon within 3° of 0.
  - `altitude_at_the_sun_is_90_and_opposite_is_minus_90`.
  - `night_band_covers_midnight_not_noon`: parse columns, or test through an exported `nightInterval(alt, lon, sub)`. Solar longitude at the equator is outside; the antisolar longitude at the equator is inside.
  - `night_band_exists_at_the_equinox`: `subsolar` lat 0 gives a non-empty path for every band.
  - `bands_bleed_past_the_stage_in_november`: for all six bands at Nov 3 09:11 UTC, the lower edge at the antisolar longitude is at y ≥ 1069.
  - `bands_bleed_past_the_globe_in_june`: June 21, upper edge at the antisolar longitude is at y ≤ −17, the globe's top.
  - `sky_is_stable_between_calls`: `skySvg(t)` equals itself; stars don't change with `t`.
- [ ] **Step 2: Run `npx vitest run test/hfGreyline.test.ts`.** Expected: FAIL, modules don't exist.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run it.** Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat(hf): greyline and sky geometry for the Atlas"`

### Task 2: What the Atlas shows

**Files:**
- Create: `kiosk/src/frontend/dashboard/atlas.ts`
- Modify: `kiosk/src/backend/config/schema.ts` (`display.hf`)
- Test: `kiosk/test/hfAtlas.test.ts`, the existing config schema test

**Interfaces:**
- Consumes: `greatCircle`, `robinson`.
- Produces:
  - `bandColor(band: string | null): string`: `oklch(.8 .14 h)` with `h = 20 + 23 × index`, else `var(--kc-glass)`
  - `HF_BANDS_ORDER`, the spec's 13 names
  - `interface AtlasRow { freqHz; band; peakDb; onSpeaker; lat?: number | null; lon?: number | null }`
  - `atlasDots(rows): Array<{ x; y; r; opacity }>`: one per site at its strongest `peakDb`, `r = 3 + min(db, 50) / 12`, `opacity = 0.25 + min(db, 50) / 90`
  - `atlasTraces(rows, home, live: { lat; lon; band } | null): Array<{ key; color; segments: string[] }>`: played, located rows, one per site and band, without the live one
  - `tracePath(from: LatLon, to: LatLon): string[]`: split at the antimeridian
  - `legend(rows, liveBand): Array<{ label; color; lit; live }>`
  - `type HitChange = "none" | "start" | "end" | "replace"`, `hitChange(prev: HitKey | null, next: HitKey | null): HitChange`, where `HitKey` is the located station `{ hz, lat, lon, band }`
  - `display.hf`: `greylineStepMs` (300 000), `traceOpacity` (0.34), `hitGrowMs` (900), `hitLineDelayMs` (550), `hitLineMs` (2000), `hitPingMs` (800), `hitFadeMs` (700), `zoomMs` (1500), all optional with these defaults

- [ ] **Step 1: Write failing tests**
  - `band_colour_runs_by_wavelength`: `120m` is `oklch(.8 .14 20)`, `25m` is `oklch(.8 .14 181)`.
  - `unlisted_band_and_null_are_live_teal`.
  - `dots_keep_the_strongest_peak_per_site`, `dots_skip_rows_without_a_location`.
  - `traces_only_for_played_located_rows`, `traces_one_per_site_and_band`.
  - `live_station_has_no_trace_until_it_ends`: the row matching `live` is left out. It returns when `live` is null.
  - `path_across_the_antimeridian_has_two_segments`: home to New Zealand (−38.8, 176.4).
  - `legend_lights_bands_with_traces_and_marks_live`.
  - `hit_change_covers_each_transition`: null to key `start`; key to null `end`; key to other key `replace`; same key `none`.
  - `late_schedule_name_starts_one_hit`: for one `hz`, null then a key is `start`, and the same key again is `none`.
  - `display_hf_defaults`: schema fills the values above, and rejects `traceOpacity` above 1.
- [ ] **Step 2: Run the tests.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "feat(hf): traces, dots, band colours and hit logic for the Atlas"`

### Task 3: The still wall

**Files:**
- Modify: `kiosk/src/frontend/dashboard/hfView.ts`, `dashboard.ts` (stage markup, `paintHf`, `hfHeard` poll), `dashboard.css` (HF section)
- Test: `kiosk/test/hfWall.test.ts`

**Interfaces:**
- Consumes: Tasks 1 and 2.
- Produces: stage markup `#hfSky`, `#hfLand`, `#hfTraces`, `#hfLive`, `#hfContent`, each layer `will-change: transform` and absolutely positioned to the full stage with `STAGE_VIEWBOX`. `HfView` loses `map`, `mapKey` and the heard-row `when`; gains `rows: string[]` (`"9595 Radio Taiwan Int."`, last three), `legend`, `liveColor`, and `liveStation: HitKey | null`. `paintHeld(station)` draws the ring, line and country tint in `#hfLive` with no animation. Task 4 replaces it with the driver.

The country tint is a copy of the country's paths in `#hfLive`, so a hit never repaints `#hfLand`.

Layout values are the spec's. The clock's CSS changes only under `.dash.hfStage`: top-right, stacked, clear of the rim. `.kc-corner` stays above the stage.

Rows from `/api/hf/log` already carry the location fields. Widen `HfHeard` to `AtlasRow`. Keep all rows for the layers and the last three for the band. Request `hfHeard` when `listenHz` changes as well as when the band does.

- [ ] **Step 1: Update tests.** Replace `map`, dial and tag assertions. Add:
  - `rows_are_the_last_three_with_no_times`.
  - `live_color_follows_the_band`, `live_color_is_teal_when_hunting_and_on_error`.
  - `unidentified_station_has_no_live_station`: `listenHz` set, no candidate location. The readout still shows "Unidentified station".
  - `html_keeps_likely_muted_and_meter`.
  - `html_has_legend_and_reception_band`.
- [ ] **Step 2: Run `npx vitest run test/hfWall.test.ts`.** Expected: FAIL.
- [ ] **Step 3: Implement.** Sky is drawn once on entering the stage. `#hfLand` is `world.svg` plus dots; `#hfTraces` redraws only when the trace key changes. Delete the old `.kc-hf__*` rules this replaces.
- [ ] **Step 4: Run `npm test` and `npm run typecheck`.** Expected: pass.
- [ ] **Step 5: Deploy the branch to the kiosk, restart `kerchunk-display`, screenshot with `grim`.** Compare with the prototype: globe, stars, halo, panel, band, clock clear of the rim.
- [ ] **Step 6: Commit.** `git commit -m "feat(hf): the Atlas layout on the wall"`

### Task 4: The hit, on time

**Files:**
- Create: `kiosk/src/frontend/dashboard/hitAnim.ts`
- Modify: `kiosk/src/backend/server.ts`, `dashboard.ts`, `docs/API.md`
- Test: `kiosk/test/hfMode.test.ts`, `kiosk/test/hfWall.test.ts`

**Interfaces:**
- Consumes: `hitChange`, `tracePath`, `bandColor`, `display.hf`.
- Produces:
  - `class HitAnimator { constructor(svg: SVGSVGElement, opts); start(s: HitKey, home); hold(s: HitKey, home); end(onDone: () => void); clear() }`
  - WebSocket event `{ type: "statusChanged", ts }`, sent after a mode change (`POST /api/mode`) and after each HF `apply`. The wall answers with `poller.request("status")` and nothing else.

Use the Web Animations API on elements in `#hfLive`, with the spec's sequence and `linear` keyframes computed from the existing ring shape: rim, two trails, a 300 ms flash, a 12-unit halo. Each line segment animates `stroke-dashoffset`, one after the other, sharing the total `hitLineMs`. `end()` fades over `hitFadeMs`: ring to 0, line to `traceOpacity`, then calls `onDone`, which refreshes the traces and clears the layer. `start()` during a fade finishes it first. `prefers-reduced-motion` calls `hold`.

The first status after a load or after re-entering the stage is `hold`, never `start`.

- [ ] **Step 1: Write failing tests**
  - `mode_change_broadcasts_status_changed`, `hf_tune_broadcasts_status_changed` in `hfMode.test.ts`, with `wsHub` spied.
  - `first_status_holds_rather_than_starts`, through an exported pure `hitAction(known: boolean, prev, next): "hold" | "start" | "end" | "replace" | "none"`.
  - `re_entering_the_stage_holds`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `npm test` and `npm run typecheck`.** Expected: pass.
- [ ] **Step 5: Prove on the kiosk.** `POST /api/scan/skip` until a located station plays. Screenshot mid-hit (at about 1.5 s), held, and after the next tune. Check an Unidentified station draws nothing, then `POST /api/test/alert`, then a mode trip to `weather` and back, which must hold with traces intact.
- [ ] **Step 6: Commit.** `git commit -m "feat(hf): the hit animation, started by an instant status event"`

### Task 5: Greyline timer, tuning and heat (ship PR A)

**Files:**
- Modify: `dashboard.ts`, `CLAUDE.md`, `docs/bench/2026-11-hf-proofs.md`, and the steepening constants or `traceOpacity` default as tuned

- [ ] **Step 1: Write a failing test,** `greyline_redraws_only_when_the_step_passes`, for an exported pure `greylineDue(lastTs, now, stepMs): boolean`. Run it, implement it, and redraw only the greyline group inside `#hfSky`.
- [ ] **Step 2: Check four dates.** A scratch page, not committed, renders `skySvg` and the land for Mar 20, Jun 21, Sep 22 and Dec 21 at 00, 06, 12 and 18 UTC. Look for a flat band edge. Tune `35°S` and `55°N`, keeping them as far from land as you can. If June can't meet the rule without bad distortion over the US and Europe, stop and show the operator.
- [ ] **Step 3: Tune on the wall.** Glow strength stays as approved unless it's plainly different on the wall's screen. Trace opacity against the heaviest log available.
- [ ] **Step 4: Heat.** 30 minutes in HF with the real wall, at least one full pass, sampling temperature, helper CPU and Chromium's CPU. Bar: peak under 64 °C. Baseline: 54 °C peak, 47.9 °C mean, helper 23%. Record in the bench notes. If it fails, stop and show the operator.
- [ ] **Step 5: Screenshots of the live wall:** a hit in flight, held, fade, Unidentified, test alert, hunting. Noon rollover can't be forced: test it by `hfView` input, and flag it as unproven live until a noon passes.
- [ ] **Step 6: Update `CLAUDE.md` (HF section: `display.hf`, the layers, the WS event).** Definition of done. Fresh review of the whole branch. Commit, PR, CI, merge, clean up, kiosk on `main`.

### Task 6: The zoom (PR B)

**Files:**
- Create: `kiosk/src/frontend/dashboard/zoom.ts`
- Modify: `dashboard.ts`, `dashboard.css`, `kiosk/src/frontend/map/map.ts` (`MapHandle.whenDrawn()`), `CLAUDE.md`
- Test: `kiosk/test/hfZoom.test.ts`

**Interfaces:**
- Consumes: `statusChanged`, `display.hf.zoomMs`, `MapHandle.pause/resume`, `mapShouldRun`.
- Produces:
  - `zoomFor(prev: Mode | null, next: Mode, breakIn: boolean, hasMap: boolean): "out" | "in" | null`
  - `MapHandle.whenDrawn(timeoutMs: number): Promise<void>`: the map's next `tilesloaded` or `idle`, or the timeout. No camera call.
  - `runZoom(direction, els, opts): Promise<void>`: Web Animations transforms and opacity only. `#hfStage` scales around home's stage position, from 8 to 1 on the way out; `#mapBase` scales from 1 toward 0.3 around its centre and fades.

The stage swap classes move inside the zoom: both layers are visible during it, and the map pauses at the end of "out". For "in", resume the map, set it visible at opacity 0, `await whenDrawn(3000)`, then zoom. Interrupted by another mode change: finish immediately, then apply the new one.

- [ ] **Step 1: Write failing tests**
  - `zoom_out_only_from_scan_to_hf`, `zoom_in_only_from_hf_to_scan`.
  - `no_zoom_on_first_load`: `prev` null.
  - `no_zoom_for_other_modes_or_break_ins`: `weather`, `cb`, `monitor`, and `breakIn` true.
  - `no_zoom_without_a_map`: no Google key.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `npm test` and `npm run typecheck`.** Expected: pass.
- [ ] **Step 5: Prove on the kiosk.** Six trips between scan and HF with temperature logged. Capture frames mid-zoom. Check the Google map's camera doesn't move, and the map still draws after.
- [ ] **Step 6: Show the operator.** The spec requires it before finishing. Definition of done, PR, CI, merge, clean up, on their approval of how it looks.

## Not proven by this plan

- Noon rollover live, until a noon passes.
- How the zoom feels, until the operator sees it.
- Colour and glow beyond the wall's own screen.
