# Quiet Restyle (Dashboard + Admin) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** De-AI the dashboard and admin styling — Inter throughout, tracking capped, one glow, flat panels — plus the kiosk usability-floor fixes, with zero layout/interaction changes.

**Architecture:** Pure CSS edits to `dashboard.css`/`admin.css` plus a font link change in `index.html`; small string/markup edits in `admin.ts`/`dashboard.ts` for labels, error/empty copy, and a row-open chevron. Font tokens are overridden scoped by `html[data-page]` so the out-of-scope map/wall/art routes render unchanged.

**Tech Stack:** Vanilla TS + CSS, Vite, Campfire design tokens (`@jeremyfuksa/campfire/tokens.css`), vitest.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-16-quiet-restyle-design.md`. Priority: usable > distinctive > beautiful.
- Letter-spacing max **0.06em**; 0.06em reserved for small uppercase section legends. No `text-indent` compensation hacks left behind.
- Glow budget of exactly one: `.now .tag` single faint halo. No other decorative `text-shadow`/glow `box-shadow`. Functional elevation shadows (drawer, dialog, map-stage cards, alert pulses) stay.
- Border radii: 4px (controls/chips/bars) and 8px (panels/cards/dialogs) only.
- Map, wall, art routes must not change. All CSS is bundled globally — any new `:root`-level rule must be scoped `html[data-page="dashboard"]` / `html[data-page="admin"]`.
- Campfire token *values* unchanged; overrides live in this repo only.
- All work on branch `feat/quiet-restyle` (already created; spec committed). Repo rule: PR to main, never direct push.
- Run all commands from `kiosk/`.

---

### Task 1: Inter webfont + scoped font-token override

**Files:**
- Modify: `kiosk/src/frontend/index.html:9`
- Modify: `kiosk/src/frontend/dashboard/dashboard.css` (top, after `:root` block)
- Modify: `kiosk/src/frontend/admin/admin.css` (top, after `:root` block)

**Interfaces:**
- Produces: `--font-sans`, `--font-body`, `--font-mono` all resolve to the Inter stack on dashboard + admin pages only. Later tasks assume every `font-family: var(--mono)` / `var(--cond)` already renders Inter — they do not re-declare families.

- [ ] **Step 1: Add Inter to the font link (keep the existing three families — map/wall/art still use them)**

In `index.html`, replace line 9:

```html
    <link href="https://fonts.googleapis.com/css2?family=Fira+Code:wght@400;500;600;700&family=Space+Grotesk:wght@500;600;700&family=Hanken+Grotesk:wght@400;500;600&display=swap" rel="stylesheet" />
```

with:

```html
    <link href="https://fonts.googleapis.com/css2?family=Fira+Code:wght@400;500;600;700&family=Space+Grotesk:wght@500;600;700&family=Hanken+Grotesk:wght@400;500;600&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet" />
```

- [ ] **Step 2: Scoped token override in dashboard.css**

Immediately after the closing `}` of the `:root` block (line 25), add:

```css
/* Inter throughout (spec 2026-07-16): one face for display, body, and data.
   Scoped to this page — the CSS bundle is global and map/wall/art keep the
   Campfire faces. html[data-page] outranks Campfire's :root/.dark tokens. */
