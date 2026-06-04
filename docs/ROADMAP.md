# Kerchunk Kiosk — Roadmap of Ideas

> Status: brainstorm / idea backlog (2026-06-04). Nothing here is committed
> scope. This captures four directions the operator wants to explore on top of
> the shipped v1.0 appliance, grounded in what the code actually exposes today.
> Each idea has a "what we have," a "what's missing," and a rough build shape so
> a later build/no-build call is informed.

## Where v1.0 stands (the substrate these ideas build on)

The pieces these ideas plug into already exist:

- **Channel model** (`kiosk/src/backend/config/schema.ts`): every channel has
  `freq`, `alphaTag`, `mode`, `enabled`, optional `priority`, and an optional
  `location { lat, lon, city, state, source }` populated by the RepeaterBook /
  RadioReference identification chain. Close Call discoveries carry the same
  `location` shape.
- **Live event stream** (`EngineEvent` in `ScannerEngine.ts`, fanned out over
  the WebSocket): `active` (a channel opened), `audible` (this channel owns the
  speaker), `closecall` (strong TX on a non-configured freq), `signal` (dBFS
  meter), `idle`, `status`, `error`. This is the per-hit firehose every visual
  idea below consumes.
- **RF grouping** (`grouping.ts`): channels are clustered into ~2 MHz windows
  *for the DSP* by frequency proximity. This is an engine concern, **not** a
  user-facing category — important for the "banks" idea below.
- **Two front-ends**: the fullscreen kiosk dashboard (HDMI) and the web admin
  (any device). Both are vanilla TS + Vite, no framework.

---

## Idea 1 — Banks (toggleable service groups)

**The pitch.** Group channels into named *banks* the operator can toggle on/off
as a unit — UHF and VHF first, then service-oriented banks like Air, Rail,
Marine, Public Safety, Ham, Business, NOAA/Weather. Toggling a bank off drops
its channels out of the scan (and/or off the map) in one tap instead of
enabling/disabling rows one at a time.

**What we have.** Nothing today groups channels by *service* — `enabled` is the
only on/off axis, and the only grouping is RF-proximity windows the operator
never sees. So a bank is a genuinely new, **orthogonal** concept.

**A naming subtlety worth deciding up front.** "UHF/VHF" are *frequency ranges*;
"Air/Rail/Marine" are *services*. They overlap messily (Marine VHF and the 2 m
ham band are both VHF; airband is VHF too, around 118–137 MHz AM). Two clean ways
to model it:

- **Bands = frequency ranges** (HF / VHF / UHF / 700-800), **services = tags.**
  A channel is in exactly one band (derivable from `freq`, zero data entry) and
  carries zero-or-more service tags. The operator's "banks" UI can pivot on
  either axis. Recommended — it's the most honest to the physics and the band is
  free.
- **Banks = a single freeform label per channel** ("Marine", "BNSF", "Ham 2m").
  Simpler, one field, but a channel can only live in one bank and you re-litigate
  every overlap by hand.

**Build shape.**
1. Schema: add `band` (derived enum: `hf|vhf|uhf|...`, computed from `freq`, not
   stored) and `tags: string[]` to `channelSchema`. Migration is a no-op —
   existing channels just have `tags: []`.
2. Config: a `banks` list (name, predicate over band/tags, `enabled`,
   `mapOnly` — see Idea 4) so banks are first-class and persist.
3. Engine: `groupChannels` already filters on `c.enabled`; add a bank-enabled
   filter at the same chokepoint so a disabled bank never makes it into a DSP
   window. No DSP changes.
4. Admin: a bank rail with toggles; the channel table gains a band column and a
   tags editor. Bulk "tag selected as…" action.
5. Seed: derive sensible default banks (NOAA already special-cased via
   `weatherChannel`; airband by `mode === "am"` + range; marine/rail/etc. from
   the identification `source` + range heuristics) so the operator starts with
   real banks, not an empty rail.

**Why it's high-value.** It's the connective tissue for Ideas 2 and 4 — "show
all of Rail on the map but only let Public Safety touch the speaker" only makes
sense once banks exist.

---

## Idea 2 — Live map with a blip on every hit

