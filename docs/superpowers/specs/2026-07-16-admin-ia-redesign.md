# Admin IA redesign: five pages, phone-first

**Date:** 2026-07-16
**Status:** Approved (operator, 2026-07-16)
**Scope:** `kiosk/src/frontend/admin/` only. No backend/API changes. Builds on the quiet restyle (PR #192, branch `feat/quiet-restyle`).

## Problem

Operator feedback: things aren't logically clustered; too much scrolling;
progressive disclosure missing where it should exist; the channels UI is
overcomplicated; settings is an undesigned mess.

Root causes found in the code:

- **Overview mixes three jobs** — listening controls, system administration
  (restart backend / test alert / refresh kiosk live on the now-playing hero),
  and monitoring (health, stats, insights, alerts).
- **Channels stacks five always-visible mechanisms** — bank builder, bank
  profile editor (injected at top of page), dup panel, a table whose bank
  header rows each carry six actions, rows with five controls — plus **two
  edit paths** (inline `editRow` and the drawer, which already has the full
  form).
- **Settings is one giant panel with mixed concerns** — "Scan behavior"
  contains Google Maps keys and alert settings; weather saves separately;
  Close Call lockouts (a data list) is parked there.

Context decisions (operator): **phone-first**; **drawer-only channel
editing**; **audible is the only row toggle**; **five-page nav** (System gets
its own page).

## Design

### 1. Navigation

Rail: **Overview / Triage / Channels / Settings / System**. Route `system`
added to `ROUTES`; nav icon `lucide-static/icons/wrench.svg`. Subtitles:
Overview "Live status and activity", Triage "Review new discoveries",
Channels "Organize what you scan", Settings "Scanning, alerts, weather",
System "Appliance health and controls".

### 2. Overview = glance + listen

- Hero card keeps audio controls (Listen here, volume, mute, remote
  listening) and transmission controls (Resume scan, Listen to weather, Skip
  transmission, Pause 30 min, Lock out channel).
- The `systemActions` group (Refresh kiosk screen, Test weather alert, Clear
  alert, Restart radio backend, status hint) **moves to the System page**.
- The `sysHealth` section **moves to the System page**. The red/amber
  `healthBanner` stays on Overview as its only health surface (unchanged
  behavior, including its "Reduce processing load → #/scan" link).
- Stat tiles and Alerts feed stay. Insights stays, collapsed by default
  (already the stored default).

### 3. Channels = one mechanism per job

- **Rows**: freq · name (+bell/membership/location chips) · audible
  checkbox · chevron. The Mode column, Priority and Archived checkboxes, and
  the Listen/Lock-out icon buttons are removed from rows (all exist in the
  drawer already). Table columns: Freq (MHz) / Name / Audible.
- **Drawer is the only editor.** The inline `editRow` machinery is deleted
  (`editRow`, `rowPatch`, `saveRow`, `editingId`, `pendingTags`,
  `pendingGroup`, `tr0Focus`, edit wiring). "+ Add channel" and each bank's
  "Add channel here" open the drawer in **new-channel mode**: the existing
  channel-drawer form rendered empty (mode NFM default), Save calls
  `api.addChannel`; a bank's add pre-fills Tags with the bank's first tag.
- **Bank headers** slim to: caret · name · count · summary text · one **⋯
  menu** (`<details class="bankMenu">` with an absolutely positioned menu
  list) containing Make audible / Make silent / Archive all / Add channel
  here / Scan profile / Delete bank. Same handlers as today; menu closes
  after action. Only one bankMenu open at a time (closing others on toggle).
- **Bank scan-profile editor moves into the drawer** (new drawer kind
  `"bank"`), replacing the `#bankProfile` box injected at the top of the
  page. Same fields (squelch open, quieting, hang, dwell weight; empty =
  global) and save logic.
- Bank builder stays behind its `<details>`; dup panel and archive
  recommendations stay as conditional banners.

### 4. Settings = pure tunables, grouped cards

Four cards, each a `section.settingsCard` with legend-style h2, help line,
consistent setting rows, and its **own Save + err span**:

1. **Scanning** — Group dwell, Hang time, Squelch open, Quieting threshold,
   Close Call toggle, Close Call threshold, Sweep ranges.
2. **Alerts** — Alert cooldown, Alert hold, Push notification URL, SAME
   county codes, Show SAME tests.
3. **Weather channel** — NOAA channel, Name, Mode (existing behavior/save).
4. **Integrations** — Google Maps key, Map ID (keeps the "set a weather
   location first" guard).

The single `#tSave` handler is split into three (`Save scanning`,
`Save alerts`, `Save integrations`), each doing getConfig → patch its slice →
putConfig, preserving today's field semantics (empty = default/clear, sweep
parsing, alerts object pruning).

**Phone accordion**: below 700px the four cards render as an accordion —
`<details>`-backed, one open at a time, first card open by default, state not
persisted (cheap to reopen). Desktop (≥700px): two-column card grid, all
open, no accordion behavior.

Close Call lockouts **leave Settings** for System.

### 5. System page (new)

Order: health verdict + details grid (the moved `sysHealth`, same 3 s poll),
then **Kiosk & radio actions** card (Refresh kiosk screen, Test weather
alert, Clear alert, Restart radio backend + confirm dialog + status hint),
then **Close Call lockouts** list (moved from Settings, same rendering).
Page intro: "System — appliance health, kiosk controls, and lockouts."

### 6. Invariants

- Usability floor: ≥44px touch targets incl. the new ⋯ menu items; no
  hover-only affordances; plain-language states; same action = same label.
- Quiet-restyle rules: tracking ≤0.06em, no new glows, radii 4px/8px.
- No backend/API changes. Existing localStorage keys keep working; the
  `collapsed` default set still applies to sections that remain collapsible.
- Tests: update `adminForm`-adjacent tests if any pin removed markup; suite
  stays green.

## Out of scope

- Dashboard, map, wall, art routes; backend; Triage page (unchanged).
- Any change to bank/channel data semantics.
