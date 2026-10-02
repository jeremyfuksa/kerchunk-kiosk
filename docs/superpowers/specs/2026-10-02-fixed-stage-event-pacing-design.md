# Fixed stage + event pacing: amending Weather Glass for CPU

Date: 2026-10-02 · Status: design approved in brainstorm, awaiting spec review
Amends: [`2026-10-01-weather-glass-design.md`](2026-10-01-weather-glass-design.md).
It supersedes that spec's **§1 frame pacing**, the **§3 camera**, the
**"Hold: breathing"** step of §3, and **§6 PR 4**. Everything else in it stands.

## Why

Today's measurements on the appliance (2026-10-02):

- Tile radar at baseline: 58.4 °C, chromium about 20 %.
- Glass radar with haze off: 57.9 °C. Chromium ranged 14–64 % over six 10 s
  samples during a run of hits.
- Haze at 0.35, i.e. a continuous redraw at 30 fps: the box reached 90 °C and
  tripped safety mode (2026-10-01).

Two things cost CPU on this wall, and the Weather Glass plan made both worse:

1. **The camera.** Every located `audible` runs `panTo` and then `setZoom(+2)`,
   with no rate limit, so a busy band re-pans on every change of speaker.
   After 12 s of quiet, `fitBounds` jumps home. Each move makes Google
   re-lay-out the vector map: tiles at the new zoom, label collision,
   tessellation. That work runs on chromium's CPU threads. The planned
   PR 4 would have made it a 60 fps `moveCamera` tween for 2.5 s in and
   4 s out, on every hit.
2. **Continuous redraw.** The glass layer shares Google's GL context, so
   every glass frame re-composites the whole map. The planned PR 3 rim
   breathes at 30 fps for the whole time a channel is open, and afterglows
   fade smoothly for 60 s.

## Decisions (from the brainstorm)

| Question | Decision |
|---|---|
| Camera's job | **Fixed stage.** The map frames once and never moves on its own. Who's talking and where is carried by the glass front at the pin plus the LCD. |
| Off-frame speaker | **Directional edge bloom** at the point where the line to the speaker leaves the screen. Unlocated speakers keep today's whole-edge glow. |
| Motion during a hold | **Motion only on events.** The grow and the dissolve are full-rate; the hold is still. Signal brightness and afterglow fades move in quantised steps. |
| Rollout | **Two PRs, cheapest first:** A, fixed stage; B, glass transmissions with event pacing. The planned PR 4 "gentle camera" is dropped. |
| Escape hatch | `display.camera.follow` (off) keeps today's push/pull-back path, unchanged. |

## PR A: Fixed stage

**Framing (kiosk).**

- Unchanged at first load: one `fitBounds(framedBounds(), KIOSK_FIT_PAD)` after
  the sites, the channels and the map's first `idle`.
- A re-fit happens only when the viewport resizes (debounced 500 ms). Sites
  and channels load once per page, so a newly located site joins the frame on
  the next `kiosk/reload`. No runtime "bounds moved" check is needed.
- A re-fit is an instant `fitBounds`, with no tween. It is **deferred while
  any transmission is live** and applied on the next `idle` event, so the
  frame never jumps under an active speaker.
- Apart from these re-fits, nothing in the kiosk moves the camera. `/map`
  (interactive) is unchanged; it never moved on its own.

**Removed** (when `display.camera.follow` is false): `punch()`'s camera calls,
`PUNCH_HOLD_MS`, `PUNCH_ZOOM_IN`, `homeZoom`, and the 1.5 s pull-back
interval. The `audible` handler still sets `audibleId`.

**Directional bloom for an off-frame speaker.**

- **When:** an `audible` arrives whose location is outside the **padded**
  visible rect, i.e. the viewport minus `KIOSK_FIT_PAD`. A pin hidden under the
  clock or the corner counts as off-frame.
- **Where:** project the site to screen pixels. Find where the ray from the
  padded rect's centre toward the site crosses the **viewport** edge. That
  point is the anchor.
- **What:** one DOM element, `.edgeBloom`: a radial gradient in the service
  `colorFor()` colour, about 480 px across, centred on the anchor and so half
  off-screen. It pulses with the existing `edgeGlowPulse` keyframes (7 s,
  opacity only), so it is compositor-only work: no layout, no paint, and not
  the full-screen overlay pattern CLAUDE.md warns against. A new pulse
  restarts the animation, the same way `glowEdges` does today.
- **Not a bloom:** an unlocated speaker or a Close Call keeps the full
  `edgeGlow`. An on-frame speaker gets nothing extra; its pin and (after PR B)
  its front carry it.

**Pure helpers** (new `src/frontend/map/stage.ts`):

- `padRect(w, h, pad)`: the padded frame rect.
- `outside(p, rect)`: whether a point lies outside it (a pin under the clock
  or the LCD counts).
- `edgeExit(center, target, rect)`: where the ray from `center` through
  `target` crosses `rect`'s border (the bloom anchor).
- `lngLatToViewPx(lat, lng, bounds, w, h)`: projects a site from
  `map.getBounds()` with Mercator math (valid for the north-up, untilted
  kiosk camera; works off-screen).

**Knob:** `display.camera.follow` (boolean, default `false`). Applies on
`kiosk/reload`. When it is `true`, today's punch and pull-back code runs as
it does now, and the bloom is off.

## PR B: Glass transmissions with event pacing

This is the planned PR 3 (`glassState`, `/api/test/tx`, and both `Circle`
systems retired), with these changes.

**Lifecycle visuals.**

- **Key-up:** core flash (~300 ms), then a front grows to the latched radius
  over `txGrowMs` (900 ms, ease-out), with two faint secondary ripples.
