# Silent chatter — hear only what matters, see everything else as city life

Status: design approved in chat 2026-10-13; awaiting written-spec review.

## Why

The operator only wants to *hear* air, rail, marine, ham and GMRS. Business,
public safety and unidentified Close Call traffic is noise on the speaker,
but it is also most of the metro's RF activity. That makes it the life the
glass map is short of (ROADMAP: KC traffic is "too sparse to feel alive").

Today that traffic costs scan time and mostly can't be seen:

1. **Visual hold** (spec 2026-10-03) parks a window up to 15 s for a muted
   open (`hasVisualOpen`).
2. **A muted close re-arms dwell** (`WidebandEngine` "close" →
   `groupStartedAt = now()` unless the visual budget is spent). This happens
   even with visual hold off, so every muted burst lengthens the visit.
3. **Close Call hits always speak and hold.** An unknown `cc_*` id counts as
   audible (`hasAudibleOpen`), and the helper assigns CC lanes
   `priority: true` with audio allowed.
4. **Unlocated hits are invisible on the glass.** `nofix()` only pulses the
   screen edges. Most business Close Call traffic is unlocated.

Goal: silent traffic takes no speaker time and no scan time, but still shows
on the map. Unlocated silent traffic gets a stable invented metro spot and
colour. Every live transmission throws sparks while it is on the air.

Visual hold's original motivation (muted rail was censored to 1.4 s) is gone:
rail is in the audible set now.

## Decisions (operator, 2026-10-13)

| Question | Answer |
|---|---|
| What is audible? | Only **air, rail, marine, ham, GMRS**. **Weather is always a priority**: the weather family and SAME break-ins always speak, and the config can't silence them. |
| Silent traffic and scan time | **Note the hit and move on.** No hold, no dwell re-arm, no speaker. Scan-time win over map duration. |
| Unlocated silent placement | **B: a stable spot per frequency** (and a stable colour per frequency). |
| Which unlocated hits get a spot | **A: every silent one** (business, public safety, unknown). Audible unlocated hits keep the edge glow. |
| Lane release to save CPU | Not built. Detection *is* the demod (squelch reads the discriminator), so a silent lane costs the same as an audible one. The real cost is scan time, which is solved above. |
| Sparks while transmitting | **B: a live-spark tick**, its own knob, running only while a front is live. |

## Section 1 — Silent means "note it and move on"

### The rule

A transmission is **silent** when its family is not in
`config.audio.audibleFamilies`, **or** its channel/discovery has
`audible: false`. Weather is always audible regardless of the list.

- `config.audio.audibleFamilies`: array of
  `"air" | "rail" | "marine" | "ham" | "gmrs" | "biz" | "publicsafety" | "unknown"`,
  default `["air","rail","marine","ham","gmrs"]`. `"weather"` is not a
  member, because it is always audible. Live via `PUT /api/config`: a change
  re-resolves the channels and `retune()`s in place, with no respawn.
- **This is a runtime gate, not a bulk edit.** It supersedes "individual
  choice wins" *for the family only*. A per-channel `audible: false` still
  silences an allowed-family channel, but a per-channel `audible: true` can't
  un-silence a disallowed family. To hear one business channel, tag it into
  an allowed family (bank tags win over the frequency guess) or add the family
  to the list. Stored `audible` flags are untouched, so removing the knob
  restores today's behaviour exactly.
- **One classifier.** `categoryFor` / `categoryForService` / `TAG_CATEGORY`
  move from `src/frontend/lib/serviceColor.ts` to a shared module
  (`src/backend/config/family.ts`, which already sits beside `banks.ts`'s
  `serviceFor`). `serviceColor.ts` re-exports it. Behaviour is unchanged and
  the pin-palette drift test still passes.
- `isAudible(channel, banks, audibleFamilies)` in `config/banks.ts` applies
  the rule. It is wired through `toScanConfig` (the boot path and the API path
  are the same function, per the do-not-undo invariant).

### Engine behaviour (`WidebandEngine`)

- **Silent opens never hold.** `hasAudibleOpen()` resolves `cc_<hz>` ids by
  family (frequency only, with no tags; weather always audible) instead of
  "unknown = audible". A silent CC open no longer holds the window.
- **Silent closes never re-arm dwell.** The "close" path re-arms
  `groupStartedAt` only when the closed channel (or CC id) is audible.
- **Visual hold is retired.** `hasVisualOpen`, `visualBudgetLeft`,
  `visualVisitStartedAt` and the visual-hold `creditDwell` path are removed.
  `config.scan.visualHold` stays in the schema as optional and ignored
  (deprecated comment) so existing configs still parse. Its `updateScheduling`
  plumbing is dropped. Silent channels no longer credit `autoDwell`.
- **Release on hop.** `sendTune` / `sendSweepTune` emit a `release` event for
  every id still in `openIds` before clearing it. The map's front then
  settles into rim and smoke instead of waiting for its `until` timeout.
- The `active` event and history row for a silent open are unchanged. Silent
  durations in `history.db` are **censored to roughly one dwell** again; the
  ROADMAP/history notes say so.

### Helper (`kerchunk-dsp`)

The helper owns CC lane assignment, so it has to know which CC hits are
silent.

- `tune` gains `ccSilentHz: [[loHz, hiHz], ...]`. These are the frequency
  ranges whose family is silent, computed in Node from the service table and
  `audibleFamilies`, and sent on every tune. Absent or empty = today's
  behaviour.
