# Engine knobs in the admin: design

Date: 2026-09-27 · Status: approved in brainstorm (layout B + controls mockup) ·
Mockups: `.superpowers/brainstorm/402490-1790560004/content/{layout,controls}.html`
(git-ignored)

## Problem

The native engine gained about 25 operator knobs (PRs #233–#256). Today they are
config-only, so tuning one means hand-editing `config.json`, with a service stop
first, or a `PUT /api/config` from a shell. The operator tunes these by ear over
time, so the admin should expose them. The design has to keep the everyday
knobs easy to reach, keep the rest out of the way, and be honest about what
each save costs. Most of these saves restart scanning, which cuts audio and
replays the wall warm-up.

## Decisions (operator)

- **Layout B:** add a new **Sound** card for the everyday knobs, plus one collapsed,
  full-width **Advanced (engine)** card at the bottom of Settings. Existing cards
  are unchanged. The quieting threshold stays in Scanning, where it is today.
- Keep the **group-shape preview** (live group count / edge count / cycle
  estimate).
- The controls, wording and curve are as in `controls.html`.

## Surfaces

### Sound card (`#/scan`, second card, after Scanning)

Header: "Sound", hint "Loudness and filters". Contents, top to bottom:

1. **Loudness curve.** An inline SVG with input level on x and output level on y,
   −70…0 dBFS. It plots `out = min(ceil, x + clamp(target − x, minGain, maxGain))`
   with:
   - the unity diagonal (dashed), the target line and the limiter ceiling line
     (`20·log10(limiterCeiling)`);
   - a shaded "gain held" region below `agcHoldBelowDb`;
   - a caption: "Talkers from {target−max} to {target−min} dBFS come out at {target}".

   The curve redraws on `input` from the five fields that feed it (target, max
   boost, and min gain, hold below and limiter ceiling from the Advanced card).
   An empty field falls back to its default. The curve is a first-order picture
   of the steady state: it ignores attack and release, and says so in the SVG
   `aria-label`.
2. **Rows** (existing `.settingGroups` label/hint/`inputUnit` pattern):

   | Label | Config | Unit | Range | Default |
   |---|---|---|---|---|
   | Target loudness | `audio.agcTargetDb` | dBFS | −40…−3 | −18 |
   | Max boost | `audio.agcMaxGainDb` | dB | 0…30 | 15 |
   | Hiss cut (FM) | `scan.fmAudioLpfHz` | Hz | 1000…24000 | 2700 |
   | Hum filter (FM) | `scan.fmAudioHpfHz` | Hz | 0 = off, or 50…1000 | 300 |
   | Airband balance | `scan.nativeAmGainDb` | dB | −30…+20 | 0 |
3. **Save** labelled "Save sound". It becomes "Save and restart scanning" while any
   field is dirty, with a caution note: "Audio cuts for a moment and the wall
   replays its warm-up." The idle note is "Volume and mute stay on the Now panel
   and apply instantly."

### Advanced (engine) card (`#/scan`, last, `grid-column: 1 / -1`, closed by default)

Header hint: "Tuned for this appliance. Leave blank for the default." The card
has four bands in a 2-column grid (1 column when narrow). Each band has an `h3`,
a one-line purpose, and a **cost label** stated once:

| Band | Cost label | Fields (config → UI unit) |
|---|---|---|
| Loudness detail | Restarts scanning (caution) | `audio.agcAttackMs` ms (1…200, 10) · `agcReleaseMs` ms (20…5000, 400) · `agcHoldBelowDb` dBFS (−90…−20, −50) · `agcMinGainDb` dB (−40…0, −20) · `limiterCeiling` FS (>0…0.8, 0.7) · `limiterReleaseMs` ms (5…1000, 50) |
| Group shape | Restarts scanning (caution) | `scan.lanesPerGroup` (1…64, 32) · `sampleRateHz` shown in Msps (0.95…3.2, step 0.05, 2.50) · `windowBandwidthHz` MHz (2.40) · `flatBandwidthHz` MHz (2.00) |
| Scheduling | Applies live (green) | `scan.autoDwell.enabled` switch · `halfLifeMin` min (1…1440, 30) · `minFactor` × (0.2…1, 0.5) · `maxFactor` × (1…5, 2.0) · sub-heading "Priority revisit": `priorityRevisit.enabled` switch · `everyMs` shown in s (1…60, 8) · `lookMs` shown in s (0.3…5, 0.7) |
| Helper watchdogs | Needs a backend restart (coral) | `scan.helperReadyTimeoutMs` s (1…120, 10) · `helperSilenceTimeoutMs` s (1…120, 5) |

Band-level behaviours:
- **Group-shape preview.** Under the band, a `.derived` box reads "{n} groups from
  {c} channels, {e} outside the flat passband. Quiet cycle ≈ {s} s." It is
  recomputed on `input` from the dirty-or-default lanes, window and flat values,
  and the rate is used only to validate the window.
  - Channel set: `cfg.channels` filtered through `isScannable` (the same filter
    `toScanConfig` uses, from `backend/config/banks.ts`). It has no NWR
    background channel, which is correct because the appliance has a weather
    radio.
  - Groups: `groupChannels(channels, window, lanes, { flatHz })`, imported from
    `backend/engine/grouping.ts` (pure, type-only import of `Channel`).
  - Edge count: channels with |freq − center| > flat/2.
  - Cycle: Σ over groups of `groupDwellMs × max(dwellWeight)` + groups × 0.64 s
    warm-up, at an autoDwell factor of 1. The label says "quiet" because holds
    lengthen it.
  - If window > rate − 0.05 MHz, the box shows the caution message instead:
    "Window {w} MHz is wider than rate − 0.05 ({r}). Raise the rate or narrow the
    window." Save is disabled while that holds (the schema would 400).
- **Priority revisit hint.** If no channel has `priority: true`, the row hint reads
  "No channel is marked priority yet, so this is idle". Otherwise it reads
  "Peeks at {k} priority groups".
- **Save** is one button for the card. The label is "Save and restart scanning" if
  any dirty field is in a restart-scanning band, else "Save engine settings". The
  note joins the costs of the dirty bands: "audio cuts for a moment",
  "scheduling applies at once", "watchdogs apply after a backend restart (System
  → Restart radio backend)". It reads "Nothing changed." when idle.