**The pitch.** A map (Google Maps or an open alternative) that drops a pulse at a
channel's transmitter location every time it keys up — the kiosk becomes a
real-time "where is the radio traffic right now" picture.

**What we have.** The hard part is already done: channels and discoveries carry
`location { lat, lon }`, and `active` / `audible` / `closecall` events already
stream over the WS with the channel attached. A blip is "on `active`, if the
channel has a location, pulse at that lat/lon." No new backend data path.

**What's missing.**
- **Map surface + tiles.** Google Maps JS API needs a key and is online-only —
  the appliance boots headless on HDMI and may not always have WAN. Worth an
  early decision: **Google Maps** (familiar, needs key + network + billing) vs.
  **MapLibre/Leaflet with cached tiles** (works offline, no per-load cost,
  self-hostable). For a kiosk that should keep working if the network blips, a
  cached-tile open stack is the safer default; Google can be a configurable
  provider. (See "Open question" — flagging this to the operator.)
- **Coverage gaps.** Only identified channels have a location. Un-enriched
  channels and many Close Call discoveries won't have lat/lon → either hidden or
  shown in a "no location" tray. Repeater lat/lon is the *transmitter* site, not
  the talker — honest framing in the UI ("repeater site," not "caller").

**Build shape.**
1. New dashboard panel (or a dashboard *mode* — see Idea 3) hosting the map.
2. WS already flows to the dashboard; add a reducer branch: on `active`/`closecall`
   with a location, push a `{lat, lon, alphaTag, ts, kind}` blip onto a
   short-lived list.
3. Blips pulse and fade over ~30–60 s (CSS/canvas), so the map shows "recent
   activity decaying," not a pin pile-up. Color by bank (ties to Idea 1).
4. Click/tap a blip → channel detail (last heard, count today, hear/mute toggle).
5. Optional heat accumulation: a per-site hit counter drives a heatmap layer so
   "the busy corners of the band" emerge over a session.

**Phasing.** Static map + live decaying blips is the MVP. Heatmap, history
scrubbing, and clustering are follow-ons.

---

## Idea 3 — An artistic treatment of the data on hand (brainstorm)

The scanner produces a genuinely rich, *live* data exhaust: frequency, signal
strength (dBFS), open/close timing, dwell, which bank, transmitter geography,
alpha tags, Close Call surprises. That's raw material for something beautiful on
a screen that's on 24/7. Brainstorm, roughly easiest → most ambitious:

- **Spectrum aurora / waterfall-as-art.** A slow vertical waterfall where each
  band group is a horizontal lane; signal strength drives hue and bloom. Less
  "FFT readout," more "northern lights that happen to be the radio." Cheapest win
  — `signal` events already carry dBFS.
- **Channel constellation.** Each channel is a star, positioned by frequency
  (angle) and bank (radius), brightness = how recently it was heard, twinkle on
  a hit. Over an evening the sky lights up where the traffic is. Maps cleanly
  onto data we already have, no geo needed.
- **Activity bloom / generative garden.** Each transmission grows a stroke,
  petal, or ripple; busy channels grow denser "plants." A quiet night is sparse;
  a fire callout is a sudden bloom. Resets daily — the art *is* the day's
  traffic.
- **Geographic light-painting.** The Idea-2 map, but stylized: blips leave
  fading light trails, the city glows where the radio is alive. Map + art are the
  same surface in two skins.
- **Sonification / ambient layer.** Beyond the demod audio, a subtle generative
  tone bed driven by activity density — felt, not foreground. (Careful: the
  speaker's day job is the actual transmissions; this is a "weather-only-mode"-
  style optional layer.)
- **Today-in-numbers / data poster.** A quietly typeset "front page": busiest
  channel, longest silence, first Close Call of the day, most-active bank,
  rendered like a newspaper masthead. Exportable as an image — a daily artifact.
- **The kerchunk wall.** Literal to the name: every brief key-up (a kerchunk)
  drops a tally mark / ripple. A visual record of every "anyone there?" the radio
  heard.

**Build shape.** These share one input — the existing WS event stream — and one
home: a **dashboard "screensaver"/ambient mode** that the kiosk falls into after
N seconds of speaker silence and snaps out of the instant a channel opens. That
gives the art a job (fill the quiet) without ever hiding live activity. Start
with one (constellation or aurora — both need only `signal`/`active`, no geo),
make it a pluggable `mode`, add more as skins.