- `Scanner::assign_cc` sets `audible = false` and `priority = false` for a
  frequency inside a silent range. The lane still opens, closes, emits
  `closecall` and parks as today. It just never takes the speaker or
  pre-empts.
- `ccRecorder` needs no change: it only fires on `audible`, which a silent CC
  lane never emits.
- C++ unit test: a silent-range CC assignment opens and closes without an
  `audible` event; a CC outside the range behaves exactly as today.

### Proof: scan-coverage readout

`/api/system` (not `/api/status`, whose shape an external site depends on)
gains a `scanCoverage` block: rolling 10 min fractions of wall time spent
(a) holding for audible opens, (b) on quiet dwell, (c) on sweep stops.
`docs/API.md` is updated. Done means a live before/after:

- capture `scanCoverage` and audible key-ups/hour for ~30 min on `main`, then
  the same on the branch;
- by ear: air, ham, rail, marine and GMRS come through more often, and no
  business chatter plays;
- a SAME test alert (`POST /api/test/alert`) still breaks in with audio.

## Section 2 — Invented metro spots, random colour, live sparks

### Placement (`src/frontend/map/scatter.ts`, pure)

- `scatterSpot(freqHz, stage) → { lat, lng, color }`. A 32-bit hash of the
  frequency (with a fixed salt) gives two uniforms. They map to a point
  **area-uniform** in a disc (`r = R·√u`) centred on the kiosk's fixed
  stage centre, clipped to the stage less `marginPx` (rejection with
  re-hashing, bounded tries, then clamp). The result is deterministic, so
  there is no storage and it is stable across reloads and restarts.
- Knob `display.glass.scatter`: `{ enabled: true, radiusKm?, marginPx: 80 }`.
  `radiusKm` absent = fit the stage. `enabled: false` = today's edge glow.
- **Who uses it:** a live `active`/`closecall` hit, or a history backfill
  row, with no location **and** silent by the Section 1 rule. The frontend
  gets `audibleFamilies` from the config it already loads and reuses the
  shared classifier. Located hits always use their real location, so a
  frequency that later gets identified moves to its true site automatically.
  Audible unlocated hits keep `nofix()` (edge glow).
- **No antenna marker** for an invented spot: only glass, sparks and smoke.
  A dot means a real place. Recently heard and history list the hit as usual.
- Site key: `scatter:<freqHz>`, so hit counts, radius ramp and puff merging
  work as for any site.

### Colour

Hue = a second hash of the frequency × 360°. L and C are fixed at the glow
band (L 0.74, C 0.17, inside the palette's L 0.62–0.84 band), rendered with
`oklchHex` → `hexToGlowRgb`. Invented spots ignore the family palette and
`display.glass.siteColor` on purpose: they are "the city", and their hue only
tells one frequency from another.

### Live sparks (every live front, real or invented)

- While a front is unreleased, the shader draws ember grain around the
  transmit point. It is the same hash-grain family as the smoke sparks: dense
  at the source, thinning outward, biased a short way downwind (calm =
  isotropic). The grain generation advances on the **live-spark tick**.
- Knob `display.glass.liveSparkStepMs`, default **750**, `0` = off (the
  front looks as it does today). Range 250–6000.
- `glassState.frame()`: while `liveCount() > 0` and the knob is > 0,
  `nextChangeAt` includes `nextTick(now, liveSparkStepMs)` and the frame
  carries `liveStep`. With no live front it contributes nothing, so a quiet
  band still does zero glass redraws. `continuous` is unchanged.
- On release the embers hand off to the normal smoke sparks (same grain,
  so there is no pop).
- Shader: the front pass gets `uLiveStep` and `uLiveSparkDensity` (reusing
  `sparkDensity`). No new pass, no new overlay, no blur.

### Thermal proof

The camera stays still and the glass stays event-paced. The new tick only
runs during transmissions. A/B on the live wall, ~30 min each with real
traffic: `liveSparkStepMs` 750 vs 0, logging package temperature and
chromium CPU. If the delta is > ~1 °C, raise the default before shipping.
The result goes in the PR.

## Knobs (summary)

| Knob | Default | Live? |
|---|---|---|
| `audio.audibleFamilies` | `["air","rail","marine","ham","gmrs"]` (weather implicit) | yes (retune in place) |
| `display.glass.scatter.enabled` | `true` | kiosk/reload |
| `display.glass.scatter.radiusKm` | fit stage | kiosk/reload |
| `display.glass.scatter.marginPx` | 80 | kiosk/reload |
| `display.glass.liveSparkStepMs` | 750 (0 = off) | kiosk/reload |
| `scan.visualHold` | — | **deprecated, ignored** |

## Testing

- vitest: `isAudible` family gate (allowed, disallowed, tag override,
  weather always, per-channel false); `toScanConfig` carries it; engine:
  silent open doesn't hold, silent close doesn't re-arm, silent `cc_` doesn't
  hold, audible `cc_` still does, hop emits `release` for open ids;
  `ccSilentHz` ranges computed from families; `scanCoverage` accounting;
  `scatterSpot` determinism, in-stage bounds, area spread (χ² over a grid,
  loose), colour stability; `glassState` live tick in `nextChangeAt` only
  while live.
- native: the `assign_cc` silent-range test above.
- Live: Section 1 proof plus the thermal A/B; wall screenshots via `grim`
  showing invented-spot smoke and live sparks.

## Out of scope

- Admin UI for `audibleFamilies` (the knob is set via config/API first; an
  admin control can follow as its own PR).
- Releasing or descheduling lanes for CPU.
- Changing how real (located) sites are coloured or marked.