## Behaviour and data flow

- **Load:** these fields populate in the same place and at the same time as the
  existing Scanning fields (the `cfg` load in `admin.ts`). Unset → an empty input
  with the default as placeholder. Unit conversions (Hz↔MHz/Msps, ms↔s) happen
  only at the input boundary.
- **Save** follows the existing card pattern: fetch the current config, merge this
  card's fields (empty → `undefined`, i.e. back to the default), then `putConfig`.
  Volume and mute are not touched. The server's existing diff decides the real
  cost: scheduling stays live via `updateScheduling`, and everything else
  restarts the engine. No API or behaviour change on the backend.
- **Validation:** the inputs carry the schema's `min`/`max`/`step`. On save, the
  client checks the range, the 50 kHz rate step and window ≤ rate − 50 kHz, and
  shows the card's `.err` line. A server `400` shows its first zod issue message
  in the same place.
- **Dirty tracking:** a field is dirty when its value differs from the loaded
  value. The label and note update on `input`. After a save, the card reloads
  from the response and dirty state clears.

## Defaults mirror (new, `src/backend/config/engineDefaults.ts`)

The AGC, limiter, LPF, HPF and AM-gain defaults exist only in
`kiosk/native/src/constants.hpp`. Add a TypeScript `ENGINE_DEFAULTS` object for
the UI placeholders and the curve. It re-exports the existing TS defaults
(lanes, rate, window, flat, `AUTO_DWELL_DEFAULTS`, `PRIORITY_REVISIT_DEFAULTS`)
and adds the C++-only ones. The watchdog defaults (10 s / 5 s) move from
`WidebandEngine.ts` into this module, and `WidebandEngine` imports them from
there.

A vitest reads `constants.hpp` and asserts that every mirrored C++ value matches.
If it drifts, the test fails.

## Code shape

- Everything stays in `admin.ts` / `admin.css`: vanilla TS, `lucide-static` icons
  only, and no new dependencies. Pure helpers go in a new
  `src/frontend/admin/engineKnobs.ts` so they can be unit-tested headless:
  - `loudnessCurve(params)` → the SVG path points;
  - `previewGroups(channels, knobs)` → `{groups, edge, cycleS}` or `{error}`;
  - `saveCost(dirtyBands)` → the button label and note;
  - the field table (config path, unit scale, range, default, band) that drives
    load, save, validation and dirty tracking. This keeps 25 fields from
    becoming 25 hand-written blocks.
- Styling uses the existing tokens (`--panel`, `--rule`, `--caution`, `--green`,
  `--red`, `--t-*`) and the `DESIGN.md` `rounded` scale (card 8 px, control 4 px).
  No `backdrop-filter`.

## Testing and proof

- vitest: the `engineDefaults` ↔ `constants.hpp` parity test, plus
  `loudnessCurve`, `previewGroups` and `saveCost`:
  - on a fixture channel list, `previewGroups` must match `groupChannels`,
    with the expected edge count and cycle;
  - window > rate − 0.05 must produce the error;
  - a band mix must produce the right label.
- `npm run typecheck` (both tsconfigs), `npm test`, `npm run test:native`
  (unchanged C++), and a full `npm run build`.
- On the appliance:
  - Take a headless screenshot of `/admin/#/scan` with the Advanced card open,
    saved inside `$HOME`.
  - Save a scheduling-only change and confirm the scanner `kerchunk-dsp` PID is
    unchanged.
  - Save a Sound change (for example hum filter 300 → 250) and confirm the
    helper respawned with `--audio-hpf-hz 250`.
  - Restore the operator's values afterwards.
- No backend restart is needed to ship this. The only backend edit (watchdog
  defaults moving into `engineDefaults.ts`) is behaviour-identical and takes
  effect at the next natural restart. After `npm run build`, refresh the admin
  tab. `/api/kiosk/reload` is for the wall and isn't needed here.

## Out of scope

- A per-knob live preview by ear (A/B), and resetting a band to its defaults (clearing
  its fields does the same).
- Moving the quieting threshold out of Scanning.
- Any backend or API change. `docs/API.md` is unchanged. `docs/DEPLOY.md` gets one
  line saying the knobs are now editable under Settings.
