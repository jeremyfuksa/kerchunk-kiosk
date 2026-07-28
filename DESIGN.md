---
name: Kerchunk
description: Dark-only operator interfaces for an always-on SDR scanner appliance — quiet at rest, with exactly one thing lit.
colors:
  signal-amber: "#ff6b35"
  caution-hay: "#f9c574"
  adopt-moss: "#9ac35d"
  destroy-coral: "#f17d7b"
  listen-pine: "#87a7a9"
  night-ground: "#1c1f26"
  slate-panel: "#2b303b"
  hairline: "#4d515c"
  steel: "#747b8a"
  bright-ink: "#f7f8f9"
  cool-label: "#b8bcc5"
  quiet-hint: "#9299a5"
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
typography:
  micro:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "0.7rem"
    fontWeight: 600
    lineHeight: 1.35
    letterSpacing: "0.06em"
  caption:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "0.78rem"
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: "0.02em"
  dense:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "0.85rem"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "normal"
  body:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "0.92rem"
    fontWeight: 400
    lineHeight: 1.55
    letterSpacing: "normal"
  title:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "1rem"
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: "normal"
  lead:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "1.15rem"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "0.02em"
    fontFeature: "tabular-nums"
  heading:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "1.3rem"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "0.02em"
  display-sm:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "1.5rem"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "0.02em"
  display:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "1.9rem"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "normal"
    fontFeature: "tabular-nums"
  display-lg:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "2.1rem"
    fontWeight: 600
    lineHeight: 1.1
    letterSpacing: "normal"
    fontFeature: "tabular-nums"
  page-title:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "clamp(1.6rem, 3vw, 2.25rem)"
    fontWeight: 700
    lineHeight: 1.1
    letterSpacing: "-0.035em"
  kiosk-display:
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "clamp(3rem, 7.5vw, 6.2rem)"
    fontWeight: 600
    lineHeight: 1.08
    letterSpacing: "0.01em"
rounded:
  control: "4px"
  card: "8px"
  dot: "9999px"
spacing:
  control-gap: "0.5rem"
  field-gap: "0.75rem"
  card-padding: "1.1rem 1.2rem"
  card-gap: "1rem"
  section-gap: "1.8rem"
  workspace-gap: "2rem"
components:
  button-primary:
    backgroundColor: "{colors.signal-amber}"
    textColor: "{colors.night-ground}"
    rounded: "{rounded.control}"
    padding: "0.45rem 0.75rem"
    typography: "{typography.label}"
    height: "2.35rem"
  button-primary-hover:
    backgroundColor: "{colors.caution-hay}"
    textColor: "{colors.night-ground}"
  button-default:
    backgroundColor: "{colors.night-ground}"
    textColor: "{colors.bright-ink}"
    rounded: "{rounded.control}"
    padding: "0.45rem 0.75rem"
    height: "2.35rem"
  button-danger:
    backgroundColor: "{colors.night-ground}"
    textColor: "{colors.destroy-coral}"
    rounded: "{rounded.control}"
    padding: "0.45rem 0.75rem"
    height: "2.35rem"
  input-field:
    backgroundColor: "{colors.night-ground}"
    textColor: "{colors.bright-ink}"
    rounded: "{rounded.control}"
    padding: "0.38rem 0.55rem"
  card-panel:
    backgroundColor: "{colors.slate-panel}"
    textColor: "{colors.bright-ink}"
    rounded: "{rounded.card}"
    padding: "{spacing.card-padding}"
  nav-item-active:
    backgroundColor: "{colors.slate-panel}"
    textColor: "{colors.signal-amber}"
    rounded: "{rounded.card}"
    padding: "0.6rem 0.75rem"
    height: "3.35rem"
  chip:
    backgroundColor: "transparent"
    textColor: "{colors.cool-label}"
    rounded: "{rounded.control}"
    padding: "0.08em 0.45em"
    typography: "{typography.label}"
---

# Design System: Kerchunk

## Overview

**Creative North Star: "The Night Watch"**

Kerchunk is a radio that never sleeps, watched by one person who is usually doing something else. Every surface is built for that: a dark room, a glance from across it, and exactly one thing lit. At rest the whole interface is quiet gray on near-black — panels, rules, labels, and data all sit in a narrow neutral band. Emphasis is not distributed; it is spent. The tuned channel's name glows amber at six rem on the kiosk. The active nav item is amber. The current hour on the activity clock is amber. Almost nothing else ever is.

