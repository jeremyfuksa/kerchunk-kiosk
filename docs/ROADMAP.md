# Kerchunk Kiosk — Roadmap of Ideas

> Status: brainstorm / idea backlog (2026-06-04). Nothing here is committed
> scope. This captures the directions the operator wants to explore on top of
> the shipped v1.0 appliance — four headline ideas (banks, live map, artistic
> mode, hear-vs-see) plus the adjacent items that fall out of them (Ideas 5–9) —
> grounded in what the code actually exposes today. Each idea has a "what we
> have," a "what's missing," and a rough build shape so a later build/no-build
> call is informed.

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

## Idea 1 — Banks (toggleable service groups) — *SHIPPED 2026-06-04/05*

> Shipped as band+tags predicates with off-wins (PR #36-era), then evolved:
> per-bank scan profiles (Idea 7, PR #54), loHz/hiHz range predicates and a
> SERVICE-ONLY mixer after the operator's design review (PR #57) — spectrum
> became a computed read-only chip on the kiosk rail, not a toggle.

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
sense once banks exist. It's also the unit that eventually binds to a physical
radio: assigning a bank to its own SDR is the endpoint of this track (Idea 10).

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

**Pin vocabulary — encode each dimension on its own visual channel.** The map has
several categorically different things to show at once; one pin style for all of
them is unreadable. The blip object already carries a `kind` — lean on it, and
spread the distinctions across independent visual channels so the map reads at a
glance:

- **Glyph / shape → *what kind* of hit it is** (the `kind` field). The distinction
  that earns the most is **configured-channel hit vs. Close Call discovery** —
  "a channel I chose" vs. "something new the radio just found" should never look
  alike. Beyond that, the naturally-separate layers get their own glyphs:
  **aircraft** (ADS-B, Idea 13), **mesh nodes** (Meshtastic, Idea 14), and the
  **affected-county / weather-alert** marker (SAME, Idea 11).
- **Color → bank / service** (Idea 1): air / rail / marine / public-safety / ham
  each a hue (colorblind-safe palette). This is the existing "color by bank" —
  *don't* also vary glyph by bank; that's what color is for.
- **Motion → audibility** (Idea 4 + the see-only refinement): audible = framed
  *and* ring; see-only = ring only, camera held.
- **Decoration → state**: a priority halo, the shipped **NO-FIX ring** for
  unlocated hits, a pulsing treatment for an active weather warning.

Restraint is the whole game: a small, legible legend (a handful of glyphs × bank
colors), not a glyph per bank. Pure frontend — the renderer maps
`kind → glyph`, `bank → color`, `audible → motion`, `flags → decoration`; no new
backend data (bank comes from Idea 1, audibility from Idea 4).

**This needs an extended Campfire palette (prerequisite).** Color-by-bank only
works if the colors are genuinely tellable apart — and Campfire's *semantic*
tokens (primary / accent / success / warn / danger / neutral) are not a
*categorical* scale. The prerequisite is a dedicated **categorical palette** in
the Campfire tokens: ~8–10 perceptually-separated, **colorblind-safe** hues
(survive deuteranopia — no red/green-only distinctions) that hold up on the dark
map-stage background and stay distinct at small pin size and at a glance. Define
the **bank → color mapping once** (rail = amber, marine = blue, …) as the single
source of truth and reference it *everywhere the same category appears* — map
pins, the bank rail/toggles (Idea 1), the legend, and the art skins (Idea 3) — so
a bank is the same color across the whole UI. It's a design-system task that
underpins Idea 1 and this pin vocabulary both.

**Accessibility — color is never the only cue.** The layered encoding above is
already half the a11y story; make the rest explicit:

- **Don't encode meaning by color alone (WCAG 1.4.1).** Glyph carries *type* and
  motion carries *audibility*, but *bank* rides on color only — so it needs a
  **redundant non-color cue**: the pin's text label / callout, the always-visible
  legend, or a secondary pattern. Someone with color-vision deficiency (CVD —
  ~8% of men) must be able to tell banks apart without relying on hue.
- **Start from a CVD-safe categorical set, then verify.** Don't hand-pick hues
  off a color wheel; begin from a palette engineered for color-universal design —
  the **Okabe–Ito** 8-color set is the canonical reference — and check it under
  *protan / deutan / tritan* simulation (not just deuteranopia). Maximize
  perceptual separation (Lab / CIEDE2000 distance), not even hue spacing.
- **Non-text contrast ≥3:1 (WCAG 1.4.11).** Pins are graphical objects over a
  variable dark map; give each a consistent **outline/halo** so it clears 3:1
  against whatever tile sits behind it and stays separable from adjacent pins.
- **`prefers-reduced-motion`.** Since motion encodes audibility (ring/pulse), a
  reduced-motion user needs that distinction shown *without* animation — a static
  ring or weight difference. Same redundancy principle as color.
- Optional **high-contrast / a11y mode** honoring `prefers-contrast`.

**Weather radar overlay.** The map can carry a live NEXRAD radar layer — a
semi-transparent raster tile layer drawn above the base map and below the blips.
Mechanically small: both the open stack (`L.tileLayer.wms(...)` / an XYZ layer in
Leaflet/MapLibre) and Google Maps (`ImageMapType`) take it in a few lines, and
everything's Web Mercator (EPSG:3857) so it aligns automatically. Source options,
ranked by fit:

- **NOAA / NWS NEXRAD (most on-brand).** `weather.ts` already pulls keyless NWS
  data (its comment: *"free, keyless, government data — exactly right for an
  appliance"*). The **Iowa Environmental Mesonet (IEM) NEXRAD WMS** is the
  keyless, free, US-wide radar service hobby maps use; NOAA nowCOAST is the
  official WMS equivalent. No key, US coverage (fits the US-only framing).
- **RainViewer** — best for *animation*: a free tile API that returns timestamped
  past frames (and short-range forecast frames) for "last hour of rain" loops.
  Global, simple URLs, free tier (optional key).
- **OpenWeatherMap** precipitation layer — works but needs a key; least aligned
  with the keyless ethos.

Caveats: **online-only** — unlike base tiles (cacheable for offline kiosk use),
radar is live and can't meaningfully be cached, so it degrades to "not shown"
without WAN. **Refresh cadence** ~4–6 min (NEXRAD volume scans); re-fetch on a
timer. Plus attribution. The payoff is the cross-tie to **SAME alerts
(Idea 11)**: when a warning decodes for the operator's county, pin the affected
FIPS county *and* show it under live radar — the overlay makes the alert spatial
instead of just text.

**Phasing.** Static map + live decaying blips is the MVP. Heatmap, history
scrubbing, the radar overlay, and clustering are follow-ons.

---

## Idea 3 — An artistic treatment of the data on hand (brainstorm)

> **Operator note (2026-06-05, after living with the map-stage kiosk):**
> absolute low priority, and the premise needs a rethink before any build.
> KC-metro traffic is too sparse for live-decay visuals to ever feel alive —
> most of the time the map shows antennas with no blips, because each hit
> fades before the next arrives. Whatever the artistic treatment becomes, it
> can't depend on constant traffic; it has to make SPARSE activity beautiful
> (accumulation, memory, replay — not decay). Way down the line.

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

## Idea 4 — Hear vs. see: decouple audio from visibility — *SHIPPED 2026-06-05*

> Shipped as the enabled+audible tri-state (Hear/See/Off) with mute-wins
> bank semantics; visible-muted tier chosen (SEE costs a DSP lane, catches
> every hit). Now also the substrate for alert pull-ins and CC triage
> verdicts.

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

**Map-stage behavior — the camera follows the ear, not the eye (operator note,
2026-06-06).** On the shipped map-as-stage kiosk, an audible hit earns the stage:
the auto-fit framing zooms/pans to it because it's what you're hearing. A
**see-only** hit must NOT move the camera — otherwise a whole *See* bank would
constantly yank the view toward channels the operator isn't even listening to.
Instead, a see-only hit just plays a **blip-ring animation** (an expanding ripple
that fades) at the transmitter site, in place, leaving the camera where it is.

- **Audible hit** → frame it (existing auto-fit) *and* ring it.
- **See-only hit** → ring only; camera stays put.

This keeps the stage calm and meaningful — movement is reserved for what's on the
speaker, while the rings still register "something was seen here." It also plays
nicely with the Idea 3 sparse-traffic note: rings read as deliberate punctuation
rather than a camera that twitches at every distant, unheard opening. Build: gate
the map's framing/auto-fit on `audible` events; render `active`-but-visible-only
hits as a non-camera ripple layer.

---

## Idea 5 — Persistent activity history (the keystone) — *SHIPPED 2026-06-05*

> node:sqlite store (events + durations, 30-day retention), /api/history +
> /sites + /stats. Proved keystone as predicted: map antennas/heat, Insights,
> alert feed, SAME proof-of-life, and the ERP estimator all ride it.

**The pitch.** Keep a durable record of every channel opening that survives a
reboot, so the map can replay, stats can be computed, and alerts can be reviewed.

**What we have.** `ActivityLog` (`kiosk/src/backend/activityLog.ts`) is a pure
in-memory ring buffer — `add()` unshifts onto an array capped at `capacity`, and
the whole thing is lost on restart. The events it records (`freq`, `alphaTag`,
`ts`) already flow from the engine; nothing persists them.

**Why it's the keystone.** Map replay (Idea 8), stats (Idea 9), and "review the
alert that fired while I was away" (Idea 6) all need history that outlives the
process. Build this first and the rest become mostly queries.

**Build shape.**
1. A small append-only store on the appliance's writable partition — SQLite is
   the obvious fit (one file, queryable, no server, already the right shape for
   "events with a timestamp, freq, bank, location"). Row per opening:
   `{ ts, freq, alphaTag, bank, lat, lon, durationMs?, audible }`.
2. Tee the existing `active`/`audible`/`closecall` event path into the store
   alongside the in-memory ring buffer — the ring buffer stays as the hot "recent
   activity" cache for the dashboard; the store is the durable tail.
3. Retention policy (rolling N days, or cap by row count) so an always-on kiosk
   doesn't grow the card without bound — matters given the read-only-rootfs /
   small-writable-partition appliance design.
4. A read API (`/api/history?since=…&bank=…`) the map, stats, and admin consume.

---

## Idea 6 — Alerts / notifications — *SHIPPED 2026-06-05 (PR #47)*

> channel.alert flag, kiosk banner, see-only speaker break-in (helper
> alert_unmute), admin alert feed, ntfy push, cooldown/hold knobs. SAME
> (Idea 11) reuses this exact plumbing as its action side.

**The pitch.** The counterpart to "see-only" (Idea 4): some channels you don't
listen to live but still want to be *pulled into* when they key up — a watched
tac channel, a Close Call discovery, a weather alert. Flash the dashboard, chirp
the speaker, and/or push to a phone.

**What we have.** Close Call already preempts the speaker for discoveries, so the
"interrupt me" plumbing partly exists. The event stream carries everything an
alert rule needs (channel, bank, freq, signal). No persistence required for the
fire itself, but reviewing missed alerts wants Idea 5.

**Build shape.**
1. Per-channel / per-bank `alert` flag (a third axis alongside hear/see, or a
   property of a bank).
2. Alert actions, escalating in cost: visual (dashboard flash / toast), audible
   (brief tone or unmute-and-listen), push (a notification channel — ntfy,
   webhook, or the session's push path).
3. Rule conditions worth having: "any hit," "first hit in N minutes," "signal
   over X dB," "this specific bank only." Keep it small — a couple of conditions,
   not a rules engine.
4. An alert feed in the admin (backed by Idea 5) so the operator can see what
   fired while they were away.

---

## Idea 7 — Per-bank scan profiles — *SHIPPED 2026-06-05 (PR #54)*

> The design pass resolved the mixed-window caveat: squelch trio (open/
> quieting/hang) applies per CHANNEL, dwellWeight per WINDOW (max across
> its channels), field-wise first-match in config order. Per-bank gain
> deferred to Idea 10 (device property); bank priority + audio trim cut.

**The pitch.** Different services genuinely want different radio settings:
airband is AM with its own squelch/gain regime; marine VHF wants its own volume;
public-safety might warrant tighter Close Call. Once banks exist (Idea 1),
attach settings *per bank* instead of only the single global `scan` block.

**What we have.** `configSchema.scan` is one global block (`squelchLevel`, `gain`,
`dwellMs`, `openAboveFloorDb`, `noiseQuietDb`, Close Call knobs). Channels carry a
learned per-channel `levelTrimDb` already, so per-group audio normalization has
precedent — but squelch/gain/dwell are global today.

**Build shape.**
1. Optional per-bank overrides: `{ squelch?, gain?, volume?, priority?,
   dwellWeight?, closeCall? }`, falling back to the global `scan` block when
   unset (so existing configs are unaffected).
2. Engine: when a group is assembled from a bank's channels, apply that bank's
   overrides at tune/squelch time. `dwellWeight` feeds the group-hop scheduler so
   a busy bank (e.g. public safety) gets more dwell than a quiet one.
3. Admin: per-bank settings drawer next to the bank toggle (Idea 1).

**Caveat.** A DSP window can span channels from more than one bank (grouping is
by RF proximity, not bank), so per-bank squelch/gain has to resolve sensibly when
a window is mixed — likely "apply per-channel where the override is squelch-like,
per-group for tune-time settings." Worth a design pass, not free.

---

## Idea 8 — Map history, replay & click-to-listen — *resolved 2026-06-05*

**The pitch.** Deepen the map (Idea 2) with time: a scrubber to replay the last
hour, a heatmap of busy transmitter sites, and click-a-blip-to-hear-it — which is
the hear/see toggle (Idea 4) applied to a pin.

**Resolution (operator decisions, after the kiosk became the map's primary
home — an output-only surface):**

- **Heatmap: SHIPPED.** Per-site golden-amber glow discs under the antenna
  icons, scaled by 30-day hit counts (log scale). Not Google's HeatmapLayer
  (deprecated May 2025); the glow rides the existing antenna layer.
- **Click-to-listen: DROPPED.** The kiosk has no pointer, and the browser
  user already has the admin (Listen button, hear/see tri-state) one tab
  over — a parallel control path on the map is duplicate affordance.
- **Time scrubber: DEFERRED, mutated.** As a slider it's a browser toy; the
  kiosk-native version is an ambient **auto-replay** — when the band is
  quiet, replay the last hours' blips on a loop, snap to live on any
  activity. That folds into **Idea 3** as the map-skin ambient mode.

---

## Idea 9 — Stats & insights — *SHIPPED 2026-06-05 (PR #42)*

> Admin Insights panel: totals/airtime/discoveries, top channels, by-tag/
> band, hour-of-day clock; 24h/7d/30d periods. Doubles as Idea 3's data
> source, as planned.

**The pitch.** "Busiest channel today, busiest bank, quietest hours, first Close
Call of the day." A quiet analytics surface over the persisted history.

**What we have.** Nothing today (history is RAM-only). Once Idea 5 lands, this is
almost entirely queries — no new capture path.

**Build shape.**
1. A handful of aggregate queries over the history store (counts by channel /
   bank / hour, longest silence, discovery timeline).
2. An admin "Insights" panel; numbers double as the data source for the artistic
   "daily poster" skin in Idea 3 — same queries, two presentations.

---

## Idea 10 — Multi-SDR: bind a bank to a radio

**The pitch.** Eventually each bank should be assignable to a *physical SDR*.
Plug in a second (third…) dongle, hand Air to one and VHF to another, and those
banks are monitored **continuously and in parallel** — no group-hop between
distant bands. This is the natural endpoint of the banks concept (Idea 1) and the
README's existing post-MVP line, "second SDR (eliminates group-hop)."

**Why banks are the right unit.** A single dongle's ~2.4 MHz window can't span
airband AM (~118–137 MHz), VHF marine/rail (~150–162 MHz), and UHF (~450 MHz) at
once, so today's engine *group-hops* one radio across those windows and you miss
whatever fires on the bands it isn't parked on. Services cluster far apart in
frequency — which is exactly the boundary banks already draw. Assigning a bank to
its own radio turns "hop between services" into "watch every service at once."
It also unlocks **per-bank antennas**: an airband antenna on the airband dongle,
a UHF whip on the UHF dongle — each SDR has its own SMA.

**What we have (and what blocks this today).**
- The DSP helper opens `soapy.source("driver=rtlsdr", …)` (`wideband_helper.py`)
  with **no serial** — it grabs the first dongle it finds. Multi-device needs
  explicit addressing (`driver=rtlsdr,serial=…`; serials are settable via
  `rtl_eeprom`).
- `WidebandEngine` spawns exactly **one** helper and owns **one** group-hop loop
  (`groups` / `groupIndex`). Multi-SDR means N helpers, each on a distinct
  device, each hopping only within its assigned banks' windows.
- Speaker ownership / priority arbitration is currently within one engine. With
  several radios able to open a channel simultaneously, arbitration becomes
  **cross-device** (one speaker, N candidate audibles) — the part that needs the
  most thought.

**Build shape.**
1. Schema: a `radios` list (`{ id, serial, label, gain?, antenna? }`) and an
   optional `radioId` on each bank. Unassigned banks share a default radio and
   keep hopping among themselves — so one dongle still works exactly as today.
2. Engine: promote the single helper to a **pool**, one helper per configured
   radio, each fed only its banks' channels through the existing `groupChannels`
   path. Each helper retunes/hops independently; a bank that owns a radio and
   fits one window never hops at all.
3. A cross-device **audio arbiter** in front of the ALSA sink: collects audibles
   from every helper, applies priority + Close Call preempt across radios, and
   grants the speaker to one. (Today each helper plays straight to ALSA — that
   has to move behind the arbiter, or each radio gets its own sink/output.)
4. Admin: a radios panel (detect connected dongles by serial, label them) and a
   radio dropdown on each bank.

**Cost / limits to be honest about.** Each dongle is another ~4.8 MB/s of USB I/Q
*and* another full channelizer flowgraph — CPU and USB bandwidth are the ceiling,
and the appliance is a 2014 laptop. Realistically 2–3 radios, not ten. This is
also the feature that makes **per-bank gain (Idea 7)** fully real: gain is a
hardware property of a *device*, so per-bank gain is only truly independent once
a bank owns its radio (on a shared, hopping radio it's still per-group).

**Antenna sharing — how many SDRs can feed off one antenna.** A decision that's
easy to forget until three dongles are already on the bench. Short answer:
*passively ~2 (maybe 4 with compromises); actively 4–8–16 cleanly.* Two separate
problems cap the passive case:

- **Split loss (physics).** A passive splitter divides power: every 2-way split
  is ~3.5 dB down, a 4-way ~6–7 dB. RTL-SDR front-ends are already noisy, so
  throwing away signal before the dongle hurts exactly the weak/fringe reception
  this radio is weakest at.
- **LO leakage / port isolation (the sneaky one).** An RTL-SDR isn't a silent
  passive load — the R820T2 tuner leaks local-oscillator energy back *out* the
  antenna port. Through a dumb splitter (poor port-to-port isolation) each
  dongle's LO leaks into the others, producing spurs/"birdies" that move as you
  retune. Two dongles is usually tolerable; more gets messy.

**The clean fix is an active multicoupler** (antenna distribution amplifier): one
antenna in → internal LNA → N *isolated* outputs. The amp recovers the split
loss; 20+ dB of port-to-port isolation kills the LO cross-talk. This is the
standard way monitoring posts run one antenna into many receivers; the
scanner-hobby reference part is the **Stridsberg multicoupler** (4 / 8 / 16-port,
~25 MHz–1.3 GHz). Two project-specific caveats: (1) **bias-tee DC** — if any
dongle powers an external LNA over the coax, you can't passively combine (DC
back-feeds the others); multicouplers isolate DC per port and supply their own
gain. (2) **Intermod** — gain ahead of several receivers can worsen intermod near
a strong transmitter (FM broadcast, paging, a local cell site); budget for an
FM-trap / band filter.

So the hardware fork under this idea is: **per-bank antennas** (each SDR its own
optimized antenna — best RF, but multiple feedlines/mounts) **vs. one wideband
antenna + active multicoupler** (single mount/feedline, clean isolation, costs a
~$100+ multicoupler, less optimal per band). Rule of thumb to carry forward:
**plan for an active multicoupler the moment more than ~2 SDRs share an
antenna.**

**Sequencing note.** This is the heaviest item here and the natural *long-term*
target of the banks line of work — it wants banks (Idea 1) and per-bank profiles
(Idea 7) in place first, and the cross-device audio arbiter is net-new. Park it at
the end of the banks track, not the start.

---

## Idea 11 — SAME / NOAA alert decoding — *SHIPPED 2026-06-05 (PR #63, visiting-slot tier)*

> Operator chose the honest-lossy tier: the helper's last lane carries a
> permanent multimon-ng tap; NWR rides the scan as a BACKGROUND channel
> (demodulated, never opens/holds/speaks) in its own group, decoded each
> hop visit. FIPS scoping + test-banner knobs; alerts ride Idea 6's
> plumbing. The dedicated-SDR tier (Idea 10) upgrades reliability with
> zero pipeline changes — exactly as the tiers below predicted.

**The pitch.** Decode the Specific Area Message Encoding (SAME) headers on NOAA
Weather Radio. When an alert for the operator's area is decoded: **display the
alert text on the kiosk and automatically tune to the weather channel** so the
voice message plays — exactly the "break in when it matters" behavior of a
consumer weather radio, but on the appliance.

**No extra RF hardware needed — SAME is audio.** The SAME header is an AFSK data
burst (520.83 baud, 1562.5/2083.3 Hz tones) carried *in the voice baseband* of
the NWR FM channel, not a separate signal. The DSP helper already demodulates
every channel through `nbfm_rx` at 48 kHz (`wideband_helper.py`) — that demod
output is precisely what a SAME decoder consumes. The decoder is a tap off the
NWR channel's audio (a GNU Radio EAS block in the flowgraph, or piping that lane's
PCM to a decoder like `multimon-ng -a EAS` / `samedec` / `dsame3`). Mature
decoders exist; this is parsing, not invention.

**The real catch is architectural, not RF: you must be demodulating NWR *during*
the header burst.** The machine-readable SAME header is only ~a few seconds long
(sent 3× back-to-back at the start), then a 1050 Hz alarm tone (8–25 s), then
voice. But NWR transmits *continuously* 24/7 — which is exactly why Kerchunk
already special-cases it as a separate `weatherChannel` with a squelch-free
"weather-only mode" instead of putting it in the scan. So in normal scanning the
engine isn't demodulating NWR, and a single group-hopping SDR isn't always parked
on its window. Three tiers of reliability:

- **Cheapest:** run the decoder on the NWR lane only while the group containing
  NWR is tuned — catches alerts only when that group is active. Lossy by hop
  timing.
- **Better:** give weather a held/priority demod slot so NWR is always in a
  covered window.
- **Gold standard:** a slot/radio parked on NWR full-time — the cleanest real
  argument for giving **weather its own SDR (Idea 10)**. SAME is the feature that
  justifies weather's own continuous slot.

**Build shape.**
1. SAME decoder on the NWR channel's demod output (GR EAS block, or PCM →
   `multimon-ng -a EAS` parsed by the backend). Emit a new engine event, e.g.
   `{ type: "same", org, event, fips[], purgeMinutes, issuedTs, station }`.
2. **Local filtering:** parse the FIPS county codes in the header and match
   against the operator's area. Kerchunk already collects location
   (`display.weatherLat/Lon`, zip) and `radioReference.countyIds`, so the local
   FIPS set is derivable — ignore alerts for other counties.
3. **On a matching alert (the two behaviors requested):**
   - **Display on the kiosk** — a prominent banner with the decoded event
     (e.g. "TORNADO WARNING", issuing office, affected area, expires-at from the
     purge time). The dashboard already renders now-playing / activity; this is a
     new high-priority card driven by the `same` event.
   - **Tune to weather** — preempt the speaker and switch to the weather channel
     so the NWR voice message plays, reusing the existing priority/Close Call
     preempt + weather-only hold. Auto-revert when the purge time elapses (or on
     SAME End-Of-Message / operator dismiss).
4. Event-code → human-label table (TOR/SVR/FFW/…); persist alerts to **history
   (Idea 5)**, optionally fan out to **alerts/notifications (Idea 6)** and pin the
   affected county on the **map (Ideas 2/8)** — under the map's weather-radar
   overlay (Idea 2), so the alert shows spatially against live precipitation.

**Honest scope note.** "Tune to weather on alert" only works if the radio can get
to the NWR channel at decode time — trivial once weather has a held/dedicated slot
(above), but on a single busy SDR mid-hop it's a retune, not instantaneous. The
decode-reliability tiers and this tune-latency are the same underlying constraint:
continuous NWR coverage. Ties this idea tightly to Idea 10.

---

## Idea 12 — Digital voice decode (DMR, and the P25 path) — *low priority*

**Priority: low.** Captured for the record; a real but heavy, far-future item.
Decoding *unencrypted* analog-adjacent digital voice would turn signals Kerchunk
currently recognizes-but-can't-hear into audio — but it's a parallel decode
pipeline, not a tweak, so it sits well behind the rest of this roadmap.

**Is it possible? Yes.** DMR decoding on an RTL-SDR is well-trodden: **DSD-FME**
and **SDRTrunk** decode DMR voice today. The realistic path is integrating one of
those (exactly how the README backlog frames P25: "integrate DSD-FME or OP25"),
not writing a C4FM + vocoder stack from scratch.

**Why it's not a small change.** `wideband_helper.py` is built entirely around
analog FM (`nbfm_rx`) with a power-plus-quieting squelch (`noiseQuietDb`,
open-above-floor). DMR needs a parallel path:
- **Frame/symbol sync** instead of "is there a carrier" — DMR is 4FSK (C4FM
  family, 4800 sym/s) and you detect it by locking to its burst sync, so the
  analog quieting metric doesn't apply.
- **TDMA slot tracking** — one 12.5 kHz channel carries *two* timeslots / two
  simultaneous conversations; you follow both and read each burst's data type.
- **Vocoder** — DMR voice is **AMBE+2** (DVSI). Bits → audio needs an AMBE
  decoder; the open-source **mbelib** (what DSD uses) does it at good-enough
  quality, and the core AMBE patents have largely aged out. Hardware AMBE dongles
  (ThumbDV) are the "proper" alternative.

The RF front-end *is* reusable (the existing channelizer/discriminator can feed
4FSK symbol recovery), and CPU is a non-issue — one or a few digital channels is
light next to 12 analog channelizers. The cost is engineering a second pipeline,
not compute.

**Two very different effort tiers.**
- **Conventional DMR** (fixed simplex / single repeater) — decode the channel
  directly. Tractable; comparable to adding any one digital mode.
- **Trunked DMR** (Tier III / Capacity Plus) — a control channel dynamically
  assigns talkgroups to frequencies, so you follow control and retune. Same
  complexity class as the P25 trunking already parked at the far end of the
  backlog. Much bigger.

**Caveats.**
- **Encryption.** Unencrypted DMR is just a mode (legal to receive), but much
  business / public-safety DMR is **encrypted** (AES/ARC4) — no decoder gets audio
  without the key, so those channels read "encrypted, no audio" regardless.
- **It already half-exists in spirit.** Close Call tags each discovery's `mode`
  ("FMN, DMR, P25…") specifically to tell the operator *whether a discovery is
  even decodable as analog*. Kerchunk already recognizes DMR and files it as
  undecodable; a decoder is what turns those silent discoveries into audio.

**Stance.** Conventional DMR via DSD-FME/SDRTrunk is a reasonable *post-analog*
milestone if the itch arises; trunked DMR and P25 trunking are far-future,
same-tier work; encrypted traffic is off the table either way. Lowest priority on
this roadmap.

---

## Idea 13 — ADS-B aircraft on the map

**The pitch.** Plot live aircraft on the map and pair them with airband voice:
*see the plane move AND hear the tower/approach frequency it's working.* No
scanner does this; Kerchunk already has the map and the Air bank to join it to.

**Tiering (per the modularity note): Tier A on display, Tier C on RF.** The
consumption side is a clean map-layer module fed by an external decoder; the RF
side needs its own radio and a separate pipeline.

**RF reality.** Aircraft broadcast on **1090 MHz** (1090ES; plus **978 MHz** UAT
for US general aviation) using Mode S extended squitter — 2 Mbps pulse-position
modulation, nothing like FM voice. That's far outside Kerchunk's VHF/UHF voice
windows, and you can't group-hop between 145 MHz and 1090 MHz and catch anything,
so ADS-B wants a **dedicated SDR parked on 1090** — it rides directly on
**Multi-SDR (Idea 10)**. A 1090-tuned antenna + LNA helps a lot (per-band antenna,
also Idea 10).

**Build shape.**
1. Run a mature decoder as a **sidecar process** — `dump1090` / `readsb` — on its
   own dongle. These already exist and are rock-solid; don't reimplement Mode S.
2. Ingest the decoder's JSON aircraft feed (lat/lon, altitude, callsign, speed,
   squawk) in the backend; expose it to the dashboard like any other module.
3. Map layer (Idea 2): aircraft icons that move and trail, rotated to heading,
   labeled with callsign/altitude. Distinct from the transmitter blips.
4. **The payoff cross-tie:** correlate an aircraft with the **Air bank (Idea 1)**
   voice — click a plane to see/affect the relevant airband channel, or highlight
   the aircraft when its sector frequency is audible.

**Caveats.** Needs the dedicated radio (so it's gated on Idea 10 in practice);
coverage is line-of-sight (ground/low aircraft drop out); UAT (978) is a second
frequency if GA coverage matters. CPU for `dump1090` is light.

---

## Idea 14 — Meshtastic (companion node feed)

**The pitch.** Surface Meshtastic mesh traffic on the kiosk — received text
messages and node positions on the map — turning the appliance into a passive
mesh monitor alongside the radio. **The operator already has a companion mesh
node**, so the hardware side is solved.

**Critical: this is NOT an SDR feature.** Meshtastic is **LoRa** (Semtech's
proprietary chirp-spread-spectrum) on 915 MHz ISM (US). RTL-SDR can't practically
demodulate LoRa — experimental GNU Radio decoders exist but are fragile and
SNR-hungry, not a real monitoring path. So Meshtastic does **not** go through the
dongle or the DSP at all. Worth stating plainly so nobody burns time trying to
de-chirp LoRa on an RTL-SDR.

**Tiering: Tier A, but sourced from a peripheral, not the radio.** It's a clean
consumer module that ingests an external feed and renders a panel + map layer —
it just happens to source from a LoRa node instead of the engine event bus.

**Build shape.**
1. Talk to the existing companion node over its **API**: USB-serial (protobuf),
   BLE, or — if the node publishes to MQTT — subscribe to that. The Meshtastic
   project ships a Python API and documented serial/MQTT interfaces; pick whatever
   matches how the node is already connected.
2. Backend module ingests packets → emits a normalized feed (messages, node
   telemetry, positions) to the dashboard, optionally persisted to **history
   (Idea 5)**.
3. UI: a mesh **message panel** (recent texts, channel, sender) and **node
   positions on the map (Idea 2)** — nodes as a distinct marker layer from
   transmitter blips and aircraft.
4. Optional: tie into **alerts (Idea 6)** for keyword/DM notifications.

**Caveats.** Receive/display only (no implication of transmitting from the
kiosk); coverage is whatever the companion node hears; encrypted mesh channels
without the key show as undecodable, same as any other crypto.

---

## Idea 15 — Admin IA: analytics home, config in pages — *SHIPPED 2026-06-07 (PR #80)*

> Mission-control workspace: left nav rail (lucide icons, live triage badge),
> analytics home (Now Playing hero, stat tiles, 24 h activity clock, feeds), a
> Triage page, and an a11y pass (AA contrast, focus-visible rings,
> reduced-motion, aria-labeled chart). The operator's structural question —
> "why treat banks and channels separately when a bank consists of channels?"
> — collapsed Banks into section-header rows inside ONE unified Channels page
> (banks are predicates, not folders; `#/banks` redirects). Zero schema/API
> change. Spec: `docs/superpowers/specs/2026-06-06-unified-channels-design.md`.
> Followed by the operator-workflow redesign (PR #83) and the completed admin
> ops surface — health alerts, 24 h channel analytics, Close Call
> location/suppression/archive (PR #84).

**The pitch.** Make the admin **home an analytics dashboard** — at-a-glance
insights, alerts, now-playing, recent activity — and move the operational
surfaces (channels, banks, scan tuning, audio, Close Call lockouts, weather,
identification keys) into their **own pages** behind a nav. Config becomes a
destination you go to, not the thing you land in.

**What we have.** One long, progressively-disclosed page. `admin.ts` (~1040
lines) renders stacked sections — Now Playing, Discoveries, Banks, Channels,
Insights, Alerts, Scan tuning, Close Call lockouts, Weather — with the minor ones
collapsed behind their legends (`section.collapsible`). Vanilla TS + Vite, no
framework and no router. Notably, **Insights (Idea 9), Alerts (Idea 6) and Banks
(Idea 1) already exist as sections** — the analytics raw material for the home is
already on the page; this is about *promotion and layout*, not new data.

**Why now.** Progressive disclosure is a stopgap that doesn't scale: as features
multiply (history, per-bank profiles, ADS-B, mesh, radar), one scroll gets
unwieldy. And it mismatches usage — a running appliance is *mostly monitored,
occasionally configured*, so the landing view should be the glance (what's
happening, what fired, what's busy), with configuration one click away.

**Build shape.** Frontend-only; no backend/API change.
1. A tiny **hash router** (`#/`, `#/channels`, `#/banks`, `#/scan`, `#/audio`,
   `#/closecall`, `#/weather`, `#/identification`, `#/history`) — vanilla, no
   framework, matching the stack. Keep routes deep-linkable so admin bookmarks
   survive.
2. **Home = analytics:** promote Insights (Idea 9) + the Alert feed (Idea 6) +
   now-playing + a discoveries summary + recent activity (and later, history
   charts from Idea 5) into a read-only glance.
3. **Port each operational section into its own page.** The existing per-section
   render functions are already modular, so they mostly move as page bodies —
   low-risk, mechanical.
4. A nav rail/tabs; reuse the existing Campfire responsive workspace + tokens.
5. **Ties to the modularity note:** this *is* the admin **page/panel registry** —
   each module (history, stats, ADS-B, mesh, …) registers a nav entry + page, and
   the home is assembled from module-contributed analytics widgets. Build the
   shell now and future modules slot in without touching it.

**Scope note.** Genuinely a restructure, not a rewrite: the risk is re-layout + a
router, not new behavior. Worth doing *before* the next few panels land, so they
arrive as pages instead of more sections to collapse.

---

## Idea 16 — System/host stats in admin (machine stress)

**The pitch.** Show host health in the admin — CPU, load, RAM, temperature, disk,
and (most diagnostically) the DSP helper's own load — so the operator can *see*
the machine under stress. The motivating symptom: it sometimes spikes, and right
now there's no way to tell what or why.

**What we have.** Nothing host-facing. Note `/api/stats` already exists but it's
**activity analytics** (history aggregates, Idea 9) — *not* machine metrics — so
this is a new surface; name it `/api/system` (or `/api/health`) to avoid
collision. Node gives most of it for free; the appliance is Linux (Intel laptop
or Pi 4), so the platform-specific bits read from sysfs.

**The real culprit, and why generic gauges aren't enough.** The heavy thing is
the GNU Radio flowgraph: the wideband helper is a separate process
(`WidebandEngine` spawns it; `child.pid` is right there), and load spikes most
plausibly come from **group-hops, many simultaneous active channels, or the Close
Call FFT sweep**. So the stat that actually explains a spike is the *helper
process's* CPU, **correlated with engine state** (active-channel count, hop
events, Close Call). That correlation turns "it spikes" into "it spikes when 11
channels open during a hop."

**Build shape.**
1. Backend `SystemStats` collector polled ~2–5 s (cheap):
   - CPU% + load (`os.loadavg()`, `os.cpus()` deltas), RAM (`os.totalmem/freemem`),
     backend RSS (`process.memoryUsage()`) — all Node built-ins.
   - **Helper-process** CPU/RSS via `/proc/<pid>/stat` using the engine's known
     helper PID — the diagnostic signal.
   - **Temperature** from sysfs (`/sys/class/thermal/thermal_zone*/temp`,
     millidegrees), auto-detecting the zone; **optional/null** when absent
     (VM/permission), same graceful-degrade pattern as other optional features.
     Throttle flags where available (Pi `vcgencmd get_throttled`).
   - **Disk free** on the writable partition — ties to the history store (Idea 5)
     growing the card; surfaces retention pressure.
   Expose `/api/system` and push a periodic `system` event over the existing WS.
2. Frontend: a **System health** panel — gauges with warning thresholds (temp
   especially) **plus short rolling sparklines**, because a spike is invisible on
   an instantaneous gauge. Lands naturally on the analytics home / a health page
   from the admin-IA work (Idea 15).
3. **Spike diagnosis:** keep a short in-memory ring for the sparklines; optionally
   persist samples to history (Idea 5) to review past spikes, and overlay engine
   state so a spike is explainable. Optional **alert (Idea 6)** when temp/CPU
   crosses a threshold.

**Caveats.** Temperature source is platform-specific and may be missing — degrade
to "n/a", don't break. Keep the poll light so monitoring doesn't itself add load.
Thermal throttling (Intel frequency drop / Pi throttle flags) is worth surfacing
explicitly: a "spike" the operator feels as audio stutter may actually be the SoC
throttling, which a bare CPU% gauge would hide.

---

## Stretch items (named, not obvious-tier)

- **FCC proximity lookup — SHIPPED 2026-06-05 (PRs #56/#57)** and it grew:
  19-probe cached license grid, name-hint + frequency-confirmed placement
  (locationNumber-aware, nearest-home, 80 km sanity cap), licensed power +
  antenna height harvested into coverage-radius blips, background-primed
  metro index for bare-frequency (Close Call) identification with emission-
  based voice/data triage. Spawned two unplanned siblings: the **ERP
  estimator** (helper measures median received RF per transmission;
  FCC-licensed channels anchor a path-loss inversion; regulatory ceilings
  clamp where the law is known) and **Close Call triage** (listenability
  verdicts, service-allocation chips with OUTBAND flagging, mirror-bin
  image rejection, persistence-before-filing).
- **Close Call band-sweep mode (phase 2 of the CC spec).** Today Close Call
  watches the window the scanner is already parked on. The deferred second
  phase from `specs/2026-06-05-close-call-design.md`: when idle, deliberately
  sweep windows across whole bands hunting for activity away from the
  programmed channels. Interacts with banks/profiles (sweep ranges per bank?)
  and costs scan coverage while sweeping — needs its own dwell policy.
- **AM demod / CB band.** Tabled 2026-06-04 with a design sketch: the R820T
  reaches 27 MHz (deaf-ish at its 24 MHz floor + antenna mismatch), all 40 CB
  channels fit ONE window, and `mode: "am"` has been in the schema since day
  one — no engine has ever honored it. Build shape: a per-lane AM path
  (magnitude → DC-block → audio) alongside the NBFM demod, keyed off
  channel.mode in the tune command. Airband (118–137 MHz AM) falls out of the
  same work and is the more rewarding listen.
- **Polyphase filter-bank channelizer.** Replace the per-channel
  freq-xlating FIRs with a PFB (the sdrtrunk model): one shared filter + FFT
  produces ALL channels in the window, so channel count becomes ~free
  (~2.4 cores for 12 lanes today; a PFB holds roughly flat at 50). Pure DSP
  refactor behind the same helper protocol; only matters when a window wants
  dozens of channels — which Banks bulk-toggling and band-sweep could both
  cause.
- **Transcription — shipped (PR #68) then REMOVED 2026-06-07 (operator
  decision, not wanted).** Was opt-in speech-to-text (faster-whisper tiny.en)
  filing text onto history rows. Excised entirely — module, worker, schema
  `transcribe` flag, admin UI, and the appliance venv — because its only real
  cost was CPU/heat on the 2014 chassis (the very thing the efficiency review
  flags) for a feature the operator never enabled. Don't re-pitch.
- **Remote audio streaming.** Stream the live demod to a phone/browser
  (Icecast-style) — the old "home base Wi-Fi mode" from the vision doc. Lets the
  operator listen away from the kiosk.

---

## Where things stand (2026-06-07) — open items, sorted

Ideas 1, 2, 4, 5, 6, 7, 8, 9, 11, 15, 16 are shipped or resolved; the stretch
sweep landed ambient replay, CC band-sweep, and remote listening (PRs #66–#68).
Transcription shipped then was removed (operator decision, 2026-06-07 — see the
stretch list above). What's open, in execution order:

### PHASE: CONSOLIDATION (operator, 2026-06-06) — admin pass complete (2026-06-07)
> "We are going to nail the stuff we have before adding." No new features
> until the existing surface is field-proven. What nailing looks like:
> live with everything, fix what use reveals, verify the watch items
> (SAME proof-of-life, estimator anchors, FCC priming), harden rough
> edges (e.g. zombie helper on hot-unplug).
>
> **Update 2026-06-07:** the gate reopened for the admin track. Idea 15
> (Admin IA) shipped (PR #80), followed by the operator-workflow redesign
> (#83) and the completed admin ops surface (#84) — the latter net-new
> (health alerts + thermal load-shedding, 24 h analytics, Close Call
> location/suppression/archive). A post-merge review (#85) caught two real
> bugs in #84's fresh code (RF written to the wrong history row;
> restore-to-triage instantly re-suppressed) — evidence for the consolidate
> instinct. Back to field-proving from here.

### Build next (software-only, in order)
1. **Idea 3 — further ambient skins** (constellation, kerchunk wall, data
   poster). First skin (auto-replay) shipped; optional polish, low priority.

### Hardening backlog — DSP efficiency (from the 2026-06-06 review)
`docs/PROCESSOR-EFFICIENCY-REVIEW-2026-06-06.md` found the dominant cost is the
GNU Radio helper (~2.4–2.5 cores for 12 lanes), not the Node backend — and a
second weather radio roughly doubles it. The fixed 12-lane flowgraph runs every
lane continuously (including parked ones) and runs BOTH FM and AM paths per
lane. Highest-return work, in order:
1. Build only the number and type of DSP lanes the current engine needs (skip
   parked lanes; build AM path only for AM channels).
2. Give the dedicated weather radio a one-lane, decode-only flowgraph.
3. Don't run the Close Call FFT, SAME decoder, or PCM streaming tee when those
   features are disabled.
4. Make dashboard/map rendering event-driven while idle to cut continuous
   Chromium work.
Distinct from the parked polyphase-channelizer rewrite below — these are
in-place wins on the current helper, not a DSP re-architecture.

### Tabled by operator (2026-06-06 — don't re-pitch; he'll return to them)
- **Idea 13 — ADS-B**: hardware staged (V4 stick identified, port system
  ready, plan = blog-librtlsdr build → dump1090 sidecar → map layer);
  antenna pending. Tabled "for now."
- **Idea 14 — Meshtastic**: tabled before the connection question
  (USB-serial / BLE / MQTT) was answered.

### Hardware/architecture continuing under Idea 10
- Multi-SDR day 1 SHIPPED (PRs #74-#76): port-path addressing (topology
  order, PID family), dedicated-weather-radio architecture (parked until a
  stick gets an antenna — visiting-slot SAME auto-returns meanwhile),
  tune-to-weather. Phase 2 = cross-device audio arbiter (gives the weather
  radio and any future role a speaker claim).

### Parked, deliberately
- **Idea 12 — digital voice**: local DMR is trunked Cap+/Tier III;
  conventional decode would hear ~nothing. Revisit on a worthwhile signal.
- **Polyphase channelizer**: declined until something actually needs >12
  lanes per window — rewrite risk vs a field-calibrated DSP.

### Watch items (no build, just time)
- **RepeaterBook token** (pending since March-2026 policy): when issued,
  set config.lookup.apiToken AND clear lookedUpAt stamps on unlocated
  channels so ham geo backfills.
- **SAME proof-of-life**: KEAX's next weekly test should land in the alert
  feed (banner only if alerts.sameTests).
- **ERP estimator anchors**: estimates refine as licensed channels are
  heard; GMRS clamps at the Part 95 ceiling by design.


## Suggested sequencing (historical)

These interlock; a sensible order — kept as written for the record:

1. **Banks (Idea 1)** — the data backbone; banks + tags + derived band. Unlocks
   bulk control and gives the map and hear/see something to pivot on.
2. **Persistent history (Idea 5)** — the keystone infrastructure. Unblocks map
   replay, stats, and alert review; build it early so the rest are mostly queries.
3. **Hear-vs-see (Idea 4)** — small schema change once banks exist; immediately
   useful on its own (mute noisy channels but keep logging them).
4. **Map + map history (Ideas 2 & 8)** — SHIPPED: Google Maps (operator pick,
   vector via Map ID, style master in `kiosk/kiosk-assets/map-style.json`),
   antenna layer + heat glow, NO-FIX ring, auto-fit framing. The kiosk IS the
   map now (map-as-stage redesign, PR #48); Idea 8 resolved (heatmap shipped,
   click-to-listen dropped, scrubber → Idea 3 ambient auto-replay).
5. **Per-bank profiles, alerts, stats (Ideas 7, 6, 9)** — layered refinements that
   ride on banks + history; each is small once its dependencies exist.
6. **Artistic mode (Idea 3)** — an ambient/screensaver mode that reuses the same
   event stream (and Idea 9's queries for the data-poster skin); ship one skin,
   grow the gallery.
7. **Multi-SDR (Idea 10)** — the long-term endpoint of the banks track: bind a
   bank to its own radio for true parallel, hop-free coverage. Heaviest item
   (a cross-device audio arbiter is net-new); wants banks + per-bank profiles
   first.

**The identification/DSP stretch items** slot opportunistically: FCC proximity
is a small win any time; AM/CB and the PFB channelizer ride whichever of
band-sweep or banks-scale demand them first.

**SAME / NOAA alert decoding (Idea 11)** sits across this order rather than at a
fixed step: a basic decoder + kiosk banner can land early (it only needs the NWR
lane's audio), but *reliable* catch-and-tune wants weather on a held or dedicated
slot — so its robust form rides on Idea 10. Build the decoder when convenient;
upgrade its reliability as the weather slot firms up.

## Architecture: modularity (how these fit together)

A recurring question: should these be **plugins/extensions** on the core rather
than features welded into it? Mostly yes — but the boundary is sharp, and the
codebase already points to where it falls.

**The dividing line: observe vs. change.** The `EngineEvent` union fanned out
over the WebSocket is already a clean event bus, and the identification chain
(RepeaterBook → RadioReference in `lookup.ts`) is already a pluggable provider
chain. Anything that just **observes** the radio and emits UI or side-effects is
plugin-shaped almost for free. Anything that **changes how the radio fundamentally
works** is core and resists a clean plugin seam. Sorting the ideas by that test:

- **Tier A — natural plugins (downstream of the event bus).** Map (2, now
  shipped — and it validated the thesis: it's a pure consumer of the event
  stream), artistic mode (3), persistent history (5), stats (9), alerts (6), the
  weather-radar overlay, SAME *output* handling (11). Each takes the event stream
  in and emits a panel / a stored row / a notification, touching nothing in the
  DSP core. This is where a module model genuinely pays off.
- **Tier B — core data-model changes (plugin-resistant).** Banks (1), hear-vs-see
  (4), per-bank profiles (7). These mutate the channel/config *schema* itself, and
  the engine has to honor them at grouping/tune time — so they can't be isolated
  plugins. They're core features wearing a feature flag, not extensions.
- **Tier C — DSP / RF pipeline (do *not* make these plugins).** Multi-SDR (10),
  SAME *decode* (11), DMR (12). They live in the Python flowgraph and the device
  layer, cross the Node↔Python boundary, and run in the real-time path. A plugin
  seam here buys complexity and costs latency/clarity. The crown jewel — squelch,
  quieting, speaker-ownership — stays a small, stable kernel, **not** an
  extension point.

**The trap to avoid.** Don't build a plugin *SDK* before you've built three
plugins. You'll guess the seams wrong, then maintain a frozen public contract for
an audience of one, on a single appliance that isn't a third-party platform yet.
Plugin systems earn their keep when *others* extend you or you ship different
feature sets per deployment — neither is true today.

**Recommended shape: a lightweight internal module pattern now; a public SDK
later, if ever.** Define a small in-tree contract — a "module" gets:
1. a read-only subscription to the engine event stream;
2. a **namespaced config slice** — a zod fragment merged into the root schema
   (this is the one real core change needed, since `schema.ts` is monolithic
   today);
3. optional HTTP routes + WS message types;
4. optional registration of a dashboard panel / admin section (a **panel
   registry**, which the proposed art/map "modes" were already drifting toward).

Modules live in the repo, are statically listed, and are enable/disable-able from
config (a nice appliance fit — turn off the art on a low-power box). That's the
**modular monolith**: it buys the real wins — a lean, pure DSP core; isolation;
per-feature toggles; forced clean boundaries — without dynamic loading or a frozen
API. Apply the rule of three: build map, stats, and alerts against the internal
contract, see what they actually share, and *extract* the interface from real
usage. If third-party extension appetite ever appears, that battle-tested
internal contract becomes the public SDK — earned, not speculated.

**The prize isn't a plugin marketplace — it's keeping the radio kernel small and
stable while the observers multiply.** The event bus is the seam to do it on.

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
