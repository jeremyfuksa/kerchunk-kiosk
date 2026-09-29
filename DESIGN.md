---
name: Kerchunk
description: Dark-only interfaces for an always-on SDR scanner appliance. The admin is the scanner's front panel (the Faceplate); the ambient displays are quiet rooms with exactly one thing lit.
colors:
  # ── Layer 2: the admin (Faceplate × Night desk) — tokens.css --kc-* ──
  kc-ground: "#15191f"
  kc-raised: "#20262d"
  kc-key: "#262d35"
  kc-line: "#232a31"
  kc-well: "#0c1113"
  kc-well-edge: "#2a3a3a"
  kc-ink: "#e6e9ee"
  kc-dim: "#a4acb7"
  kc-mute: "#8d96a3"
  kc-glass: "#5fd4c3"
  kc-glass-ink: "#08231f"
  kc-glass-text: "#d9f5f0"
  kc-coral: "#f29b8f"
  kc-hay: "#e8c37a"
  kc-hay-ink: "#2a1d05"
  kc-ok: "#7fc79a"
  # ── Layer 1: ambient displays (wall, dashboard, map, art) — frozen ──
  signal-amber: "#ff6b35"
  caution-hay: "#f9c574"
  adopt-moss: "#9ac35d"
  destroy-coral: "#f17d7b"
  flamingo: "#dc3a38"
  golden-amber: "#ef991f"
  danger-50: "#fef5f4"
  danger-800: "#9c2524"
  night-ground: "#0e0f12"
  slate-panel: "#16181d"
  panel-edge: "#23262d"
  hairline: "#343842"
  neutral-600: "#4d525e"
  steel: "#7a8090"
  bright-ink: "#f7f8f9"
  cool-label: "#b8bcc5"
  quiet-hint: "#9299a5"
  pine: "#4a7c7e"
  service-air: "#3478f5"
  service-rail: "#8b5034"
  service-ham: "#ec4e89"
  service-gmrs: "#1fa84c"
  service-business: "#6d28d9"
  service-marine: "#0faec0"
  service-weather: "#f4b315"
  service-publicsafety: "#e5383b"
  service-unknown: "#747b8a"
  position-unknown: "#4a7c7e"
  wall-ground: "#05070a"
  art-ground: "#04060a"
  art-ground-mid: "#070a10"
  art-ground-lift: "#0b0f16"
  storm-tornado: "#e01a2b"
  storm-severe: "#f5a623"
  storm-flood: "#15924f"
  storm-winter: "#d23a9d"
  storm-wind: "#c59a2c"
  storm-tropical: "#a8327f"
  storm-fire: "#e8501e"
  storm-civil: "#c8102e"
  storm-test: "#5b6b7a"
  storm-on-light: "#ffffff"
  storm-on-dark: "#1a1205"
  storm-on-test: "#e8eef3"
typography:
  # ── Layer 2: the admin — Schibsted Grotesk, --kc-t-* ──
  kc-meta:
    fontFamily: "'Schibsted Grotesk', system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "0.78rem"
    fontWeight: 600
    lineHeight: 1.3
  kc-small:
    fontFamily: "'Schibsted Grotesk', system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "0.82rem"
    fontWeight: 400
    lineHeight: 1.4
  kc-body:
    fontFamily: "'Schibsted Grotesk', system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "0.94rem"
    fontWeight: 400
    lineHeight: 1.5
  kc-row:
    fontFamily: "'Schibsted Grotesk', system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "1rem"
    fontWeight: 500
    lineHeight: 1.4
  kc-lead:
    fontFamily: "'Schibsted Grotesk', system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "1.25rem"
    fontWeight: 700
    lineHeight: 1.25
    fontFeature: "tabular-nums"
  kc-title:
    fontFamily: "'Schibsted Grotesk', system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "1.6rem"
    fontWeight: 700
    lineHeight: 1.2
  kc-lcd-name:
    fontFamily: "'Schibsted Grotesk', system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "1.5rem"
    fontWeight: 700
    lineHeight: 1.15
  kc-lcd-freq:
    fontFamily: "'Schibsted Grotesk', system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "2.6rem"
    fontWeight: 800
    lineHeight: 1
    letterSpacing: "-0.02em"
    fontFeature: "tabular-nums"
  # ── Layer 1: ambient displays — Inter, the kiosk's --k-* ramp ──
  kiosk-meta:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "0.95rem"
    fontWeight: 400
    lineHeight: 1.4
  kiosk-body:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "1.05rem"
    fontWeight: 400
    lineHeight: 1.45
  kiosk-label:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "1.2rem"
    fontWeight: 600
    lineHeight: 1.3
  kiosk-alert:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "1.3rem"
    fontWeight: 600
    lineHeight: 1.3
  kiosk-status:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "1.5rem"
    fontWeight: 700
    lineHeight: 1.25
  kiosk-scan:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "1.6rem"
    fontWeight: 600
    lineHeight: 1.2
  kiosk-value:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "1.9rem"
    fontWeight: 600
    lineHeight: 1.15
  kiosk-headline:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "2.2rem"
    fontWeight: 600
    lineHeight: 1.15
  kiosk-alert-lg:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "2.5rem"
    fontWeight: 700
    lineHeight: 1.04
  kiosk-clock:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "2.7rem"
    fontWeight: 600
    lineHeight: 1
  kiosk-alert-xl:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "3.3rem"
    fontWeight: 700
    lineHeight: 1.02
  kiosk-clock-lg:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "3.7rem"
    fontWeight: 600
    lineHeight: 1
  kiosk-display:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "clamp(3rem, 7.5vw, 6.2rem)"
    fontWeight: 600
    lineHeight: 1.08
    letterSpacing: "0.01em"
  kiosk-display-map:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "clamp(2.3rem, 3.9vw, 3.85rem)"
    fontWeight: 600
    lineHeight: 1.08
  kiosk-freq:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "clamp(1.7rem, 3.6vw, 2.8rem)"
    fontWeight: 500
    lineHeight: 1.2
