# Unified Channels Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Merge the Banks and Channels admin tabs into one grouped channel list where banks are section-header rows carrying their controls (spec: `docs/superpowers/specs/2026-06-06-unified-channels-design.md`).

**Architecture:** A pure `groupChannelsByBank()` helper (backend/config/banks.ts, shared import like `matchesBank`) computes `[{bank, channels}]` in config order with first-match homing and a trailing Unbanked group. `admin.ts`'s `renderRows()` renders bank header rows + channel rows from it; existing bank-chip handlers (Hear/See/Off cycle, profile gear, delete) move onto header rows; the standalone Banks section and nav entry are removed and `#/banks` redirects.

**Tech Stack:** Vanilla TypeScript + CSS (no framework), vitest, Campfire tokens, lucide-static icons.

**Invariants (from spec):** zero schema/API/semantics changes; channel-row wiring (drawer, tri-state, listen/lockout/delete) byte-identical in behavior; bank header cycle behaves exactly like today's chip.

---

### Task 1: `groupChannelsByBank` pure helper

**Files:**
- Modify: `kiosk/src/backend/config/banks.ts` (append)
- Test: `kiosk/test/banks.test.ts` (append)

- [ ] **Step 1: Write the failing test** — append to `kiosk/test/banks.test.ts`:

```ts
describe("groupChannelsByBank — the unified Channels page's skeleton", () => {
  const mk = (id: string, freq: number, tags?: string[]) =>
    ({ id, freq, alphaTag: id, mode: "nfm" as const, enabled: true, ...(tags ? { tags } : {}) });
  const banks = [
    { id: "b1", name: "Rail", enabled: true, tags: ["rail"] },
    { id: "b2", name: "VHF-ish", enabled: true, band: "vhf" as const },
    { id: "b3", name: "GMRS", enabled: false, tags: ["gmrs"] },
  ];
  it("homes each channel under its FIRST matching bank, groups in config order", () => {
    const chans = [
      mk("rail1", 160_650_000, ["rail"]),   // matches b1 AND b2 -> homes b1
      mk("ham1", 146_790_000, ["ham"]),     // matches b2 only
      mk("gmrs1", 462_675_000, ["gmrs"]),   // matches b3 (disabled banks still group)
      mk("uhf-stray", 446_000_000),         // matches nothing -> Unbanked
    ];
    const g = groupChannelsByBank(chans, banks);
    expect(g.map((x) => x.bank?.name ?? "UNBANKED")).toEqual(["Rail", "VHF-ish", "GMRS", "UNBANKED"]);
    expect(g[0]!.channels.map((c) => c.id)).toEqual(["rail1"]);
    expect(g[1]!.channels.map((c) => c.id)).toEqual(["ham1"]);
    expect(g[2]!.channels.map((c) => c.id)).toEqual(["gmrs1"]);
    expect(g[3]!.channels.map((c) => c.id)).toEqual(["uhf-stray"]);
  });
  it("sorts channels by frequency within a group; empty banks still render; no empty Unbanked", () => {
    const chans = [mk("hi", 161_100_000, ["rail"]), mk("lo", 160_215_000, ["rail"])];
    const g = groupChannelsByBank(chans, banks);
    expect(g[0]!.channels.map((c) => c.id)).toEqual(["lo", "hi"]);
    expect(g.length).toBe(3);                       // Rail, VHF-ish, GMRS — no Unbanked group
    expect(g[1]!.channels).toEqual([]);             // empty bank still listed (findable, deletable)
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /home/kiosk/kerchunk-kiosk/kiosk && npx vitest run test/banks.test.ts`
Expected: FAIL — `groupChannelsByBank is not defined` (also add it to the import line at the top of the test file: `import { bandFor, matchesBank, isScannable, isAudible, profileFor, serviceFor, spectrumLabelFor, groupChannelsByBank } from "../src/backend/config/banks.js";`)

- [ ] **Step 3: Implement** — append to `kiosk/src/backend/config/banks.ts`:

```ts
// The unified Channels page (spec 2026-06-06): banks as structure. A
// channel's HOME is its first matching bank — the same config-order
// precedence profileFor() uses, so "first match" means one thing
// everywhere. Channels matching no bank land in a trailing Unbanked
// group (bank: null); empty banks still render so they can be found
// and deleted.
export interface BankGroup {
  bank: Bank | null;
  channels: Channel[];
}

export function groupChannelsByBank(channels: Channel[], banks: Bank[]): BankGroup[] {
  const groups: BankGroup[] = banks.map((b) => ({ bank: b, channels: [] }));
  const unbanked: Channel[] = [];
  for (const c of [...channels].sort((a, b) => a.freq - b.freq)) {
    const home = groups.find((g) => matchesBank(c, g.bank!));
    if (home) home.channels.push(c);
    else unbanked.push(c);
  }
  if (unbanked.length > 0) groups.push({ bank: null, channels: unbanked });
  return groups;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd /home/kiosk/kerchunk-kiosk/kiosk && npx vitest run test/banks.test.ts`
Expected: PASS (all bank tests green)

- [ ] **Step 5: Commit**

```bash
cd /home/kiosk/kerchunk-kiosk && git add kiosk/src/backend/config/banks.ts kiosk/test/banks.test.ts && git commit -m "feat(banks): groupChannelsByBank — the unified Channels page's skeleton"
```

---

### Task 2: Grouped renderer in admin.ts

**Files:**
- Modify: `kiosk/src/frontend/admin/admin.ts` — `renderRows()` (~line 614), `displayRow()` (~588), `rowPatch()` (~625), `wireRows()` (~652), imports (top)

- [ ] **Step 1: Import the helper and add group state.** Change the banks import line (top of file) to include the new names:

```ts
import { bandFor, matchesBank, serviceFor, groupChannelsByBank, type BankGroup } from "../../backend/config/banks.js";
```

Near `let editingId` (the table-state block, ~line 580), add:

```ts
  // Per-group add: the new-channel row renders inside this bank's section
  // and the saved channel carries the bank's first tag, so a channel added
  // "into Rail" actually matches Rail.
  let pendingTags: string[] = [];
  // Collapsed bank groups (persisted like the collapsible modules).
  const GROUPS_KEY = "kerchunk.admin.banksCollapsed";
  const collapsedBanks = new Set<string>(JSON.parse(localStorage.getItem(GROUPS_KEY) ?? "[]"));
```

- [ ] **Step 2: Bank header row template.** Add next to `displayRow()`:

```ts
  function profileSummary(b: Bank): string {
    const bits: string[] = [];
    if (b.dwellWeight !== undefined) bits.push(`dwell ×${b.dwellWeight}`);
    if (b.hangMs !== undefined) bits.push(`hang ${b.hangMs / 1000} s`);
    if (b.openAboveFloorDb !== undefined) bits.push(`open ${b.openAboveFloorDb} dB`);
    if (b.noiseQuietDb !== undefined) bits.push(`quiet ${b.noiseQuietDb} dB`);
    return bits.join(" · ");
  }

  function bankHeaderRow(g: BankGroup): string {
    if (!g.bank) {
      return `<tr class="bankRow" data-bank="unbanked">
        <td colspan="6"><span class="bkCaret">${collapsedBanks.has("unbanked") ? "▸" : "▾"}</span>
        <span class="bkName">UNBANKED</span> <span class="bankCount">${g.channels.length}</span>
        <span class="hint">matches no bank — tag these or add a bank that covers them</span></td>
      </tr>`;
    }
    const b = g.bank;
    const state = !b.enabled ? "off" : b.audible === false ? "see" : "on";
    const next = state === "on" ? "SEE (scan, stay silent)" : state === "see" ? "OFF" : "HEAR";
    const summary = profileSummary(b);
    return `<tr class="bankRow bk-${state}" data-bank="${esc(b.id)}">
      <td colspan="6">
        <span class="bkCaret">${collapsedBanks.has(b.id) ? "▸" : "▾"}</span>
        <span class="bkName">${esc(b.name)}</span>
        <span class="bankCount">${g.channels.length}</span>
        <button class="bkCycle" title="${state.toUpperCase()} — click for ${next}"><span class="bankState"></span>${state === "see" ? "SEE" : state === "off" ? "OFF" : "HEAR"}</button>
        ${iconBtn("bkGear", "gear", "Scan profile (squelch/dwell overrides)")}
        ${iconBtn("bkAddCh", "add", `Add a channel into ${esc(b.name)}`)}
        ${iconBtn("bkDel", "del", "Delete bank — its channels keep scanning")}
        ${summary ? `<span class="bkSummary">${summary}</span>` : ""}
      </td>
    </tr>`;
  }
```