That restraint is what makes the appliance readable at speed. The operator is not reading the screen — they are checking it, from a doorway, while the radio talks. So hierarchy is carried by size and by *liveness*, not by decoration. Cards are flat plates with hairline borders. Numbers are tabular so columns line up and a changing digit doesn't shift its neighbours. Labels are small, uppercase and tracked so they read as instrument legends rather than as prose. The one piece of theatre in the system — the amber text-shadow on the live tag — exists because a glowing thing reads as *on* from further away than a bright thing does.

The system takes its palette and its ramps from Campfire, the operator's own design system, and its type from a single face. It does not take its personality from hardware nostalgia: there are no bevels, no brushed metal, no fake screws. Instrument *logic* — legends, meters, consequence colour, tabular data — without instrument *cosplay*.

**Key Characteristics:**
- Dark-only. There is no light theme and no theme switch; the use scene is a dim room and a wall-mounted panel.
- One loud colour, spent on live state.
- Flat plates, hairline rules, tonal layering; shadow only where something genuinely floats.
- Tabular numerals everywhere a number can change.
- Small tracked uppercase labels; large unadorned data.
- Every surface legible from across a room *or* from a phone held at arm's length — never optimised for only one.

## Colors

A narrow neutral field with one hot accent, four consequence colours, and a categorical palette reserved for the map.

### Primary
- **Signal Amber** (`#ff6b35`): the single loud colour, and the system's whole emphasis budget. It marks what is *live right now* — the tuned channel's name, the current hour bar, the active nav item, the primary action in a form, the eyebrow above a page title. It is Campfire's `--spark` under the dark theme.

### Secondary
The consequence colours. These are never decorative: each one means a specific outcome, and a control wears one only when pressing it produces that outcome.
- **Adopt Moss** (`#9ac35d`): additive, safe, confirming. Save, add channel, healthy verdict, the analog-voice verdict chip.
- **Caution Hay** (`#f9c574`): reversible but consequential, or "needs attention". Lock out, pause, dismiss, the stressed health verdict, the triage-queue badge, and every focus ring.
- **Destroy Coral** (`#f17d7b`): irreversible or service-affecting. Delete, reboot, shut down, restart, error text, the over-temperature cell.
- **Lifted Pine** (`#87a7a9`): passive and observational — listening rather than changing. Audition a signal, location chips, sparkline strokes, the read-only spectrum chip.

### Tertiary
- **Service palette** (`#3478f5` air · `#8b5034` rail · `#ec4e89` ham · `#1fa84c` GMRS · `#6d28d9` business · `#0faec0` marine · `#f4b315` weather · `#e5383b` public safety · `#747b8a` unknown): a categorical, non-semantic set used **only** on the map, where a pin and its matching transient blip must be told apart at a glance by kind of service. These are the one place in the system where colour identifies a category rather than a consequence, and they are deliberately more saturated and more numerous than anything else in the palette because the map is the only surface dense enough to need it.
- **Position Unknown** (`#4a7c7e`): a hit that has no honest map position. Distinct from every service colour on purpose — uncertain geography must never masquerade as a located site.

### Neutral
- **Night Ground** (`#1c1f26`): the page field, and the recessed fill inside controls. The same value doing both jobs is what makes an input read as cut *into* a panel.
- **Slate Panel** (`#2b303b`): every card, table body, drawer and menu.
- **Hairline** (`#4d515c`): row separators, field dividers, card-internal rules.
- **Steel** (`#747b8a`): two jobs, both non-text — the resting edge of every interactive control, and purely decorative glyphs (carets, chevrons, the fader groove).
- **Bright Ink** (`#f7f8f9`): primary text and data.
- **Cool Label** (`#b8bcc5`): field labels, secondary values, prose.
- **Quiet Hint** (`#9299a5`): helper text under a field, units, column headers, empty states.

### Named Rules

**The One Lit Thing Rule.** Signal Amber marks live state and nothing else. If two things on a screen are amber, one of them is wrong. Brand presence comes from restraint, not from coverage.

**The Dark-Value Rule.** Campfire's *named* expressive tokens (`--flamingo`, `--sage`, `--pine`, `--golden-amber`) carry a second, much darker value under `.dark` — the theme this app always runs in. Aliasing them for text or edges silently lands at 2.8–3.6:1. Take consequence colours from the **numbered ramps** (`--danger-400`, `--success-400`, `--warning-500`), which are theme-independent, and lift Pine toward `--ink` because it has no ramp.