- **Hold:** a **still** rim; there is no breathing. Brightness follows the
  audible channel's `signal` dBFS, normalised over the window constants in
  `glassState.ts`. Other open channels hold at `DEFAULT_BRIGHT`.
- **Release:** the rim dissolves into an afterglow over 1.5 s. The afterglow's
  strength follows the 1–6 hit ramp, and it fades over 60 s. History seeds
  pre-faded afterglows.
- `TX_TTL_MS`, the caps (`MAX_FRONTS` 8, `MAX_GLOWS` 32) and the removals
  (`txRing.ts`, `BlipField`, `wake`/`tick`, the blip InfoWindows) are as in the
  plan.

**Pacing contract.**

`glassState.frame(now)` returns the scene plus:

- `continuous: boolean`: true while any front is in its key-up/grow phase or
  any rim is dissolving.
- `nextChangeAt: number | null`: the earliest future time at which the scene
  will **visibly** change if no event arrives. `null` means it will never
  change on its own.

Quantisation is what makes `nextChangeAt` sparse:

- A held rim's brightness is quantised to `signalSteps` levels. A new `signal`
  only changes the scene when its level differs. It is also rate-limited to
  `holdFps`: a level change inside the window waits for the window's end.
- An afterglow's strength is quantised to `fadeSteps` steps over its life, so
  its next change is the next step boundary.
- The TTL expiry and the afterglow's end are change points too.

`glassLayer.schedule()` becomes:

- **continuous** (or haze > 0, or a radar fade running): `requestRedraw` at
  `txFps` while growing, else at `maxFps`. This is the existing behaviour.
- **else, if `nextChangeAt`:** one `setTimeout` to that moment, then one
  `requestRedraw`.
- **else:** no timer at all.
- Events (`keyUp`, `release`, a `signal` that changed level, `seedGlow`, a
  radar scan or stale flip) call `requestRedraw` directly and reschedule.

Expected cost: a quiet band does zero glass redraws. A held channel does at
most `holdFps` redraws a second, and only when the signal level moves. A 60 s
afterglow does about `fadeSteps` redraws in total.

**Glass off** (no Map ID or no WebGL2): pins only, plus the LCD, plus the
existing diag reason. No `Circle` fallback.

## Knobs (deltas to the Weather Glass §4)

| Key | Default | Range | Applies | Notes |
|---|---|---|---|---|
| `display.camera.follow` | `false` | bool | `kiosk/reload` | Escape hatch to today's push/pull-back. |
| `display.glass.holdFps` | 4 | 1–30 | `kiosk/reload` | Max redraw rate for held-rim signal steps. |
| `display.glass.signalSteps` | 8 | 2–32 | `kiosk/reload` | Brightness levels for a held rim. |
| `display.glass.fadeSteps` | 24 | 4–120 | `kiosk/reload` | Visible steps across an afterglow's 60 s fade. |
| `display.glass.hazeIntensity` | **0** | 0–1 | `kiosk/reload` | Already shipped as off (#285); the parent spec's 0.35 is superseded. |
| ~~`display.camera.pushZoom/pushMs/holdMs/returnMs`~~ | | | | Dropped with planned PR 4. |

`KIOSK_FIT_PAD` stays a code constant (`map.ts`); it is layout, not behaviour.

## Testing and proof

**Unit (vitest, headless).**

- `stage.test.ts`:
  - `edgeExit`: targets out the top, bottom, left and right land on the
    correct edge; a target on the diagonal lands on the corner; an on-screen
    target (under the clock) still extends to the border; an off-centre
    `center` (the padded rect isn't viewport-centred) is honoured.
  - `outside`: a point under the padding counts as outside.
  - `lngLatToViewPx`: the bounds' corners map to the viewport corners, with a
    Mercator y.
- `glassState.test.ts`: the plan's lifecycle tests, plus pacing:
  - `continuous` is true during the grow and the dissolve, false during the
    hold and the afterglow;
  - a held rim with an unchanged signal level reports `nextChangeAt = null`
    (or the TTL);
  - a level change inside the `holdFps` window reports the window's end;
  - an afterglow's `nextChangeAt` falls on a `fadeSteps` boundary;
  - an empty scene reports `null`.

**On the wall.**

- PR A: drive an on-frame and an off-frame speaker through `/api/test/tx`
  (moved into PR A, see Rollout) and capture burst screenshots mid-pulse. Confirm the camera never moves across
  10 minutes of live band.
- PR B: `/api/test/tx` sequences, with burst captures during the grow, the
  hold, the release and the afterglow. Motion bugs only show up in bursts.
- **Redraw count:** the diag line gains `glassRedraws/min` (a counter in
  `glassLayer`), reported over a live 10 minutes.
- **Thermal:** 10-minute runs (temperature, CPU, chromium). PR A against
  today's glass numbers; PR B against PR A's. Budget: PR B within +3 °C and
  +10 % chromium of PR A.

## Rollout

1. **PR A: fixed stage.** `stage.ts`, the `display.camera.follow` schema,
   `map.ts` framing/bloom, CSS, and the planned `/api/test/tx` preview driver
   (Task 12, moved here because PR A's proof needs it; it takes an optional
   `lat`/`lon` so a test can place an off-frame site). Backend restart (route
   and schema), then a `kiosk/reload`.
2. **PR B: glass transmissions + event pacing.** The planned Tasks 11, 13 and
   14, amended as above, plus the three pacing knobs and the redraw counter.
   Backend restart (schema).
3. **Docs:** ROADMAP Idea 3 and the CLAUDE.md architecture notes record the
   fixed stage and event pacing (folded into PR B, replacing the planned
   Task 17).

## Out of scope

- Any camera motion on the kiosk beyond re-fits (including the planned
  `cameraTween`).
- Changing `/map`'s interactive behaviour.
- The no-key layout.
- Wall/art skins.