rounded:
  # Layer 2 (admin)
  kc-key: "10px"
  kc-seg: "13px"
  kc-group: "14px"
  kc-sheet: "18px"
  kc-pill: "999px"
  # Layer 1 (ambient)
  hairline: "2px"
  control: "4px"
  card: "8px"
  dot: "9999px"
spacing:
  kc-row-padding: "10px 16px"
  kc-group-gap: "14px"
  kc-key-gap: "8px"
  kc-column-gap: "18px"
  kc-page-max: "1180px"
components:
  key:
    backgroundColor: "{colors.kc-key}"
    textColor: "{colors.kc-ink}"
    rounded: "{rounded.kc-key}"
    padding: "10px 14px"
    typography: "{typography.kc-body}"
    height: "44px"
  key-primary:
    backgroundColor: "{colors.kc-glass}"
    textColor: "{colors.kc-glass-ink}"
    rounded: "{rounded.kc-key}"
    padding: "10px 14px"
    typography: "{typography.kc-body}"
    height: "44px"
  key-danger:
    backgroundColor: "{colors.kc-key}"
    textColor: "{colors.kc-coral}"
    rounded: "{rounded.kc-key}"
    padding: "10px 14px"
    typography: "{typography.kc-body}"
    height: "44px"
  lcd:
    backgroundColor: "{colors.kc-well}"
    textColor: "{colors.kc-glass}"
    rounded: "{rounded.kc-group}"
    padding: "16px 18px 14px"
  group:
    backgroundColor: "{colors.kc-raised}"
    textColor: "{colors.kc-ink}"
    rounded: "{rounded.kc-group}"
    padding: "6px 0 8px"
  row:
    backgroundColor: "transparent"
    textColor: "{colors.kc-ink}"
    padding: "{spacing.kc-row-padding}"
    typography: "{typography.kc-row}"
  chip:
    backgroundColor: "{colors.kc-raised}"
    textColor: "{colors.kc-dim}"
    rounded: "{rounded.kc-pill}"
    padding: "0 14px"
    typography: "{typography.kc-small}"
    height: "40px"
  chip-pressed:
    backgroundColor: "color-mix(in srgb, {colors.kc-glass} 16%, {colors.kc-raised})"
    textColor: "{colors.kc-glass}"
    rounded: "{rounded.kc-pill}"
  segmented:
    backgroundColor: "{colors.kc-raised}"
    textColor: "{colors.kc-dim}"
    rounded: "{rounded.kc-seg}"
    padding: "3px"
  segmented-current:
    backgroundColor: "{colors.kc-key}"
    textColor: "{colors.kc-ink}"
    rounded: "{rounded.kc-key}"
  badge:
    backgroundColor: "{colors.kc-hay}"
    textColor: "{colors.kc-hay-ink}"
    rounded: "{rounded.kc-pill}"
    padding: "0 7px"
    typography: "{typography.kc-meta}"
  sheet:
    backgroundColor: "{colors.kc-ground}"
    textColor: "{colors.kc-ink}"
    rounded: "{rounded.kc-sheet}"
  toast:
    backgroundColor: "{colors.kc-key}"
    textColor: "{colors.kc-ink}"
    rounded: "{rounded.kc-key}"
    padding: "10px 10px 10px 16px"
  vital:
    backgroundColor: "{colors.kc-raised}"
    textColor: "{colors.kc-ink}"
    rounded: "{rounded.kc-group}"
    padding: "12px 14px"
