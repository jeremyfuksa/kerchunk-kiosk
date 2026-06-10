# Kerchunk Wall — frequency-column activity skin (design)

> Status: design, approved 2026-06-09. The second artistic-kiosk skin (after "The
> Day's Map", PR #118), realizing the ROADMAP Idea 3 gallery. A pure
> `wallField` accumulator + canvas renderer is off-server-buildable and
> unit-testable; the *look* (calm register, legibility on the kiosk display) is a
> visual property judged on the appliance's HDMI screen. Design + plan off-server;
> view-and-tune on the kiosk before the PR. Brainstormed with the visual companion
> (skin choice → frequency-column layout → per-channel/labeled granularity).

## Intent

The Day's Map is geographic; KC traffic is sparse, so it accumulates a day's
portrait rather than decaying. The **Kerchunk Wall** is its non-geographic
sibling: **every key-up the scanner hears stacks one service-colored mark in its
channel's column.** Columns are ordered low→high frequency, so service colors
block up into bands (air, ham, the VHF mix, the big UHF/700/800 public-safety
wall). It is literal to the project's name — a visual record of every "anyone
there?" — and the first non-geo skin, so it reads as a genuinely different
surface in the gallery, not a re-skin of the map.

It must satisfy the same operator constraint that shaped The Day's Map
(ROADMAP Idea 3, 2026-06-05): **make sparse activity beautiful by accumulation,
not decay.** A dead-quiet 2 a.m. wall must look like *a quiet day*, complete and
intentional — never an empty, broken stage.

## The design (locked in brainstorming)

- **Columns = configured channels.** One thin column per enabled channel in
  `config.channels`, ordered ascending by `freq`. Every column shows a faint
  baseline tick even when silent, so an empty wall reads as "ready / a quiet day."
  (Close Call discoveries — freq-only, not configured — are **out of scope for
  v1**; the Map already surfaces those. An easy v2 add.)
- **Marks.** Each WS `active` event deposits one discrete mark on its channel's
  column. The column is a vertical stack of marks growing upward from the
  baseline.
- **Scale (relative, self-tuning).** The busiest column maps to full panel
  height; all others are proportional to it (`height = count / maxCount`). Marks
  are drawn at a pitch with a floor (`MIN_PITCH`) so individual "kerchunks" stay
  visible at low counts and merge into a glowing solid bar when a channel is
  hammering. Relative scaling means the wall looks right on both a quiet night and
  a busy evening with no fixed ceiling to exceed.
- **Fresh-hit bloom (the only motion).** On a new mark, that mark blooms brighter
  and its column briefly glows, decaying linearly over ~6 s — the same "breath"
  as The Day's Map. Calm register: no other animation, no fake energy, no camera
  moves.
- **Color & compositing.** `colorFor(freq)` (the shared service palette) over a
  deep near-black ground, `globalCompositeOperation = "screen"` so accumulated
  density reads as luminance — a busy day glows brighter. Shared visual key with
  the Map.
- **Labels.** Only the ~3 tallest columns float their `alphaTag` + count; a faint
  frequency axis (low→high) underneath. Ambient across the room (color/shape),
  informative up close (who's hammering).
- **Daily reset, reconstructable.** Clears at local midnight. The wall is **rebuilt
  from `/api/history?since=<localMidnight>&kind=active&limit=5000`** on load, so it
  survives reboot/refresh with no in-memory-only state — exactly The Day's Map's
  pattern.

## Data flow

Mount → `api.getConfig()` for the channel set (freq, alphaTag, enabled) and their
`colorFor` colors → backfill marks from `/api/history?since=<localMidnight>&kind=active`
→ subscribe to the WS `active` stream (`ReconnectingWs`) for live marks + bloom.
**Zero backend changes** — every input already exists (`active` event,
`ScannerEngine.ts`; history query, `history.ts`).

## Architecture — small, isolated, testable units

- **`src/frontend/wall/wallField.ts` — PURE accumulator.** Ingests `{freq, ts}`
  records and a channel set; produces per-column state
  `{ freq, alphaTag, color, count, bloom }` and the current `maxCount`.
  Daily-reset aware (drops marks before `startOfLocalDay`). Headless,
  unit-tested, mirroring `art/sediment.ts`'s `SedimentField`. **No canvas, no DOM,
  no time-of-day side effects** (caller passes `now`).
- **`src/frontend/wall/wall.ts` — `render(root)`.** Boot (config + history
  backfill), WS wiring, canvas setup (DPR-aware), and the paint that maps field
  state → columns/marks/labels/axis. Mirrors `art/art.ts`'s shape.
- **`src/frontend/lib/idleLoop.ts` — NEW shared idle-suspend loop.** Extracts the
  proven `map.ts` pattern (`map.ts:537-554`): a `ticking` guard, `wake()` that
  restarts only when stopped, **stops scheduling entirely when nothing animates**
  (no live bloom decaying), and a **dual-schedule** fallback (rAF + wall-clock
  `setTimeout`) so a dropped rAF can't strand the loop. Consumed by `wall.ts` AND
  retrofitted into `art.ts` (see below). Small, framework-free, unit-testable
  (inject a fake scheduler).
- **`src/frontend/lib/localDay.ts` — extracted `startOfLocalDay`.** Currently
  lives in `art/sediment.ts`; moved to `lib/` so both skins share it. `sediment.ts`
  re-imports from the new location (no behavior change).
- **Reuse unchanged:** `lib/serviceColor.ts` (`colorFor`), `lib/wsClient.ts`
  (`ReconnectingWs`), `lib/api.ts` (`getConfig`, history fetch).
- **Routing:** add a `/wall` branch in `src/frontend/main.ts` (one `else if`) and a
  `/wall` clause in `src/backend/server.ts`'s static fallback (~`:935`, alongside
  `/map` and `/art`).

## Fixing The Day's Map idle loop (in scope, approved)

`art/art.ts` runs an **unconditional `requestAnimationFrame`** (the logged
watch-item, ROADMAP) — it repaints the full sediment field forever, even on a
dead band at 2 a.m. As part of this work, `art.ts` is **retrofitted onto the new
`lib/idleLoop.ts`**: it stops scheduling frames once all breaths have decayed and
the sediment is static, and `wake()`s on the next WS event or the daily-reset
boundary. This kills the thermal regression before `/art` (or `/wall`) can become
the default kiosk screen. `map.ts` keeps its working inline loop — refactoring it
onto the shared module is **out of scope** (it works; avoid churn/risk), though the
shared module is shaped so `map.ts` *could* adopt it later.

## Constraints honored

- **Accumulation, not decay** — marks persist for the day; only the bloom decays.
- **Screen-blend luminance = volume; shared service palette** — same visual key as
  the Map.
- **Calm register; no camera punch** — the bloom is the only motion (the auto-replay
  zooms were removed for reading as a bug; nothing like that here).
- **No false connections** — trivially satisfied; the Wall is non-geo and draws no
  links between columns.
- **Idle-suspend is mandatory** — the Wall uses `lib/idleLoop.ts` from day one, and
  the same change fixes `art.ts`.
- **`prefers-reduced-motion`** — when set, skip the bloom animation and the rAF
  loop entirely; render the static accumulated wall and repaint only on a new mark
  (event-driven, no continuous loop). Honored in canvas, not just CSS.

## What is off-server vs. kiosk

- **Off-server (build + unit-test):** `wallField` accumulator (counts, bloom decay,
  daily reset, relative scale inputs); `idleLoop` scheduling logic (with an
  injected fake scheduler); the `localDay` extraction; routing wiring.
- **Kiosk (view + tune):** the canvas *look* — column legibility, mark pitch,
  bloom feel, label placement, screen-blend over the real HDMI panel, and that the
  idle loop genuinely suspends on a quiet band. Tuned on the appliance before the
  PR, the way The Day's Map was.

## Out of scope (v1)

- Close Call discovery columns (configured channels only).
- Making `/wall` the default kiosk screen (a one-line appliance-config flip, done
  later once it's proven — its own tiny follow-up).
- A skin registry / auto-rotation (premature at n=2 skins; revisit at n≥3).
- Refactoring `map.ts` onto `idleLoop` (it works; bounded risk).
- Any backend / schema / API change.

## Success criteria

- `/wall` renders a frequency-ordered column wall from the day's history on load
  and adds marks live on `active` events; the busiest columns are labeled.
- A quiet/empty wall reads as a calm "ready" state (baselines), not broken.
- Relative scaling keeps the wall well-proportioned on both quiet and busy days;
  a fresh hit blooms then settles (~6 s); no other motion.
- The Wall's rAF loop **suspends on a quiet band** and wakes on the next event
  (verified on the kiosk); `art.ts` now does the same (watch-item closed).
- `prefers-reduced-motion` disables the bloom/loop and renders statically.
- `wallField` + `idleLoop` covered by off-server unit tests; the canvas look is
  proven on the kiosk before the PR.
- Zero backend changes; The Day's Map and the live map are unaffected.