**The Three-Tier Rule.** Text uses exactly three tiers — Bright Ink, Cool Label, Quiet Hint — and all three clear 4.5:1 on Slate Panel (12.4 / 6.9 / 4.6). There is no fourth, dimmer tier, because the dark ground does not have room for one. Anything dimmer than Quiet Hint is a glyph, not text.

## Typography

**Display / Body / Data Font:** Inter (with `-apple-system`, `BlinkMacSystemFont`, "Segoe UI", sans-serif)

**Character:** One face doing every job. Inter is chosen for the same reason instruments use a single grotesque: it stays legible at 0.68rem on a phone and at 6rem across a room, and its tabular figures are unambiguous at a glance. Monospace was retired deliberately — nothing here is code, and `font-variant-numeric: tabular-nums` gives column alignment without the costume.

### Hierarchy

Ten fixed steps and two clamps. Pick by what the text *does*; the ramp is exposed as `--t-*` custom properties, so a role is one token, never a literal.

| Role | Token | Size | Purpose |
|---|---|---|---|
| Micro | `--t-micro` | 0.7rem | Instrument legends: column headers, eyebrows, chips, badges, unit suffixes. Tracked `0.06em`, usually uppercase. |
| Caption | `--t-caption` | 0.78rem | Interface chrome: buttons, nav, hints, card sub-headers. |
| Dense | `--t-dense` | 0.85rem | Table and list body, empty states, error text. |
| Body | `--t-body` | 0.92rem | Prose, inputs, form labels. Paragraphs cap at `48rem` (~52ch). |
| Title | `--t-title` | 1rem | Card headers and the masthead brand. |
| Lead | `--t-lead` | 1.15rem | Emphasised inline values — system gauges, insight totals, the now-playing frequency. |
| Heading | `--t-heading` | 1.3rem | Drawer and dialog headings. |
| Display SM | `--t-display-sm` | 1.5rem | The live channel name in the admin hero. |
| Display | `--t-display` | 1.9rem | Stat-tile values. |
| Display LG | `--t-display-lg` | 2.1rem | The drawer's frequency — the largest thing in the admin. |
| Page title | — | `clamp(1.6rem, 3vw, 2.25rem)` | Admin page titles. One per page. |
| Kiosk display | — | `clamp(3rem, 7.5vw, 6.2rem)` | The kiosk's live channel name. Kiosk only. |

Two `em`-based sizes sit off the ramp on purpose, because they must scale with whatever they annotate rather than with the page: the drawer's `MHz` unit (`0.45em` of its frequency) and the `via <source>` note (`0.9em`).

### Named Rules

**The Ramp Rule.** Font size comes from a `--t-*` token, never a literal. Before adding a step, check whether an existing one does the job — the ramp replaced 32 ad-hoc values, five of which sat between 0.82 and 0.88rem and carried no distinction a reader could see. The only literals allowed are the two clamps and the two `em` values above.

**The No-Pixels Rule.** Type is sized in `rem` or `em`, never `px`. Three `px` sizes had crept in (11, 13, 14) and silently ignored browser zoom and OS font-size settings — on an appliance that is read at arm's length and from across a room, that is the wrong thing to freeze.

**The Tabular Rule.** Any number that can change while being looked at — frequency, temperature, CPU, hit count, clock, dB — is `font-variant-numeric: tabular-nums`. A digit that changes width makes an instrument look unreliable.

**The Legend Rule.** Uppercase is for legends, never for reading. Tracked uppercase marks a label naming a value; it is never used for a sentence, a button that isn't a legend, or body copy.

**The Four-Decimal Rule.** Frequencies always render to four decimals (`145.1300`), never three. Scanner frequencies sit on a 12.5 kHz raster and three decimals misrepresents them.

## Layout

The admin is a **workspace**: a sticky vertical nav rail (13.5rem) beside a fluid content column, capped at 1500px and centred. The kiosk dashboard is a **stage**: when a Google Maps key is present the live map goes fullscreen behind everything and the interface becomes floating cards over it — now-playing at top-left, clock and weather at top-right, bank rail bottom-left, weather alerts bottom-right. Without a key the classic banded layout stands.

