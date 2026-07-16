# Admin IA Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Re-cluster the admin into five pages (Overview/Triage/Channels/Settings/System), simplify the channels UI to one edit path, and rebuild Settings as grouped cards — phone-first, no backend changes.

**Architecture:** All changes in `kiosk/src/frontend/admin/admin.ts` (markup template + wiring) and `admin.css`. The hash router already generalizes (`ROUTES` set + `data-page` attributes); the System page is a new `data-page="system"` group receiving three existing sections. The drawer becomes the single channel editor and gains `"new"` and `"bank"` modes.

**Tech Stack:** Vanilla TS + CSS, Vite, lucide-static icons, vitest.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-16-admin-ia-redesign.md`. Phone-first; usable > distinctive > beautiful.
- Usability floor: ≥44px coarse-pointer targets (incl. new ⋯ menu items); no hover-only affordances; plain-language states; same action = same label.
- Quiet-restyle caps: letter-spacing ≤0.06em, no new text-shadows/glows, radii 4px/8px only.
- No backend/API changes. Branch `feat/admin-ia` (stacked on `feat/quiet-restyle`).
- Run commands from `kiosk/`. `npm test` green after every task.

---

### Task 1: System page — route, nav entry, section moves

**Files:**
- Modify: `kiosk/src/frontend/admin/admin.ts` (imports ~line 7–20; nav template ~118–123; sections 146–153, 156–159, 264–267; `ROUTES` ~326; titles ~340; `NAV_ICONS` ~328)

**Interfaces:**
- Produces: route `"system"`, `data-page="system"` sections in this DOM order: pageIntro, sysHealth, systemActions card, lockouts. All existing element IDs (`#sysBody`, `#kioskReload`, `#testAlert`, `#testAlertClear`, `#backendRestart`, `#systemActionStatus`, `#loList`) keep their names — no wiring changes needed.

- [ ] **Step 1: Add the wrench icon import** next to the other lucide imports:

```ts
import icoWrench from "lucide-static/icons/wrench.svg?raw";
```

- [ ] **Step 2: Nav entry + route + title + icon.** In the nav template add after the Settings link:

```html
<a href="#/system" data-route="system"><span class="navIco" data-ico="system"></span><span class="navCopy"><b>System</b><small>Appliance health and controls</small></span></a>
```

Update the Settings link's `<small>` to `Scanning, alerts, weather`. Then:
- `ROUTES`: `new Set(["home", "triage", "channels", "scan", "system"])`
- `titles`: add `system: "System"`
- `NAV_ICONS`: add `system: icoWrench`

- [ ] **Step 3: Move the three sections.** Relocate markup (no ID changes):

1. Cut the `<div class="systemActions">…</div>` block out of the hero card's `.npControls`.
2. After the weather section's closing `</section>` and the `</div>` closing `.moduleRow`, add the System page group:

```html
<div class="pageIntro" data-page="system">
  <div><span class="eyebrow">System</span><h1>Appliance</h1><p>Machine health, kiosk screen controls, and Close Call lockouts.</p></div>
</div>
```

