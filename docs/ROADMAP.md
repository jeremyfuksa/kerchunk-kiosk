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

## Idea 5 — Persistent activity history (the keystone)

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

## Idea 6 — Alerts / notifications

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

## Idea 7 — Per-bank scan profiles

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

## Idea 8 — Map history, replay & click-to-listen

**The pitch.** Deepen the map (Idea 2) with time: a scrubber to replay the last
hour, a heatmap of busy transmitter sites, and click-a-blip-to-hear-it — which is
the hear/see toggle (Idea 4) applied to a pin.

**What we have.** Live blips come from Idea 2; persisted positions come from Idea
5 (lat/lon are already stored per opening). Click-to-listen reuses the same
audible/visibility switch Idea 4 introduces.

**Build shape.**
1. Time scrubber over `/api/history` — slide back, blips re-animate for the
   chosen window.
2. Heatmap layer from per-site hit counts (a `GROUP BY lat,lon` over the store).
3. Click a blip → channel detail + a "listen" control that flips that channel
   (or bank) to audible for a session. Closes the loop between map and speaker.

---

## Idea 9 — Stats & insights

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

## Idea 11 — SAME / NOAA alert decoding

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
   affected county on the **map (Ideas 2/8)**.

**Honest scope note.** "Tune to weather on alert" only works if the radio can get
to the NWR channel at decode time — trivial once weather has a held/dedicated slot
(above), but on a single busy SDR mid-hop it's a retune, not instantaneous. The
decode-reliability tiers and this tune-latency are the same underlying constraint:
continuous NWR coverage. Ties this idea tightly to Idea 10.

---

## Stretch items (named, not obvious-tier)

- **Transcription.** Speech-to-text over captured audio → a searchable log of
  *what was said*, not just when. Powerful and modern, but heavier (a model on the
  appliance or an off-box API) and depends on capturing audio, so it sits well
  past the obvious tier.
- **Remote audio streaming.** Stream the live demod to a phone/browser
  (Icecast-style) — the old "home base Wi-Fi mode" from the vision doc. Lets the
  operator listen away from the kiosk.

---

## Suggested sequencing

These interlock; a sensible order:

1. **Banks (Idea 1)** — the data backbone; banks + tags + derived band. Unlocks
   bulk control and gives the map and hear/see something to pivot on.
2. **Persistent history (Idea 5)** — the keystone infrastructure. Unblocks map
   replay, stats, and alert review; build it early so the rest are mostly queries.
3. **Hear-vs-see (Idea 4)** — small schema change once banks exist; immediately
   useful on its own (mute noisy channels but keep logging them).
4. **Map + map history (Ideas 2 & 8)** — the first big visual payoff; color blips
   by bank, visibility-gated by Idea 4, replay/heatmap backed by Idea 5. Decide
   the tile-provider question first.
5. **Per-bank profiles, alerts, stats (Ideas 7, 6, 9)** — layered refinements that
   ride on banks + history; each is small once its dependencies exist.
6. **Artistic mode (Idea 3)** — an ambient/screensaver mode that reuses the same
   event stream (and Idea 9's queries for the data-poster skin); ship one skin,
   grow the gallery.
7. **Multi-SDR (Idea 10)** — the long-term endpoint of the banks track: bind a
   bank to its own radio for true parallel, hop-free coverage. Heaviest item
   (a cross-device audio arbiter is net-new); wants banks + per-bank profiles
   first.

**SAME / NOAA alert decoding (Idea 11)** sits across this order rather than at a
fixed step: a basic decoder + kiosk banner can land early (it only needs the NWR
lane's audio), but *reliable* catch-and-tune wants weather on a held or dedicated
slot — so its robust form rides on Idea 10. Build the decoder when convenient;
upgrade its reliability as the weather slot firms up.

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