---

# Design System: Kerchunk

Kerchunk has two design languages, one per kind of surface, both defined in
`kiosk/src/frontend/tokens.css`:

1. **The admin — the Faceplate** (tokens.css layer 2, `--kc-*`). The primary
   system, and the one this document is mostly about. Everything the operator
   touches.
2. **The ambient displays** (tokens.css layer 1) — the wall, dashboard, map and
   art. Output-only surfaces seen from across a room. Their palette is frozen;
   they are documented in their own section at the end.

The two layers never mix: the admin uses only `--kc-*`, and the ambient pages
never use `--kc-*`. Spec for the admin:
`docs/superpowers/specs/2026-09-28-admin-redesign-design.md`.

## Overview

**Creative North Star: "The Faceplate"**

The admin is the scanner's front panel, not a dashboard. A real scanner has a
glass display that says what is live, and a row of keys under it. The
admin works the same way. An **LCD** (a dark recessed well whose characters
glow sea-glass) shows what the radio is doing. Tactile **keys** sit under it.
Settings live in plain-language **groups** of rows. Every other surface is
organised around that one piece of glass.

The palette is *Night desk*: a blue-slate ground, surfaces separated by tone
rather than by borders, and one live colour (sea-glass) spent on what is live
or on the one primary action on the screen. The type is Schibsted Grotesk in
sentence case, with tabular numerals on every number that can change.

The operator's jobs set the priorities, in this order: **(A) listen to and
control the radio right now**, then **(E) tune settings**. Triage, channel
curation and health come after. So Radio is home. Radio, Tune, Library and
System are four tabs, and nothing else competes for navigation.

It is instrument *logic* without instrument *cosplay*. Glow on glass and a
key that depresses one pixel are the only borrowed hardware cues. There are no
bevels, brushed metal or fake screws.

**Key characteristics:**
- Dark-only. There is no light theme and no theme switch.
- One live colour (sea-glass), one attention colour (hay) and one destructive
  colour (coral). Nothing else is coloured, except the small service dot on a
  channel row.
- Tone separates surfaces: ground → raised group → key face. There are no
  borders on surfaces. `--kc-line` sits between rows and nowhere else.
- Sentence case everywhere. No all-caps labels, no tracked legends.
- Every write says what it costs before it happens (applies live, re-tunes, or
  restarts scanning).
- Phone-first ergonomics (44px targets, a bottom tab bar, bottom sheets) that
  widen into a two-column desk layout at 900px.

## Colors

Every value below is in `tokens.css` layer 2. Measured contrast (WCAG 2.x) is
recorded beside the tokens and enforced by `kiosk/test/tokens.test.ts`: every
text token clears 4.5:1 on ground, raised **and** key.

### Surfaces
| Token | Value | Role |
|---|---|---|
| `--kc-ground` | `#15191f` | The page ground (blue-slate). Also the sheet ground. |
| `--kc-raised` | `#20262d` | Grouped surfaces: settings groups, lists, vitals, triage cards, chips at rest, the segmented track. |
| `--kc-key` | `#262d35` | Key and input faces, the toast, the bulk bar, bar-chart tracks. |
| `--kc-line` | `#232a31` | The only hairline, and it goes between rows. Never on a surface's edge. |
| `--kc-well` | `#0c1113` | The LCD glass, recessed below the ground. |
| `--kc-well-edge` | `#2a3a3a` | The LCD's bezel hairline (inside `--kc-well-shadow`). |

### Text
| Token | Value | Role | Ground / raised / key |
|---|---|---|---|
| `--kc-ink` | `#e6e9ee` | Primary text and values. | 14.5 / 12.5 / 11.4 |
| `--kc-dim` | `#a4acb7` | Secondary text, group titles, field labels in sheets. | 7.7 / 6.7 / 6.1 |
| `--kc-mute` | `#8d96a3` | Hints, row meta, counts, empty states, slider ends. The dimmest text there is. | 5.9 / 5.1 / 4.7 |

### Meaning
| Token | Value | Role | Ground / raised / key |
|---|---|---|---|
| `--kc-glass` | `#5fd4c3` | **Live.** LCD characters, the one primary key, the active tab, the focus ring. | 9.8 / 8.5 / 7.8 |
| `--kc-glass-ink` | `#08231f` | Text on sea-glass (primary key, checked switch thumb). | 9.2 on glass |
| `--kc-glass-text` | `#d9f5f0` | The channel name on the LCD; row-name hover. | — |
| `--kc-coral` | `#f29b8f` | **Destructive or broken.** Lock out, power actions, field errors, a hot vital, the "trouble" verdict. | 8.3 / 7.2 / 6.5 |
| `--kc-hay` | `#e8c37a` | **Needs attention.** Triage badge, suggestions strip, "stressed" verdict, heavy-apply notice, a pressed toggle key. | 10.5 / 9.1 / 8.3 |
| `--kc-hay-ink` | `#2a1d05` | Text on hay (the triage badge). | 9.8 on hay |
| `--kc-ok` | `#7fc79a` | The healthy verdict dot. | 8.9 / 7.7 / 7.0 |

