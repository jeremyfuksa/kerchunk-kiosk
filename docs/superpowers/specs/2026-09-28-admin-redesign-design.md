# Admin redesign: radio-first, Kerchunk's own design system

**Date:** 2026-09-28
**Status:** Design approved (operator, 2026-09-28) — spec awaiting review
**Scope:** `kiosk/src/frontend/admin/` rebuilt; new `kiosk/src/frontend/tokens.css`;
`@jeremyfuksa/campfire` removed from the whole project; `DESIGN.md` rewritten.
No backend or API changes.

## Problem

Operator: "the admin platform is overly complicated." Observed on the live
admin (all five pages screenshotted 2026-09-28):

- **Three competing navigation layers** — header links, a five-item rail with
  subtitles, and a persistent "Radio now" side panel that repeats the health
  and vitals the System page also shows.
- **Settings is a wall of 30+ raw numeric fields** in six cards with six Save
  buttons, mixing everyday choices (Close Call on/off, weather channel) with
  DSP internals (lanes, sample rate, AGC timings).
- **Channels** is a 102-row table grouped into collapsible banks, plus a bank
  builder, dup panel, archive suggestions and a full-form drawer.
- **No hierarchy** — every surface is a bordered card on near-black, and the
  single orange accent marks nav state, primary buttons, checkboxes and the
  volume thumb alike.

Operator priorities for the admin, in order: **(A) listen to and control the
radio right now**, then **(E) tune settings**. Triage, channel curation and
health are secondary.

## Decisions (operator, 2026-09-28)