Add a `gear` icon to the ICONS map (top of file): import `import icoGear from "lucide-static/icons/settings-2.svg?raw";` and add `gear: icoGear,` inside `const ICONS = {...}`.

- [ ] **Step 3: Membership chips in `displayRow()`.** In the name cell of `displayRow`, after the alert bell span and before `${locChip(c.location)}`, insert:

```ts
${membershipChips(c)}
```

and add the helper next to `displayRow`:

```ts
  // A channel can match several banks (they're predicates); its row lives
  // under the FIRST match, and these dim chips name the others.
  function membershipChips(c: Channel): string {
    const others = banksCache.filter((b) => matchesBank(c, b));
    if (others.length <= 1) return "";
    const home = others[0]!;
    return others.slice(1).map((b) =>
      `<span class="memChip" title="Also matches ${esc(b.name)} (home: ${esc(home.name)})">${esc(b.name)}</span>`).join("");
  }
```

`banksCache` is the page's bank list: add `let banksCache: Bank[] = [];` beside `let channels: Channel[] = [];` and set `banksCache = cfg.banks ?? [];` inside `refresh()` where `channels` is set (find `channels = ` in `refresh()`; it reads config already).

- [ ] **Step 4: Grouped `renderRows()`.** Replace the body of `renderRows()` (~line 614) with:

```ts
  function renderRows(): void {
    const groups = groupChannelsByBank(channels, banksCache);
    // Where does the new-channel editor render? A per-group add (pendingTags
    // set) renders inside ITS bank's group; the global + Add renders at the
    // very top (index 0). Either way the saved channel re-homes by its own
    // predicate match on the post-save refresh.
    const editorGroup = pendingTags.length === 0
      ? 0
      : Math.max(0, groups.findIndex((g) => g.bank !== null && (g.bank.tags ?? [])[0] === pendingTags[0]));
    chRows.innerHTML =
      groups.map((g, i) => {
        const key = g.bank?.id ?? "unbanked";
        const body = collapsedBanks.has(key)
          ? ""
          : (editingId === "new" && i === editorGroup ? editRow() : "")
            + g.channels.map((c) => (editingId === c.id ? editRow(c) : displayRow(c))).join("");
        return bankHeaderRow(g) + body;
      }).join("") +
      (channels.length === 0 && editingId !== "new"
        ? `<tr><td colspan="6" class="empty">no channels — hit + Add</td></tr>` : "");
    addBtn.disabled = editingId !== null;
    wireRows();
    wireBankRows();
  }
```

- [ ] **Step 5: Bank header wiring.** Add after `wireRows()`:

```ts
  function wireBankRows(): void {
    chRows.querySelectorAll<HTMLElement>("tr.bankRow").forEach((tr) => {
      const id = tr.dataset.bank!;
      tr.querySelector<HTMLElement>(".bkCaret")?.addEventListener("click", () => {
        if (collapsedBanks.has(id)) collapsedBanks.delete(id);
        else collapsedBanks.add(id);
        localStorage.setItem(GROUPS_KEY, JSON.stringify([...collapsedBanks]));
        renderRows();
      });
      if (id === "unbanked") return;
      // Hear -> See -> Off cycle: IDENTICAL semantics to the old chip.
      tr.querySelector<HTMLButtonElement>(".bkCycle")?.addEventListener("click", async () => {
        const cfg = await api.getConfig();
        cfg.banks = (cfg.banks ?? []).map((x) => {
          if (x.id !== id) return x;
          if (x.enabled && x.audible !== false) return { ...x, audible: false };
          if (x.enabled) return { ...x, enabled: false, audible: true };
          return { ...x, enabled: true, audible: true };
        });
        await api.putConfig(cfg);
        await refresh();
      });
      tr.querySelector<HTMLButtonElement>(".bkGear")?.addEventListener("click", () =>
        openProfileEditor(banksCache.find((x) => x.id === id)));
      tr.querySelector<HTMLButtonElement>(".bkAddCh")?.addEventListener("click", () => {
        const b = banksCache.find((x) => x.id === id);
        pendingTags = b?.tags?.length ? [b.tags[0]!] : [];
        editingId = "new";
        collapsedBanks.delete(id);
        renderRows();
      });
      tr.querySelector<HTMLButtonElement>(".bkDel")?.addEventListener("click", async () => {
        const b = banksCache.find((x) => x.id === id);
        if (!b || !confirm(`Delete bank ${b.name}? Its channels keep scanning.`)) return;
        const cfg = await api.getConfig();
        cfg.banks = (cfg.banks ?? []).filter((x) => x.id !== id);
        await api.putConfig(cfg);
        await refresh();
      });
    });
  }
```