Tinted strips are made by mixing a meaning colour into the surface under
them (`color-mix(in srgb, var(--kc-hay) 12–14%, var(--kc-ground))`). They are
never a new token and never a hex.

**Service colours** (`lib/serviceColor.ts` `PIN_COLORS`) appear in the admin
only as the 8px dot on a channel row.

### Depth
Shadows use black with alpha, written as short hex inside the tokens
(`--kc-key-shadow`, `--kc-lift-shadow`, `--kc-backdrop`). They are depth, not
colour, and no surface takes one as a background.

### Named rules

**The Emphasis Budget.** Sea-glass means *live* or *the one primary action on
this screen*. It also marks the current selection in the same sense: the
active tab, a pressed chip, a slider's fill and its value box, the current
hour bar, the sparkline stroke, and a text link that resolves a status line
(Undo, Use default). If sea-glass is calling for a *second* action, one of
them is wrong. Hay means attention and coral means destruction, and neither
is used as decoration.

**The Layer Rule.** The admin reads only `--kc-*`. The ambient pages read
only layer 1. A colour that isn't a token doesn't go in, not even as a
`var(--token, #hex)` fallback.

## Typography

**Font:** Schibsted Grotesk (`--kc-font`: `"Schibsted Grotesk", system-ui,
-apple-system, "Segoe UI", sans-serif`), weights 400–800, loaded for the admin
route only through `FONT_QUERY` in `main.ts`.

**Character:** a grotesque with some warmth, legible at 0.78rem on a phone,
and firm enough at 2.6rem to read as a display. One face does every job;
there is no monospace. Tabular figures give instrument alignment without the
costume.

| Role | Token | Size | Use |
|---|---|---|---|
| Meta | `--kc-t-meta` | 0.78rem | Badges, cost pills, slider ends, bottom-tab labels, "Use default". |
| Small | `--kc-t-small` | 0.82rem | Hints, row meta, group titles, the LCD meta line, the status line. |
| Body | `--kc-t-body` | 0.94rem | Prose, key labels, inputs. |
| Row | `--kc-t-row` | 1rem | Row names and setting labels (weight 500). |
| Lead | `--kc-t-lead` | 1.25rem | Vital values, today's totals, sheet titles, triage frequencies (700). |
| Title | `--kc-t-title` | 1.6rem | The one page heading on Tune, Library and System (700). |
| LCD name | `--kc-t-lcd-name` | 1.5rem | The channel name on the glass (700). |
| LCD freq | `--kc-t-lcd-freq` | 2.6rem | The frequency on the glass (800, −0.02em, tabular). The largest thing in the admin. |

The LCD's "MHz" unit is `0.38em` of its frequency, so it scales with the
number it labels. It is the only size off the scale.

### Named rules

**Sentence case.** Every label, key, heading and tab is in sentence case
("Pause 30 min", "Save and restart scanning"). Nothing is all-caps and
nothing is letter-spaced to look like a legend.

**The Tabular Rule.** Any number that can change while being looked at
(frequency, dB, temperature, CPU, counts, clock) uses
`font-variant-numeric: tabular-nums`.

**The Four-Decimal Rule.** Frequencies render to four decimals
(`145.1300`). Scanner frequencies sit on a 12.5 kHz raster, and three
decimals misrepresents them.

**The Scale Rule.** Font size comes from a `--kc-t-*` token, in rem. Never
use px for type.

## Layout

- **Shell.** Desktop (≥900px): a sticky top bar holds the wordmark, the four
  tabs, the mini-player (on every tab but Radio), a one-line health verdict
  linking to System, and "Kiosk ↗" / "Map ↗". Below 900px the tabs move to a
  bottom tab bar that respects `env(safe-area-inset-bottom)`. The mini-player
  docks full-width under the slim header. Content is capped at 1180px and
  centred.
- **Radio** is two columns on desktop (LCD, keys, volume and recently heard
  on the left; activity and alerts on the right) and one column on a phone.
  The key grid is four across only when its *column* fits "Pause 30 min" on
  one line (a container query at 620px); otherwise it is two.
- **Tune** lays its groups out in an auto-fit grid (`minmax(min(100%, 380px),
  1fr)`). Engine internals sit behind a closed "Advanced" disclosure.
- **Library** is a segmented control (Channels | New), then search, then
  bank chips, then one list. Channel detail opens as a sheet (see Components).
