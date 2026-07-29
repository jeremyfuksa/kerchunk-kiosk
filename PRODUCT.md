# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

**One person — the author, who built it and lives with it.** Both surfaces
serve that same person; there is no second audience. Confirmed: the kiosk is in
the author's **office**, not a shared or public space, and nobody else
configures or triages.

The relationship is closer to owning a piece than operating a tool. The kiosk
is on most of the time and mostly *watched* rather than used; the admin is
picked up to adjust something and put down again.

The consequence is that neither surface has to explain itself. Density is
correct, domain vocabulary is correct, and there is no newcomer to onboard.

The operator reads the product at two distances, and both are primary:

- **Across a room, without touching anything.** The HDMI wall is glanced at
  while doing something else, usually while the radio is talking.
- **At arm's length, to change something.** The admin is used from a phone
  standing next to the radio, and from a laptop on the bench.

## Product Purpose

**Kerchunk is a piece of data art.** In the author's own words it is "a kiosk
for my office that feels like a control center for every radio signal in the
Kansas City metro," and "a piece of data art that tells a real story about
what's moving across the invisible airwaves over Kansas City."

The subject is **the invisible layer over one city** — fire dispatch, a
hospital, a rail yard, a business, a ham repeater, an aircraft overhead — made
visible and audible in one place, continuously. Radio is the *mechanism* that
gets at that subject. It is not the point, and this document has already been
wrong once by treating it as the point.

The turn that defined the project is recorded plainly: "As the map filled, it
stopped being a scanner readout and turned into something closer to data art."
Anything that pushes it back toward reading as a scanner readout is moving
against the work.

Success is: the piece is worth having on the wall, it tells a true story about
the city continuously without being tended, and the parts that turned out to be
genuinely useful stay useful — the weather warnings arrive "faster than the
warnings on my phone."

## Positioning

**Six disparate data feeds fused into one story about one city.** The stated
ambition was "to find out how far I could push six disparate data feeds into
something that tells a story," and the design intent is explicitly a density
question: "how far I could push the amount of data on the map while keeping it
useful and well-designed." Density is a goal here, not a hazard to be reduced.

The technical mechanism that makes the density possible — and which a
neighbouring product could not truthfully copy — is **simultaneous wideband
demodulation instead of sequential scanning.** A conventional scanner visits
frequencies one at a time and misses whatever starts while it is elsewhere.
Kerchunk demodulates up to 12 channels at once from a single tuned window, so
within a band group there is nothing to miss. Two things follow from that
architecture rather than being bolted on:

- The SDR is opened **once per boot** and retuned live between band groups,
  structurally eliminating the USB re-open thrash that destabilises
  `rtl_fm`-style scanners.
- **Close Call** watches the whole tuned window with the same FFT, so
  discovering unknown activity is a property of how the radio works, not a
  separate mode to switch into.

It is **receive-only**. Nothing here transmits, there is no callsign in play,
no contact is made and no station is worked. The relationship to every source
on the map is one-way: the city talks and this listens.

## Origin

Kerchunk began as *Bearpaw*, software to drive an old Uniden scanner. Once the
basic functionality was replicated the question that redirected the project
was: "Why not have the system go get it for you?" — automating the lookup
instead of operating the radio by hand. Bearpaw was shelved and the work
pivoted to SDR dongles and, in the author's phrase, "the ultimate visual
display."

That history is the reason the identification chain exists and the reason the
map is the centrepiece rather than a feature.

## Operating Context

- **A 24/7 appliance, not an app.** Lid-closed Ubuntu laptop (2014 MacBook
  Pro, i7-4770HQ), RTL-SDR dongles addressed by EEPROM serial, external
  monitor on HDMI, systemd-managed, never sleeps.
- **Thermally constrained, and this is a design input.** The machine runs
  ~82–83 °C steady state, roughly 1 °C under a 90 °C safety trip. Expensive
  visual effects are a functional hazard, not a matter of taste. Restarting
  the backend respawns the DSP helper (~2.7 cores of flowgraph rebuild),
  spikes thermals and interrupts live audio, so restarts have a real cost.
- **The wall is output-only.** No mouse, no keyboard, no pointer of any kind.
  Every state it can show has to be reachable without interaction, and
  previewing a state means driving it server-side.
- **Two services**: the backend, and a separate Chromium session that renders
  the wall. Either can be restarted without the other.
- **Two radios, one antenna.** A scanning SDR and a low-rate decode-only NOAA
  monitor share an antenna through a splitter. The weather radio watches for
  SAME/EAS; an alert re-points the live flowgraph mid-transmission.
- **Development happens on the appliance itself**, and changes are verified
  against real hardware — by ear for anything audible, by eye on the real
  display for anything visual — usually within minutes of being made.

## Capabilities and Constraints

**Surfaces.** A dashboard (the HDMI wall; when a Maps key is configured the
fullscreen activity map *is* the dashboard), a web admin usable from any
device, two ambient canvas skins, and a standalone map page.