1. **IA:** four tabs — **Radio · Tune · Library · System**. Radio is home.
2. **Visual language:** the *Faceplate* structure (the admin is the scanner's
   front panel: an LCD for what's live, tactile keys) in the *Night desk*
   palette and type (blue-slate ground, tone-separated surfaces, sea-glass for
   "live", Schibsted Grotesk).
3. **LCD treatment:** *glow on glass* — a dark recessed panel whose characters
   glow sea-glass (VFD-like), not a lit slab.
4. **Tune:** plain-language groups, sliders with named ends, save as you go,
   engine internals behind "Advanced".
5. **Library / channel detail / System** as mocked (brainstorm screen
   `library-system.html`): approved "for now".
6. **Campfire removed project-wide.** The wall/dashboard/map/art keep their
   current look exactly (values move into Kerchunk's own tokens); only the
   admin adopts the new language. Restyling the wall is a possible later
   follow-up, not part of this work.
7. **Build approach:** the new admin is built alongside the old one and
   flipped at the end (sequence below).

## 1. Design system

### 1.1 `src/frontend/tokens.css` (replaces Campfire)

One file, imported once by `main.ts` in place of
`@jeremyfuksa/campfire/tokens.css`. Two layers:

**Layer 1 — surface tokens for the wall/dashboard/map/art (look unchanged).**
Every Campfire custom property currently referenced anywhere in
`src/frontend/**` (inventory by `grep -ohE "var\(--[a-z0-9-]+" src/frontend`:
`--bg-base`, `--bg-subtle`, `--border-default`, `--border-strong`,
`--text-primary/secondary/tertiary`, `--neutral-300/500/600/700`, `--spark`,
`--warning-500`, `--success-400`, `--danger-400`, `--pine`, `--golden-amber`,
`--flamingo`, `--font-sans`, and any others the inventory finds) is defined
with the value it **currently resolves to on the appliance under `.dark`**.
Values are read from the installed package in `kiosk/node_modules` — which
carries the night-ramp retune overlay (campfire#59), i.e. what is on the wall
today — not from the published npm tarball. The existing local alias layers
in `dashboard.css`, `wall.css`, `map.css`, `art.css` keep working unchanged.

**Layer 2 — the admin language (`--kc-*`).** Semantic tokens only; the admin
never uses Layer 1.

| Token | Value | Role |
|---|---|---|
| `--kc-ground` | `#15191f` | page ground (blue-slate) |
| `--kc-raised` | `#20262d` | grouped surfaces (settings groups, cards, sheets' groups) |
| `--kc-key` | `#262d35` | key/button face |
| `--kc-line` | `#232a31` | row separators (the only hairline) |
| `--kc-well` | `#0c1113` | LCD glass |
| `--kc-ink` | `#e6e9ee` | primary text |
| `--kc-dim` | `#98a1ad` | secondary text, group headings |
| `--kc-mute` | `#7c8592` → tuned | tertiary text (see contrast rule) |
| `--kc-glass` | `#5fd4c3` | LIVE: LCD characters, primary key, active tab, slider fill |
| `--kc-glass-ink` | `#08231f` | text on `--kc-glass` |
| `--kc-glass-text` | `#d9f5f0` | LCD channel name |
| `--kc-coral` | `#f29b8f` | destructive (Lock out, power actions) |
| `--kc-hay` | `#e8c37a` | needs-attention (triage badge, suggestions strip) |
| `--kc-ok` | `#7fc79a` | healthy verdict |

- **Contrast rule:** every text token must clear 4.5:1 on both `--kc-ground`
  and `--kc-raised` (non-text glyphs 3:1). `--kc-mute` as drafted is ~4.1:1 on
  `--kc-raised`; lift it until it passes. Record the measured ratios in a
  comment beside the tokens (the existing admin.css convention).
- **The emphasis budget carries over:** sea-glass marks only what is live or
  the one primary action on a screen. Service colors (`lib/serviceColor.ts`
  `PIN_COLORS`) appear only as the small row dot.
- **Type:** Schibsted Grotesk (400/500/600/700/800), loaded for the `admin`
  route via `FONT_QUERY` in `main.ts` (the same off-critical-path Google Fonts
  mechanism the other pages use); fallback `system-ui, sans-serif`. The wall,
  dashboard and map stay on Inter. Scale (rem, by role):
  `--kc-t-meta` 0.78 · `--kc-t-small` 0.82 · `--kc-t-body` 0.94 ·
  `--kc-t-row` 1 · `--kc-t-lead` 1.25 · `--kc-t-title` 1.6 ·
  `--kc-t-lcd-name` 1.5 · `--kc-t-lcd-freq` 2.6 (tabular numerals).
  Sentence case everywhere; no all-caps labels.
- **Shape:** `--kc-r-key` 10px (keys, inputs, chips' inner), `--kc-r-group`
  14px, `--kc-r-sheet` 18px, `--kc-r-pill` 999px. No borders on surfaces —
  separation is by tone. Keys carry the one "tactile" shadow
  (`0 2px 0 #0009, inset 0 1px 0 #ffffff12`); nothing else has a shadow.
- **Motion:** only in response to the operator (sheet open/close, key press
  depress, tab change). `prefers-reduced-motion` disables it. No ambient
  animation; the LCD level meter moves only with live data.
- **Thermal invariant respected:** no `backdrop-filter`, no full-screen
  overlays on the wall (admin runs on the operator's device, not the kiosk,
  but the rule is kept for consistency).
- **Icons:** `lucide-static` only (operator mandate).

### 1.2 `DESIGN.md`

Rewritten to document both layers: the admin language (Layer 2) as the
primary system, and the wall/dashboard surface values (Layer 1) as the
ambient-display palette. The `.impeccable/design.json` sidecar is refreshed
from it (`/impeccable document`).

### 1.3 Removal

`@jeremyfuksa/campfire` removed from `package.json` / lockfile; the
`import "@jeremyfuksa/campfire/tokens.css"` in `main.ts` replaced by
`import "./tokens.css"`. The node_modules overlay caveat (npm ci reverting the
night-ramp colors) disappears with it.

## 2. Shell

- **Tabs:** Radio · Tune · Library · System. Desktop (≥ 900px): a top bar —
  wordmark, the four tabs, and on the right a one-line health verdict
  (dot + "Scanning · 58°C") linking to System, plus "Kiosk ↗" / "Map ↗"
  links. Phone: the same four as a bottom tab bar (safe-area aware);
  wordmark + verdict in a slim header.
- **Library tab badge** shows the triage count in `--kc-hay` when > 0.
- **Mini-player** on Tune, Library and System (not on Radio, which *is* the
  player): channel name, frequency in sea-glass, Skip and Listen/Stop keys;
  tapping it goes to Radio. Phone: docked above the tab bar. Desktop: in the
  top bar between the tabs and the verdict.
- **Routing:** hash routes `#/` (Radio), `#/tune`, `#/library`,
  `#/library/new`, `#/system`. Old routes redirect: `#/triage` →
  `#/library/new`, `#/channels` → `#/library`, `#/scan` → `#/tune`.
- **Polling:** keep the existing polite poller design from `admin.ts`
  (one request group in flight, per-route poll declarations, "make due on
  route entry"). The appliance deadlocks on concurrent requests; the new admin
  must never fire parallel request bursts, and auto-save writes join the same
  single-flight queue.
- **Toasts, confirm dialog, skip link, focus management** carry over in the
  new styling. Visible keyboard focus (sea-glass 2px ring) on every
  interactive element.

## 3. Radio (home)

- **LCD** (glow on glass): meta line (level meter · "Live" / "Scanning" /
  "Weather" · mode · service · location; dB readout right), channel name in
  `--kc-glass-text`, frequency large in `--kc-glass` with a soft glow, "MHz"
  small. While scanning with nothing open: "Scanning…", dimmed (plus whatever
  scan-position detail `/api/status` already carries — no new fields).
- **Keys:** a full-width primary key (Listen here / Stop listening, sea-glass;
  disabled with an explanation when remote listening is off), then a row:
  Skip · Weather (↔ Resume scan while parked) · Pause 30 min · Lock out
  (coral text). Same handlers as today's now-panel buttons.
- **Volume:** slider + percentage + Mute key; "Remote listening" switch below
  it (flipping it is an engine restart — it gets the restart confirm from
  §4.2).
- **Recently heard:** the last ~8 hits (name, relative time); tapping one
  opens its channel detail.
- **Activity:** today's hits / airtime and the by-hour bars; the top-channels
  list with the 24 h / 7 d / 30 d period switch (today's Insights) collapsed
  behind "Channel activity".
- **Alerts:** the last alerts (bell + SAME) with Clear all; empty state
  explains how to flag a channel.
- **Health banner:** only when not healthy — a coral/hay strip above the LCD
  with the verdict and a link to System. The persistent health/vitals box of
  today's now-panel is dropped (the top-bar verdict covers it).
- **Desktop:** two columns — LCD, keys, volume, recently heard on the left;
  activity and alerts on the right.

## 4. Tune

### 4.1 Groups (plain language)

| Group | Fields (today's field → new control) |
|---|---|
| **Sound** | Target loudness, Max boost, Hiss cut (FM), Hum filter (FM; slider's low end is "Off"), Airband balance — plus the loudness curve figure from today's Sound card |
| **Scanning** | Squelch open, Quieting threshold, Group dwell, Hang time, Sweep ranges (text) |
| **Discovery** | Close Call switch, Close Call threshold, Record samples switch, Sample length, Sample storage |
| **Alerts** | Alert cooldown, Alert hold, Push notification URL, SAME county codes, Show SAME tests |
| **Weather channel** | NOAA channel, Name, Mode |
| **Advanced** (disclosure, closed by default) | today's Loudness detail, Group shape, Scheduling, Helper watchdogs bands, with their purpose lines and cost labels |

Integrations (Google Maps key / Map ID) move to **System → Connections**.

- **Sliders with named ends** for bounded numeric knobs ("Quieter ↔ Louder",
  "Hear more ↔ Hear less", "Clearer ↔ Brighter", …); the current value and
  unit shown right of the label. Each slider also accepts typed entry (tap the
  value to edit) for exact numbers. Free-form and unbounded fields (URLs,
  FIPS, sweep ranges, API keys) stay text inputs. Range, step and default for
  engine knobs come from `KNOB_FIELDS` in `engineKnobs.ts` — the table stays
  the single source of truth; ranges for the non-knob fields are added to it
  (or a sibling table) rather than hardcoded in markup.
- **Reset to default** per field (shown when the value differs from default).

### 4.2 Save as you go — cost-aware

Each field has a **cost**, derived from the server's PUT `/api/config` diff
(extend `BAND_COST` to cover every Tune field):

- **live** (alerts, weather name, scheduling, lockouts, Maps keys): saved
  immediately on change (text fields on blur/Enter). "Saved" appears inline
  and fades.
- **scan** (anything that changes `toScanConfig` — sound, squelch, dwell,
  Close Call, samples, shape): the engine does `stop()` + `start()`, which
  replays the wall's warm-up overlay and chops audio. These are **batched per
  group**: after the last change the group shows "Applying in 3 s — restarts
  scanning briefly · Undo" and saves once when the countdown ends. Further
  changes restart the countdown. Sliders commit on release, not on every
  input event.
- **backend** (helper watchdogs): saved, with the note that they apply after
  the next radio restart (System → Restart radio).
- **Heavy switches** — Record samples, Remote listening, and Advanced → Group
  shape — show an explicit inline "Apply" / "Cancel" instead of the countdown.

**Knob:** the countdown is `TUNE_APPLY_DELAY_MS` (default 3000) in the Tune
module, exported so it is tunable in one place.

Validation errors (schema-rejected values) show under the field, the field
keeps the operator's value, and nothing is saved until it is valid.

## 5. Library

Segmented control at the top: **Channels (n)** | **New (n)** (hay badge).

### 5.1 Channels

- Search (name, frequency, tag; `/` focuses it).
- **Bank chips:** All, then one chip per bank with its count, then
  "Manage banks". Selecting a chip filters the list. An "Archived" chip shows
  archived channels (hidden from other views).
- **Suggestions strip** (hay), only when there is something: "3 suggestions:
  1 duplicate, 2 to archive — Review" → a sheet containing today's dup
  resolver and archive recommendations.
- **Rows:** service-color dot · name (ellipsized) · frequency · mode ·
  location · one **speaker key** toggling audible (the only in-row control).
  Tap/Enter on the row opens channel detail. "+ Add channel" is the primary
  action in the header.
- **Manage banks** sheet: bank list (name, rule summary, count), create bank
  (today's bank builder fields), and per-bank scan profile (squelch open,
  quieting, hang, dwell weight; empty = global), make audible/silent, archive
  all, delete. Same handlers as today's bank ⋯ menu and profile drawer.

### 5.2 Channel detail

Phone: a bottom sheet. Desktop (≥ 900px): a right-side pane beside the list
(list stays interactive).

- LCD header (glow on glass): mode · service · location; name; frequency.
- Keys: **Listen now** (primary) · **Lock out** (coral, confirm).
- Switches, saved as you go (live): Play through speaker, Priority, Alert
  when heard, Archive.
- Name, Mode, Banks (tags) — edited in place; saved on blur/Enter.
- **More details** (disclosure): frequency (editable), tone (CTCSS/DCS with
  the "Heard: …" suggestions), tags as text, site lat/lon, and the read-only
  lookup info (band, exact Hz, location source, power, looked up, id), plus
  channel analytics (today's analytics drawer content).
- New-channel mode: the same sheet, empty, with an explicit **Add channel**
  button (a new channel is not auto-created mid-typing).

### 5.3 New (triage)

- **Cards**, newest first: frequency, hit count and last-heard, best-guess
  name/service/distance from the identification chain, the **recorded sample
  playable inline** (when recording is on), and three keys: **Add channel**
  (primary — opens channel detail pre-filled), **Dismiss**, **Lock out**
  (coral).
- "Select" link enters bulk mode (checkboxes on cards; Dismiss / Lock out
  selected).
- Footer link: "Suppressed likely noise (n)" → sheet with today's
  suppressed list.
- Empty state: when Close Call is off, "Close Call is off, so nothing new
  will arrive — Turn it on" linking to Tune → Discovery.

## 6. System

- **Verdict card:** dot + "Healthy / Degraded / …" + one-line reason and
  uptime (today's `sysHealth` verdict logic).
- **Vitals:** Temperature, CPU (with sparklines), DSP helper, Disk free;
  RAM and open-channels as secondary lines. Same data as today.
- **Kiosk screen:** Refresh kiosk screen; Show a test weather alert / Clear.
- **Connections:** Google Maps (key + Map ID, live save); Locked-out
  frequencies (count → sheet listing them with Remove).
- **Power** (last, coral): Restart radio, Reboot appliance, Shut down — each
  behind the confirm dialog with the current consequence copy; the existing
  `systemActionWatcher` status flow ("going down… / back") is kept.

## 7. Build sequence

Built alongside the old admin, then flipped. Each step is one PR, proven on
the appliance before merge (branch → build → prove → push → PR → merge).

1. **`chore/kerchunk-tokens`** — `tokens.css` (both layers), Campfire removed,
   `main.ts` import swapped, `DESIGN.md` rewritten. Proof: grim screenshot of
   the live wall before and after — must be visually identical; admin still
   renders (old admin, Layer 1).
2. **`feat/admin-next-shell-radio`** — new module tree
   `src/frontend/admin-next/` (`shell.ts`, `radio.ts`, `ui/` kit: key, lcd,
   slider, switch, sheet, group, chip), mounted at `#/next` inside the admin
   route so the current admin stays default. Radio tab complete.
3. **`feat/admin-next-tune`** — Tune with cost-aware save.
4. **`feat/admin-next-library`** — Channels, detail sheet/pane, banks sheet,
   suggestions, New.
5. **`feat/admin-next-system`** — System.
6. **`feat/admin-next-flip`** — the admin route renders the new tree; old
   `admin/admin.ts` + `admin.css` deleted (pure modules such as
   `engineKnobs.ts` and form helpers move into `admin-next/` or `lib/`), old
   hash routes redirect, `admin-next` renamed to `admin`. `docs/API.md`
   untouched (no API changes) unless something is found to have moved.

## 8. Testing & verification

- **Unit (vitest, headless):** keep `engineKnobs.test.ts` and
  `adminForm.test.ts` passing (move with their modules). New pure logic gets
  tests: the field→cost mapping (every Tune field has a cost matching the
  server diff), the per-group apply batcher (countdown, restart on change,
  undo, single-flight queue), route redirects, slider value↔config scaling.
- **Contrast:** a small test computes WCAG ratios for every `--kc-*` text
  token against `--kc-ground` and `--kc-raised` and fails below 4.5:1.
- **Definition of done per PR:** `npm test`, `npm run test:native`,
  `npm run typecheck` (both tsconfigs — the new tree must be covered by
  `tsconfig.frontend.json`), full `npm run build`.
- **On hardware:** admin screens are DOM pages, so headless chromium
  screenshots work (write PNGs inside `$HOME`) at 390px and 1440px widths for
  each tab; the operator checks on their phone. PR 1 additionally needs the
  live-wall grim comparison. Tune's apply batching is proven by changing a
  sound knob and confirming exactly one engine restart per batch in the
  journal.

## Out of scope

- Restyling the wall, dashboard, map or art (possible later follow-up).
- Any backend/API change; the external consumer's `/api/status`,
  `/api/logs`, `/api/weather` shapes are untouched.
- A light theme.
- New features — this is a restructure and restyle of existing capability.