- **System** has a verdict card, vitals (two across, four at ≥900px), kiosk
  screen actions, connections, and power last.

**The Thumb Rule.** Every target is at least 44px (inputs, chips and
segments are at least 40px, with the row as the larger target). The only
exemptions are glyphs whose row is itself the target.

**The One Scroll Rule.** A page scrolls once. Lists are rows in a group, not
tables, so nothing scrolls sideways (the chip strip is the one deliberate
horizontal scroller).

## Elevation & Depth

Flat by default. Depth comes from tone (well < ground < raised < key), not
borders or shadows. Exactly two shadows exist, and each has a job:

- **Key shadow** (`--kc-key-shadow`: `0 2px 0 #0009, inset 0 1px 0 #ffffff12`)
  makes a key look pressable. Pressed, it drops to `--kc-key-shadow-pressed`
  and the key moves down 1px. Disabled keys lose it. The current segment and
  the speaker key wear it because they are keys.
- **Lift shadow** (`--kc-lift-shadow`: `0 6px 20px #000a`) is for things that
  float above the page: the toast and the triage bulk bar.

The LCD is the one *recessed* thing: `--kc-well-shadow` is an inset bezel
hairline plus an inner shade. A modal's backdrop is `--kc-backdrop`, a flat
scrim. There is no blur.

**No borders on surfaces.** A group, card, sheet, key, input or chip never has
a border. `--kc-line` goes between rows, and it also marks the edge where a
desktop pane meets the page (`box-shadow: -1px 0 0 var(--kc-line)`). The only
other line is the dashed outline of an "add" chip.

**The One Glow.** The LCD frequency carries a soft sea-glass text-shadow
(glow on glass). Nothing else in the admin glows.

## Shapes

| Token | Value | Used by |
|---|---|---|
| `--kc-r-key` | 10px | Keys, inputs, tabs, toasts, segments, tinted strips. |
| `--kc-r-seg` | 13px | The segmented track: the key radius plus its 3px padding, so the inner and outer corners are concentric. |
| `--kc-r-group` | 14px | Groups, the LCD, vitals, triage cards, the channel list, the bulk bar. |
| `--kc-r-sheet` | 18px | Sheets, panes and the confirm dialog. |
| `--kc-r-pill` | 999px | Chips, badges, cost pills, period buttons. |

Dots (the verdict and service dot) are circles.

## Components

All markup comes from the ui kit (`kiosk/src/frontend/admin/ui/kit.ts`,
`ui/sheet.ts`) and `admin/dialogs.ts`. Styles are in `admin/admin.css`,
`library.css` and `system.css`. Every class has the `kc-` prefix, and every
page rule is scoped to `html[data-page="admin"]`.

### The LCD (signature)
`lcd()` → `.kc-lcd[data-state]`. A `--kc-well` panel with the recessed bezel
shadow. It has three lines:
- The **meta line**, in sea-glass at 75% opacity: a four-bar level meter,
  "Live" / "Scanning" / "Weather", the mode, service and location, and the dB
  readout at the right.
- The **channel name**, in `--kc-glass-text`.
- The **frequency**, large and tabular in `--kc-glass` with its glow, and a
  small "MHz".

Glow on glass, never a lit slab. `data-state` changes it only by colour:
*scanning* dims the name to `--kc-dim`, and a weather *break-in* turns the
meta line hay. A "silent" tag shows in hay. The host element carries
`role="status"`, and the dB slot is `aria-hidden` because it changes about
four times a second. The same LCD heads channel detail.

### Keys
`key()` → `button.kc-key`: at least 44px tall, `--kc-key` face, the key
shadow, a 600-weight label that never wraps, and an optional lucide icon.
- **Primary** (`.kc-key--primary`): a sea-glass face with `--kc-glass-ink`
  text. **One per screen**, for example "Listen here", "Add channel" or the
  confirm dialog's default.
- **Plain**: the neutral key.
- **Danger** (`.kc-key--danger`): coral *text* on the plain face. It is never
  a coral slab.
- **Wide** (`.kc-key--wide`) spans its grid. A toggle key with
  `aria-pressed="true"` turns hay (Pause).

### Groups and rows
`group(title, body)` → `section.kc-group`: a `--kc-raised` surface at
`--kc-r-group` with a small `--kc-dim` title in sentence case. Rows
(`.kc-row`, `.kc-lrow` in the library) are separated by `--kc-line` and have
no line before the first row. A row that opens something is one link or
button at least 44px tall. Service colour appears only as the row's 8px
`.kc-dot`. `emptyState()` is a muted sentence that says what to do next.

### Switches
`switchRow()` → `label.kc-switchRow` with a `role="switch"` checkbox, 42×26px.
Off is a key-face track with a mute thumb. On is a sea-glass track with a
glass-ink thumb. The label and hint sit on the left, and the whole row is the
target.

