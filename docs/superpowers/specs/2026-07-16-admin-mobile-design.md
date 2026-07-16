# Admin mobile-native pass

**Date:** 2026-07-16
**Status:** Approved (operator, 2026-07-16)
**Scope:** `kiosk/src/frontend/admin/admin.css` (+ one nav-markup tweak in
`admin.ts`, one meta tweak in `index.html`). Continues PR #193.

Operator feedback: "mobile definitely looks like an afterthought." Today the
phone gets shrink-to-fit desktop CSS: a horizontally scrolling nav strip,
tall page intros, a fixed 110px volume slider, desktop paddings.

## Design (all inside `@media (max-width: 699.9px)` unless noted)

1. **Bottom tab bar.** `.adminNav` becomes `position: fixed; bottom: 0` full
   width: five equal-width tabs, icon stacked over a short label
   (`navCopy b`; `small` stays hidden), min 44px height plus
   `env(safe-area-inset-bottom)` padding, top hairline border, panel
   background. Active tab = spark icon+label. The triage `navBadge` becomes
   an absolute badge pinned to the tab's icon corner. `.admin` gains bottom
   padding (~5.5rem) so content clears the bar. Desktop rail unchanged.
2. **Compact page headers.** `.pageIntro p` and `.eyebrow` hidden; h1
   `clamp` floor drops (~1.35rem); pageIntro margins tighten.
3. **Hero reflow.** `.audioControls` becomes a wrapping grid: "Listen here"
   full row; the volume label a full-width row with the slider flexing
   (`flex: 1`, no fixed width); mute/remote checkboxes side by side.
   `.transmissionControls` becomes `display: grid; grid-template-columns:
   1fr 1fr; gap 0.5rem` with full-width buttons (Resume, when visible, spans
   both columns).
4. **Table fit.** Channels table: fixed layout with freq column sized to
   content (`~7ch`), name flexes with ellipsis, audible column narrow;
   `tr.bankRow .bkSummary` hidden below 700px (name + count + ⋯ remain).
   Discoveries keeps its existing column shedding.
5. **Viewport.** `index.html` viewport meta gains `viewport-fit=cover`
   (shared with kiosk pages — no visual effect there).

## Invariants

Usability floor (≥44px targets), quiet-restyle caps, no behavior/JS changes
except none required — nav markup unchanged (CSS-only reflow), except the
badge positioning if it needs a wrapper (allowed: minimal markup touch).
Desktop (≥700px) renders identically to today.

## Out of scope

Triage/discoveries table redesign, dashboard, any behavior changes.
