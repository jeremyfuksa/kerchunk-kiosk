# The Day's Map — artistic kiosk (design)

> Status: design, approved 2026-06-09; visual language added 2026-06-09 after
> the visual brainstorm. Realizes ROADMAP Idea 3 ("artistic treatment"),
> rethought per the operator's 2026-06-05 note that sparse KC traffic kills
> decay-based visuals. This spec now fixes both *behavior* and *visual
> language*; only final tuning values (exact radii, blur, decay curves, reset
> hour) are left to implementation.

## Intent

Kerchunk began as "can an SDR scanner match a Uniden?" — it can, and did. The
map kiosk then beat the Uniden at the thing a beige box can't do: visualize
traffic. The map is *correct*. It is also **boring to watch**, because KC metro
traffic (at least what this site receives) is sparse — most of the time the live
map shows antennas and no blips, since each hit fades before the next arrives.

This screen exists to solve exactly that. It is a 24/7, always-on **aesthetic
object** whose job is to **earn its place on the wall during the silence** —
which is most of the time. It is explicitly *not* an operational readout. The
speaker already tells the operator what is happening; this screen's only job is
to be worth looking at. We are no longer competing with a Uniden's display — we
are competing with the room the screen is in.

## Concept

**A fully-literal map of the metro that remembers the day.** It becomes the
primary face of the kiosk.

Two layers:

- **Sediment (memory).** From the daily reset onward, every transmission leaves
  a *persistent* mark at its transmitter site for the rest of the day. Repeated
  hits at a site intensify its mark — so the three dominant sites the operator
  already sees in the admin Insights panel build into a bright, dense triangle,
  and the corridors between active sites etch in as they are used. A rare
  outlier hit (a Close Call, a distant repeater) leaves its own mark the map
  carries until reset. This is the layer that defeats boredom: even at 2am with
  zero current traffic, a whole day's portrait is on screen, because the day
  happened even if this minute is empty.
- **Breath (live).** On top of the sediment, a live hit *blooms softly* at its
  site when a channel keys up, then settles into the sediment. This carries the
  only "something is happening right now" signal the screen needs.

## Register

**Calm / meditative.** Low motion. Sparseness reads as *serenity*, not
emptiness. The screen does not fake energy the band does not produce — fake
motion would be worse than stillness. The rare hit is a gentle event against
quiet, never a jolt. The target feeling is "a piece of wall art that happens to
be the radio," happily glowing in the room.

## Place in the kiosk

The Day's Map **is** the default kiosk screen, replacing the live map as the
appliance's primary face. The existing live map and dashboard move to a
deliberate toggle / admin-only path (exact mechanism is an implementation
detail for the plan — the existing kiosk already has a notion of modes).

There is no operational trade in this move: a calm aesthetic object has no
operational pretense to lose. The live map's auto-fit "follow the audible hit"
framing was glanceable-readout behavior; the speaker already covers that need.

## Time

**Daily reset at local midnight.** One day = one portrait. A quiet night reads
as a faint, sparse map; a busy evening as a dense, glowing one — the art *is*
the shape of the day. Because the sediment is derived from a timestamp query
(see Data), "today" is simply `ts >= local-midnight`; there is no in-memory
accumulation state to lose on refresh or reboot, and the portrait reconstructs
itself.

## Mark behavior

The behavior every mark obeys (form-independent):

1. A mark is placed at the transmitting channel's transmitter `lat/lon`.
2. Repeated hits at the same site intensify that site's accumulated mark.
3. Marks persist for the rest of the day (no real-time decay).
4. A live hit produces a soft, momentary "breath" on top, then settles.
5. The whole canvas clears at the daily reset.
6. The overall register stays calm/meditative.

## Visual language (locked 2026-06-09)

Chosen in the visual brainstorm. Final tuning values (radii, blur, opacity
curves) are implementation details; the language below is fixed.

**Form — sediment / strata.** A mark is a soft radial *deposit* at a site;
repeated hits stack concentric strata so the deposit grows and intensifies. The
day's portrait is material accumulating where the traffic is. Rejected
alternatives and *why* (these are constraints, not just preferences):

- **No light-trails between sites; no organic tendrils joining sites.** Each
  transmission is an *independent* site key-up — there is no link, flow, or
  conversation between two sites that happen to fire near each other in time.
  Any visual that draws connection/flow/causality between distinct sites is
  **semantically false and forbidden.** The dominant-site triangle must
  *emerge* from where deposits are dense, never be drawn as edges.

