# Kiosk Faceplate — design

**Date:** 2026-10-01 · **Status:** approved in brainstorm, awaiting spec review
**Scope:** the HDMI kiosk dashboard (`src/frontend/dashboard/`) and the shared
map layers (`src/frontend/map/`). The wall and art canvases are out of scope
and keep layer 1.

## Why

The admin moved to the Faceplate × Night desk language (#266–#271). The kiosk
still speaks the old "Night Watch" layer 1: Inter, all-caps legends, Signal
Amber as the lit colour, and bordered 8px plates. Next to the admin it reads as
a different product. This brings the kiosk into the admin's language and
redesigns its scanning behaviour around the LCD.

## Decisions (from the brainstorm, with mockups)

| Question | Choice |
|---|---|
| Surfaces | Dashboard + map. Wall and art stay layer 1 for now. |
| Layout | **One piece of glass**: a single LCD bottom-left is the only plate; the clock and weather are bare text top-right; the bank rail goes. |
| Map | **New ground, same pins**: the base map is retinted to Night desk; the pins keep their cream teardrops and service heads; hits keep their service colours. |
| Live mark | **The service head**: the service-coloured disc with its icon, as tall as name + frequency, left of them on the glass. |
| Idle | **A small pill** with a **sweep tick** (a short sea-glass glint sliding along its foot). It's barely visible across the room. |
| Hit | The glass **grows out of the pill's corner**, then shrinks back on release. |
| States | All twelve in-context scenes approved as a set (below). |
| Build | **Approach 1**: one shared LCD builder for the admin and the kiosk, three PRs. |

## The design

### Composition (every state)
- **Map** is full-bleed, as today (`.dash.mapStage`).
- **Clock + weather** sit top-right as bare text with a soft dark text-shadow
  so they read over any map. The time is `--kc-ink`, 700, tabular; the date ·
  temperature · wind line is `--kc-dim`. The weather icon stays (lucide).
- **The corner** is bottom-left: the pill *or* the glass, with any alert card
  stacked directly above it (bottom-aligned column, 40% of the viewport wide).
- **Top centre** holds the machine-warning pill when present.
- Nothing else floats over the map. No blur, and no full-screen overlay
  (the warm-up overlay is retired).

### The pill (idle)
A small `--kc-well` plate with the LCD bezel hairline and a light lift
shadow. Its text is one line: a state word in `--kc-dim` 600, then
`· <detail>` in `--kc-mute` 500, about `--kc-k-pill` (≈20px on the 1920 wall).
The **sweep tick** is a 2px-tall glint (18% of the pill's width, a
sea-glass gradient at ~70%) crossing the pill's foot every
`SWEEP_MS` (4.5 s), linear, animated with `transform: translateX` only. It is
drawn only while the radio is searching (scanning and retuning).

### The glass (live)
The admin LCD at wall scale, `--kc-k-glass-*` sizes:
- **Meta line:** sea-glass at 75% — `Live · <service>` left, dB right
  (tabular). Coloured words join it: hay `· Muted`, and the whole line goes
  hay for a weather break-in or coral for an error.
- **Row:** the **service head** (a disc in the `PIN_COLORS` colour with the
  pin's lucide glyph in white, the height of name + frequency), then the
  **name** in `--kc-glass-text` 700 above the **frequency** in `--kc-glass`
  800 with the one glow, four decimals, "MHz" at 0.38em.
- **Meter:** 12 sea-glass segments under the row (unlit at 14% opacity, lit
  at 100% with a faint glow). It replaces the green→amber→red LED bar. The
  dB→fill mapping stays the kiosk's current `meterPct` range (−35…+5 dB) and
  becomes a named constant.
- If the head's service colour is under 3:1 against `--kc-well` (rail
  `#8B5034` is borderline), the disc gets a hairline ring so it stays findable;
  a test asserts every `PIN_COLORS` head clears 3:1 with its treatment.

### Grow / release (the one motion)
- **Hit** (idle → live): the glass scales from 0.26 → 1 and fades in about
  the bottom-left corner over `GROW_MS` (≈420 ms), decelerating
  (`cubic-bezier(.2,.8,.2,1)`). The pill fades out and scales up slightly.
- **Release** (live → idle): the reverse over `RELEASE_MS` (≈360 ms),
  ease-in. The pill fades back.
- **Quick re-hit:** a hit within `REHIT_MS` (1 s) of a release reverses from
  wherever the shrink has got to, instead of finishing it.
- **Channel change while live:** the contents swap in place, with no regrow.
- Transform and opacity only (compositor-only, no layout). Under
  `prefers-reduced-motion` there is no scaling: the pill and glass swap
  instantly and the sweep is static.

### The twelve states
| # | State | Corner | Notes |
|---|---|---|---|
| 1 | Scanning | pill `Scanning · <band> <centre MHz>` + sweep | `spectrumLabelFor(tunedHz)` supplies the band word (sentence case). |
| 2 | Live | glass | Ring pulses on the map, as today. |
| 3 | Live, muted | glass, meta `· Muted` in hay | Replaces the red MUTED badge. |
| 4 | Scanning, muted | pill `Scanning · Muted` (hay) + sweep | Mute is visible when nothing is on air. |
| 5 | Retuning | pill `Retuning · changing windows` + sweep | Engine state "starting". |
| 6 | Standby | hay pill `Standby · no channels are on — turn a bank on in the admin`, no sweep | `scanCount === 0`. |
| 7 | Warming up | pill `Warming up · step n of m · <phase>` + 12 segments filling by step, no sweep | Replaces the full-screen boot overlay; the same instrument as the meter. Lit segments = `round(step / of × 12)`. |
| 8 | Radio error | **full glass**, coral meta `Radio error`, the error in `--kc-ink`, hint in `--kc-mute` | Worth reading from the couch. Existing hint copy, sentence case. |
| 9 | Machine warning | top-centre pill: coral text on `color-mix(coral 16%, ground)` | Replaces the full-width `--danger-800` strip; copy `Machine warning · <titles>`. |
| 10 | Break-in + warning | storm slab above the glass; glass meta hay `Weather break-in · NOAA` | The WEATHER / MONITORING mode badge folds into the meta line. |
| 11 | Watch while scanning | ringed card with slow pulse above the pill | |
| 12 | Statement while live | spine card above the glass | |

**The alert card** keeps the NWS storm palette, the three tiers and their
border semantics exactly (`alertTheme.ts` untouched). It changes only to
Schibsted, sentence case (`Warning` / `Watch` / `Statement`), the
`--kc-r-group` radius, and the stacked placement above the corner.

**No Maps key** (`.dash` without `mapStage`): the same pill/glass and alert
stack, centred on `--kc-ground`, with "Recently heard" as a `--kc-raised`
group beside them (the existing log, sentence case, in rows separated by
`--kc-line`).

### The map
- **Cartography:** `kiosk-assets/map-style.json` retinted to Night desk:
  land `--kc-ground` `#15191f`, water `--kc-well` `#0c1113`, roads
  `--kc-line`/`--kc-raised`, and labels dimmed toward `--kc-mute` (town names
  stay deliberately quiet). The README colour table is updated to the `--kc-*`
  tokens. **Manual step for the operator:** paste into the Cloud console
  style, then **Publish**. The non-Map-ID `DARK_STYLE` fallback in `map.ts` gets
  the same values.
- **Pins, blips, aircraft:** unchanged (cream teardrops, service heads,
  service-coloured hits).
- **Amber → sea-glass:** the home pin's ring, the edge glow, and the legend's
  "active" dot. The legend's close-call (`--flamingo`) and no-fix (`--pine`)
  marks keep their colours: like the service palette they identify a *kind*
  of hit, so they are recorded in DESIGN.md as map carve-outs alongside
  `PIN_COLORS`.
- The legend and the map message line move to Schibsted, sentence case,
  `--kc-*` text colours.

## Architecture

### Shared LCD (`src/frontend/faceplate/lcd.ts`)
A new frontend-only folder, `src/frontend/faceplate/`, holds what the admin and
the kiosk share. It is not `lib/`: `lib/` is also typechecked by the backend
tsconfig, which has no `vite/client` types, so it can't import `?raw` SVGs or
CSS. `lcd()` and its helpers (`meterLit`, `dbText`, the meter) move out of
`admin/ui/kit.ts` into `faceplate/lcd.ts`. The admin re-imports them with
**no visual change** (its tests and screenshots are the guard). The builder
gains:
- `head?: ServiceHead` (`{ color, glyph, ringed }`) — the service-head slot;
- `segments?: { count: number; fill: number /* 0..1 */ }` — the segmented
  meter (the admin keeps its four-bar meter; each caller owns its own
  dB→fill mapping because the scales differ);
- a `size: "panel" | "wall"` class hook (`.kc-lcd--wall`).

The LCD CSS moves from `admin/admin.css` to `faceplate/lcd.css`, scoped with
`:where(html[data-page="admin"], html[data-page="dashboard"])` so its
specificity is unchanged.

`faceplate/serviceHead.ts` maps a `PinCategory` to `{ color: PIN_COLORS[cat],
glyph, ringed }`. The glyph is extracted from the pin SVG itself
(`map/pins/pin-*.svg?raw`), so the pins stay the single source and the head
is built from the same parts. `ringed` is true when the colour is under 3:1 on
`--kc-well` (today: rail and business); a ringed head wears a 2px
`--kc-pin-cream` ring, which echoes the pin's own body.

### The corner state machine (`dashboard/corner.ts`)
A pure reducer, unit-tested headless:
`CornerState = { show: "pill" | "glass"; since: number; contentKey: string }`.
Inputs are the existing `DashState` and `now`. It decides pill vs glass
(live, error → glass; everything else → pill), whether a transition is a
grow, a release, an in-place swap (same `show`, new `contentKey`) or a re-hit
reversal (within `REHIT_MS`). The paint layer applies CSS classes;
timing lives in CSS custom properties fed from the TS constants.

### Tokens (`tokens.css` layer 2)
- A room-distance ramp: `--kc-k-pill`, `--kc-k-clock`, `--kc-k-date`,
  `--kc-k-glass-meta`, `--kc-k-glass-name`, `--kc-k-glass-freq`,
  `--kc-k-alert-title`. Values are taken from the approved mockups at
  1920×1080 and expressed in rem/clamp.
- Motion: `--kc-grow-ms`, `--kc-release-ms`, `--kc-sweep-ms`.
- The pin carve-out mirrored as tokens so CSS never carries the literal:
  `--kc-pin-cream` (`#f5ebe8`, the pin body / head ring) and `--kc-pin-glyph`
  (`#ffffff`, the head's icon stroke).
- Any new grey needed by the map legend/labels becomes a `--kc-*` token
  with its contrast recorded. No literal colour goes in a stylesheet.

### Fonts
`FONT_QUERY.dashboard` (PR 2) and `FONT_QUERY.map` (PR 3) switch to
Schibsted Grotesk (400–800), each in the PR that restyles that page. The
`media="print"` swap stays.

### What is removed
- `.bankRail` / `#bankRail` and its paint code (the window label moves into
  the pill).
- `#modeBadge` (folded into the meta line).
- `.bootMsg` overlay (warm-up moves into the pill).
- The LED meter (`.dash .meter`, its mask), `.mutedBadge`, the `.systemRisk`
  full-width strip.
- The `html[data-page="dashboard"]` Inter aliases and every layer-1 alias the
  dashboard stops using. `map.css` drops `--spark`/`--golden-amber`.

## DESIGN.md and the Layer Rule

The Layer Rule changes from "admin = layer 2, ambient = layer 1" to:
**the admin, the dashboard and the map read layer 2; the wall and art read
layer 1.** The carve-outs become: the NWS storm palette (`dashboard.css`), the
service palette (`PIN_COLORS`, pins and hits), the hit-kind marks
(`--flamingo` close call, `--pine` no fix), the pin cream, and the wall/art
canvas grounds. The "Ambient displays" section is rewritten. The dashboard
gets its own subsection: the corner, the pill, the glass at wall scale, the
grow/release motion. The Frozen-Ambient Rule narrows to wall and art.
`tokens.test.ts` keeps pinning layer 1 (wall/art still use it) and adds
contrast checks for the new tokens on `--kc-well` and the map ground.

## Delivery — three PRs (not stacked)

1. **Tokens + shared LCD** (`feat/kiosk-faceplate-tokens`).
   - `faceplate/lcd.ts` + `lcd.css`, `faceplate/serviceHead.ts`, the new
     tokens, and DESIGN.md for the shared LCD and the new tokens. The Layer
     Rule rewrite waits for PR 2, when it becomes true.
   - The admin is visually unchanged; the kiosk is not yet using any of it.
   - Proof: tests, typecheck, build, admin screenshot unchanged.
2. **The dashboard** (`feat/kiosk-faceplate-dashboard`).
   - The corner reducer and paint, the pill, the glass, all twelve states,
     the alert stack restyle, the clock, the no-key fallback, the removals,
     Schibsted on the dashboard, and the DESIGN.md Layer Rule rewrite and
     dashboard subsection.
   - Proof: tests (reducer), typecheck, build, `kiosk/reload`, `grim`
     screenshots, and a state-cycling script the operator watches:
     `/api/test/alert` × three tiers, mute on/off, live hits.
3. **The map** (`feat/kiosk-faceplate-map`).
   - `map-style.json` + README, `DARK_STYLE`, the sea-glass accents, the
     legend/message type, Schibsted on the map, and the DESIGN.md map
     carve-outs.
   - Proof: build, reload, `grim`; then the operator pastes and publishes
     the console style, followed by a `kerchunk-display` restart and a recapture.

Frontend-only throughout: no `kerchunk-kiosk` restart; `npm run test:native`
still runs per the definition of done.

## Knobs
Visual timing and sizes are named constants/tokens, not config:
`GROW_MS`, `RELEASE_MS`, `REHIT_MS`, `SWEEP_MS`, `METER_SEGMENTS`,
`METER_RANGE_DB` at the top of `dashboard/corner.ts`, mirrored as
`--kc-*-ms` in `tokens.css`; and the `--kc-k-*` sizes in `tokens.css`.
There are no new `config.json` fields; these are visual, not behavioural.

## Risks
- **Thermal:** the sweep is a perpetual animation, so the compositor never
  fully idles. It is one tiny element animating `transform` only inside an
  `overflow:hidden` box, so it stays compositor-only, but that still has to
  be measured. Before/after package temperature and chromium CPU are
  checked over 10 minutes of idle on the appliance (PR 2 proof).
- **Map console step** is manual and easy to forget to Publish (README
  already warns). PR 3 isn't proven until the operator confirms.
- **Admin regression** from the LCD move: PR 1 has no visual intent, so any
  admin diff is a bug.
