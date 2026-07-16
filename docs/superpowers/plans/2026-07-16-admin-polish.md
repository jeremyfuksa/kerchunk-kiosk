# Admin Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Five refinements from operator review: designed drawer forms, always-open system health, lockout graveyard disclosure, alerts prominence on Overview, glance-first insights.

**Architecture:** Continues `feat/admin-ia` (PR #193). All edits in `admin.ts` + `admin.css`.

**Tech Stack:** Vanilla TS + CSS, vitest.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-16-admin-polish-design.md`.
- Usability floor + quiet-restyle caps (tracking ≤0.06em, no glows, radii 4/8px, ≥44px coarse targets).
- `npm test` + `tsc --noEmit` green after each task; commit per task.

---

### Task 1: Drawer form grammar

**Files:** Modify `admin.ts` (`renderChannelDrawer`, `renderBankProfileDrawer`), `admin.css` (`.drawer` form rules).

- [ ] Channel drawer form becomes grouped `dwRow` rows:
  - `<div class="dwSection">Identity</div>` then rows `<label class="dwRow"><span>Freq <small>MHz</small></span><input id="dwMhz" …></label>` for Freq/Name/Mode/Tags/Site (hints: Tags "Comma-separated — banks match on these"; Site "Transmitter lat, lon — drives the map blip").
  - `<div class="dwSection">Behavior</div>` then switch rows (`dwRow switchRow`) for Audible ("Play through the speaker"), Priority ("Preempts other channels in its group"), Alert on hit ("Flashes the kiosk and lands in the alert feed"), Archived ("Keep identity, stop scanning").
  - Footer `dwFooter`: `<button id="dwSave" class="primary">` ("Save" / "Add channel") + existing-channel Listen + Lock out buttons in the same row; `#dwErr` below.
  - Info `dl` unchanged, after the form.
- [ ] Bank-profile drawer uses the same `dwSection`/`dwRow` grammar (one section "Scan profile", four rows, hints from the old tooltips/help line; footer with primary "Save profile").
- [ ] CSS: `.dwSection` = small uppercase legend (0.06em, `--label`, top border padding); `.dwRow` = the settings row grid (`minmax(9rem,1fr) minmax(7rem,1fr)`, hint `small` dim, bottom hairline); `.dwRow.switchRow` = `1fr auto`; `.dwFooter` = flex row, gap, top border. Remove obsolete `.drawer .dwForm label` and `.drawer .dwForm input[type="text"]` width rules.
- [ ] Verify: `npm test`, tsc. Commit `style(admin): drawer forms adopt the settings row grammar`.

### Task 2: System health always open

**Files:** Modify `admin.ts` (`renderSystem`).

- [ ] Remove `lastVerdict`, the `prevDetails/userOpen/shouldOpen` block, and the `<details class="sysDetails">` wrapper — render verdict div + `<div class="sysGrid">` directly.
- [ ] CSS: delete `.sysDetails > summary` rule.
- [ ] Verify + commit `feat(admin): system health renders open on its own page`.

### Task 3: Lockouts graveyard

**Files:** Modify `admin.ts` (lockouts section markup + `renderLockouts`), `admin.css`.

- [ ] Markup: section keeps h2 but content becomes
  `<details class="lockoutsBox"><summary>Locked-out frequencies <span id="loCount" class="count"></span></summary><div id="loList" class="loChips"></div></details>`
  (section drops `collapsible data-key`; `loList` becomes a div).
- [ ] `renderLockouts` renders chips: `<span class="loChip">${fmtFreq(f)}${iconBtn("unlock", "unlock", \`Remove lockout ${fmtFreq(f)}\`, …)}</span>`; sets `#loCount` to `${lo.length}`; empty state keeps "No locked-out frequencies."
- [ ] CSS: `.loChips` = flex wrap gap 0.5rem padding-top; `.loChip` = chip base (border, 4px radius, tabular nums) with inline unlock icon button ≥44px on coarse.
- [ ] Verify + commit `feat(admin): lockout list becomes a collapsed chip graveyard`.

### Task 4: Alerts prominence on Overview

**Files:** Modify `admin.ts` (markup order).

- [ ] Move the `alertFeed` section to directly after the hero `</section>`; drop its `collapsible data-key="alerts"` and the `feedsRow` wrapper div. Hint text stays.
- [ ] Stat tile sub "bell + SAME, feed below" → "bell + SAME, feed above".
- [ ] CSS: delete `.feedsRow` rules.
- [ ] Verify + commit `feat(admin): alert feed surfaces under the hero on Overview`.

### Task 5: Insights glance + drill-in

**Files:** Modify `admin.ts` (insights section markup + `renderInsights`), `admin.css`.

- [ ] Section drops `collapsible data-key="insights"` (h2 + hint stay).
- [ ] `renderInsights` output becomes: `inTotals` headline (hits, airtime, busiest channel name — from `topChannels[0]`, "quiet band" when none), the hour clock, then
  `<details class="inBreakdown"><summary>Show breakdown</summary> …existing inTop table + inSplit chips… </details>`.
  Keep `.inChannel` analytics wiring (rows are inside the details now).
- [ ] CSS: `.inBreakdown summary` = ≥44px tappable row, dim text, no marker double-arrow weirdness; `.inTotals b` unchanged.
- [ ] Verify + commit `feat(admin): insights leads with a glance line, table behind disclosure`.

### Task 6: Verify, deploy, push

- [ ] `npm test`, `tsc --noEmit`, `npm run build`; grep audits (tracking/text-shadow/radii) still clean.
- [ ] Deploy (`sudo systemctl restart kerchunk-kiosk`), confirm `/admin` serves new bundle.
- [ ] Push to `feat/admin-ia` (updates PR #193); comment on the PR describing the polish pass.

## Self-review notes

Spec §1→T1, §2→T2, §3→T3, §4→T4, §5→T5. No placeholders; IDs (`loCount`, `loList`, `dwSave`) consistent across tasks.