- [ ] **Step 6: `rowPatch()` carries the pre-tag; cancel clears it.** In `rowPatch`'s return object add:

```ts
      ...(tr.dataset.id === "new" && pendingTags.length ? { tags: pendingTags } : {}),
```

In `saveRow` after `editingId = null;` add `pendingTags = [];`. Find the cancel handler in `wireRows` (`.cancel` button: sets `editingId = null` then `renderRows()`) and add `pendingTags = [];` there too. The global `addBtn` click handler (search `addBtn.addEventListener`) gets `pendingTags = [];` before setting `editingId = "new"`.

- [ ] **Step 7: Run the suite + build**

Run: `cd /home/kiosk/kerchunk-kiosk/kiosk && npx vitest run && npm run build`
Expected: all tests PASS, build 0 errors. (No new unit tests here — this is DOM wiring; the helper carries the logic and Task 1 tested it.)

- [ ] **Step 8: Commit**

```bash
cd /home/kiosk/kerchunk-kiosk && git add kiosk/src/frontend/admin/admin.ts && git commit -m "feat(admin): channels table grouped by bank — header rows carry bank controls"
```

---

### Task 3: Retire the Banks section + nav entry

**Files:**
- Modify: `kiosk/src/frontend/admin/admin.ts` — markup block (~lines 100–125), router (~ROUTES set), nav markup

- [ ] **Step 1: Move the + Bank form into the Channels section and delete the Banks section.** In the markup template, delete the whole `<section class="banks" data-page="banks">…</section>` block EXCEPT the `.bankAdd` form div and `#bankProfile` div, which move INTO the channels section directly under its `<h2>`:

```html
      <section class="channels" data-page="channels">
        <h2>Channels <span class="count" id="chCount"></span><button id="addBtn">+ Add</button></h2>
        <div class="bankAdd">
          <input id="bkName" placeholder="Bank name (Air, Rail, …)" />
          <select id="bkBand"><option value="">any band</option><option value="hf">HF</option><option value="vhf">VHF</option><option value="uhf">UHF</option><option value="shf">SHF</option></select>
          <input id="bkLo" type="number" step="0.001" placeholder="lo MHz (opt)" title="Frequency range predicate — e.g. 144 for 2m" />
          <input id="bkHi" type="number" step="0.001" placeholder="hi MHz (opt)" />
          <input id="bkTags" placeholder="tags (comma-sep, optional)" />
          <button id="bkAdd">+ Bank</button>
          <span id="bkErr" class="err"></span>
        </div>
        <div id="bankProfile" class="bankProfile"></div>
        <div class="tableWrap">…(unchanged)…</div>
        <span id="chErr" class="err"></span>
      </section>
```

- [ ] **Step 2: Delete dead code.** Remove `renderBanks()` and `refreshBanks()` functions and the `const bankChips = …` lookup; the `#bkAdd` handler stays (it ends in `refreshBanks()` — change that call to `refresh()`). The bank-profile editor (`openProfileEditor`, `hasProfile`) stays (gear uses it); delete `hasProfile` only if now unreferenced (it was only used by the chip markup — check with grep and remove if dead).

- [ ] **Step 3: Nav + router.** Remove the Banks `<a>` from `#adminNav`; remove `"banks"` from `ROUTES`; in `currentRoute()` add a legacy redirect:

```ts
  function currentRoute(): string {
    let r = location.hash.replace(/^#\/?/, "") || "home";
    if (r === "banks") r = "channels";   // pre-unification bookmarks survive
    return ROUTES.has(r) ? r : "home";
  }
```

Also remove `banks: icoLayers,` from `NAV_ICONS` and the now-unused `icoLayers` import.

- [ ] **Step 4: Refresh wiring.** In `refresh()`, ensure it no longer calls `renderBanks` and that `banksCache` is set before `renderRows()` runs. Run grep to confirm nothing references the removed names:

Run: `grep -n "renderBanks\|refreshBanks\|bankChips" kiosk/src/frontend/admin/admin.ts`
Expected: no output

