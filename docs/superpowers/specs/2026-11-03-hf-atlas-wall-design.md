# HF wall: The Atlas

Replaces the layout of the HF wall stage from `2026-11-02-hf-mode-design.md`. The sweep, the reception log, and what the wall reports stay as they are. It builds on PR #315, which made HF and CB separate manual modes, so this stage has no CB stop or hold to handle.

Prototype: [`assets/2026-11-03-hf-atlas-prototype.html`](assets/2026-11-03-hf-atlas-prototype.html). It's a throwaway with real log data, showing one fixed moment of the sun. Copy its look, not its code. Values marked "tune" are starting points from it.

## Why

The operator on the live wall: the map and log felt crowded under the time and weather, and the screen needed a better layout. They want the world map to be the main thing you see, then the station, with the log and reception strip visually diminished. They also asked for something more artistic than flat gray.

The wall is a passive 1366×768 display, seen across a room, on a machine with a 90 °C thermal trip.

## Goals

- The map is the screen. Everything else sits on it, in this order of attention: map, station, log and reception strip.
- The picture changes with what's happening: the real day and night, and a record of the night's reception that builds up until the log clears.
- A new station is an event you notice from across the room, and the wall is otherwise still.

## Non-goals

- Automatic SSB. The operator raised it during this design, and it's a separate project.
- Other surfaces. Map mode, CB's stage, admin and the `/api/status`, `/api/logs` and `/api/weather` shapes don't change.
- Fixing the Robinson break at the antimeridian. Paths end at the globe's rim and continue from the opposite rim. The visible rim makes that read as going around the world.

## Anti-goals

- Standing animation: no twinkling, drifting or breathing. See "Do-not-undo invariants" in `CLAUDE.md`.
- A visible flat edge on the twilight bands.
- A rim that looks like a stroked outline.
- Glow on top of the globe.

## The picture

Back to front:

1. **Space.** Near-black (`#04050d`) with about 520 still stars of varied size and brightness, seeded so they don't change between loads. They show only outside the globe.
2. **Atmosphere.** A thin blue halo behind the globe only, falling off smoothly into space with no hard line. The prototype stacks strokes of the outline: `#5a78e6` reaching 85 map units in 18 steps at opacity 0.02, plus `#7fd0ee` reaching 24 in 12 steps at 0.028. The operator approved this strength after asking twice for less, so don't raise it without asking.
3. **Globe.** The sky is clipped to the Robinson outline of `world.svg` (`robinson()` at longitude ±180). The prototype shows the whole globe. The final framing is under "Layout".
4. **Greyline.** The real day and night for the current time, as flat stepped bands with no blur. Day is teal (`#14505c` to `#0f3a4c`) with a soft glow around the point under the sun. Bands at sun altitudes −0.8°, −3°, −6°, −9°, −12° and −14° are `#5b3f7f`, `#4c3580`, `#3a2c78`, `#2a2466`, `#1c1c50` and `#14163c`. It's computed from the clock with no network, and it redraws on a slow timer with no visible motion between redraws.
5. **Land.** Near-black (`#07080f`, opacity 0.72), with hairline borders (`#c9cfd8`, opacity 0.2).
6. **Tonight's sites.** A quiet dot for every located site in tonight's log, whether it played or not, brighter and larger with stronger `peakDb`.
7. **Faded traces.** See below.
8. **The live station.** See below.
9. **Text.** See "Layout".

### Band edges

The bands must never show a flat edge. The operator rejected the true shape, where the night stops in a flat line above a sunlit polar cap. The prototype steepens the curve south of 35°S, multiplying the distance past that latitude by 6, so that every band runs off the bottom of the globe. That means the shading is deliberately not true in the far south, and the operator knows that.

The prototype only shows November. In June the same flattening happens at the top, where far more land sits, including the northern US and Europe. Handle both hemispheres, and check a solstice and an equinox in each direction. Keep the distortion as far from land as you can while meeting the no-flat-edge rule. If no setting works in June, stop and show the operator.

### Band colours

One colour per band in wavelength order, from red at 120 m to violet at 13 m: `oklch(.8 .14 h)` with `h = 20 + 23 × index` over `120m, 90m, 75m, 60m, 49m, 41m, 31m, 25m, 22m, 19m, 16m, 15m, 13m`.

A band from `config.hf.bands` that isn't in this list uses the live teal, `--kc-glass`. So do hunting and errors.

The frequency, meter, reception needle, source ring, live line, home ring and transmitter country tint all take the live band's colour.

## The hit

A hit is the speaker moving to a new station that has a location: `hf.listenHz` changes and `hf.candidate` has `lat` and `lon`.

1. A flash at the transmitter, about 300 ms.
2. A ring grows out of it over 900 ms, eased, with a bright rim and two fading rings behind it, then holds still. This mirrors the UHF front in `map/glassShaders.ts`, but it's drawn in SVG, because the HF stage doesn't load Google's map or its GL context.
3. From 550 ms, the line leaves the ring and travels the great-circle path to home over 2000 ms, eased. A path crossing the antimeridian draws its two parts one after the other, and the total duration stays the same.
4. It lands with a small ring at home, about 800 ms.
5. The line and source ring stay bright and still while the station plays. The meter is the only thing moving.
6. **When the scan moves on,** meaning `listenHz` changes or clears or the window ends, the ring fades out and the line fades over about 700 ms to a faded trace.

If the next hit arrives during a fade, finish it immediately and start the hit.

A wall that loads or reloads while a station is playing draws the line and ring in their held state, with no animation.