Rhythm is built on a small set of recurring gaps: `0.5rem` between controls in a group, `0.75rem` between fields, `1rem` between cards, `1.8rem` between sections, `2rem` between the rail and the content. Card padding is `1.1rem 1.2rem`.

Responsive behaviour has three states, and the phone state is designed rather than derived: at ≥1101px stat tiles are a 4+1 grid; at ≤1100px they collapse to two columns; at ≤900px the nav rail becomes a horizontal strip; at ≤700px it becomes a fixed bottom tab bar in the thumb zone, respecting `env(safe-area-inset-bottom)`, page descriptions are dropped because the tab bar already names the page, and the hero reflows to single-column with two-up action buttons.

**The One Scroll Rule.** A page has exactly one vertical scroll region. Tables are `table-layout: fixed` with declared column widths at every width, so they never scroll sideways and never need an inner scroll box. Sticky table headers stick against the page, not against a nested container.

**The Thumb Rule.** On coarse pointers every target is ≥44px (`2.75rem`). The only exemptions are glyphs whose surrounding cell or row is itself the larger target.

## Elevation & Depth

Flat by default. Depth comes from tonal layering — Night Ground behind, Slate Panel on top, Night Ground again recessed inside controls — plus hairline borders. None of Campfire's `--shadow-*` ramp is used as a general elevation scale.

Shadow appears only where something genuinely floats above another layer, and it is structural rather than ambient: it says "this is a separate plane", not "this is important".

### Shadow Vocabulary
- **Floating panel** (`box-shadow: -18px 0 50px rgb(0 0 0 / 0.5)`): the channel drawer sliding over the page.
- **Menu** (`box-shadow: 0 12px 36px rgb(0 0 0 / 0.5)`): the bank overflow menu.
- **Modal** (`box-shadow: 0 24px 80px rgb(0 0 0 / 0.65)`): the confirm dialog.
- **Over-map card** (`box-shadow: 0 8px 28px rgb(0 0 0 / 0.45)`): kiosk cards floating on the live map, where the background is arbitrary and a shadow is what keeps the card's edge findable.

### Named Rules

**The No-Glass Rule.** No `backdrop-filter`, no blur, no translucent-frosted surfaces. This is a thermal constraint first — blur over the animating WebGL map measured +6 °C on this hardware — and a visual one second. Where a card must sit over the map, raise the background opacity to 90–96% instead. It reads the same and costs nothing.

**The One Glow Rule.** Exactly one glow exists in the system: the amber text-shadow on the kiosk's live channel name. It is what makes the tag read as *on* rather than merely bright. Do not add a second.

## Shapes

Two radii, and they mean different things. **Controls and chips are `4px`** — tight, machined, close to square. **Cards, panels, tiles and menus are `8px`** — the container language. Status dots and bank LEDs are full circles. Nothing else is rounded, and there is no `12px`+ soft-card treatment anywhere in the system.

Borders are always `1px` and always meaningful: a card edge, a control edge, a rule between rows. The single exception is the 2px ring a weather *watch* card wears on the kiosk, where the frame must read as deliberate at distance.

**The Hairline Rule.** Borders are 1px. A thicker coloured border on a card, list item, callout or alert is not part of this system — emphasis comes from ground tint, type size, or the accent colour of the text itself.

## Components

### Buttons
- **Shape:** tightly machined (`4px` radius), `2.35rem` tall, `0.45rem 0.75rem` padding, 0.78rem semibold label.
- **Primary:** solid Signal Amber with Night Ground text — the one filled button on a screen. Hover shifts the fill to Caution Hay.
- **Default:** recessed Night Ground fill, Bright Ink text, Steel edge.
- **Consequence variants:** the label takes the consequence colour and the edge takes a mix of it strong enough to clear 3:1 (Adopt 60%, Caution 60%, Destroy 70%, Listen 70%).
- **Icon buttons:** no resting border or fill — a recognisable glyph in its consequence colour identifies the control. Edge and fill appear on hover and focus.
- **Focus:** `2px` Caution Hay outline at `2px` offset, on every interactive element without exception.

### Chips
- **Style:** one recipe — `0.7rem` semibold, `0.08em 0.45em` padding, `4px` radius, 1px border. Size and shape are identical everywhere; only colour varies.
- **State:** counts and memberships are neutral; verdicts take a consequence colour; the map's spectrum chip takes Lifted Pine because it is instrumentation, not a toggle.