3. Move the `sysHealth` section after that intro; change its attribute `data-page="home"` → `data-page="system"` and drop `collapsible`/`data-key` (it is the page's main content now; keep the h2 + hint).
4. Wrap the moved systemActions in a card:

```html
<section class="systemCard" data-page="system">
  <h2>Kiosk &amp; radio actions</h2>
  <div class="systemActions"> …existing four buttons + status span, minus the systemActionsLabel span… </div>
</section>
```

Delete the `<span class="systemActionsLabel">System controls</span>` (the card h2 says it now).
5. Move the lockouts section out of `.moduleRow` to after the systemCard; give it `data-page="system"`, keep `collapsible data-key="lockouts"`.

- [ ] **Step 4: CSS.** In admin.css, `.systemActions` currently assumes it lives in the hero grid (`grid-column: 1 / -1; padding-top; border-top`). Add a scoped reset:

```css
.systemCard .systemActions { padding-top: 0; border-top: 0; }
```

(`.admin .systemActionsLabel` rule becomes dead — delete it.)

- [ ] **Step 5: Verify + commit**

Run: `npm test` → pass. Load `/admin#/system` via dev server or built bundle: health verdict, actions, lockouts present; Overview no longer shows them.

```bash
git add src/frontend/admin && git commit -m "feat(admin): System page — health, kiosk/radio actions, lockouts"
```

---

### Task 2: Settings — four cards, split saves, phone accordion

**Files:**
- Modify: `kiosk/src/frontend/admin/admin.ts` (settings template ~227–277; `#tSave` handler ~1683–1735)
- Modify: `kiosk/src/frontend/admin/admin.css` (settings styles ~1050–1095)

**Interfaces:**
- Produces: buttons `#tSave` (Save scanning), `#alSave` (Save alerts), `#igSave` (Save integrations), err spans `#tErr`, `#alErr`, `#igErr`. Field IDs unchanged.

- [ ] **Step 1: Restructure the markup.** Replace the single `.tuning settingsPanel` + moduleRow with four sibling cards under `data-page="scan"`:

```html
<div class="settingsCards" data-page="scan">
  <details class="settingsCard tuning" open>
    <summary><h2>Scanning</h2><span class="cardHint">Dwell, squelch, and discovery</span></summary>
    <div class="cardBody">
      …Timing and squelch fields (tGroupDwell, tHang, tOpenDb, tQuietDb)…
      …Discovery fields (tCloseCall, tCloseCallDb, tSweep)…
      <div class="formActions"><button id="tSave" class="primary">Save scanning</button><span id="tErr" class="err"></span></div>
    </div>
  </details>
  <details class="settingsCard alertsCard">
    <summary><h2>Alerts</h2><span class="cardHint">Cooldowns, notifications, SAME scope</span></summary>
    <div class="cardBody">
      …tAlertCool, tAlertHold, tAlertNtfy, tSameFips, tSameTests…
      <div class="formActions"><button id="alSave" class="primary">Save alerts</button><span id="alErr" class="err"></span></div>
    </div>
  </details>
  <details class="settingsCard weather">
    <summary><h2>Weather channel</h2><span class="cardHint">NOAA channel for weather-only mode</span></summary>
    <div class="cardBody">
      …wxFreq, wxTag, wxMode…
      <div class="formActions"><button id="wxSave" class="primary">Save weather channel</button><span id="wxErr" class="err"></span></div>
    </div>
  </details>
  <details class="settingsCard integrations">
    <summary><h2>Integrations</h2><span class="cardHint">Google Maps for the activity map</span></summary>
    <div class="cardBody">
      …tMapsKey, tMapsMapId…
      <div class="formActions"><button id="igSave" class="primary">Save integrations</button><span id="igErr" class="err"></span></div>
    </div>
  </details>
</div>
```

Field rows keep the existing `settingGroups label` grid pattern (rename container class per card body: keep `.settingGroups` inside each cardBody, one fieldset-less flat list — drop the `<fieldset>`/`<legend>` wrappers, the card IS the group). Weather section's old `collapsible` section is deleted (fields move here). Page intro paragraph becomes "Tune scanning, alerts, the weather channel, and integrations. Each card saves on its own."

- [ ] **Step 2: Split the save handler.** Extract the existing `#tSave` logic into three handlers with identical field semantics:

```ts
// Save scanning: groupDwellMs, dwellMs (hang), openAboveFloorDb, noiseQuietDb,
// closeCall, closeCallDb, sweepRanges — exactly today's parsing incl. the
// sweep "lo-hi" error message.
// Save alerts (#alSave → #alErr): the alerts object build (cooldownMinutes,
// holdSeconds, ntfyUrl, sameFips, sameTests) with the prune-to-delete rule.
// Save integrations (#igSave → #igErr): maps key/ID incl. the
// "set a weather location first — the map needs coordinates" guard.
```

Each: `getConfig → patch slice → putConfig → err.textContent = "saved"`.

- [ ] **Step 3: Accordion + grid CSS.** Replace `.settingGroups` two-column and `.moduleRow` settings rules with:

```css
.settingsCards { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; align-items: start; }
.settingsCard { background: var(--panel); border: 1px solid var(--panel-edge); border-radius: 8px; }
.settingsCard summary { display: flex; align-items: baseline; gap: 0.6rem; padding: 0.9rem 1.1rem; cursor: pointer; list-style: none; min-height: 2.75rem; }
.settingsCard summary::-webkit-details-marker { display: none; }
.settingsCard summary h2 { margin: 0; font-size: 1rem; color: var(--ink); }
.settingsCard .cardHint { color: var(--dim); font-size: 0.78rem; }
.settingsCard .cardBody { padding: 0 1.1rem 1.1rem; }
@media (min-width: 700px) {
  /* Desktop: cards are always open; summary is a plain header. */
  .settingsCard summary { pointer-events: none; }
}
@media (max-width: 699.9px) {
  .settingsCards { grid-template-columns: 1fr; }
  .settingsCard summary::after { content: "›"; margin-left: auto; color: var(--dim); transform: rotate(90deg); }
  .settingsCard[open] summary::after { transform: rotate(-90deg); }
}
```

Desktop always-open: on load, JS sets `open` on all cards when `matchMedia("(min-width: 700px)")` matches; on phone, wire one-open-at-a-time (on `toggle` of a card opening, close the others). First card (`.tuning`) is `open` in markup for the phone default.

- [ ] **Step 4: Verify + commit**

`npm test` → pass. Dev check: four cards, each save works (scanning save round-trips config), phone width accordions.

```bash
git add src/frontend/admin && git commit -m "feat(admin): settings as four save-scoped cards with phone accordion"
```

---

### Task 3: Channels rows — three columns, no inline editing

**Files:**
- Modify: `kiosk/src/frontend/admin/admin.ts` (thead ~200–203; `displayRow`/`editRow`/`renderRows`/`rowPatch`/`saveRow`/`wireRows` ~712–958; `addBtn` handler ~1444; mobile-column CSS refs)
- Modify: `kiosk/src/frontend/admin/admin.css` (drop nth-child(4..6) centering; mobile Mode-column hiding for `.channels`)

**Interfaces:**
- Consumes: drawer new-channel mode from Task 4 — `openChannelEditor(c?: Channel, presetTags?: string[])`; this task calls it from `addBtn`. (Order note: implement Task 4 first or land both before running the UI; tests don't cover the interim.)
- Produces: channel rows with cells Freq / Name / Audible; `colspan="4"` on bank header + empty rows.

- [ ] **Step 1: New thead** — `<th>Freq (MHz)</th><th>Name</th><th>Audible</th><th></th>` → actually the chevron lives in the Name cell; use three `th` (Freq, Name, Audible). Bank header `colspan` 7 → 3; empty-row colspan 7 → 3.

- [ ] **Step 2: `displayRow` becomes:**

```ts
function displayRow(c: Channel): string {
  return `<tr data-id="${esc(c.id)}">
    <td class="rowOpen">${fmtFreq(c.freq)}</td>
    <td class="rowOpen">${esc(c.alphaTag)}${c.alert ? `<span class="bellChip" title="Alerts on a hit">${ICONS.bell}</span>` : ""}${membershipChips(c)}${locChip(c.location)}<span class="rowChev" aria-hidden="true">›</span></td>
    <td class="chAudible"><input type="checkbox" class="audible" ${c.audible !== false ? "checked" : ""} title="Audible — play this channel through the speaker" /></td>
  </tr>`;
}
```

- [ ] **Step 3: Delete the inline-edit machinery**: `editRow`, `rowPatch`, `saveRow`, `tr0Focus`, `editingId`, `pendingTags`, `pendingGroup`, `MODES`/`modeOptions` **stay** (drawer uses them). `renderRows` drops editor placement (`editorGroup`, editingId branches, `addBtn.disabled`); `wireRows` keeps rowOpen + audible wiring only (prio/archived/listen/lock/save/cancel/keydown wiring deleted).

- [ ] **Step 4: `addBtn` and bank-add open the drawer**: `addBtn` → `openChannelEditor()`; `.bkAddCh` handler → `openChannelEditor(undefined, b?.tags?.slice(0,1) ?? [])`.

- [ ] **Step 5: CSS/tests sweep** — remove `.channels` nth-child centering + mobile mode-column hide; keep `.dMode` rules (discoveries table unchanged). Check `test/adminForm.test.ts` for reliance on removed helpers (`formToChannel` lives in a lib and stays).

- [ ] **Step 6: Verify + commit** — `npm test`; visual check.

```bash
git add src/frontend/admin && git commit -m "feat(admin): channels rows simplify to freq/name/audible, drawer-only edit"
```

---

### Task 4: Drawer — new-channel mode and bank-profile mode

**Files:**
- Modify: `kiosk/src/frontend/admin/admin.ts` (drawer machinery ~961–1080; `openProfileEditor` ~421–462; remove `#bankProfile` div ~197 and `bankProfBox`)

**Interfaces:**
- Produces: `openChannelEditor(c?: Channel, presetTags?: string[])` — renders the existing channel form; when `c` is undefined: header "New channel", empty fields, Mode NFM, Audible checked, Save → `api.addChannel({...base, tags: presetTags/parsed})`. `openBankProfile(b: Bank)` — drawer kind `"bank"` with the four profile fields + Save/Cancel (same semantics: empty = inherit global).
- Drawer kinds: `"channel" | "discovery" | "analytics" | "bank"`; `renderDrawer` and the analytics poll guard extend accordingly.

- [ ] **Step 1: Generalize the channel drawer** — `renderChannelDrawer(c?: Channel)`: existing template with `c` optional (`c?.freq` etc.; dwFreq line hidden for new; info `dl` and Listen/Lock out actions rendered only when editing an existing channel). Save handler branches `c ? api.updateChannel(c.id, patch) : api.addChannel(patch)`; on successful add: `closeDrawer(); await refresh();`.

- [ ] **Step 2: `openChannelEditor`** sets `drawerKind = "channel"`, `drawerId = c?.id ?? "new"`, stores `presetTags` for the form's Tags field default, opens drawer.

- [ ] **Step 3: Bank profile drawer** — port `openProfileEditor` fields into `renderBankProfileDrawer(b: Bank)`; delete `#bankProfile` div, `bankProfBox`, `.bankProfile` CSS. Save keeps the strip-then-spread update, then `closeDrawer(); await refresh();`.

- [ ] **Step 4: Verify + commit** — `npm test`; dev check add/edit/profile flows.

```bash
git add src/frontend/admin && git commit -m "feat(admin): drawer gains new-channel and bank-profile modes"
```

---

### Task 5: Bank header ⋯ menu

**Files:**
- Modify: `kiosk/src/frontend/admin/admin.ts` (`bankHeaderRow` ~744–770; `wireBankRows` ~901–953)
- Modify: `kiosk/src/frontend/admin/admin.css`

**Interfaces:**
- Consumes: `openChannelEditor`, `openBankProfile` (Task 4).

- [ ] **Step 1: `bankHeaderRow`** for real banks becomes: caret · name · count chip · summary (`N audible · M archived · profile bits`) · one `<details class="bankMenu">` at the row end:

```html
<details class="bankMenu">
  <summary aria-label="Bank actions">⋯</summary>
  <div class="bankMenuList">
    <button class="bkBulkAudible">Make audible</button>
    <button class="bkBulkSilent">Make silent</button>
    <button class="bkBulkArchive">Archive all</button>
    <button class="bkAddCh">Add channel here</button>
    <button class="bkGear">Scan profile</button>
    <button class="bkDel danger">Delete bank</button>
  </div>
</details>
```

Unbanked header keeps caret/name/count/hint only. Bulk/gear/add/del handlers unchanged except: each closes the menu (`details.open = false`) before acting; `bkGear` → `openBankProfile(b)`; `bkAddCh` → `openChannelEditor(undefined, b.tags?.slice(0,1) ?? [])`.

- [ ] **Step 2: menu CSS** (44px items, right-aligned popover, one open at a time via JS on toggle):

```css
.bankMenu { position: relative; margin-left: auto; }
.bankMenu summary { list-style: none; cursor: pointer; padding: 0.3rem 0.8rem; min-height: 2.35rem; display: inline-flex; align-items: center; border-radius: 4px; color: var(--label); }
.bankMenu summary::-webkit-details-marker { display: none; }
.bankMenu summary:hover { background: var(--etch); }
.bankMenu[open] summary { background: var(--etch); }
.bankMenuList { position: absolute; right: 0; top: 100%; z-index: 30; display: grid; min-width: 12rem; padding: 0.35rem; background: var(--panel); border: 1px solid var(--panel-edge); border-radius: 8px; box-shadow: 0 12px 36px rgba(0, 0, 0, 0.5); }
.bankMenuList button { justify-content: flex-start; text-align: left; border: none; background: none; min-height: 2.75rem; }
tr.bankRow td { position: relative; }
tr.bankRow td > :first-child { vertical-align: middle; }
```

Make the header `td` content a flex row (`display: flex; align-items: center; gap: 0.5rem;`) so `margin-left: auto` lands the menu right. Delete the old `.bkBulk*` inline-button sizing rules.

- [ ] **Step 3: scrim/close behavior** — clicking outside closes: document-level click handler that closes any open `.bankMenu` when the click lands outside it. Only one open: on `toggle`, close all other `.bankMenu[open]`.

- [ ] **Step 4: Verify + commit** — `npm test`; dev check all six menu actions.

```bash
git add src/frontend/admin && git commit -m "feat(admin): bank actions behind an overflow menu"
```

---

### Task 6: Full verification, hardware proof, PR

- [ ] **Step 1:** `npm test` and `npm run build` clean.
- [ ] **Step 2:** Grep audit (quiet-restyle rules still hold): no `letter-spacing > 0.06em`, no `text-shadow`, radii 4/8px in admin.css; no references to deleted ids (`bankProfile`, `editRow`, `fMhz`) outside history.
- [ ] **Step 3:** Route sweep on the built bundle: `#/`, `#/triage`, `#/channels`, `#/scan`, `#/system` each show exactly their sections (`document.querySelectorAll('[data-page]:not(.pageHidden)')`).
- [ ] **Step 4:** Deploy: `npm run build && sudo systemctl restart kerchunk-kiosk`; verify `/admin` serves, spot-check flows.
- [ ] **Step 5:** Push, PR against `feat/quiet-restyle` if #192 unmerged else `main`; body: spec summary + usability-floor checklist + verification results.

## Self-review notes

- Spec coverage: §1→T1, §2→T1, §3→T3+T4+T5, §4→T2, §5→T1, §6→T6.
- Task ordering: T4 (drawer modes) is consumed by T3 step 4 and T5 — execute T4 before finalizing T3's addBtn wiring or land T3+T4 in sequence before manual verification; tests don't exercise the interim gap.
- Type consistency: `openChannelEditor(c?, presetTags?)` and `openBankProfile(b)` named identically in T3/T4/T5.