- [ ] **Step 5: Build + commit**

Run: `cd /home/kiosk/kerchunk-kiosk/kiosk && npx vitest run && npm run build`
Expected: PASS / 0 errors

```bash
cd /home/kiosk/kerchunk-kiosk && git add kiosk/src/frontend/admin/admin.ts && git commit -m "feat(admin): retire the Banks tab — #/banks redirects to the unified Channels page"
```

---

### Task 4: CSS for bank rows and membership chips

**Files:**
- Modify: `kiosk/src/frontend/admin/admin.css` (append)

- [ ] **Step 1: Append:**

```css
/* ── Unified Channels page (spec 2026-06-06): banks as section headers. */
tr.bankRow td {
  background: var(--bg-subtle, #2b303b);
  border-top: 1px solid var(--border-strong, #4d515c);
  padding: 0.45rem 0.6rem;
}
tr.bankRow .bkCaret { cursor: pointer; padding: 0 0.4rem 0 0.1rem; color: var(--text-tertiary, #747b8a); }
tr.bankRow .bkName {
  font-family: var(--font-sans, sans-serif);
  font-weight: 700; font-size: 0.8rem;
  letter-spacing: 0.18em; text-transform: uppercase;
  color: var(--text-primary, #f7f8f9);
  margin-right: 0.5rem;
}
tr.bankRow.bk-see .bkName { color: var(--pine, #75acaf); }
tr.bankRow.bk-off .bkName { color: var(--text-disabled, #5e6371); text-decoration: line-through; }
tr.bankRow .bkCycle {
  font-size: 0.7rem; font-weight: 700; letter-spacing: 0.14em;
  padding: 0.15rem 0.6rem; margin: 0 0.45rem;
}
tr.bankRow .bkSummary { font-size: 0.72rem; color: var(--text-secondary, #9299a5); margin-left: 0.6rem; }
.memChip {
  font-size: 0.62rem; letter-spacing: 0.08em; text-transform: uppercase;
  padding: 0.08em 0.4em; margin-left: 0.45em;
  border: 1px solid var(--border-default, #42454e);
  border-radius: 3px;
  color: var(--text-tertiary, #747b8a);
  vertical-align: 0.12em;
}
```

- [ ] **Step 2: Build + commit**

```bash
cd /home/kiosk/kerchunk-kiosk/kiosk && npm run build:frontend && cd /home/kiosk/kerchunk-kiosk && git add kiosk/src/frontend/admin/admin.css && git commit -m "feat(admin): unified Channels page styling — bank rows, membership chips"
```

---

### Task 5: Deploy, field-verify, PR

- [ ] **Step 1: Deploy (frontend-only — no service restart, no helper respawn)**

Run: `cd /home/kiosk/kerchunk-kiosk/kiosk && npm run build:frontend && curl -s -X POST localhost:8080/api/kiosk/reload >/dev/null`

- [ ] **Step 2: Field checks (operator + API)**

1. Admin → Channels: groups render in bank config order, Unbanked last.
2. Click a bank's cycle to SEE then OFF: `curl -s localhost:8080/api/status` shows `scanCount` dropping exactly as the old chip did; kiosk bank rail dims the chip.
3. Gear opens the profile editor; saving restarts the engine (status banner).
4. Per-group + on Rail: new row appears inside Rail; save; `curl -s localhost:8080/api/channels | python3 -c "import json,sys; print([c['tags'] for c in json.load(sys.stdin) if c['alphaTag']=='<the test name>'])"` shows `['rail']`. Delete the test channel from its row.
5. Channel row click still opens the drawer; Listen/lockout/delete intact.
6. `#/banks` in the URL lands on Channels.

- [ ] **Step 3: PR**

```bash
cd /home/kiosk/kerchunk-kiosk && git push -u origin HEAD && gh pr create --title "feat(admin): unified Channels page — banks as structure, one UI" --body "Implements docs/superpowers/specs/2026-06-06-unified-channels-design.md (operator-approved design, visual-companion model A). Banks become section-header rows inside the channel table — same cycle/gear/delete behaviors, first-match homing (profileFor precedence), membership chips, per-group add that pre-tags, Unbanked catch-all. Banks tab retired; #/banks redirects. Zero schema/API/semantics change."
```

Then the operator merges per ritual.
