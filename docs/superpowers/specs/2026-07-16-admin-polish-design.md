# Admin polish: drawer design, health, lockouts, alerts, insights

**Date:** 2026-07-16
**Status:** Approved (operator, 2026-07-16)
**Scope:** `kiosk/src/frontend/admin/` only. Continues PR #193 on `feat/admin-ia`.

Operator feedback on the IA redesign: (1) the channel edit drawer looks
undesigned; (2) system health needs no collapse now that it has its own page;
(3) the lockout list is a graveyard — long, and only visited to undo a
mistake; (4) the alerts card is buried on Overview; (5) insights is useful
but too much to take in.

## Design

1. **Drawer form grammar.** The channel drawer (edit + new) and bank-profile
   drawer adopt the settings-card row grammar:
   - `dwSection` legends: **Identity** (Freq, Name, Mode, Tags, Site lat/lon)
     as `dwRow` label-left / input-right grid rows with `small` hints;
     **Behavior** as switch rows (Audible, Priority, Alert on hit, Archived)
     with the tooltip text promoted to visible hints.
   - Footer: `Save` becomes `class="primary"` (amber, consistent with every
     other Save); Listen / Lock out sit in the same footer row for existing
     channels. Info `dl` stays below.
2. **System health always open.** Drop the `<details class="sysDetails">`
   wrapper and the open/collapse preservation logic in `renderSystem` —
   verdict line + grid always render. (The `lastVerdict` tracking goes too.)
3. **Lockouts as graveyard.** The System-page lockouts section becomes a
   collapsed-by-default `<details class="lockoutsBox">` whose summary reads
   `Locked-out frequencies (N)`. Inside, compact chips (freq + × unlock)
   in a wrap grid instead of full-width rows. Unlock keeps its confirm-free
   immediate behavior and the existing handler semantics. Empty state:
   "No locked-out frequencies."
4. **Alerts move up on Overview.** The alert feed section moves to directly
   after the now-playing hero, before statRow; it stops being collapsible.
   The `feedsRow` wrapper (1-col grid leftover) is removed.
5. **Insights = glance + drill-in.** Always visible: the period toolbar, a
   headline strip (`N transmissions · H h M m airtime · busiest <channel>`
   as stat-styled numbers), and the hour clock. The top-channels table and
   tag/split chips move behind `<details class="inBreakdown">` with summary
   "Show breakdown". Insights section itself stops being collapsible (its
   default-collapsed state hid the page's most useful glance data; the
   drill-in now handles the "too much" problem instead).

## Invariants

Usability floor and quiet-restyle caps as before. No backend changes. Tests
stay green. localStorage keys for removed collapsibles (`insights`,
`lockouts`, `alerts` in `kerchunk.admin.collapsed`) simply go unused.

## Out of scope

Triage, Channels table, Settings cards, dashboard.
