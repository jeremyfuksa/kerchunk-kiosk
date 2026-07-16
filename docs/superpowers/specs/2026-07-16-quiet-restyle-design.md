# Quiet restyle: dashboard + admin (de-AI pass)

**Date:** 2026-07-16
**Status:** Approved (operator, 2026-07-16)
**Scope:** `kiosk/src/frontend/dashboard/`, `kiosk/src/frontend/admin/`, `kiosk/src/frontend/index.html`. The map, wall, and art routes are out of scope and must render unchanged.

## Problem

The current dashboard and admin aren't broken and aren't ugly; they read as
AI-generated. The tells, confirmed in the CSS:

1. Tracked-out uppercase everywhere (`letter-spacing: 0.3–0.6em` on labels,
   badges, headings, buttons).
2. Glow on everything: `text-shadow` halos on the tag, temp, badges, chips,
   drawer frequency; decorative `box-shadow` glows on dots, chips, the slider
   thumb.
3. Atmosphere effects: CRT scanline + vignette overlay, radial gradient washes
   behind body/panels/cards, the alert-bell `alertRing` wiggle.
4. Five separate chip/badge recipes in the admin (count, mode, service,
   verdict, mem).
5. Three webfonts (Space Grotesk, Hanken Grotesk, Fira Code) doing overlapping
   jobs.

**Priority order: usable > distinctive > beautiful.** Never trade the first
for the third.

## Design

### 1. Type — Inter only

- `index.html`: keep the existing three families in the Google Fonts link
  (out-of-scope routes still use them); add Inter 400/500/600/700.
- Override the Campfire font tokens **scoped by route**, not globally — all
  page CSS is bundled into one file, and `main.ts` stamps
  `html[data-page="…"]` for exactly this purpose. Under
  `html[data-page="dashboard"]` and `html[data-page="admin"]`:
  `--font-sans`, `--font-body`, `--font-mono` → Inter stack
  (`"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`).
- Numeric alignment survives via `font-variant-numeric: tabular-nums` on the
  clock, frequencies, log timestamps, meter dB, and stat values (mostly
  already declared; add where missing).
- Letter-spacing capped at **0.06em**, allowed in exactly one role: small
  uppercase section legends. Everything else — buttons, badges, headings,
  SCANNING/STANDBY/WARMING UP text — normal tracking; hierarchy carried by
  size and weight.

### 2. Surfaces and effects — one glow, flat panels

Delete:
- CRT scanline/vignette overlay (`.dash::before`) and its map-stage exemption.
- All radial gradient washes (admin body, `.now`, `.nowCard`, `.nowCard.hero`).
- The `alertRing` bell-wiggle animation.
- Every decorative `text-shadow` and glow `box-shadow` (chips, wxTemp, mode
  badge, bank chips, slider thumb, drawer frequency, hover text-shadow on
  row-open cells).

Keep:
- **Glow budget of one:** the live now-playing tag (`.now .tag`) keeps a
  single faint halo, reduced from the current double shadow.
- Functional elevation shadows: drawer, confirm dialog, floating map-stage
  cards.
- The LED-segment meter mask (dashboard meter + boot bar) — earned identity.
- The `alertPulse` background pulse and warning-tier treatments — attention is
  the job of a weather alert.

Normalize:
- Border radii to two values: 4px (controls, small chips) and 8px (panels,
  cards, dialogs) — no other values.
- One `.chip` base (size, padding, radius, border) with color modifiers
  replacing the five recipes.

### 3. Color — unchanged palette, stricter amber discipline

No Campfire token value changes. Amber is reserved for live/hero data:
now-playing, active nav, lit bank chip, stat values. Decorative amber drops to
ink/label: channel-table first column, count badges. Consequence-colored
buttons (green adopt / red destructive / amber caution / blue listen) stay.

### 4. Kiosk usability floor (non-negotiable checklist)

- **Touch targets ≥44px, no hover-dependent affordances.**
  - Admin buttons: `min-height` 2.35rem (37.6px) → 44px under
    `@media (pointer: coarse)`; icon buttons (~33px) likewise; larger slider
    thumb and checkbox hit area.
  - Channel rows open the drawer but only signal it on hover → add an
    always-visible chevron affordance to row-open rows.
  - Alert-dismiss is already always visible (0.45 opacity) — keep.
- **Idle/reset state returns cleanly to a known start.** Audited: the
  dashboard falls back to the SCANNING sweep on its own; warm-up overlay is
  determinate. No change required.
- **Error and empty states say what happened and what to do.**
  - Dashboard error card: keep the engine error text but add a plain-language
    "what to do" line (restart the radio backend from the admin if it
    persists).
  - `"name required"` → `"Enter a bank name"`.
  - `"no samples yet"` → `"No readings yet — data appears within a minute."`
  - Table empty states name the action (e.g. "No channels yet — use Add
    channel").
- **Same action, same label.** Drawer "Lockout" → "Lock out" (matches "Lock
  out channel" / "Lock out selected"); discovery-drawer "Add" → "Add channel"
  (matches "+ Add channel").

### 5. Verification

- `npm test` from `kiosk/` (adminForm/alertTheme/dashboardState tests may pin
  labels — update alongside).
- Grep audit: no `letter-spacing` > 0.06em and no `text-shadow` outside the
  single budgeted glow in dashboard.css/admin.css.
- Both pages eyeballed via the vite dev server; map/wall/art spot-checked
  unchanged.
- CLAUDE.md hardware flow: branch → build/deploy on the kiosk → prove → PR.

## Out of scope

- Any layout, IA, interaction, or backend change beyond the strings/labels and
  affordances listed above.
- Campfire (the design system package) itself — overrides live in this repo.
- The map, wall, and art routes.