### Traces

- A faded trace stays until the log clears. It's the path in its band's colour at opacity 0.34 (tune on the wall). The operator's words: "the faded trace should never go away", then "until log clears".
- **Clearing:** a listening night runs noon to noon (`nightOf`). When `/api/hf/log`'s latest night changes, the traces and dots show only the new night.
- **Source of truth:** rows from `/api/hf/log` with `onSpeaker` true and a location, one trace per site and band. They survive a reload, a restart and a trip through another mode, and they're drawn with no animation. The live station's trace appears when it fades, not before.
- Last night's real data gave 74 traces. A full noon-to-noon run could give more, so check legibility with the heaviest log available.

### No animation

- A station with no location ("Unidentified"): the panel shows it, and there's no ring, line or trace. The prototype doesn't have this case, so the panel's wording stays as it is today.
- A station that's logged but didn't play: a dot, added silently.
- Error and hunting states: no ring or line. Traces and dots stay.

## The zoom between map mode and HF

The operator asked for switching between UHF and HF to look like zooming out of the local map to the global one, and back. Scan mode's map and the Atlas are different pictures at very different scales, so it's a staged illusion and not a real camera move:

- **Out to HF:** about 1.5 s, eased (tune). The local map shrinks toward home and fades, while the Atlas starts scaled up about 8× around home and settles to full size. The crossfade hides the jump in scale.
- **Back to the map:** the reverse. The Atlas scales up around home and fades into the local map.
- **The Google map must not move.** No camera moves or zoom calls: its layer is transformed as a still, because camera moves are what drove heat before (`CLAUDE.md`, "the kiosk camera stays still"). Pause it once it's hidden, as today. Coming back, it has to be drawn before the zoom starts, so hold on the Atlas until it's ready.
- **It starts when the wall learns of the change.** The wall only polls `/api/status` every 5 s (`dashboard.ts`), so add a WebSocket event for a mode change, or the zoom can start up to 5 s after the button press, and after the audio has already changed.
- **Only scan and HF.** Other mode changes, a SAME break-in and its return, and a page load that finds HF already on just cut as they do today. The operator hasn't seen this in motion, so prototype it on the wall and show them before finishing it.

The heat proof below includes several of these.

## Layout

At 1366×768, per the prototype:

- **Map:** larger than the screen, centred, 1905 map units across the 1366 px. The top of the screen is about 78°N, so the flat pole line and the high Arctic are off screen: the operator rejected traces flattening along that line. The flat south edge sits behind the reception band.
- **Station panel:** lower left over the South Pacific, 430 px wide, 66 px from the bottom, on a translucent dark plate with no blur (`rgba(14,14,42,.74)`). It holds the frequency at 68 px, the name at 30 px, one line of details, and the meter. All of `hfView`'s readout data stays, including "Likely", "Muted", and the error and hunting states.
- **Top left:** "HF · 25m", small and dim.
- **Clock and weather:** top right, inside the corner of space and clear of the globe's rim. The prototype's one line crosses the rim, and the operator agreed to moving it. Stacking it is fine if one line won't fit. Keep the Lucide weather icon that's there today.
- **Reception band:** a full-width dark band along the bottom (`rgba(9,9,28,.86)`), which also hides the globe's flat south edge. Left: the band legend. Right: "Heard tonight N" and the last three stations, dim, on one line. Under them: the reception strip, reduced to a hairline with short ticks and the needle.
- **Band legend:** the 13 band numbers in their colours at 13 px. Bands with traces are lit, the rest at 30% opacity, and the live band is underlined.
- **Alert banner:** still shows over the stage, as it does today (`.kc-corner` stays). Don't hide it behind the panel.

## Constraints

- Vanilla TS, with `lucide-static` icons only.
- Keep the logic in `hfView` pure and unit-tested, including sun position, band outlines, band colours, trace selection and the hit's state changes.
- The animation must not repaint the background. Put the moving parts in their own small layer above a still picture. The greyline redraw and a new trace are the only things that touch the still layers. The prototype's stacked strokes and 520 stars are costly to repaint, so draw them once and keep the result.
- No `backdrop-filter`, and no full-screen overlay above anything animating. Neither is needed here.
- The Google map stays paused on this stage (`mapShouldRun`).
- HTTP polling stays sequential through the existing poller lane.
- Knobs go in config, under `display.hf`: greyline redraw interval (default 5 minutes), faded trace opacity, and the hit timings. Hit colours and star counts can be constants.
- `CLAUDE.md`'s definition of done applies, and `docs/API.md` changes if any route does.

## Proof on the wall

- **Heat:** 30 minutes in HF with the real wall, through at least one full pass with hits, sampled as in `docs/bench/2026-11-hf-proofs.md`. Baseline: 54 °C peak, 47.9 °C mean, helper 23% of a core. Also record Chromium's CPU, which that baseline didn't. Bar: peak stays under map mode's 64 °C. If it doesn't, stop and show the operator.
- **Screenshots of the live wall:** a hit in flight, a held station, a fade, an Unidentified station, a test alert banner, and hunting.
- **Greyline on the wall:** the bands checked against the real time of day.
- **Tuning on the wall:** glow strength and trace opacity, because the wall's screen differs from the laptop the prototype was judged on.
- **Noon:** traces clearing when the night rolls over.

## Left to the builder

- Whether the still layers are SVG or a cached canvas or image.
- How the hit is driven, as long as it meets the layering constraint.
- File and module structure.
- Exact spacing, where the prototype and this document leave room.