### Cards / Containers
- **Corner Style:** `8px`.
- **Background:** Slate Panel. The hero card adds a 4% Signal Amber tint to its ground and a stronger edge — it is lit, not tabbed.
- **Shadow Strategy:** none at rest (see Elevation & Depth).
- **Border:** 1px Hairline-to-panel-edge.
- **Internal Padding:** `1.1rem 1.2rem`, tightening to `1rem 0.8rem` on phones.
- **Header:** an in-flow `h2` at 1rem with an optional trailing hint. There is one card-header grammar; do not reintroduce a second.

### Inputs / Fields
- **Style:** Night Ground fill recessed into the panel, 1px Steel edge, `4px` radius. The edge clears 3:1 against both the card and its own fill so a twenty-field form is readable at rest, not just on focus.
- **Focus:** border shifts to Signal Amber; `:focus-visible` adds the Caution Hay outline.
- **Layout:** label left / control right on a two-column grid, with helper text in Quiet Hint under the label. Collapses to stacked rows on phones.

### Navigation
- **Style:** vertical rail of `3.35rem` items, each an icon plus a two-line label/description, `8px` radius. Active takes Slate Panel fill, a panel edge, Signal Amber text, and `aria-current="page"`.
- **Mobile:** a fixed bottom tab bar, icon over a `0.62rem` label, descriptions dropped, badge repositioned over the icon.

### Signal Meter (signature)
A horizontal LED-segment bar: a green→amber→red gradient fill masked by `repeating-linear-gradient` hard stops to punch segment gaps. The same treatment drives the boot progress bar, so warm-up and signal read as the same instrument. Its width transition is the only animated fill in the system.

### Weather Alert Card (signature)
The kiosk's EAS surface, and the one place colour is driven by external convention rather than by this palette. Storm type sets `--alert-color` (NWS convention: tornado red, severe amber, flood green, winter magenta, fire orange-red), and severity sets treatment: a **statement** is quiet, a **watch** takes a 2px colour ring and a slow pulse, a **warning** turns the whole card into a solid slab of the storm colour with high-contrast text. Every rule reads `--alert-color` / `--alert-on`, so retheming a storm category is a one-line swatch change.

## Do's and Don'ts

### Do:
- **Do** spend Signal Amber on live state only — one lit thing per screen.
- **Do** take consequence colours from Campfire's numbered ramps (`--danger-400`, `--success-400`, `--warning-500`), never from the named expressive tokens, which are darker under `.dark`.
- **Do** give every interactive edge ≥3:1 against both its card and its own fill, and every text tier ≥4.5:1.
- **Do** use `font-variant-numeric: tabular-nums` on any number that can change while being watched.
- **Do** keep frequencies at four decimals.
- **Do** declare table column widths and use `table-layout: fixed`, so nothing scrolls sideways.
- **Do** raise background opacity to 90–96% when a card must sit over the live map.
- **Do** hit 44px targets on coarse pointers, exempting only glyphs whose row or cell is already the target.
- **Do** edit the rule that already exists rather than restating it further down the stylesheet.

### Don't:
- **Don't** use `backdrop-filter`, blur, or frosted glass anywhere. It is a measured thermal cost (+6 °C) and a visual anti-goal.
- **Don't** add a coloured `border-left`/`border-right` thicker than 1px to a card, alert, list item or callout.
- **Don't** add a second glow. The live channel tag owns the only one.
- **Don't** drift toward a generic dark SaaS dashboard: purple-blue gradients, soft glow cards, decorative sparklines standing in for data.
- **Don't** reach for skeuomorphic hardware texture — bevels, brushed metal, fake screws, drop-shadowed knobs.
- **Don't** adopt a consumer scanner-app look: bright chrome, playful colour, phone-only layouts that lose the across-the-room read.
- **Don't** introduce a fourth text tier dimmer than Quiet Hint; make it a glyph or make it brighter.
- **Don't** use monospace as a signal of "technical". One face, tabular figures.
- **Don't** invent a second card-header grammar, or a radius between `4px` and `8px`.
- **Don't** repeat a Campfire token's hex as a `var(--token, #hex)` fallback; the token layer is always loaded, and a duplicated hex drifts silently.

<!-- Known deviation: the /map surface still inherits Campfire's Space Grotesk
     and Fira Code for its legend and aircraft chips. Inter is normative per this
     document; the map is drift to be corrected, not a sanctioned exception. -->