**Technical constraints that bound design work:**

- TypeScript backend (Node ≥24, ESM) with vanilla-TS/Vite frontends. **No
  frontend framework** — vanilla TS only.
- Icons come from `lucide-static` only. No hand-rolled SVG, and no typed
  characters standing in for glyphs.
- **Dark-only.** There is no light theme and no theme switch; the use scene is
  a dim room and a wall-mounted panel.
- No `backdrop-filter`, blur, or full-screen overlay above the animating map —
  measured at +6 °C on this hardware.
- Config is the single source of truth: one zod-validated file on the
  appliance. Every secret lives there, never in env vars and never in the repo.
- **The HTTP API has an external consumer.** A public website polls several
  endpoints over a private tailnet, sequentially — the appliance has been
  observed to deadlock on concurrent requests. Those response shapes are a
  contract, not internal surface.

**Operator vocabulary.** These are the words the domain uses and the words the
operator thinks in; they are not jargon to be simplified away: *kerchunk,
Close Call, discovery, triage, bank, lockout, alpha tag, dwell, hang time,
squelch, quieting, SAME/EAS, QTH, break-in, group-hop, audible, archived.*

**Domain facts any design must respect:**

- Frequencies render to four decimals. Scanner frequencies sit on a 12.5 kHz
  raster, and fewer decimals misrepresent them.
- National Weather Service storm colours and severity conventions are
  externally mandated. They are not restyled toward house rules, because an
  operator reading a tornado warning is relying on a colour they already know.

**Explicitly undecided:** whether Kerchunk becomes something other people
install. Today it is a single appliance for one operator, but the setup path
should keep working for someone else, so location, hardware and personal
habits should not be baked in where avoiding that is cheap. It is not a
product, and first-run/activation is not currently a design problem being
solved.

## Brand Commitments

- **Name:** Kerchunk — a radio term, the sound of keying up a repeater.
- **Campfire**, the operator's own design system, currently supplies the
  palette and ramps as an npm dependency. Confirmed: **Campfire is not frozen
  for this work.** A redesign may push new values back into Campfire and the
  two may evolve together. Changes ripple to anything else consuming Campfire,
  and that is an accepted cost.

- **"Control center."** The author's own stated register for the kiosk: it
  should feel "like a control center for every radio signal in the Kansas City
  metro." Recorded as volunteered, not expanded — it names the feeling the
  piece is going for, and design work should treat it as a given rather than
  something to re-litigate.

No other identity constraint, required asset, or reference has been made
binding.

## Evidence on Hand

- **Live hardware carrying real traffic**, continuously. A real ~97-channel
  Kansas City-area library across air, rail, ham, GMRS, business, public
  safety and NOAA; thousands of real hits per day; real SAME/EAS alerts.
- **Working identification chain** against live third-party sources, with one
  provider dormant pending a token.
- `docs/ROADMAP.md` is the backlog and the record of design decisions already
  made. `docs/API.md` documents the HTTP/WS surface.
- **What does not exist:** there are no users besides the operator, no
  testimonials, no customers, no benchmarks against other scanners, no
  pricing, and no third-party deployments. Future work must not invent them.

## Product Principles

1. **The screen is the work; the radio is how it gets its material.** The map
   filling with real traffic is the artifact, not a readout of a machine that
   lives elsewhere. Anything that makes it read as a scanner readout again is
   moving against the project. *This principle previously said the opposite,
   and that error produced a run of work aimed at the wrong subject.*
2. **Density is the ambition, not the hazard.** The stated goal is how much
   data can go on the map while staying useful and well-designed. Reducing,
   simplifying and calming are not automatically improvements here; the bar is
   more signal held legibly, not less signal shown.
3. **The radio's stability is a hard floor under all of it.** No surface may
   cost audio quality, thermal headroom or engine stability to render. This
   bounds how the work is built; it is not what the work is about.
4. **Two distances, one known audience.** The office kiosk is watched from
   across the room, ambiently, for long stretches without interaction. The
   admin is picked up at arm's length to adjust something and put down again.
   Both reads are primary and neither may be sacrificed for the other. Because
   the audience is one person who built it, domain vocabulary is correct and
   onboarding, hand-holding and explanatory chrome are not — though the
   specific location and hardware should not be hardcoded where avoiding that
   is cheap.
5. **Prove it on hardware, in small steps.** Anything audible is verified by
   ear and anything visual on the real display, within minutes. Fixing what
   exists beats adding surface area, and ideas deliberately set aside stay set
   aside.

## Accessibility & Inclusion

- Dark-only is a deliberate product decision for the use scene, not an
  oversight or an unfinished theme.
- Text must clear 4.5:1 and interactive edges 3:1. This is driven by the
  physical situation — a dim room, and surfaces read from across it — as much
  as by standards.
- Coarse-pointer targets are ≥44px in the admin; phone use is a primary path,
  not a fallback.
- `prefers-reduced-motion` is honored on the kiosk surfaces.

No user-specific accessibility requirement beyond the above has been
established.