### Sliders with named ends
`slider()` → `.kc-slider`. The label (plus an optional "Use default" link) sits
over its hint. A typed-entry box on the right shows the exact value in
sea-glass, tabular, with its unit. Under it are the range (sea-glass accent)
and the **named ends** ("Quieter" ↔ "Louder", "Hear more" ↔ "Hear less").
The ends are labels, not targets. Sliders commit on release. Ranges, steps and
defaults come from `KNOB_FIELDS` / `tuneFields.ts`, never markup.

### Chips
`chip()` → `button.kc-chip`: a pill at least 40px tall on `--kc-raised`, in
`--kc-dim`, with an optional muted count. It is a toggle (`aria-pressed`), and
pressed is a sea-glass tint with sea-glass text. `.kc-chip--dashed` is the one
"add / manage" chip. Chips filter; they never act on the radio.

### Segmented control
`segmented()` → `nav.kc-seg`. Each item is a link, because each view is a
route. The track is `--kc-raised` at `--kc-r-seg` with 3px padding. The
current item is a key face with the key shadow and `aria-current="page"`. A
count can wear the hay `.kc-badge` when it needs attention (Library → New).

### Sheets
`mountSheet()` → `dialog.kc-sheet`, on the ground colour, radius
`--kc-r-sheet`.
- **Phone, and every management sheet:** a modal **bottom sheet** pinned to
  the bottom edge, with its top corners rounded and room for the safe area. It
  gets a native focus trap and Esc.
- **Desktop (≥900px, `PANE_MIN_WIDTH_PX`) channel detail:** the same dialog
  opens *non-modally* as a **right-side pane**, 420px wide. The list next to
  it stays usable and makes room for the pane. Esc still closes it, and focus
  returns to the opener.

A sheet header is sticky, with the title and a 44px close key. Opening slides
up 24px over 160ms and fades in (skipped under reduced motion).

### Toasts with Undo
`dialogs.toast(text, { undo })` → `.kc-toast`: a key-face slip with the lift
shadow, centred above the tab bar. It is announced politely, and its **Undo**
is sea-glass. It stays offered for `TOAST_MS` (8s) and stays mounted until an
undo settles, so a refused undo can be retried. While a sheet is open, the
toast host moves into the top-most modal so Undo stays reachable.
`dialogs.confirm()` is the one modal dialog (`.kc-confirm`). Its confirm key
is danger for destructive actions.

### The status line
`.kc-status`: one line per group (and per sheet) that says what just
happened to *this* group's settings. It shows "Applying in 3 seconds, which
restarts scanning briefly. Undo available.", "Saved.", an error in coral, or
a Retry / Undo / Apply link in sea-glass. It takes no room when idle. Focus
moves to it when the key that was pressed disappears. It does the toast's job
where a toast would be too far from the setting.

### Vitals with sparklines
`.kc-vital`: a raised tile with a `--kc-dim` label, a lead-size tabular value,
and a 28px sea-glass polyline sparkline (`.kc-spark2`, non-scaling stroke).
Over its threshold, the vital goes `.kc-vital--hot`: the value and line turn
coral. A failed read keeps the last readings, dimmed (`.kc-vitals--stale`),
with a line that says why. Channel detail uses the larger `.kc-spark` (90px)
for 24h history.

### Also in the kit
`field()` (a label, a control and a coral error line with `role="alert"`), the
hay `.kc-badge`, the `.kc-cost` pill ("Applies live" / "Restarts scanning" /
"Needs a backend restart"), the health strip above the LCD (hay or coral tint,
only when not healthy), and the Advanced disclosure (`details` with a rotating
chevron).

## Behaviour the code enforces

These are design rules because the operator feels them, and the admin's
modules enforce them.

**One request on the wire.** The appliance deadlocks on two or more
concurrent requests. Every poll and every write goes through one single-flight
lane, `Poller.run()` (`admin/poller.ts`). Polls run one at a time, only while
the tab is visible, and only for the tab on screen, at cadences set in
`POLL_MS`. Writes queue behind the poll pass in progress and never overlap it.
While a power action (restart, reboot, shut down) is being watched, the
poller pauses and `run()` **refuses every write** with "Wait for the radio to
come back." (`PAUSED_TEXT`). This keeps the watcher's probes alone on the
wire. Nothing may introduce a second poller or a parallel burst.

**Cost-aware saving.** Every setting has a cost, taken from the server's
`PUT /api/config` diff (`BAND_COST`, `tuneFields.ts`), and the copy names it
*before* the operator commits:
- **Live** ("Applies live"): saved as you go, on change (on blur/Enter for
  text), with an inline "Saved." that fades. Alerts, weather name,
  scheduling, lockouts and Maps keys are live. So are channel-detail switches,
  which **re-tune** the running engine in place with no restart.
