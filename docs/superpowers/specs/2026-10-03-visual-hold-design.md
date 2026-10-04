# Visual hold — muted channels earn scan time for the map

Status: design approved in chat 2026-10-03; awaiting written-spec review.

## Why

The map is now the art (Weather Glass rings, smoke, sparks), but scan time is
still a pure *listening* decision. In `WidebandEngine` a muted
(`audible:false`) open:

- never holds a window (`hasAudibleOpen()` gate in the dwell tick), and
- never credits `autoDwell` (`recordActivity` skips muted channels).

So a muted channel is visited at the minimum dwell and every transmission is
cut at the hop. 30 days of `history.db` (2026-09-04 → 10-03) showed it
plainly: all 29 rail channels were muted, and every rail transmission topped
out at **1.385 s** (the dwell minus retune warm-up). That read as "rail is
dead noise" and rail was archived on bad evidence — then restored (5 heard
channels) once the censoring was spotted. Rail heard ~405 key-ups at an
estimated 2–3 % listening duty, i.e. likely 400+/day of real traffic: a whole
service colour (rust) the map was starving.

Goal: a muted channel that is in the scan gets enough time for the map to see
its transmission whole — ring for the full key-up, smoke on release — while
the speaker stays silent and audible listening keeps first claim.

## Knob

`config.scan.visualHold` (all fields optional), Node-side scheduling like
`autoDwell` / `priorityRevisit`: carried through `toScanConfig`, stripped from
the PUT handler's `scanChanged` diff, and applied live via
`engine.updateScheduling` — **no helper respawn**.

| Field | Default | Range | Meaning |
|---|---|---|---|
| `enabled` | `true` | bool | Muted opens may hold a window. `false` = today's behaviour exactly. |
| `maxMs` | `15000` | 1000–180000 | Ceiling on ONE continuous visual hold. Covers a typical rail / business / WOF transmission (median 9–12 s); bounds a stuck muted carrier. |
| `creditDwell` | `true` | bool | Muted opens also count toward `autoDwell` activity (only while `enabled`), so a busy muted-only window (rail) earns more visits, not just finished transmissions. |

Defaults and `resolveVisualHold()` live in `scanSchedule.ts` beside
`AUTO_DWELL_DEFAULTS` / `PRIORITY_REVISIT_DEFAULTS`.

## Behaviour (dwell tick, `WidebandEngine.ts`)

Per tick, in order:

1. **Audible open** (`hasAudibleOpen()` — unchanged, incl. Close Call lanes):
   hold-through exactly as today, capped by `maxHoldMs` (180 s) measured from
   `holdStartedAt`. On breach: today's stuck-lane path (log, clear
   `openIds`, force hop).
2. **Else, visual hold**: `visualHold.enabled` and some open id resolves to a
   configured channel of the current group that is muted and not
   `background` → hold-through (re-arm `groupStartedAt`) while
   `now - holdStartedAt < visualHold.maxMs`. On breach: fall through to the
   normal advance. **Do not clear `openIds` and do not log** — a long muted
   transmission is not a stuck lane, and a continuously keyed muted carrier
   would otherwise log every rotation.
3. **Else**: no hold (`holdStartedAt = 0`), plain dwell — unchanged.

`holdStartedAt` is shared: a hold that starts visual and turns audible keeps
its start, and the audible cap (180 s) then applies — audible always wins.
A visual hold whose cap fired leaves the window; returning to it later starts
a fresh hold (the `close` path / hop already zero `holdStartedAt`).

Sweeps and priority-revisit looks: the visual hold follows the same rule the
audible hold does today (the hold check precedes the sweep/revisit branches),
so no special-casing.

**`recordActivity`:** the `channel.audible === false` early-return becomes
"muted and not (visualHold.enabled && visualHold.creditDwell)". Background
channels, Close Call lanes, sweeps and revisits stay excluded.

**Speaker:** untouched. Muted stays muted; the helper's audible pick is not
involved.

## Cost / trade-off

While the scanner holds up to 15 s for a muted rail call, an audible repeater
in another window can be missed. The cap bounds it; `enabled:false` restores
listening-first scheduling exactly. `creditDwell` lets muted traffic lengthen
its window's quiet dwell (up to `autoDwell.maxFactor`, 2×) — the remaining
muted chirpers in the 462 window (St Luke's, Harrah's, Bally's …) will push
that window toward 2×, which is the richest visual window anyway.

## Testing

Unit (`test/WidebandEngine.test.ts`, fake helper + injected `now`):

- muted open holds past the plain dwell;
- visual hold releases at `maxMs` (hop happens, `openIds` not cleared, no log);
- audible open during a visual hold switches to the 180 s cap;
- `enabled:false` → muted open does not hold (today's behaviour);
- `creditDwell` → a muted open raises the group's activity / dwell factor;
  `creditDwell:false` → it doesn't;
- `updateScheduling({ visualHold })` applies live.

`scanSchedule.test.ts`: `resolveVisualHold` defaults/overrides. Schema test
for the bounds.

On hardware:

- `history.db`: rail rows with `durationMs > 1385` appear within hours;
- rail-window smoke births/day (≥60 s-separated site episodes) up vs the
  2026-10-03 baseline;
- repeaters still sound right by ear (no obvious missed audible traffic);
- `npm test`, `npm run test:native`, `npm run typecheck`, `npm run build`.

## Docs

CLAUDE.md knob list, `docs/API.md` config notes (if scan fields are listed),
schema comment.

## Out of scope (separate PRs)

- Merging the 462/464 windows (`lanesPerGroup` / rare-channel archive).
- Airband `dwellWeight` rebalance.
- `/api/recommendations/archive` 5000-row cap bug.
- Smaller map pins (`display` knob; separate UI PR).

## Amendment (final review, 2026-10-03)

- `maxMs` is a **per-visit budget**, not a per-hold cap: a visit's visual
  holds share it (clock starts at the visit's first visual hold; reset only
  by a tune/spawn/stop), and a muted close past the budget no longer re-arms
  the dwell. Without this, back-to-back muted traffic re-started the cap on
  every key-up and could park the scanner on a muted-only window
  indefinitely.
- A due **priority peek pre-empts a visual hold** (nobody is listening to
  it); audible holds still can't be pre-empted.
- The visual hold no longer writes `holdStartedAt`, so an audible open that
  follows a visual hold gets its full `maxHoldMs`.
