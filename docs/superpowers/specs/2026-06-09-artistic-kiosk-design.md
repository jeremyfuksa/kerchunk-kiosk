# The Day's Map — artistic kiosk (design)

> Status: design, approved 2026-06-09. Concept only. Mark vocabulary (the
> visual form of a mark) is deliberately deferred to a later visual-brainstorm
> stage — this spec fixes *behavior*, not *style*. Realizes ROADMAP Idea 3
> ("artistic treatment"), rethought per the operator's 2026-06-05 note that
> sparse KC traffic kills decay-based visuals.

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

## Mark vocabulary — deferred

What a single mark *looks like* (light/heat vs. organic growth vs.
sediment/strata) is a visual decision, made in a later visual-brainstorm stage.
This spec fixes only the **behavior** every candidate form must satisfy:

1. A mark is placed at the transmitting channel's transmitter `lat/lon`.
2. Repeated hits at the same site intensify that site's accumulated mark.
3. Marks persist for the rest of the day (no real-time decay).
4. A live hit produces a soft, momentary "breath" on top, then settles.
5. The whole canvas clears at the daily reset.
6. The overall register stays calm/meditative regardless of form.

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

- Mark visual form / color / motion style (next stage: visual brainstorm).
- Any change to the audio path, engine, or history schema.
- Sonification, data-poster, and the other ROADMAP Idea 3 candidates — this
  design selects the remembering-map reading and sets the rest aside.
- Multi-day / rolling-window / all-time portraits — daily reset only.

## Success criteria

- At any hour, including a dead-quiet one, the screen shows a non-empty,
  composed image (the day so far) and is pleasant to have on the wall.
- The day's dominant-site triangle is legible in the accumulated sediment.
- A live key-up produces a soft, noticeable breath without disturbing the calm.
- At the daily reset the canvas clears and a fresh portrait begins.
- The view reconstructs the day's portrait from history after a reboot/refresh
  with no separate persisted state.
- No regressions to audio, engine, or the existing admin/live-map paths.