- **Restarts scanning** ("restarts scanning briefly"): batched per group
  behind a countdown (`TUNE_APPLY_DELAY_MS`, 3s). The status line says
  "Applying in 3 seconds, which restarts scanning briefly. Undo available." A
  further change restarts the countdown. One batch causes one engine restart.
- **Heavy** (Record samples, Remote listening, Advanced → Group shape): an
  explicit hay "Apply" / "Cancel" instead of a countdown.
- **Backend** ("Needs a backend restart"): saved now, and the copy says it
  takes effect after System → Restart radio backend.

**Never an unlabelled restart.** A control that restarts scanning or the
backend says so on its label, hint, cost pill or confirm copy ("Save and
restart scanning", "Stream the speaker to this browser — restarts scanning").
Power actions sit last on System, in coral, each behind the confirm dialog.

**The emphasis budget** (see Colors). Sea-glass is live or the one primary
action. Coral is destructive. Hay is attention.

**Motion only answers the operator.** Motion happens only in response to the
operator: a key depresses (60ms), a sheet rises (160ms), a switch thumb slides
and a chevron turns (120ms). The level meter moves only with live data.
Nothing animates at rest, and `prefers-reduced-motion` turns all of it off.

**Focus.** Every interactive element shows a 2px sea-glass outline at 2px
offset on `:focus-visible`. There is a skip link, the tab set uses
`aria-current`, and focus returns to the opener when a sheet closes.

## Ambient displays (tokens.css layer 1)

The wall, dashboard (the HDMI kiosk view, where the fullscreen map *is* the
dashboard), map and art are **output-only**: no mouse or keyboard, read from
across a room. They keep the language they had before the admin redesign,
**"The Night Watch"**: quiet gray on near-black, and exactly one thing lit.

### The Frozen-Ambient Rule
Layer 1 of `tokens.css` holds the values Campfire resolved to on the appliance
when Campfire was removed (2026-09-28). `kiosk/test/tokens.test.ts` pins them
against `test/fixtures/campfire-dark-resolved.json`. Change them only on
purpose, never as a side effect of admin work. The pages alias them locally
(`dashboard.css`: `--bg`, `--panel`, `--ink`, `--caution`, `--green`,
`--red`, …). Consequence colours come from the numbered steps
(`--danger-400`, `--success-400`, `--warning-500`).

### Palette
- **Signal Amber** (`--spark`, `#ff6b35`): the one loud colour, spent on live
  state. It marks the tuned channel's name and nothing else.
- **Consequence:** `--success-400` `#9ac35d`, `--warning-500` `#f9c574`,
  `--danger-400` `#f17d7b`. Also `--flamingo` `#dc3a38` (a close-call blip
  with no frequency), `--golden-amber` `#ef991f` (the antenna mark in the map legend), and
  `--danger-800` `#9c2524` with its on-colour `--danger-50` `#fef5f4` (the
  kiosk's solid system-risk strip, 13.6:1).
- **Neutrals:** `--bg-base` `#0e0f12` (the field), `--bg-subtle` `#16181d`
  (panels), `--border-default` `#23262d` and `--border-strong` / `--neutral-700`
  `#343842` (edges), `--neutral-600` `#4d525e`, `--neutral-500` /
  `--text-tertiary` `#7a8090` (glyphs only), and three text tiers:
  `--text-primary` `#f7f8f9`, `--neutral-300` `#b8bcc5`, `--text-secondary`
  `#9299a5`. All three clear 4.5:1 on the panel.
- **Service palette** (`lib/serviceColor.ts` `PIN_COLORS`): air `#3478f5` ·
  rail `#8b5034` · ham `#ec4e89` · GMRS `#1fa84c` · business `#6d28d9` ·
  marine `#0faec0` · weather `#f4b315` · public safety `#e5383b` · unknown
  `#747b8a`. These are categorical, not semantic, and are used on the map for
  pins and their matching blips. They are the one place colour identifies a
  kind rather than a consequence. **Position unknown** (`--pine`, `#4a7c7e`)
  is a hit with no honest map position, and is distinct from every service
  colour on purpose.
- **Canvas grounds** (in `wall.css` / `art.css`): the wall `#05070a`, and art
  as a radial from `#0b0f16` through `#070a10` to `#04060a`. These are unlit
  rooms, darker than `--bg-base`, and luminance is painted on top of them.
- **NWS storm palette** (in `dashboard.css`, `--alert-color` / `--alert-on`):
  tornado `#e01a2b`, severe `#f5a623`, flood `#15924f`, winter `#d23a9d`,
  wind `#c59a2c`, tropical `#a8327f`, fire `#e8501e`, civil `#c8102e`, test
  `#5b6b7a`. The on-colours are `#ffffff`, `#1a1205` and `#e8eef3`. These
  colours follow National Weather Service convention, so **don't restyle them
  toward the house palette**. An operator reading a tornado warning from
  across a room relies on a colour they already know.

### Type
Inter, one face for display, body and data (`FONT_QUERY` for dashboard and
map; the wall uses system-ui). The kiosk has its own larger ramp, `--k-*`,
from `--k-meta` 0.95rem to `--k-clock-lg` 3.7rem, with `--k-alert-xl` 3.3rem
as the loudest text in the system. Two clamps track viewport width for the
live channel name and its frequency. It follows the same tabular and
four-decimal rules as the admin. On the ambient pages only, small uppercase
status words (ACTIVE, SCANNING) are allowed, because they are instrument
legends read at distance.

### Night-Watch rules (ambient only)
- **One lit thing.** Signal Amber marks live state. If two things are amber,
  one of them is wrong.
- **One glow.** The amber text-shadow on the kiosk's live channel name makes
  it read as *on* from across the room. Don't add a second. The weather
  alert card's severity pulse is the documented exception, owned by the storm
  palette.
- **Flat plates.** Cards are `--bg-subtle` plates at 8px radius with 1px
  edges. Controls and chips are 4px, and hairline marks (insight bars,
  callsign chips) are 2px. Shadow appears only where a card floats over the
  live map (`0 8px 28px` / `0 10px 34px` black at 45–55%), and it is what
  keeps the card's edge findable over arbitrary imagery.
- **Over the map.** Raise the card's background opacity to 90–96% instead of
  blurring it.
- **The weather alert card (signature).** It encodes NWS severity: a
  **statement** is quiet with a 4px storm-colour spine, a **watch** has a 2px
  storm-colour ring and a slow pulse, and a **warning** is a solid slab of the
  storm colour. This is the one place border weight does semantic work.
  Nothing else may borrow it.
- **The signal meter (signature).** An LED-segment bar, a green→amber→red fill
  masked by hard stops. The boot bar shares it, so warm-up and signal read as
  one instrument. A `#000` inside a `mask-image` is a stencil, not a colour.
- **Scoped warning banners.** Warning-banner styling is scoped under
  `.dash.mapStage`, so it applies only when a Google Maps key is configured.

## Do's and Don'ts

### Do (both layers)
- **Do** take every colour from a token in `tokens.css` (or `PIN_COLORS` for
  service colours), and keep the admin on layer 2 and the ambient pages on
  layer 1.
- **Do** keep text at 4.5:1 or better on ground, raised and key (and on the
  ambient panel), and non-text marks at 3:1 or better.
- **Do** use `font-variant-numeric: tabular-nums` on any number that can
  change while being watched.
- **Do** keep frequencies at four decimals.
- **Do** make targets at least 44px, exempting only glyphs whose row is
  already the target.
- **Do** use `lucide-static` icons only (operator mandate). Never hand-roll an
  SVG icon.

### Do (admin)
- **Do** write in sentence case.
- **Do** put one primary key on a screen, at most.
- **Do** name a write's cost before it happens: applies live, re-tunes, or
  restarts scanning briefly.
- **Do** route every request through `Poller.run()`, the one lane.
- **Do** offer Undo for anything reversible, and confirm anything that isn't.

### Don't (both layers)
- **Don't** use `backdrop-filter`, blur or frosted glass anywhere. Blur over
  the animating map measured +6 °C on this hardware.
- **Don't** add a coloured side border (`border-left` / `border-right` thicker
  than 1px) to a card, alert, list item or callout. The storm card's spine is
  the only exception.
- **Don't** write a `var(--token, #hex)` fallback. `tokens.css` is always
  loaded, and a duplicated hex drifts silently.
- **Don't** use monospace to signal "technical". One face, tabular figures.
- **Don't** reach for skeuomorphic hardware texture: bevels, brushed metal,
  fake screws, drop-shadowed knobs.
- **Don't** drift toward a generic dark SaaS dashboard: purple-blue
  gradients, soft glow cards, decorative sparklines standing in for data.

### Don't (admin)
- **Don't** put a restart behind an unlabelled control, or a power action
  anywhere without a confirm.
- **Don't** give surfaces borders, or put `--kc-line` anywhere but between
  rows.
- **Don't** use all-caps or tracked-uppercase labels.
- **Don't** build dashboard cards (stat-tile walls, a persistent status side
  panel) or a nav rail. The admin is four tabs and a front panel.
- **Don't** add a second glow. The LCD frequency owns it.
- **Don't** start a second poller or fire requests in parallel.