html[data-page="dashboard"] {
  --font-sans: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  --font-body: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  --font-mono: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
```

- [ ] **Step 3: Scoped token override in admin.css**

Same block after admin.css's `:root` (line 26), with selector `html[data-page="admin"]` and the same three declarations (comment: `/* Inter throughout — see dashboard.css note; scoped so map/wall/art keep Campfire faces. */`).

- [ ] **Step 4: Verify tests and build stay green**

Run: `npm test` → all pass. Run: `npm run build:frontend` → exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/frontend/index.html src/frontend/dashboard/dashboard.css src/frontend/admin/admin.css
git commit -m "style: Inter throughout on dashboard + admin (scoped token override)"
```

---

### Task 2: Dashboard CSS quiet pass

**Files:**
- Modify: `kiosk/src/frontend/dashboard/dashboard.css`

**Interfaces:**
- Consumes: Task 1's Inter tokens.
- Produces: the only `text-shadow` left in the file is on `.now .tag`; no `letter-spacing` above 0.06em; radii only 4px/8px.

- [ ] **Step 1: Delete atmosphere effects**

  - Delete the whole `.dash::before` scanline/vignette rule (lines 53–62) and its comment.
  - Delete the map-stage exemption `.dash.mapStage::before { display: none; }` (line 408) and its two-line comment.
  - `.now` background: replace the two-layer `radial-gradient(...), var(--panel)` with `background: var(--panel);`.

- [ ] **Step 2: Enforce the glow budget**

  - `.now .tag` text-shadow → `text-shadow: 0 0 18px color-mix(in srgb, var(--spark) 25%, transparent);` (single faint halo — this is the budget).
  - Delete: `.topbar .wxIcon` `filter: drop-shadow(...)`; `.topbar .wxTemp` text-shadow; `.now .active .dot` box-shadow (keep the breathe animation); `.modeBadge` text-shadow; `.bankChipK.lit` box-shadow and text-shadow (keep its color/border-color change).
  - Keep untouched: map-stage card elevation shadows, `alertCardPulse`/`alertWarnPulse` keyframes, drawer/boot shadows.

- [ ] **Step 3: Cap tracking, drop text-indent**

Exact changes (delete every `text-indent` on the same rules):

| Rule | from | to |
|---|---|---|
| `.systemRisk` | 0.08em | 0.02em |
| `.topbar .clockDate` | 0.24em | 0.06em |
| `.now .active` | 0.45em | 0.06em |
| `.now .freq .unit` | 0.3em | 0.06em |
| `.scanning .scanText` | 0.6em | 0.06em |
| `.log h2` (legend) | 0.45em | 0.06em |
| `.modeBadge` | 0.4em | 0.06em |
| `.alertBar .alertLabel` | 0.3em | 0.06em |
| `.mapStage .alertBar .alertLabel` | 0.28em | 0.06em |
| `.mapStage .alertBar.warning .alertLabel` | 0.3em | 0.06em |
| `.bankChipK` | 0.18em | 0.04em |
| `.mutedBadge` | 0.22em | 0.06em |
| `.now .standbyHint` | 0.15em | 0 (sentence text) |
| `.meterDb` | 0.08em | 0.02em |
| `.bootText` | 0.6em | 0.06em |
| `.bootPhase` | 0.25em | 0.06em |

Leave ≤0.06em values (`.tag` 0.01em, `.freq` 0.02em, `.alertCounties` 0.04em, warning-tag none) as they are.

- [ ] **Step 4: Normalize radii**

3px → 4px: `.meter`, `.modeBadge`, `.bootBar`. 2px → 4px: `.sweep`, range-free bars. 6px → 8px: `.now .err`. 9px/10px → 8px: `.mapStage .now`, `.mapStage .topbar`, `.mapStage .alertBar` (incl. the statement `0 10px 10px 0` → `0 8px 8px 0`).

- [ ] **Step 5: Verify**

Run: `npm test` → pass.
Run: `grep -nE "letter-spacing: 0\.(0[7-9]|[1-9])" src/frontend/dashboard/dashboard.css` → no output.
Run: `grep -cn "text-shadow" src/frontend/dashboard/dashboard.css` → exactly 1 (the `.now .tag` budget; the warning-tag legibility shadow `0 1px 2px rgba(0,0,0,0.28)` may stay — it is contrast, not glow; if kept, expected count is 2).
Run: `grep -nE "border-radius: (?!4px|8px)" ...` — perl grep unsupported; instead `grep -n "border-radius" src/frontend/dashboard/dashboard.css` and eyeball only 4px/8px/50% (dots) remain.

- [ ] **Step 6: Commit**

```bash
git add src/frontend/dashboard/dashboard.css
git commit -m "style(dashboard): quiet pass — no scanlines/washes, one glow, capped tracking"
```

---

### Task 3: Admin CSS quiet pass + chip unification + amber discipline

**Files:**
- Modify: `kiosk/src/frontend/admin/admin.css`

**Interfaces:**
- Produces: zero `text-shadow` in admin.css; one shared chip recipe; tracking ≤0.06em.

- [ ] **Step 1: Delete washes and glows**

  - `body` background: drop the radial-gradient layer → `background: var(--bg);`.
  - `.admin h1`: delete text-shadow, letter-spacing, text-indent, text-transform (the page-intro override already neutralizes them; the base rule must not carry the old look anywhere).
  - `.nowCard` and `.nowCard.hero` backgrounds: drop radial layers → `background: var(--panel);` / `background: var(--bg-subtle, #2b303b);` (keep the hero's spark left border).
  - Delete text-shadows: `.nowCard .npFreq`, `.drawer .dwFreq`, and the row-hover `text-shadow` on `td.rowOpen:first-child`.
  - Delete glows: range-thumb `box-shadow`, `.iconBtn:hover` white `box-shadow` (keep its background).
  - Keep: drawer/dialog elevation shadows, focus-visible outlines, health/alert tints.

- [ ] **Step 2: Cap tracking**

| Rule | from | to |
|---|---|---|
| `.admin h1` | 0.35em | (deleted in Step 1) |
| `.admin section h2` (legend) | 0.32em | 0.06em |
| base `.admin button` | 0.12em | 0.02em + `text-transform: none` |
| `.chTable th` (both decls: 0.18em base, 0.1em late) | | 0.06em |
| `.dcToolbar` n/a; `.dcSee, .dcHear` | 0.12em | 0.02em |
| `.modeChip` | 0.12em | 0.02em |
| `.memChip` | 0.08em | 0.04em |
| `tr.dcDetail .dl` | 0.18em | 0.06em |
| `.drawer .dwUnit` | 0.3em | 0.06em |
| `.drawer .dwInfo dt` | 0.18em | 0.06em |
| old `.adminNav a` rules (0.18em, 0.16em) | | 0 (late rule already sets 0) |
| `.adminHead .brand` | 0.3em | 0.06em |
| `.adminHead .brandSub` | 0.26em | 0.06em |
| `.stLabel` | 0.2em | 0.06em |
| `.sysLabel` | 0.14em | 0.06em |
| `tr.bankRow .bkName` | 0.18em | 0.06em |
| `tr.bankRow .bkCycle` | 0.14em | 0.02em |
| `.systemActionsLabel` | 0.14em | 0.06em |
| `.eyebrow`, `.confirmEyebrow` | 0.18em | 0.06em |
| `.alertClearAll` | 0.08em | 0.02em |
| `.admin h1 .mapLink` | 0.2em | 0.02em |
| `.admin .hint` | 0.08em | 0 |

- [ ] **Step 3: One chip recipe**

Replace the per-chip size/padding/radius in `.count`, `.modeChip`, `.dcSee`, `.dcHear`, `.dcSvc`, `.memChip` with a shared rule (keep each one's color/border-color modifiers where they differ):

```css
/* One chip recipe (spec 2026-07-16): size/shape identical, color varies. */
.admin .count, .admin .modeChip, .dcSee, .dcHear, .dcSvc, .memChip {
  font-family: var(--cond);
  font-size: 0.7rem; font-weight: 600;
  letter-spacing: 0.04em;
  padding: 0.08em 0.45em;
  margin-left: 0.45em;
  border: 1px solid var(--panel-edge);
  border-radius: 4px;
  vertical-align: 0.1em;
  white-space: nowrap;
}
```

then reduce each original rule to color only (e.g. `.dcSee { color: var(--pine); border-color: var(--pine); }`). `.dcSvc.outband` keeps `font-weight: 700`.

- [ ] **Step 4: Amber discipline**

  - `.admin .chTable td:first-child { color: var(--amber); }` → `color: var(--ink);`
  - `.admin .discoveries .chTable td:nth-child(2) { color: var(--amber); }` → delete (inherits ink).
  - `.admin .count` colors → `color: var(--label); background: transparent;` (border from the shared chip rule).
  - Keep amber: `.stValue`, active nav, `.inPeriod.active`, primary buttons, `.eyebrow`, focus/volume accents.

- [ ] **Step 5: Normalize radii**

6px → 8px: `.admin section`, `.bankProfile`, `.sysCell`, `.signalChart`, `.locationMap` (5px→8px... controls stay 4px: inputs/buttons keep 4px; `.locationMap`/`.analyticsSummary span` 5px → 8px). 3px → 4px: `.modeChip` (now via chip rule), `.alertBar` chips n/a. 10px → 8px: `.nowCard.hero`, `.confirmDialog`. Pills (`.count` 8px, `.navBadge` 8px, `.inChip` 8px, `.bankCount` 8px) → 4px via chip rule or explicit (navBadge/inChip/bankCount → 4px).

- [ ] **Step 6: Verify**

Run: `npm test` → pass.
`grep -c "text-shadow" src/frontend/admin/admin.css` → 0.
`grep -nE "letter-spacing: 0\.(0[7-9]|[1-9])" src/frontend/admin/admin.css` → no output.
`grep -n "radial-gradient" src/frontend/admin/admin.css` → no output.

- [ ] **Step 7: Commit**

```bash
git add src/frontend/admin/admin.css
git commit -m "style(admin): quiet pass — flat panels, one chip recipe, amber discipline"
```

---

### Task 4: Touch targets + always-visible row affordance

**Files:**
- Modify: `kiosk/src/frontend/admin/admin.css` (pointer-coarse block, ~line 281)
- Modify: `kiosk/src/frontend/admin/admin.ts:785` (channels row), `kiosk/src/frontend/admin/admin.ts:1351` (discoveries row)

**Interfaces:**
- Produces: `.rowChev` span appended to the tag cell of both tables; CSS class `.rowChev`.

- [ ] **Step 1: Bump the pointer-coarse block to the 44px floor**

Replace:

```css
@media (pointer: coarse) {
  .admin .iconBtn { padding: 0.5rem; }
  .admin .iconBtn svg { width: 17px; height: 17px; }
  .admin .chTable td { padding: 0.55rem 0.5rem; }
}
```

with:

```css
/* Touch floor (spec 2026-07-16): every target ≥44px on coarse pointers. */
@media (pointer: coarse) {
  .admin button { min-height: 2.75rem; }
  .admin .iconBtn { min-width: 2.75rem; min-height: 2.75rem; padding: 0.5rem; }
  .admin .iconBtn svg { width: 18px; height: 18px; margin: auto; }
  .admin .chTable td { padding: 0.55rem 0.5rem; }
  .admin input[type="checkbox"] { width: 1.35rem; height: 1.35rem; }
  .admin input[type="range"] { height: 8px; }
  .admin input[type="range"]::-webkit-slider-thumb { width: 22px; height: 30px; }
}
```

- [ ] **Step 2: Always-visible drawer affordance**

In `admin.ts` channels `displayRow` (line 785), append to the tag cell before `</td>`: `<span class="rowChev" aria-hidden="true">›</span>`. Same in the discoveries row tag cell (line 1351). Add CSS near the `.rowOpen` rules:

```css
/* Rows open the dossier drawer — say so without hover. */
.admin .chTable .rowChev { float: right; color: var(--dim); padding-left: 0.5em; }
.admin .chTable tbody tr:hover .rowChev { color: var(--ink); }
```

- [ ] **Step 3: Verify + commit**

`npm test` → pass. Then:

```bash
git add src/frontend/admin/admin.css src/frontend/admin/admin.ts
git commit -m "fix(admin): 44px touch floor and always-visible row-open affordance"
```

---

### Task 5: Same action same label + plain-language states

**Files:**
- Modify: `kiosk/src/frontend/admin/admin.ts` (lines 467, 656, 790, 825, 1035, 1143, 1145, 1347, 1353)
- Modify: `kiosk/src/frontend/dashboard/dashboard.ts` (lines 355, 372–373)
- Modify: `kiosk/src/frontend/dashboard/dashboard.css` (`.now .err` copy styling if needed — none expected)

**Interfaces:** none.

- [ ] **Step 1: Unify labels in admin.ts**

  - Line 1035 and 1145: `>Lockout</button>` → `>Lock out</button>` (both drawer instances).
  - Line 790 and 1353 tooltips: `"Lockout — remove and never..."` → `"Lock out — remove and never..."`; `"Lockout — never Close-Call..."` → `"Lock out — never Close-Call..."`.
  - Line 1143: `>Add</button>` → `>Add channel</button>`.

- [ ] **Step 2: Plain-language error/empty copy in admin.ts**

  - Line 467: `"name required"` → `"Enter a bank name"`.
  - Line 656: `"no samples yet"` → `"No readings yet — data appears within a minute."`
  - Line 825: `no channels — hit + Add` → `No channels yet — use Add channel above.`
  - Line 1347: `nothing pending — Close Call is hunting` → `Nothing pending — Close Call is hunting. New discoveries land here.`
  - Line 506: `history store unavailable` → `History store unavailable — restart the radio backend if this persists.`
  - Line 1432: `<li class="empty">none</li>` → `<li class="empty">No locked-out frequencies.</li>`

- [ ] **Step 3: Dashboard error + standby copy in dashboard.ts**

  - Line 355: `` nowEl.innerHTML = `<div class="err">${esc(state.error)}</div>`; `` →

```ts
nowEl.innerHTML = `<div class="err"><div>Radio error: ${esc(state.error)}</div>
  <div class="errHint">Scanning resumes automatically. If this stays up, restart the radio backend from the admin page.</div></div>`;
```

  and add to dashboard.css after `.now .err`:

```css
.now .err .errHint { font-size: 0.75em; color: var(--label); margin-top: 0.6rem; }
```

  - Lines 372–373 standby hint: `no channels enabled — check banks` → `No channels are enabled — turn a bank on in the admin.`

- [ ] **Step 4: Verify + commit**

`npm test` → pass (`grep -rn "Lockout\|name required\|no samples" test/` first → expect no pins; fix any that appear).

```bash
git add src/frontend/admin/admin.ts src/frontend/dashboard/dashboard.ts src/frontend/dashboard/dashboard.css
git commit -m "fix: consistent action labels and plain-language error/empty states"
```

---

### Task 6: Full verification, hardware proof, PR

**Files:** none new.

- [ ] **Step 1: Full suite + build**

Run: `npm test` → all pass. Run: `npm run build` → exits 0.

- [ ] **Step 2: Grep audit (spec §5)**

```bash
grep -nE "letter-spacing: 0\.(0[7-9]|[1-9])" src/frontend/dashboard/dashboard.css src/frontend/admin/admin.css   # → empty
grep -n "text-shadow" src/frontend/dashboard/dashboard.css src/frontend/admin/admin.css                          # → only .now .tag budget (+ warning-tag contrast shadow if kept)
grep -n "text-indent" src/frontend/dashboard/dashboard.css src/frontend/admin/admin.css                          # → empty (pageIntro's reset `text-indent: 0` may stay)
grep -n "repeating-linear-gradient" src/frontend/dashboard/dashboard.css                                          # → only the two LED meter masks
```

- [ ] **Step 3: Out-of-scope routes untouched**

`git diff main -- src/frontend/map src/frontend/wall src/frontend/art` → empty.

- [ ] **Step 4: Prove on hardware (normal flow)**

```bash
npm run build && sudo systemctl restart kerchunk-kiosk
```

Then load `/` and `/admin` (localhost:8080) and check: dashboard renders Inter with tabular clock/freq, no scanlines, single tag glow; admin renders flat panels, chips uniform, buttons ≥44px on the phone. If `sudo` is unavailable non-interactively, skip restart and note it in the PR (off-machine exception flow).

- [ ] **Step 5: Push + PR**

```bash
git push -u origin feat/quiet-restyle
gh pr create --title "style: quiet restyle — Inter + de-AI pass for dashboard and admin" --body "..."
```

PR body: summary of spec, the usability-floor checklist with verification results, note that map/wall/art are untouched. End body with the Claude Code attribution line.

---

## Self-review notes

- Spec coverage: §1 fonts → Task 1; §2 effects/radii → Tasks 2–3; §3 amber → Task 3; §4 floor → Tasks 4–5 (idle/reset audited, no change — recorded in PR body); §5 verification → Task 6.
- No placeholders; all copy and selectors are exact.
- Type consistency: `.rowChev` defined once (Task 4) and used only there.
