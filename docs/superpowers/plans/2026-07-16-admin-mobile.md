# Admin Mobile-Native Pass Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Phones get a designed layout — bottom tab bar, compact headers, reflowed hero, no-scroll channels table — with desktop unchanged.

**Architecture:** CSS-only inside the existing `@media (max-width: 700px)` block (which sits late in admin.css, so it wins the cascade against the 560px and 900px rules); one meta attribute in index.html. No JS changes.

**Tech Stack:** CSS, vitest (regression only).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-16-admin-mobile-design.md`.
- Desktop ≥700px renders identically; usability floor + quiet-restyle caps hold.

---

### Task 1: Bottom tab bar + content clearance

- [ ] In the `@media (max-width: 700px)` block: `.adminNav` → `position: fixed; inset: auto 0 0 0; z-index: 50; display: flex; flex-direction: row; gap: 0; margin: 0; padding: 0.25rem 0.25rem calc(0.25rem + env(safe-area-inset-bottom)); background: var(--panel); border-top: 1px solid var(--panel-edge); overflow: visible;`
- [ ] `.adminNav a` → `flex: 1 1 0; min-width: 0; flex-direction: column; justify-content: center; gap: 0.15rem; min-height: 3.1rem; padding: 0.3rem 0.1rem; position: relative; border: none; border-radius: 4px; text-align: center;`; `.navCopy b` → `font-size: 0.62rem; letter-spacing: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%;`; `.navIco svg` → 1.3rem; active tab keeps spark color, background transparent.
- [ ] `.adminNav .navBadge:not(:empty)` → absolute, `top: 0.1rem; right: 50%; transform: translateX(1.3rem); margin: 0;`
- [ ] `.admin` → `padding-bottom: calc(5.5rem + env(safe-area-inset-bottom));`
- [ ] index.html viewport meta → `content="width=device-width, initial-scale=1, viewport-fit=cover"`.

### Task 2: Compact headers

- [ ] Same block: `.pageIntro p, .pageIntro .eyebrow { display: none; }`; `.pageIntro h1 { font-size: 1.35rem; margin: 0; }`; `.pageIntro { margin-bottom: 0.8rem; }`; `.adminHead { min-height: 2.75rem; margin-bottom: 0.9rem; padding-block: 0.5rem; }`

### Task 3: Hero reflow

- [ ] `.admin .audioControls { display: flex; flex-wrap: wrap; gap: 0.6rem; }`; `#streamBtn { flex: 1 1 100%; }`; the volume `label` → `flex: 1 1 100%; display: flex; align-items: center; gap: 0.6rem;` with `input[type="range"] { flex: 1; width: auto; }`
- [ ] `.admin .transmissionControls { display: grid; grid-template-columns: 1fr 1fr; gap: 0.5rem; }`; `#resumeBtn { grid-column: 1 / -1; }`; buttons `margin: 0; width: 100%;`

### Task 4: Table fit

- [ ] `.admin .channels .chTable { display: table; table-layout: fixed; width: 100%; }` (beats the 560px `display: block`); `th:nth-child(1) { width: 6.2rem; }`, `.chAudible { width: 4rem; }`, name cell `overflow: hidden; text-overflow: ellipsis; white-space: nowrap;`
- [ ] `tr.bankRow .bkSummary { display: none; }`

### Task 5: Verify + deploy + push

- [ ] `npm test`, `npm run build`; grep audits clean; deploy; push to `feat/admin-ia`; PR #193 comment.

## Self-review notes
Spec §1→T1, §2→T2, §3→T3, §4→T4, §5→T1 (meta). All selectors exist in current markup; no JS edits needed.