**Recommendation.** Pick the **constellation** or **kerchunk wall** first: both
are pure-data (no Google dependency, no geo coverage gap), visually distinct, and
directly thematic to the project's name.

---

## Idea 4 — Hear vs. see: decouple audio from visibility

**The pitch.** "See all, hear only select." Today `enabled` conflates two things:
*does this channel get a DSP slot and the speaker* vs. *does it show up on the
map / in the art*. The operator wants the map to show **everything** that's
active while the speaker stays curated to a chosen few.

**What we have.** One axis (`enabled`) doing double duty. Cleanly splitting it is
mostly a UX + plumbing change.

**The model.** Two independent flags per channel (and per bank, from Idea 1):

| | Audible | Visible |
|---|---|---|
| **What it gates** | DSP slot + squelch + speaker ownership | map blip + art + activity log |
| **"Hear & see" (today's `enabled`)** | ✓ | ✓ |
| **"See only"** | ✗ | ✓ |
| **"Off"** | ✗ | ✗ |

**The catch worth being honest about.** "See it but don't hear it" still requires
the engine to *detect* the channel opening — and the wideband engine only knows a
channel is active because it's demodulating it in a window. So "visible but not
audible" isn't free: the channel still needs a channelizer lane; we just don't
route its audio to the speaker. That's cheap (mute the lane) but **not** zero —
it still costs a slot in its band group. Two honest tiers:

- **Visible-muted** (cheap-ish): channel stays in the scan and is demodulated, so
  we see every hit, but its audio is gated out of speaker ownership. Costs a
  DSP slot.
- **Visible-via-Close-Call** (free): don't scan it at all, but let the existing
  Close Call FFT (`closeCall` events) surface it on the map when it's strong
  enough. No slot cost, but only catches strong TX and only on the currently
  tuned window — lossy by nature.

Worth surfacing both to the operator so "see all" doesn't quietly imply "demod
all," which the hardware can't always afford.

**Build shape.**
1. Schema: rename the concept — keep `enabled` meaning *audible*, add
   `visible: boolean` (default = `enabled` for a clean migration). Or introduce a
   single `mode: "hear" | "see" | "off"` enum and derive both — cleaner UI, one
   control.
2. Engine: `audible` event/ speaker-ownership logic respects `visible && audible`;
   the `active`/`closecall` → map/art path respects `visible`. The grouping
   filter (Idea 1) includes any channel that is audible **or** visible-muted.
3. Admin: the channel table's enable toggle becomes a tri-state (Hear / See /
   Off); banks get the same tri-state for bulk control.
4. Ties to Idea 1 and 2: "show all of Marine on the map, only let Public Safety
   reach the speaker" = set the Marine bank to *See*, Public Safety to *Hear*.

---

## Suggested sequencing

These interlock; a sensible order:

1. **Banks (Idea 1)** — the data backbone; banks + tags + derived band. Unlocks
   bulk control and gives Ideas 2/4 something to pivot on.
2. **Hear-vs-see (Idea 4)** — small schema change once banks exist; immediately
   useful on its own (mute noisy channels but keep logging them).
3. **Map (Idea 2)** — the first big visual payoff; color blips by bank,
   visibility-gated by Idea 4. Decide the tile-provider question first.
4. **Artistic mode (Idea 3)** — an ambient/screensaver mode that reuses the same
   event stream; ship one skin, grow the gallery.

## Open questions for the operator

- **Map provider:** Google Maps (familiar, but needs an API key, billing, and a
  live network) vs. MapLibre/Leaflet with cached tiles (offline-safe on a
  headless kiosk). Which matters more — Google specifically, or the map working
  when the network doesn't?
- **Banks model:** frequency-band + service-tags (recommended, two axes) vs. a
  single freeform bank label per channel (simpler, one axis)?
- **"See all" cost:** is "visible-muted but still demodulated" (costs DSP slots,
  catches every hit) acceptable, or should "see only" mean
  "Close-Call-discovered-only" (free, but lossy)?
- **First art skin:** constellation, kerchunk wall, aurora/waterfall, or the
  daily data poster?
