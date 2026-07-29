# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

**One operator — the person who built the appliance and runs it.** Both
surfaces serve that same person; there is no second audience. Confirmed: the
wall display is a personal instrument in the operator's own space, not a shared
or public display, and nobody else configures or triages.

The consequence is that neither surface has to explain itself. Density is
correct, domain vocabulary is correct, and there is no newcomer to onboard.

The operator reads the product at two distances, and both are primary:

- **Across a room, without touching anything.** The HDMI wall is glanced at
  while doing something else, usually while the radio is talking.
- **At arm's length, to change something.** The admin is used from a phone
  standing next to the radio, and from a laptop on the bench.

## Product Purpose

Kerchunk is a software-defined-radio scanner **appliance**. One persistent GNU
Radio flowgraph samples a ~2 MHz window and demodulates every channel in it
simultaneously, so there is no scan latency and no missed burst inside a band
group. It runs continuously, boots lid-closed straight to a fullscreen
dashboard on an external monitor, and is administered over the network.

Success is: the operator hears what matters, can tell what the radio is doing
from across the room without interacting with it, and can retune, triage or
reconfigure from any device without interrupting the audio.

## Positioning

The mechanism a neighbouring product could not truthfully copy: **simultaneous
wideband demodulation instead of sequential scanning.** A conventional scanner
visits frequencies one at a time and misses whatever starts while it is
elsewhere. Kerchunk demodulates up to 12 channels at once from a single tuned
window, so within a band group there is nothing to miss.

Two things follow from that architecture rather than being features bolted on:

- The SDR is opened **once per boot** and retuned live between band groups,
  structurally eliminating the USB re-open thrash that destabilises
  `rtl_fm`-style scanners.
- **Close Call** watches the whole tuned window with the same FFT, so
  discovering unknown activity is a property of how the radio works, not a
  separate mode the operator switches into.

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

1. **The radio is the product; the screen reports it.** No surface may cost
   audio quality, thermal headroom, or engine stability to render. When
   presentation and the radio conflict, the radio wins.
2. **Tighten before expanding.** Fixing what exists beats adding surface area.
   Ideas that have been deliberately set aside stay set aside.
3. **Built for one known operator in a known room.** Density and domain
   vocabulary are right; onboarding, hand-holding and explanatory chrome are
   not. Avoid hardcoding the specific location or hardware where avoiding it
   is cheap, but do not design for a hypothetical stranger.
4. **Two distances, both primary.** The wall answers "what is the radio doing"
   from across a room with no interaction. The admin answers "change this" on
   a phone held at arm's length. Neither read may be sacrificed for the other.
5. **Prove it on hardware.** Anything audible is verified by ear and anything
   visual on the real display, within minutes. Design for live verification
   rather than for review in the abstract.

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