**Color — band-coded by service, reusing the existing map palette.** A deposit
is colored by its channel's service, using the **same** classifier and palette
the live map already uses — `PIN_COLORS` and `colorFor()` in
[`kiosk/src/frontend/map/map.ts`](../../../kiosk/src/frontend/map/map.ts) (air
`#3478F5`, rail `#F5821F`, ham `#EC4E89`, gmrs `#1FA84C`, biz/PS `#7C4FE0`,
marine `#0FAEC0`, weather `#F4B315`, unknown `#747B8A`). One color language
across the whole appliance. **Implementation note:** factor that classifier +
palette out of `map.ts` into a small shared frontend module so the art view and
the live map *import the same source*, rather than duplicating it. Hue here
encodes a property of an independent site — it never encodes a relationship, so
it does not violate the no-false-connection rule.

**Multi-service sites — layered strata with blended overlap.** A single channel
is exactly one service; a channel never "fires as" a second service. A site
shows more than one service *only* when two physically distinct transmitters are
co-located closely enough that their `lat/lon` round to the same site (the
`history.sites()` grouping rounds to ~5 decimal places — roughly antennas on the
same tower). That genuine tower-sharing case is rendered as **layered strata**:
each service's deposit is its own colored sub-layer within the one site's
footprint — the site's own internal composition, still no link to any *other*
site.

**Compositing — `mix-blend-mode: screen` globally, on a calm dark ground.**
Screen-blending is the global compositing model for the entire piece, not just
the rare overlap: every deposit, every outlier grain, and the live breath
composite additively over a deep near-black ground. Consequences this buys for
free:

- Accumulated density reads as **added luminance** — a busy day literally glows
  brighter because more light has been deposited; a quiet day stays dim and
  sparse. Brightness *is* the volume of the day's traffic.
- Where two service strata overlap at a co-located site, their hues screen into
  a luminous third tone — the tower-sharing case becomes a small jewel of
  color-mixing rather than a muddy smear. The blend is contained within one
  site's footprint, so it still implies nothing between sites.
- The whole surface reads as one continuous luminous field rather than stacked
  opaque marks — appropriate to the calm, wall-art register.

**Intensity / always-on safety.** Tuned for a panel that is on 24/7: the ground
is dark, no large bright statics, deposits are soft-edged and never fully
saturate. The calm register governs all tuning — if a value reads as "hot" or
"busy," it is wrong.

## Data — all of it already exists

No new persistence. Backend work is near-zero; this is a new **frontend** kiosk
view consuming existing APIs.

- **Sediment** = a history query for today's hits, aggregated per site *in the
  view*. Use `history.query({ sinceMs: localMidnight, limit: 5000 })` and group
  by `lat/lon`. Note: the existing `history.sites()` aggregates over *all*
  history with no time filter, so it is **not** the right source for a daily
  layer — query-by-`sinceMs` and aggregate is. Rows already carry
  `ts, freq, alphaTag, lat, lon, kind, tags, durationMs?, rfDb?`.
- **Breath** = the existing WebSocket event stream (`active` / `audible` /
  `closecall`), each event carrying the channel (and thus its `location`), the
  same firehose the live map already consumes.
- **Coverage caveat (inherited, honest framing).** Only channels/discoveries
  with a resolved `location` can place a mark; un-located hits cannot. This is
  the same limitation the live map already has. Repeater `lat/lon` is the
  *transmitter site*, not the talker — the form should not imply "a person is
  here." For a calm, abstract aesthetic object this is a soft constraint, not a
  blocker.

## Out of scope

- Final tuning values only: exact deposit radii, blur, opacity/decay curves,
  the reset hour, breath duration. The visual *language* is fixed above.
- Any change to the audio path, engine, or history schema.
- Sonification, data-poster, and the other ROADMAP Idea 3 candidates — this
  design selects the remembering-map reading and sets the rest aside.
- Multi-day / rolling-window / all-time portraits — daily reset only.
- **Channel-list de-duplication / uniqueness rules.** Surfaced during this
  brainstorm but it is a separate config/admin project, not part of the art
  (the art is a read-only consumer of whatever the config holds; genuine
  duplicates would merely co-deposit at one site — visually harmless). Captured
  as a follow-up: audit the live config for same-frequency duplicates and add a
  uniqueness rule that holds *within* most services but **exempts GMRS/FRS**
  (shared channelized spectrum legitimately has many users per frequency).
  Needs the real `/var/lib/kerchunk-kiosk/config.json`, so it waits until back
  on the kiosk.

## Success criteria

- At any hour, including a dead-quiet one, the screen shows a non-empty,
  composed image (the day so far) and is pleasant to have on the wall.
- The day's dominant-site triangle is legible in the accumulated sediment.
- A live key-up produces a soft, noticeable breath without disturbing the calm.
- At the daily reset the canvas clears and a fresh portrait begins.
- The view reconstructs the day's portrait from history after a reboot/refresh
  with no separate persisted state.
- No regressions to audio, engine, or the existing admin/live-map paths.
