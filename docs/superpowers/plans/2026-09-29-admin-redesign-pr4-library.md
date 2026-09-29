# Admin Redesign — PR 4 (Library tab) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace admin-next's Library placeholder with the real Library tab: a searchable channel list filtered by bank chips, a channel detail sheet/pane that saves as you go, the Manage banks and Suggestions sheets, and the New (triage) cards with inline samples, bulk actions and the suppressed list.

**Architecture:**
- One pure, unit-tested module, `libraryModel.ts`, holds the logic: search, chips, row text, suggestion summary, discovery facts, form parsing, bank rules and toggles, and the analytics series.
- A small store (`libraryStore.ts`) holds what the Library polls load. It gives every sub-view a `lib.run()` that writes through the Poller lane and then asks for one refresh.
- DOM modules:
  - `library.ts` composes the tab and routes.
  - `libraryChannels.ts` is the list.
  - `channelDetail.ts` is the sheet/pane.
  - `librarySheets.ts` holds Manage banks and Suggestions.
  - `libraryNew.ts` is triage.
  - `samples.ts` is the one-clip player.
  - `libraryActions.ts` holds lockout and discovery mutations with Undo.
- The detail is route-driven (`#/next/library/ch/<id>`, `…/hz/<freq>`, `…/add[/from/<discovery>|/tag/<tag>]`), so the phone's Back button closes it and Radio's "Recently heard" rows can link into it.

**Tech Stack:** TypeScript ESM (`.js` import suffixes, `strict` + `noUncheckedIndexedAccess`), vanilla DOM, Vite, vitest (node env — no DOM in tests), lucide-static.

**Spec:** `docs/superpowers/specs/2026-09-28-admin-redesign-design.md` — §5 Library, §2 shell/polling, §1.1 tokens, §8 testing. Approved mockup: `.superpowers/brainstorm/564019-1790643021/content/library-system.html` (the Library · Channels, Library · New and Channel detail frames).

**Background (read before Task 4):**
- The classic implementation is in `kiosk/src/frontend/admin/admin.ts`:
  - rows, banks and the drawer: lines 1141–1850
  - suggestions and triage: lines 1852–2167
  - `lockoutFreq`: lines 788–830
  - the bank builder: lines 834–866
  - sample playback: lines 160–256
- Port handlers from there; keep their guards (Undo snapshots, 409 handling via `editConfig`-style read-modify-write).

## Global Constraints

- All commands run from `kiosk/`; the branch is `feat/admin-next-library` in `/home/kiosk/kerchunk-kiosk`.
- Relative imports carry `.js` even from `.ts`; `tsconfig` is `strict` + `noUncheckedIndexedAccess`.
- **The appliance deadlocks on 2+ concurrent requests.** Every Library read is a `poller.add` poll. Every write is inside a `.run(` call — `lib.run(...)` or `ctx.poller.run(...)`. Never `Promise.all` over requests. `test/adminNext.lane.test.ts` fails the build on a bare write. A poll's `run` must never call `.run(` (deadlock — see `Poller.run` doc).
- **Write cost follows the server** (`server.ts:864-890`, `:760-790`):
  - A single-channel add/edit via `/api/channels[/:id]` **re-tunes in place**: no warm-up overlay, no audio chop. **Always use these routes for one channel. Never `putConfig` for a single-channel change.** Duplicate resolve (`POST /api/channels/duplicates/resolve`) also re-tunes (`persistAndReload` → `switchMode` → `retune`, `server.ts:915-924`) — its confirm does not mention a restart.
  - `putConfig` that changes the channel set, per-bank profile or channel flags (bank bulk edits, bank profile, lockout that archives a channel) **restarts scanning**. Its confirm or status copy says "restarts scanning briefly".
  - `putConfig` that only touches `discoveries` / `lockoutHz` (dismiss, restore, discovery lockout with no channel) is live — no restart.
  - Creating or deleting a bank with no profile fields changes no channel's scan config — live.
- **Channel PUT merge is shallow** (`server.ts:944`): `location` is replaced whole. Only `ctcssHz`/`dcsCode` clear with `null`. Clearing a site therefore sends `location` without `lat`/`lon`.
- **CSS rules:**
  - Library CSS lives in `admin-next/library.css` (imported by `library.ts`).
  - `kc-`-prefixed classes only; colours only from `--kc-*` tokens.
  - No `backdrop-filter`; no borders on surfaces (tone separation), except `--kc-line` hairlines between rows.
  - Controls are at least 40px tall, keys at least 44px; visible focus uses the existing ring.
  - Responsive at 390px (no horizontal scroll) and 1440px. The detail is a right-side pane at ≥900px, where the list stays interactive, and a bottom sheet below 900px.
- **Markup rules:** icons from lucide-static via `ui/icons.ts` only. Operator strings (names, tags, bank names, lookup text, error messages) go through `esc` or `textContent`.
- **Copy:** sentence case, plain language, and actions say what they do. Service colours appear only as the row dot (`colorFor` from `lib/serviceColor.ts`).
- **No backend or API changes.** New `lib/api.ts` methods only wrap routes that already exist.
- **Live system:**
  - Never restart `kerchunk-kiosk` during tasks.
  - Frontend verification is `npm run typecheck` + `npm run build:frontend` + `curl -s -X POST localhost:8080/api/kiosk/reload`.
  - The full `npm run build` (C++ helper, thermal cost) runs once, in Task 8.
  - Headless screenshots must write PNGs inside `$HOME` and use real-time `--timeout=20000`, not `--virtual-time-budget`.
  - **Never press write controls against the live radio.** The operator does the by-hand checks.
- **Commits** end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. **PR body** ends with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
- **Definition of done:** `npm test`, `npm run test:native`, `npm run typecheck` and `npm run build` pass. The PR is opened from the branch. After merge: `gh pr merge <n> --merge --delete-branch`, `git checkout main && git pull --ff-only && git fetch --prune`, `git branch -d feat/admin-next-library`.

## Decisions carried into this plan (flag in the PR)

1. **Promote is cheaper than classic.** "Add channel" from New opens the detail pre-filled; saving calls `api.addChannel` (re-tune), then removes the discovery with a `putConfig` (live). Classic did both in one `putConfig`, which restarted scanning. Both writes happen inside one `lib.run`, so nothing interleaves. The promoted channel defaults to silent (`audible: false`), as classic — "audibility is always an explicit operator choice".
2. **Dropped per spec §5.3** (triage cards have three keys):
   - the discovery drawer's Google-Maps pin-drop locate editor (site lat/lon is still editable in the new channel's More details)
   - "Suppress likely noise" as a manual action (the server still auto-suppresses; Restore stays)
   - the per-row Listen on discoveries (the recorded sample replaces it)

   List these in the PR so the operator can object.
3. **Banks in the detail are toggle chips.** A tag-based bank toggles membership by adding its first tag or removing its tags. A band/range-only bank shows as a fixed chip. Raw tags stay editable under More details.
4. **Chip semantics:**
   - "All" and bank chips list tracked (enabled) channels.
   - "Archived" lists archived channels and appears only when there are any.
   - Search composes with the selected chip, and the count reads "3 of 97".
5. **`Poller.request(name)`** is added (PR 3 Ruling 2 deferred it). A write refreshes only the `library` poll, not every poll the tab shares.

## Review Focus

- **A poll landing while the operator types in the detail.** Focused or dirty inputs are never overwritten; switches with a save in flight are not repainted. Pinned by `detailFieldsToPatch` tests (Task 5) and the by-hand checklist.
- **Stale or vanished targets:**
  - a detail for a channel deleted elsewhere (duplicate resolve, classic admin)
  - `add/from/<id>` for a discovery already dismissed
  - a bank chip for a deleted bank

  Each shows a plain message or falls back to "All" — never a blank sheet or a throw. Pinned by `validChip` and `resolveDetail` tests (Tasks 2 and 5).
- **Bad input in the detail or bank forms:**
  - non-numeric MHz
  - `lat, lon` out of range
  - hi < lo
  - a profile value ≤ 0

  Each shows under the field and sends nothing. Pinned by the parse tests (Task 2).
- **409 / 400 from the server** (frequency collision, stale config revision). The message shows at the field (detail) or as a toast (sheets), and switches revert. Pinned by `detailFieldsToPatch`/`resolveDetail` purity plus the by-hand checklist.
- **Undo after a bulk action or lockout** restores exactly what was there (snapshots, not defaults). Pinned by the `bulkPatch` and `lockoutSnapshot` tests (Tasks 2 and 6).

---

## File map

| File | Change |
|---|---|
| `kiosk/src/frontend/lib/api.ts` | **Modify:** `getDuplicates`, `resolveDuplicates`, `getArchiveRecommendations` (+ exported `DuplicateSet`, `ArchiveRec`); `deleteChannel` unused here, untouched |
| `kiosk/test/api.test.ts` | **Modify:** append typed-route tests |
| `kiosk/test/adminNext.lane.test.ts` | **Modify:** add `resolveDuplicates` to `WRITES`; expect the new files |
| `kiosk/src/frontend/admin-next/poller.ts` | **Modify:** `request(name)`; `POLL_MS.library`, `.suggestions`, `.analytics` |
| `kiosk/test/adminNext.poller.test.ts` | **Modify:** `request` test |
| `kiosk/src/frontend/admin-next/route.ts` | **Modify:** `Detail` routes |
| `kiosk/test/adminNext.route.test.ts` | **Modify** |
| `kiosk/src/frontend/admin-next/time.ts` | **Create:** `ago()` (moved out of `radio.ts`) |
| `kiosk/src/frontend/admin-next/libraryModel.ts` | **Create:** pure Library logic |
| `kiosk/test/adminNext.libraryModel.test.ts` | **Create** |
| `kiosk/src/frontend/admin-next/ui/kit.ts` | **Modify:** `segmented()`, `chip()`, `field()` |
| `kiosk/src/frontend/admin-next/ui/sheet.ts` | **Create:** `mountSheet()` — modal bottom sheet / desktop pane on `<dialog>` |
| `kiosk/src/frontend/admin-next/ui/icons.ts` | **Modify:** `plus`, `speaker` (volume-2 reused), `speakerOff`, `check` |
| `kiosk/test/adminNext.kit.test.ts` | **Modify** |
| `kiosk/src/frontend/admin-next/live.ts` | **Modify:** `LcdView.state` gains `"detail"` |
| `kiosk/src/frontend/admin-next/libraryStore.ts` | **Create:** `LibStore`, `LibCtx`, `libCtx()` |
| `kiosk/src/frontend/admin-next/library.ts` | **Create:** mount, polls, routing |
| `kiosk/src/frontend/admin-next/library.css` | **Create** |
| `kiosk/src/frontend/admin-next/libraryChannels.ts` | **Create:** list view |
| `kiosk/src/frontend/admin-next/channelDetail.ts` | **Create:** detail sheet/pane |
| `kiosk/src/frontend/admin-next/librarySheets.ts` | **Create:** Suggestions + Manage banks |
| `kiosk/src/frontend/admin-next/libraryActions.ts` | **Create:** lockout / discovery mutations with Undo |
| `kiosk/src/frontend/admin-next/samples.ts` | **Create:** `SamplePlayer` |
| `kiosk/test/adminNext.samples.test.ts` | **Create** |
| `kiosk/src/frontend/admin-next/libraryNew.ts` | **Create:** triage cards |
| `kiosk/src/frontend/admin-next/index.ts` | **Modify:** mount Library; drop its placeholder |
| `kiosk/src/frontend/admin-next/placeholder.ts` | **Modify:** only `system` remains |
| `kiosk/src/frontend/admin-next/radio.ts` | **Modify:** recent rows link to `library/hz/<freq>`; import `ago` from `time.ts` |

---

### Task 1: Plumbing — API routes, `Poller.request`, detail routes, poll knobs

**Files:**
- Modify: `kiosk/src/frontend/lib/api.ts`, `kiosk/src/frontend/admin-next/poller.ts`, `kiosk/src/frontend/admin-next/route.ts`
- Test: `kiosk/test/api.test.ts`, `kiosk/test/adminNext.poller.test.ts`, `kiosk/test/adminNext.route.test.ts`, `kiosk/test/adminNext.lane.test.ts`

**Interfaces:**
- Produces:
  - `api.getDuplicates(): Promise<DuplicateSet[]>`
  - `api.resolveDuplicates(): Promise<{ removed: number; setsResolved: number }>`
  - `api.getArchiveRecommendations(): Promise<ArchiveRec[]>`
  - `export interface DuplicateSet { freq: number; channels: Array<{ channel: Channel; completeness: number }> }`
  - `export interface ArchiveRec { id: string; freq: number; alphaTag: string; audible: boolean }`
  - `Poller.request(name: string): void`
  - `POLL_MS.library = 15_000`, `POLL_MS.suggestions = 120_000`, `POLL_MS.analytics = 30_000`
  - `type Detail = { kind: "ch"; id: string } | { kind: "hz"; hz: number } | { kind: "add"; from?: string; tag?: string }`
  - `Route` gains `detail?: Detail`

- [ ] **Step 1: Write the failing tests**

Append to `kiosk/test/api.test.ts`, inside the existing `describe("typed api routes", …)` block, before its closing `});`:

```ts
  it("library suggestion routes return their bodies and reject on non-OK", async () => {
    const f = reply(200, [{ freq: 146_520_000, channels: [] }]);
    vi.stubGlobal("fetch", f);
    await expect(api.getDuplicates()).resolves.toEqual([{ freq: 146_520_000, channels: [] }]);
    expect(f).toHaveBeenCalledWith("/api/channels/duplicates");
    vi.stubGlobal("fetch", reply(404, { error: "no history store" }));
    await expect(api.getArchiveRecommendations()).rejects.toThrow("no history store");
  });
  it("resolveDuplicates POSTs and returns the tally", async () => {
    const f = reply(200, { removed: 2, setsResolved: 1 });
    vi.stubGlobal("fetch", f);
    await expect(api.resolveDuplicates()).resolves.toEqual({ removed: 2, setsResolved: 1 });
    expect(f).toHaveBeenCalledWith("/api/channels/duplicates/resolve", { method: "POST" });
  });
```

Append to `kiosk/test/adminNext.poller.test.ts` (the file already imports `Poller` and uses `new Poller({ now, hidden })`; match its existing setup helpers):

```ts
describe("Poller.request", () => {
  it("makes only the named poll due", async () => {
    const p = new Poller({ now: () => 1_000, hidden: () => false });
    const ran: string[] = [];
    p.add({ name: "a", everyMs: 60_000, run: async () => { ran.push("a"); } });
    p.add({ name: "b", everyMs: 60_000, run: async () => { ran.push("b"); } });
    await p.tick("library");
    expect(ran).toEqual(["a", "b"]);
    p.request("b");
    await p.tick("library");
    expect(ran).toEqual(["a", "b", "b"]);
    p.request("nope"); // unknown names are ignored
    await p.tick("library");
    expect(ran).toEqual(["a", "b", "b"]);
  });
});
```

Append to `kiosk/test/adminNext.route.test.ts`, inside the existing `describe`:

```ts
  it("parses library detail routes", () => {
    expect(parseRoute("#/next/library/ch/ch_ab12")).toEqual({ tab: "library", detail: { kind: "ch", id: "ch_ab12" } });
    expect(parseRoute("#/next/library/hz/146520000")).toEqual({ tab: "library", detail: { kind: "hz", hz: 146_520_000 } });
    expect(parseRoute("#/next/library/add")).toEqual({ tab: "library", detail: { kind: "add" } });
    expect(parseRoute("#/next/library/add/from/cc_1")).toEqual({ tab: "library", detail: { kind: "add", from: "cc_1" } });
    expect(parseRoute("#/next/library/add/tag/air%20band")).toEqual({ tab: "library", detail: { kind: "add", tag: "air band" } });
  });
  it("ignores malformed detail routes", () => {
    expect(parseRoute("#/next/library/hz/abc")).toEqual({ tab: "library" });
    expect(parseRoute("#/next/library/hz/-5")).toEqual({ tab: "library" });
    expect(parseRoute("#/next/library/ch/")).toEqual({ tab: "library" });
    expect(parseRoute("#/next/library/ch/%E0%A4%A")).toEqual({ tab: "library" });
  });
  it("round-trips detail routes", () => {
    for (const r of [
      { tab: "library", detail: { kind: "ch", id: "ch_x/y" } },
      { tab: "library", detail: { kind: "hz", hz: 462_562_500 } },
      { tab: "library", detail: { kind: "add" } },
      { tab: "library", detail: { kind: "add", from: "cc_9" } },
      { tab: "library", detail: { kind: "add", tag: "rail" } },
    ] as const) {
      expect(parseRoute(hrefFor(r))).toEqual(r);
    }
  });
```

In `kiosk/test/adminNext.lane.test.ts`, add `"resolveDuplicates"` to the `WRITES` array (after `"deleteChannel"`).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/api.test.ts test/adminNext.poller.test.ts test/adminNext.route.test.ts`
Expected: FAIL — `api.getDuplicates is not a function`, `p.request is not a function`, and the route expectations mismatch.

- [ ] **Step 3: Implement**

`kiosk/src/frontend/lib/api.ts`. After the imports, add:

```ts
/** GET /api/channels/duplicates — richest row first in each set. */
export interface DuplicateSet { freq: number; channels: Array<{ channel: Channel; completeness: number }> }
/** GET /api/recommendations/archive — tracked channels not heard in 30 days. */
export interface ArchiveRec { id: string; freq: number; alphaTag: string; audible: boolean }
```

and inside `export const api = { … }`, after `deleteChannel`:

```ts
  getDuplicates: () => fetch("/api/channels/duplicates").then(j<DuplicateSet[]>),
  resolveDuplicates: () =>
    fetch("/api/channels/duplicates/resolve", { method: "POST" }).then(j<{ removed: number; setsResolved: number }>),
  getArchiveRecommendations: () => fetch("/api/recommendations/archive").then(j<ArchiveRec[]>),
```

`kiosk/src/frontend/admin-next/poller.ts`. Add to `POLL_MS`, after `tune`:

```ts
  library: 15_000,    // Library: channels + config (discoveries, banks, lockouts) + samples
  suggestions: 120_000, // Library: duplicates + archive suggestions
  analytics: 30_000,  // Library: the open channel's last-24 h history
```

and after `makeDue`:

```ts
  /** Make one poll due now, by name — a refresh after a write, without
   *  re-running every other poll the tab shares. Unknown names are ignored. */
  request(name: string): void {
    for (const p of this.polls) if (p.name === name) p.lastAt = -Infinity;
  }
```

`kiosk/src/frontend/admin-next/route.ts`. Replace the `Route` interface, `parseRoute` and `hrefFor` with:

```ts
/** What the Library's detail sheet shows: a channel by id, the first channel
 *  on a frequency (Radio's "Recently heard" links), or a new channel — blank,
 *  pre-filled from a discovery, or pre-tagged for a bank. */
export type Detail =
  | { kind: "ch"; id: string }
  | { kind: "hz"; hz: number }
  | { kind: "add"; from?: string; tag?: string };

export interface Route { tab: Tab; sub?: "new"; detail?: Detail }

function decode(s: string | undefined): string | null {
  if (!s) return null;
  try { return decodeURIComponent(s); } catch { return null; }
}

function parseDetail(rest: string[]): Detail | null {
  const [kind, a, b] = rest;
  if (kind === "ch") { const id = decode(a); return id ? { kind: "ch", id } : null; }
  if (kind === "hz") {
    const hz = Number(a);
    return Number.isInteger(hz) && hz > 0 ? { kind: "hz", hz } : null;
  }
  if (kind === "add") {
    if (a === "from") { const from = decode(b); return from ? { kind: "add", from } : { kind: "add" }; }
    if (a === "tag") { const tag = decode(b); return tag ? { kind: "add", tag } : { kind: "add" }; }
    return { kind: "add" };
  }
  return null;
}

export function parseRoute(hash: string): Route {
  const [head, ...rest] = segments(hash);
  switch (head) {
    case "tune": return { tab: "tune" };
    case "library": {
      if (rest[0] === "new") return { tab: "library", sub: "new" };
      const detail = parseDetail(rest);
      return detail ? { tab: "library", detail } : { tab: "library" };
    }
    case "system": return { tab: "system" };
    default: return { tab: "radio" };
  }
}

function detailPath(d: Detail): string[] {
  switch (d.kind) {
    case "ch": return ["ch", encodeURIComponent(d.id)];
    case "hz": return ["hz", String(d.hz)];
    case "add":
      return d.from ? ["add", "from", encodeURIComponent(d.from)]
        : d.tag ? ["add", "tag", encodeURIComponent(d.tag)] : ["add"];
  }
}

export function hrefFor(r: Route): string {
  const path = [
    NEXT_PREFIX, r.tab === "radio" ? "" : r.tab, r.sub ?? "", ...(r.detail ? detailPath(r.detail) : []),
  ].filter(Boolean).join("/");
  return `#/${path}`;
}
```

Note: `segments()` splits on `/`. That is why `encodeURIComponent` is applied to ids and tags (an id containing `/` becomes `%2F`).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/api.test.ts test/adminNext.poller.test.ts test/adminNext.route.test.ts test/adminNext.lane.test.ts && npm run typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add kiosk/src/frontend/lib/api.ts kiosk/src/frontend/admin-next/poller.ts kiosk/src/frontend/admin-next/route.ts kiosk/test/api.test.ts kiosk/test/adminNext.poller.test.ts kiosk/test/adminNext.route.test.ts kiosk/test/adminNext.lane.test.ts
git commit -m "feat(admin-next): Library plumbing — suggestion routes, Poller.request, detail routes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: `libraryModel.ts` — the Library's pure logic

**Files:**
- Create: `kiosk/src/frontend/admin-next/time.ts`, `kiosk/src/frontend/admin-next/libraryModel.ts`
- Modify: `kiosk/src/frontend/admin-next/radio.ts` (import `ago` from `time.ts`; delete its local copy)
- Test: `kiosk/test/adminNext.libraryModel.test.ts`

**Interfaces:**
- Consumes: `DuplicateSet`, `ArchiveRec` (Task 1); `matchesBank`, `serviceFor` from `backend/config/banks.js`; `fmtFreq`.
- Produces everything exported from `libraryModel.ts` below, plus `ago(ts: number, now?: number): string` from `time.ts`.

- [ ] **Step 1: Write the failing tests**

Create `kiosk/test/adminNext.libraryModel.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import type { Bank, Channel } from "../src/backend/config/schema.js";
import {
  matchesQuery, chipsFor, validChip, visibleChannels, CHIP_ALL, CHIP_ARCHIVED, bankChip,
  rowMeta, channelName, lcdMeta, suggestionSummary, pendingDiscoveries, suppressedDiscoveries,
  hitsText, guessLine, milesBetween, discoveryNote, draftFromDiscovery, emptyDraft, parseMhz, parseTags,
  parseSite, toneValue, toneFromValue, newChannelBody, siteLocation, bankRule, profileText,
  bankFromForm, profileFromForm, withProfile, bankToggles, bulkPatch, signalSeries, defaultMode,
  type Discovery,
} from "../src/frontend/admin-next/libraryModel.js";
import { ago } from "../src/frontend/admin-next/time.js";

const ch = (o: Partial<Channel> & { id: string; freq: number }): Channel =>
  ({ alphaTag: "", mode: "nfm", enabled: true, ...o });
const air: Bank = { id: "bk_air", name: "Air", enabled: true, tags: ["air"] };
const uhf: Bank = { id: "bk_uhf", name: "UHF", enabled: true, band: "uhf" };
const A = ch({ id: "a", freq: 118_400_000, alphaTag: "KC Approach", mode: "am", tags: ["air"], location: { city: "Kansas City", state: "MO", source: "rr" } });
const B = ch({ id: "b", freq: 462_562_500, alphaTag: "GMRS 1" });
const C = ch({ id: "c", freq: 151_820_000, alphaTag: "Walmart", enabled: false });

describe("search", () => {
  it("matches name, MHz text, raw Hz and tags, case-insensitively", () => {
    expect(matchesQuery(A, "approach")).toBe(true);
    expect(matchesQuery(A, "118.4")).toBe(true);
    expect(matchesQuery(A, "118400000")).toBe(true);
    expect(matchesQuery(A, "AIR")).toBe(true);
    expect(matchesQuery(A, "rail")).toBe(false);
    expect(matchesQuery(A, "   ")).toBe(true);
  });
});

describe("chips", () => {
  it("counts tracked channels per bank and shows Archived only when any", () => {
    expect(chipsFor([A, B, C], [air, uhf])).toEqual([
      { id: CHIP_ALL, label: "All", count: 2 },
      { id: bankChip("bk_air"), label: "Air", count: 1 },
      { id: bankChip("bk_uhf"), label: "UHF", count: 1 },
      { id: CHIP_ARCHIVED, label: "Archived", count: 1 },
    ]);
    expect(chipsFor([A, B], []).map((c) => c.id)).toEqual([CHIP_ALL]);
  });
  it("falls back to All for a chip that no longer exists", () => {
    const chips = chipsFor([A, B], [air]);
    expect(validChip(bankChip("bk_gone"), chips)).toBe(CHIP_ALL);
    expect(validChip(CHIP_ARCHIVED, chips)).toBe(CHIP_ALL);
    expect(validChip(bankChip("bk_air"), chips)).toBe(bankChip("bk_air"));
  });
  it("filters by chip, then query, sorted by frequency", () => {
    expect(visibleChannels([B, A, C], [air], { chip: CHIP_ALL, query: "" }).map((c) => c.id)).toEqual(["a", "b"]);
    expect(visibleChannels([B, A, C], [air], { chip: bankChip("bk_air"), query: "" }).map((c) => c.id)).toEqual(["a"]);
    expect(visibleChannels([B, A, C], [air], { chip: CHIP_ARCHIVED, query: "" }).map((c) => c.id)).toEqual(["c"]);
    expect(visibleChannels([B, A, C], [air], { chip: CHIP_ALL, query: "gmrs" }).map((c) => c.id)).toEqual(["b"]);
  });
});

describe("row text", () => {
  it("names, meta and LCD meta", () => {
    expect(channelName(A)).toBe("KC Approach");
    expect(channelName(ch({ id: "x", freq: 146_520_000, alphaTag: "  " }))).toBe("146.5200 MHz");
    expect(rowMeta(A)).toBe("118.4000 · AM · Kansas City, MO");
    expect(rowMeta(B)).toBe("462.5625 · NFM");
    expect(lcdMeta(A)).toBe("AM · air · Kansas City, MO");
  });
});

describe("suggestions", () => {
  it("summarises duplicates (extra rows) and archive ideas, or null", () => {
    const dup = { freq: 1, channels: [{ channel: A, completeness: 3 }, { channel: A, completeness: 1 }] };
    const rec = { id: "c", freq: 2, alphaTag: "x", audible: true };
    expect(suggestionSummary([dup], [rec, rec])).toBe("3 suggestions: 1 duplicate, 2 to archive");
    expect(suggestionSummary([], [rec])).toBe("1 suggestion: 1 to archive");
    expect(suggestionSummary([], [])).toBeNull();
  });
});

describe("discoveries", () => {
  const now = 10_000_000;
  const d1: Discovery = { id: "cc_1", freq: 462_562_500, alphaTag: "Close Call 462.5625", ts: now - 60_000, hitCount: 18, lastSeenAt: now - 180_000 };
  const d2: Discovery = { id: "cc_2", freq: 151_820_000, alphaTag: "Walmart", ts: now - 30_000, mode: "DMR", location: { lat: 39.11, lon: -94.6, city: "Kansas City", source: "places" } };
  const d3: Discovery = { id: "cc_3", freq: 453_275_000, alphaTag: "x", ts: now, suppressedAt: now, suppressionReason: "Likely repeated noise" };
  it("splits pending (newest first) from suppressed", () => {
    expect(pendingDiscoveries({ discoveries: [d1, d2, d3] }).map((d) => d.id)).toEqual(["cc_2", "cc_1"]);
    expect(suppressedDiscoveries({ discoveries: [d1, d2, d3] }).map((d) => d.id)).toEqual(["cc_3"]);
    expect(pendingDiscoveries({})).toEqual([]);
  });
  it("says how often and how recently", () => {
    expect(hitsText(d1, now)).toBe("18× · heard 3 min ago");
    expect(hitsText(d2, now)).toBe("1× · heard just now");
  });
  it("guesses from name, service, place and distance", () => {
    expect(guessLine(d1)).toBe("GMRS/FRS");
    expect(guessLine(d2, { lat: 39.1, lon: -94.58 })).toMatch(/^Likely Walmart · .+ · Kansas City · 1\.\d mi$/);
    expect(guessLine({ id: "z", freq: 5_000_000_000, alphaTag: "", ts: 0 })).toBe("Unidentified");
  });
  it("distance is great-circle miles", () => {
    expect(milesBetween({ lat: 39, lon: -94 }, { lat: 39, lon: -94 })).toBe(0);
    expect(milesBetween({ lat: 39, lon: -94 }, { lat: 40, lon: -94 })).toBeCloseTo(69.1, 0);
  });
  it("notes digital and data-only discoveries", () => {
    expect(discoveryNote(d2)).toBe("DMR — digital, can't be played here");
    expect(discoveryNote({ ...d1, audible: false })).toBe("Data or paging — added as a silent channel");
    expect(discoveryNote(d1)).toBe("");
  });
  it("drafts a silent channel with the airband AM rule", () => {
    expect(draftFromDiscovery(d1)).toEqual({ freq: 462_562_500, alphaTag: "", mode: "nfm", audible: false, tags: [] });
    expect(draftFromDiscovery({ ...d2, mode: "FM" })).toMatchObject({ alphaTag: "Walmart", mode: "fm", location: d2.location });
    expect(draftFromDiscovery({ id: "q", freq: 120_000_000, alphaTag: "", ts: 0 }).mode).toBe("am");
    expect(defaultMode(462_000_000)).toBe("nfm");
    expect(emptyDraft({ freq: 121_800_000, tag: "air" })).toEqual({ freq: 121_800_000, alphaTag: "", mode: "am", audible: true, tags: ["air"] });
    expect(emptyDraft()).toEqual({ freq: null, alphaTag: "", mode: "nfm", audible: true, tags: [] });
  });
});

describe("form parsing", () => {
  it("MHz → Hz, or a plain error", () => {
    expect(parseMhz(" 146.52 ")).toBe(146_520_000);
    expect(parseMhz("462.5625")).toBe(462_562_500);
    for (const bad of ["", "abc", "0", "-1"]) expect(() => parseMhz(bad)).toThrow("Enter the frequency in MHz, like 146.5200");
  });
  it("tags: trimmed, deduped, empties dropped", () => {
    expect(parseTags(" air, rail ,,air ")).toEqual(["air", "rail"]);
    expect(parseTags("")).toEqual([]);
  });
  it("site: blank clears, lat/lon validated", () => {
    expect(parseSite("  ")).toBeNull();
    expect(parseSite("39.1755, -94.4861")).toEqual({ lat: 39.1755, lon: -94.4861 });
    for (const bad of ["39.1", "91, 0", "0, 181", "a, b", "1,2,3"]) expect(() => parseSite(bad)).toThrow("Site must be 'lat, lon'");
  });
  it("site → location: keeps lookup fields, clears coordinates on blank", () => {
    const loc = { lat: 1, lon: 2, city: "X", source: "rr" };
    expect(siteLocation(loc, { lat: 3, lon: 4 })).toEqual({ lat: 3, lon: 4, city: "X", source: "operator" });
    expect(siteLocation(loc, null)).toEqual({ city: "X", source: "rr" });
    expect(siteLocation(undefined, null)).toBeUndefined();
  });
  it("tone select value ↔ channel fields", () => {
    expect(toneValue({})).toBe("");
    expect(toneValue({ ctcssHz: 100 })).toBe("100.0");
    expect(toneValue({ dcsCode: "023N" })).toBe("dcs:023N");
    expect(toneFromValue("")).toEqual({ ctcssHz: null, dcsCode: null });
    expect(toneFromValue("100.0")).toEqual({ ctcssHz: 100, dcsCode: null });
    expect(toneFromValue("dcs:023I")).toEqual({ ctcssHz: null, dcsCode: "023I" });
  });
  it("new channel body carries only set fields", () => {
    expect(newChannelBody({ freq: 1, alphaTag: " A ", mode: "fm", audible: true, tags: [] })).toEqual(
      { freq: 1, alphaTag: "A", mode: "fm", enabled: true, audible: true });
    const loc = { lat: 1, lon: 2, source: "places" };
    expect(newChannelBody({ freq: 1, alphaTag: "", mode: "nfm", audible: false, tags: ["air"], location: loc })).toEqual(
      { freq: 1, alphaTag: "", mode: "nfm", enabled: true, audible: false, tags: ["air"], location: loc });
  });
});

describe("banks", () => {
  it("describes the rule and the profile", () => {
    expect(bankRule(air)).toBe("Tagged air");
    expect(bankRule(uhf)).toBe("UHF band");
    expect(bankRule({ id: "r", name: "2m", enabled: true, loHz: 144_000_000, hiHz: 148_000_000 })).toBe("144–148 MHz");
    expect(bankRule({ id: "e", name: "Everything", enabled: true })).toBe("Every channel");
    expect(profileText({ ...air, openAboveFloorDb: 6, hangMs: 2000, dwellWeight: 2 })).toBe("Opens at 6 dB · hang 2 s · dwell ×2");
    expect(profileText(air)).toBe("");
  });
  it("builds a bank from the form, or throws a plain error", () => {
    expect(bankFromForm({ name: " Air ", band: "", lo: "", hi: "", tags: "air" }, "bk_1"))
      .toEqual({ id: "bk_1", name: "Air", enabled: true, tags: ["air"] });
    expect(bankFromForm({ name: "2m", band: "vhf", lo: "144", hi: "148", tags: "" }, "bk_2"))
      .toEqual({ id: "bk_2", name: "2m", enabled: true, band: "vhf", loHz: 144_000_000, hiHz: 148_000_000 });
    expect(() => bankFromForm({ name: " ", band: "", lo: "", hi: "", tags: "" }, "x")).toThrow("Give the bank a name");
    expect(() => bankFromForm({ name: "a", band: "", lo: "x", hi: "", tags: "" }, "x")).toThrow("From must be in MHz");
    expect(() => bankFromForm({ name: "a", band: "", lo: "148", hi: "144", tags: "" }, "x")).toThrow("To must be above From");
  });
  it("parses a profile (blank = global) and applies it", () => {
    expect(profileFromForm({ open: "", hang: "", dwell: "" })).toEqual({});
    expect(profileFromForm({ open: "6", hang: "1500", dwell: "0.5" })).toEqual({ openAboveFloorDb: 6, hangMs: 1500, dwellWeight: 0.5 });
    expect(() => profileFromForm({ open: "0", hang: "", dwell: "" })).toThrow("Squelch open must be a number above 0");
    expect(() => profileFromForm({ open: "", hang: "x", dwell: "" })).toThrow("Hang time must be a number above 0");
    expect(withProfile({ ...air, hangMs: 9 }, { dwellWeight: 2 })).toEqual({ ...air, dwellWeight: 2 });
  });
  it("offers toggles only where a tag change flips membership", () => {
    const vhfAir: Bank = { id: "bk_va", name: "VHF air", enabled: true, band: "vhf", tags: ["air"] };
    const t = bankToggles(B, [air, uhf, vhfAir]);
    expect(t).toEqual([
      { id: "bk_air", name: "Air", member: false, next: ["air"] },
      { id: "bk_uhf", name: "UHF", member: true, next: null },
      { id: "bk_va", name: "VHF air", member: false, next: null }, // B is UHF: a tag can't make it a member
    ]);
    expect(bankToggles(A, [air])).toEqual([{ id: "bk_air", name: "Air", member: true, next: [] }]);
  });
  it("bulk patch snapshots exactly what it changed", () => {
    const { channels, before } = bulkPatch([A, B, C], air, { enabled: true, audible: false });
    expect(channels.find((c) => c.id === "a")).toMatchObject({ enabled: true, audible: false });
    expect(channels.find((c) => c.id === "b")).toBe(B);
    expect([...before.entries()]).toEqual([["a", { enabled: true, audible: undefined }]]);
  });
});

describe("analytics", () => {
  it("summarises active rows and scales the signal line", () => {
    const rows = [
      { ts: 3, durationMs: 2000, rfDb: -10, alphaTag: "x" },
      { ts: 2, durationMs: null, rfDb: null, alphaTag: "x" },
      { ts: 1, durationMs: 1000, rfDb: -20, alphaTag: "x" },
    ];
    const s = signalSeries(rows, 100, 50);
    expect(s.active).toHaveLength(2);
    expect(s.airtimeMs).toBe(3000);
    expect(s.samples).toBe(2);
    expect(s.min).toBe(-22);
    expect(s.max).toBe(-8);
    expect(s.points).toBe("0.0,42.9 100.0,7.1");
    expect(signalSeries([], 100, 50).points).toBe("");
  });
});

describe("ago", () => {
  it("is relative, then a date", () => {
    expect(ago(1_000_000, 1_000_000 + 30_000)).toBe("just now");
    expect(ago(0, 5 * 60_000)).toBe("5 min ago");
    expect(ago(0, 3 * 3_600_000)).toBe("3 h ago");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/adminNext.libraryModel.test.ts`
Expected: FAIL — cannot resolve `libraryModel.js` / `time.js`.

- [ ] **Step 3: Implement**

Create `kiosk/src/frontend/admin-next/time.ts` with the body of `radio.ts`'s `ago`, taking `now`:

```ts
// Relative time for rows ("just now", "5 min ago"), shared by Radio and Library.
export function ago(ts: number, now: number = Date.now()): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h} h ago` : new Date(ts).toLocaleDateString();
}
```

In `radio.ts`, delete the local `function ago` and add `import { ago } from "./time.js";`.

Create `kiosk/src/frontend/admin-next/libraryModel.ts`:

```ts
// Library logic, pure (no DOM, no fetch) so it is unit-tested headless: search,
// bank chips, row text, suggestions, discovery facts, form parsing, bank rules
// and the analytics series. The DOM modules (library*.ts, channelDetail.ts)
// only render what these return.
import type { Bank, Channel, Config } from "../../backend/config/schema.js";
import { matchesBank, serviceFor } from "../../backend/config/banks.js";
import { fmtFreq } from "../lib/format.js";
import type { ArchiveRec, DuplicateSet } from "../lib/api.js";
import { ago } from "./time.js";

export type Discovery = NonNullable<Config["discoveries"]>[number];
export type Mode = Channel["mode"];
type Loc = NonNullable<Channel["location"]>;

export const MODES: ReadonlyArray<[Mode, string]> = [["nfm", "NFM"], ["fm", "FM"], ["am", "AM"]];
export function modeLabel(m: Mode): string { return MODES.find(([v]) => v === m)?.[1] ?? m.toUpperCase(); }

/** Modulations the lookup chain names that this radio can't demodulate. */
export const DIGITAL = ["DMR", "P25", "NXDN", "D-STAR", "YSF", "TETRA"] as const;
export function isDigital(mode: string | undefined): boolean {
  const m = (mode ?? "").toUpperCase();
  return DIGITAL.some((d) => m.includes(d));
}

/** VHF airband (118–137 MHz) is AM; everything else defaults to NFM. */
export function defaultMode(freq: number): Mode {
  return freq >= 118_000_000 && freq <= 137_000_000 ? "am" : "nfm";
}

// ── Search and chips ──────────────────────────────────────────────────────────

/** Name, frequency as MHz text ("146.52") or raw Hz, and tags. */
export function matchesQuery(c: Channel, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return c.alphaTag.toLowerCase().includes(q)
    || fmtFreq(c.freq).includes(q)
    || String(c.freq).includes(q)
    || (c.tags ?? []).some((t) => t.toLowerCase().includes(q));
}

export const CHIP_ALL = "all";
export const CHIP_ARCHIVED = "archived";
/** Bank chip ids are prefixed so a bank can never collide with All/Archived. */
export const bankChip = (id: string): string => `bank:${id}`;

export interface Chip { id: string; label: string; count: number }

/** All (tracked channels), one chip per bank (its tracked members), then
 *  Archived — only when something is archived. */
export function chipsFor(channels: Channel[], banks: Bank[]): Chip[] {
  const tracked = channels.filter((c) => c.enabled);
  const archived = channels.length - tracked.length;
  return [
    { id: CHIP_ALL, label: "All", count: tracked.length },
    ...banks.map((b) => ({ id: bankChip(b.id), label: b.name, count: tracked.filter((c) => matchesBank(c, b)).length })),
    ...(archived > 0 ? [{ id: CHIP_ARCHIVED, label: "Archived", count: archived }] : []),
  ];
}

/** A chip that no longer exists (bank deleted, nothing archived) → All. */
export function validChip(chip: string, chips: Chip[]): string {
  return chips.some((c) => c.id === chip) ? chip : CHIP_ALL;
}

export function visibleChannels(channels: Channel[], banks: Bank[], o: { chip: string; query: string }): Channel[] {
  const bank = banks.find((b) => bankChip(b.id) === o.chip);
  return channels
    .filter((c) => (o.chip === CHIP_ARCHIVED ? !c.enabled : c.enabled))
    .filter((c) => !bank || matchesBank(c, bank))
    .filter((c) => matchesQuery(c, o.query))
    .sort((a, b) => a.freq - b.freq);
}

// ── Row and LCD text ──────────────────────────────────────────────────────────

export function placeText(loc?: { city?: string; state?: string }): string {
  return [loc?.city, loc?.state].filter(Boolean).join(", ");
}
export function channelName(c: { alphaTag: string; freq: number }): string {
  return c.alphaTag.trim() || `${fmtFreq(c.freq)} MHz`;
}
export function rowMeta(c: Channel): string {
  return [fmtFreq(c.freq), modeLabel(c.mode), placeText(c.location)].filter(Boolean).join(" · ");
}
/** The detail LCD's meta line: mode · service · place. */
export function lcdMeta(c: { freq: number; mode: Mode; location?: { city?: string; state?: string } }): string {
  return [modeLabel(c.mode), serviceFor(c.freq) ?? "", placeText(c.location)].filter(Boolean).join(" · ");
}

// ── Suggestions ───────────────────────────────────────────────────────────────

/** "3 suggestions: 1 duplicate, 2 to archive", or null when there are none.
 *  A duplicate is an extra row (the set keeps its richest one). */
export function suggestionSummary(dups: DuplicateSet[], recs: ArchiveRec[]): string | null {
  const d = dups.reduce((n, s) => n + Math.max(0, s.channels.length - 1), 0);
  const a = recs.length;
  const total = d + a;
  if (total === 0) return null;
  const parts = [d ? `${d} duplicate${d === 1 ? "" : "s"}` : "", a ? `${a} to archive` : ""].filter(Boolean);
  return `${total} suggestion${total === 1 ? "" : "s"}: ${parts.join(", ")}`;
}

// ── Discoveries ───────────────────────────────────────────────────────────────

export function pendingDiscoveries(cfg: Pick<Config, "discoveries">): Discovery[] {
  return (cfg.discoveries ?? []).filter((d) => !d.suppressedAt).sort((a, b) => b.ts - a.ts);
}
export function suppressedDiscoveries(cfg: Pick<Config, "discoveries">): Discovery[] {
  return (cfg.discoveries ?? []).filter((d) => d.suppressedAt).sort((a, b) => b.ts - a.ts);
}

export function hitsText(d: Discovery, now: number = Date.now()): string {
  return `${d.hitCount ?? 1}× · heard ${ago(d.lastSeenAt ?? d.ts, now)}`;
}

/** Close Call's placeholder names ("Close Call 462.5625") say nothing. */
export function isGenericName(name: string): boolean {
  return name.trim() === "" || /^close call\b/i.test(name.trim());
}

export function milesBetween(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const rad = (d: number): number => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * 3958.8 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** "Likely Walmart · biz/PS · Kansas City · 1.2 mi" — the identification
 *  chain's best guess, or "Unidentified". */
export function guessLine(d: Discovery, home?: { lat: number; lon: number }): string {
  const bits: string[] = [];
  if (!isGenericName(d.alphaTag)) bits.push(`Likely ${d.alphaTag.trim()}`);
  const svc = serviceFor(d.freq);
  if (svc) bits.push(svc);
  const place = placeText(d.location);
  if (place) bits.push(place);
  if (home && d.location?.lat != null && d.location.lon != null) {
    const mi = milesBetween(home, { lat: d.location.lat, lon: d.location.lon });
    bits.push(`${mi < 10 ? mi.toFixed(1) : Math.round(mi)} mi`);
  }
  return bits.join(" · ") || "Unidentified";
}

/** One caution line for a card, or "". */
export function discoveryNote(d: Discovery): string {
  if (isDigital(d.mode)) return `${d.mode!.toUpperCase()} — digital, can't be played here`;
  if (d.audible === false) return "Data or paging — added as a silent channel";
  return "";
}

/** What the detail's new-channel form starts from. */
export interface ChannelDraft {
  freq: number | null;
  alphaTag: string;
  mode: Mode;
  audible: boolean;
  tags: string[];
  location?: Loc;
}

export function emptyDraft(o: { freq?: number; tag?: string } = {}): ChannelDraft {
  return {
    freq: o.freq ?? null, alphaTag: "", mode: o.freq ? defaultMode(o.freq) : "nfm",
    audible: true, tags: o.tag ? [o.tag] : [],
  };
}

/** A discovery as a new channel: its identified mode mapped onto what we can
 *  demodulate (unknown in the airband = AM), silent until the operator says
 *  otherwise (classic promoteDiscovery's rule), located if the chain found it. */
export function draftFromDiscovery(d: Discovery): ChannelDraft {
  const m = (d.mode ?? "").toUpperCase();
  const mode: Mode = m === "FM" ? "fm" : m === "AM" ? "am" : m === "" ? defaultMode(d.freq) : "nfm";
  return {
    freq: d.freq, alphaTag: isGenericName(d.alphaTag) ? "" : d.alphaTag.trim(), mode, audible: false, tags: [],
    ...(d.location ? { location: d.location } : {}),
  };
}

// ── Form parsing (each throws a message fit to show under the field) ──────────

export function parseMhz(raw: string): number {
  const t = raw.trim();
  const n = Number(t);
  if (!t || !Number.isFinite(n) || n <= 0) throw new Error("Enter the frequency in MHz, like 146.5200");
  return Math.round(n * 1e6);
}

export function parseTags(raw: string): string[] {
  return [...new Set(raw.split(",").map((t) => t.trim()).filter(Boolean))];
}

/** "lat, lon" → coordinates; blank → null (clear the site). */
export function parseSite(raw: string): { lat: number; lon: number } | null {
  if (!raw.trim()) return null;
  const parts = raw.split(",").map((x) => Number(x.trim()));
  const [lat, lon] = parts;
  if (parts.length !== 2 || lat === undefined || lon === undefined || !Number.isFinite(lat) || !Number.isFinite(lon)
    || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    throw new Error("Site must be 'lat, lon', like 39.1755, -94.4861");
  }
  return { lat, lon };
}

/** The channel's new `location` for a site edit. The channel PUT replaces
 *  `location` whole, so clearing sends it without lat/lon (keeping what the
 *  lookup chain found); an operator-set site is sourced "operator". */
export function siteLocation(loc: Loc | undefined, site: { lat: number; lon: number } | null): Loc | undefined {
  if (site) return { ...(loc ?? {}), lat: site.lat, lon: site.lon, source: "operator" };
  if (!loc) return undefined;
  const { lat: _lat, lon: _lon, ...rest } = loc;
  return rest;
}

/** The tone select's value: "" none, "100.0" CTCSS, "dcs:023N" DCS. */
export function toneValue(c: { ctcssHz?: number; dcsCode?: string }): string {
  if (c.dcsCode !== undefined) return `dcs:${c.dcsCode}`;
  if (c.ctcssHz !== undefined) return c.ctcssHz.toFixed(1);
  return "";
}
/** Select value → the PUT fields; null clears (one scheme at a time). */
export function toneFromValue(v: string): { ctcssHz: number | null; dcsCode: string | null } {
  if (v.startsWith("dcs:")) return { ctcssHz: null, dcsCode: v.slice(4) };
  if (v === "") return { ctcssHz: null, dcsCode: null };
  return { ctcssHz: Number(v), dcsCode: null };
}

/** POST /api/channels body from a completed draft. */
export function newChannelBody(d: ChannelDraft & { freq: number }): Omit<Channel, "id"> {
  return {
    freq: d.freq, alphaTag: d.alphaTag.trim(), mode: d.mode, enabled: true, audible: d.audible,
    ...(d.tags.length ? { tags: d.tags } : {}),
    ...(d.location ? { location: d.location } : {}),
  };
}

// ── Banks ─────────────────────────────────────────────────────────────────────

/** What a bank matches, in words. */
export function bankRule(b: Bank): string {
  const bits: string[] = [];
  if (b.band) bits.push(`${b.band.toUpperCase()} band`);
  if (b.loHz !== undefined || b.hiHz !== undefined) {
    const mhz = (hz: number | undefined): string => (hz === undefined ? "…" : String(hz / 1e6));
    bits.push(`${mhz(b.loHz)}–${mhz(b.hiHz)} MHz`);
  }
  if (b.tags?.length) bits.push(`Tagged ${b.tags.join(", ")}`);
  return bits.join(" · ") || "Every channel";
}

/** The bank's scan-profile overrides in words, or "" (all global). */
export function profileText(b: Bank): string {
  const bits: string[] = [];
  if (b.openAboveFloorDb !== undefined) bits.push(`Opens at ${b.openAboveFloorDb} dB`);
  if (b.hangMs !== undefined) bits.push(`hang ${b.hangMs / 1000} s`);
  if (b.dwellWeight !== undefined) bits.push(`dwell ×${b.dwellWeight}`);
  return bits.join(" · ");
}

export interface BankForm { name: string; band: string; lo: string; hi: string; tags: string }

export function bankFromForm(f: BankForm, id: string): Bank {
  const name = f.name.trim();
  if (!name) throw new Error("Give the bank a name");
  const mhz = (raw: string, label: string): number | undefined => {
    if (!raw.trim()) return undefined;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`${label} must be in MHz, like 144`);
    return Math.round(n * 1e6);
  };
  const loHz = mhz(f.lo, "From");
  const hiHz = mhz(f.hi, "To");
  if (loHz !== undefined && hiHz !== undefined && hiHz <= loHz) throw new Error("To must be above From");
  const tags = parseTags(f.tags);
  return {
    id, name, enabled: true,
    ...(f.band ? { band: f.band as NonNullable<Bank["band"]> } : {}),
    ...(loHz !== undefined ? { loHz } : {}),
    ...(hiHz !== undefined ? { hiHz } : {}),
    ...(tags.length ? { tags } : {}),
  };
}

export interface ProfileForm { open: string; hang: string; dwell: string }
export type Profile = Pick<Bank, "openAboveFloorDb" | "hangMs" | "dwellWeight">;

/** Blank = inherit the global setting; otherwise a number above 0. */
export function profileFromForm(f: ProfileForm): Profile {
  const num = (raw: string, label: string): number | undefined => {
    if (!raw.trim()) return undefined;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`${label} must be a number above 0`);
    return n;
  };
  const open = num(f.open, "Squelch open");
  const hang = num(f.hang, "Hang time");
  const dwell = num(f.dwell, "Dwell weight");
  return {
    ...(open !== undefined ? { openAboveFloorDb: open } : {}),
    ...(hang !== undefined ? { hangMs: hang } : {}),
    ...(dwell !== undefined ? { dwellWeight: dwell } : {}),
  };
}

export function withProfile(b: Bank, p: Profile): Bank {
  const { openAboveFloorDb: _o, hangMs: _h, dwellWeight: _d, ...rest } = b;
  return { ...rest, ...p };
}

/** One chip per bank in the detail. `next` = the channel's tags after a tap,
 *  or null when a tag change can't flip membership (band/range-only banks, or
 *  a channel outside the bank's band). */
export interface BankToggle { id: string; name: string; member: boolean; next: string[] | null }

export function bankToggles(c: Channel, banks: Bank[]): BankToggle[] {
  const tags = c.tags ?? [];
  return banks.map((b) => {
    const member = matchesBank(c, b);
    let next: string[] | null = null;
    if (b.tags?.length) {
      const candidate = member ? tags.filter((t) => !b.tags!.includes(t)) : [...tags, b.tags[0]!];
      if (matchesBank({ ...c, tags: candidate }, b) !== member) next = candidate;
    }
    return { id: b.id, name: b.name, member, next };
  });
}

/** A bank-wide edit (make audible / silent / archive all), with a snapshot of
 *  exactly what each touched channel had — Undo restores that, not a default. */
export function bulkPatch(
  channels: Channel[], bank: Bank, patch: Partial<Pick<Channel, "enabled" | "audible">>,
): { channels: Channel[]; before: Map<string, Pick<Channel, "enabled" | "audible">> } {
  const before = new Map<string, Pick<Channel, "enabled" | "audible">>();
  const next = channels.map((c) => {
    if (!matchesBank(c, bank)) return c;
    before.set(c.id, { enabled: c.enabled, audible: c.audible });
    return { ...c, ...patch };
  });
  return { channels: next, before };
}

// ── Channel analytics (last 24 h) ─────────────────────────────────────────────

export interface HistRow { ts: number; durationMs: number | null; rfDb: number | null; alphaTag: string }

/** Transmissions (rows with a duration or a level), airtime, and the signal
 *  line oldest→newest scaled into W×H with 2 dB headroom. */
export function signalSeries(rows: HistRow[], W: number, H: number): {
  active: HistRow[]; airtimeMs: number; samples: number; min: number; max: number; points: string;
} {
  const active = rows.filter((r) => r.durationMs !== null || r.rfDb !== null);
  const sig = active.filter((r) => r.rfDb !== null).reverse();
  const levels = sig.map((r) => r.rfDb!);
  const min = levels.length ? Math.min(...levels) - 2 : -40;
  const max = levels.length ? Math.max(...levels) + 2 : 0;
  const points = sig.map((r, i) => {
    const x = sig.length === 1 ? W / 2 : (i * W) / (sig.length - 1);
    const y = H - ((r.rfDb! - min) / Math.max(1, max - min)) * H;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  return { active, airtimeMs: active.reduce((n, r) => n + (r.durationMs ?? 0), 0), samples: sig.length, min, max, points };
}
```

Check before moving on: `lcdMeta(A)` expects `serviceFor(118_400_000)` to be `"air"`. If `serviceFor` returns a different label for 118.4 MHz, correct the **test** expectation to the real label (do not change `banks.ts`). Do the same for `guessLine(d1)`'s `"GMRS/FRS"`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/adminNext.libraryModel.test.ts test/adminNext.radio.test.ts && npm run typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add kiosk/src/frontend/admin-next/time.ts kiosk/src/frontend/admin-next/libraryModel.ts kiosk/src/frontend/admin-next/radio.ts kiosk/test/adminNext.libraryModel.test.ts
git commit -m "feat(admin-next): libraryModel — search, chips, discoveries, forms, banks

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: UI kit — segmented control, chips, fields, and the sheet

**Files:**
- Modify: `kiosk/src/frontend/admin-next/ui/kit.ts`, `kiosk/src/frontend/admin-next/ui/icons.ts`, `kiosk/src/frontend/admin-next/live.ts`
- Create: `kiosk/src/frontend/admin-next/ui/sheet.ts`, `kiosk/src/frontend/admin-next/library.css`
- Test: `kiosk/test/adminNext.kit.test.ts`

**Interfaces:**
- Produces:
  - `segmented(o: { label: string; items: Array<{ id: string; label: string; href: string; count?: number; attention?: boolean }>; current: string }): string` — links, one with `aria-current="page"`; the count goes in a `<b>` (hay badge when `attention`).
  - `chip(o: { id: string; label: string; count?: number; pressed?: boolean; attrs?: string; dashed?: boolean }): string` — `<button class="kc-chip" aria-pressed>`.
  - `field(o: { id: string; label: string; control: string; hint?: string }): string` — label + trusted control HTML + `<small class="kc-fieldErr" id="${id}-err" hidden>`.
  - `IconName` gains `plus`, `speaker`, `speakerOff`, `check`.
  - `LcdView.state` gains `"detail"` (a static channel on the glass — no meter, no dB).
  - `mountSheet(host: HTMLElement, o: { id: string; label: string }): Sheet` where

    ```ts
    export interface Sheet {
      readonly body: HTMLElement;
      /** pane: at ≥900px open non-modally as a right-side pane (the page stays usable). */
      open(o: { title: string; pane?: boolean }): void;
      close(): void;
      isOpen(): boolean;
      /** Called once per close, however it closed (button, Esc, backdrop, code). */
      onClose(fn: () => void): void;
      setTitle(t: string): void;
    }
    ```

  - `PANE_MIN_WIDTH_PX = 900` (exported from `sheet.ts`).

- [ ] **Step 1: Write the failing tests**

Append to `kiosk/test/adminNext.kit.test.ts` (update its kit import to include `segmented`, `chip`, `field`):

```ts
describe("segmented", () => {
  it("renders links with the current one marked and counts", () => {
    const html = segmented({
      label: "Library view", current: "new",
      items: [
        { id: "channels", label: "Channels", href: "#/next/library", count: 102 },
        { id: "new", label: "New", href: "#/next/library/new", count: 3, attention: true },
      ],
    });
    expect(html).toContain('aria-label="Library view"');
    expect(html).toMatch(/href="#\/next\/library\/new"[^>]*aria-current="page"/);
    expect(html).not.toMatch(/href="#\/next\/library"[^>]*aria-current/);
    expect(html).toContain('<b class="kc-seg__count">102</b>');
    expect(html).toContain('<b class="kc-seg__count kc-badge">3</b>');
  });
});

describe("chip", () => {
  it("is a pressed-state button that escapes its label", () => {
    const html = chip({ id: "bank:a", label: "<Air>", count: 15, pressed: true });
    expect(html).toContain('data-chip="bank:a"');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain("&lt;Air&gt;");
    expect(html).toContain("<b>15</b>");
  });
});

describe("field", () => {
  it("labels the control and carries a hidden error slot", () => {
    const html = field({ id: "kcX", label: "Name", control: '<input id="kcX">', hint: "Shown on the wall" });
    expect(html).toContain('<label for="kcX">Name</label>');
    expect(html).toContain('id="kcX-err"');
    expect(html).toContain("hidden");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/adminNext.kit.test.ts`
Expected: FAIL — `segmented` is not exported.

- [ ] **Step 3: Implement**

`ui/icons.ts`: add the imports and the map entries.

```ts
import plus from "lucide-static/icons/plus.svg?raw";
import check from "lucide-static/icons/check.svg?raw";
// speaker reuses volume-2; speakerOff reuses volume-x
const ICONS = { radio, tune, library, system, play, stop, skip, weather, pause, lockout, volume, volumeOff, close, external, chevron, trash, plus, check, speaker: volume, speakerOff: volumeOff } as const;
```

`live.ts`: change `state: "live" | "scanning" | "monitor" | "weather" | "breakin";` to add `| "detail"`, with the comment `// "detail": a Library channel shown on the glass — static, no meter`.

`ui/kit.ts`: append

```ts
/** A two-or-more-way view switch made of links (each view is a route). */
export function segmented(o: {
  label: string; current: string;
  items: Array<{ id: string; label: string; href: string; count?: number; attention?: boolean }>;
}): string {
  return `<nav class="kc-seg" aria-label="${esc(o.label)}">${o.items.map((it) =>
    `<a class="kc-seg__item" data-seg="${esc(it.id)}" href="${esc(it.href)}"${it.id === o.current ? ' aria-current="page"' : ""}>`
    + `${esc(it.label)}${it.count !== undefined ? ` <b class="kc-seg__count${it.attention ? " kc-badge" : ""}">${it.count}</b>` : ""}</a>`,
  ).join("")}</nav>`;
}

/** A filter chip: a toggle button (aria-pressed), optional count. */
export function chip(o: { id: string; label: string; count?: number; pressed?: boolean; attrs?: string; dashed?: boolean }): string {
  return `<button type="button" class="kc-chip${o.dashed ? " kc-chip--dashed" : ""}" data-chip="${esc(o.id)}"`
    + `${o.pressed === undefined ? "" : ` aria-pressed="${o.pressed}"`}${o.attrs ? ` ${o.attrs}` : ""}>`
    + `${esc(o.label)}${o.count !== undefined ? ` <b>${o.count}</b>` : ""}</button>`;
}

/** A labelled settings field around a trusted control, with the error line
 *  the caller fills (and un-hides) on a refused value. */
export function field(o: { id: string; label: string; control: string; hint?: string }): string {
  return `<div class="kc-field"><label for="${o.id}">${esc(o.label)}</label>${o.control}`
    + `${o.hint ? `<small class="kc-field__hint">${esc(o.hint)}</small>` : ""}`
    + `<small class="kc-fieldErr" id="${o.id}-err" role="alert" hidden></small></div>`;
}
```

Create `ui/sheet.ts`:

```ts
// One sheet element for Library's sheets and detail. Phone (and every
// non-pane sheet): a modal <dialog> styled as a bottom sheet — native focus
// trap, Esc and inert page for free. Desktop detail (pane: true, ≥900px): the
// same <dialog> opened non-modally as a right-side pane, so the list beside it
// stays usable; Esc still closes it and focus returns to the opener.
import { esc } from "../../lib/format.js";
import { ico } from "./icons.js";

/** At or above this width a `pane` sheet opens beside the page, not over it. */
export const PANE_MIN_WIDTH_PX = 900;

export interface Sheet {
  readonly body: HTMLElement;
  open(o: { title: string; pane?: boolean }): void;
  close(): void;
  isOpen(): boolean;
  onClose(fn: () => void): void;
  setTitle(t: string): void;
}

export function mountSheet(host: HTMLElement, o: { id: string; label: string }): Sheet {
  host.insertAdjacentHTML("beforeend", `
    <dialog class="kc-sheet" id="${o.id}" aria-labelledby="${o.id}-title">
      <header class="kc-sheet__head">
        <h2 class="kc-sheet__title" id="${o.id}-title">${esc(o.label)}</h2>
        <button type="button" class="kc-sheet__close" aria-label="Close">${ico("close")}</button>
      </header>
      <div class="kc-sheet__body"></div>
    </dialog>`);
  const dlg = host.querySelector<HTMLDialogElement>(`#${o.id}`)!;
  const body = dlg.querySelector<HTMLElement>(".kc-sheet__body")!;
  const title = dlg.querySelector<HTMLElement>(".kc-sheet__title")!;
  const closeSubs: Array<() => void> = [];
  let opener: HTMLElement | null = null;

  dlg.querySelector(".kc-sheet__close")!.addEventListener("click", () => dlg.close());
  // A click on the modal backdrop lands on the <dialog> itself.
  dlg.addEventListener("click", (ev) => { if (ev.target === dlg && !dlg.classList.contains("kc-sheet--pane")) dlg.close(); });
  // A non-modal dialog gets no Esc handling from the browser.
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && dlg.open && dlg.classList.contains("kc-sheet--pane")) dlg.close();
  });
  dlg.addEventListener("close", () => {
    document.documentElement.classList.remove(`${o.id}-pane-open`);
    opener?.focus();
    opener = null;
    for (const fn of closeSubs) fn();
  });

  return {
    body,
    open({ title: t, pane }) {
      title.textContent = t;
      if (dlg.open) return; // re-open = retitle only (the caller re-renders body)
      opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const asPane = !!pane && window.matchMedia(`(min-width: ${PANE_MIN_WIDTH_PX}px)`).matches;
      dlg.classList.toggle("kc-sheet--pane", asPane);
      document.documentElement.classList.toggle(`${o.id}-pane-open`, asPane);
      if (asPane) dlg.show(); else dlg.showModal();
      dlg.querySelector<HTMLElement>(".kc-sheet__close")!.focus();
    },
    close() { if (dlg.open) dlg.close(); },
    isOpen: () => dlg.open,
    onClose(fn) { closeSubs.push(fn); },
    setTitle(t) { title.textContent = t; },
  };
}
```

Create `admin-next/library.css`. It is imported in Task 4, and it must style everything Tasks 3–7 render.

```css
/* Library — list, chips, detail sheet/pane, sheets, triage cards. Faceplate
   language: tone separation, --kc-line hairlines between rows only. */
.kc-lib__head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.kc-lib__head h1 { margin: 8px 0 2px; font-size: var(--kc-t-title); font-weight: 700; }
.kc-seg { display: flex; background: var(--kc-raised); border-radius: 12px; padding: 3px; margin: 10px 0 12px; max-width: 28rem; }
.kc-seg__item { flex: 1; text-align: center; padding: 10px 0; border-radius: 9px; color: var(--kc-dim); font-weight: 600; text-decoration: none; min-height: 40px; box-sizing: border-box; }
.kc-seg__item[aria-current="page"] { background: var(--kc-key); color: var(--kc-ink); box-shadow: var(--kc-key-shadow); }
.kc-seg__count { font-weight: 600; color: var(--kc-mute); margin-left: 4px; }
.kc-seg__count.kc-badge { color: var(--kc-hay-ink); }
.kc-search { width: 100%; box-sizing: border-box; min-height: 44px; background: var(--kc-raised); color: var(--kc-ink); border: 0; border-radius: var(--kc-r-key); padding: 0 14px; font: inherit; }
.kc-search::placeholder { color: var(--kc-mute); }
.kc-chips { display: flex; gap: 6px; overflow-x: auto; padding: 10px 0 4px; scrollbar-width: none; }
.kc-chip { flex: none; min-height: 40px; padding: 0 14px; border-radius: var(--kc-r-pill); border: 0; background: var(--kc-raised); color: var(--kc-dim); font: 500 var(--kc-t-small) var(--kc-font); cursor: pointer; }
.kc-chip b { font-weight: 600; margin-left: 4px; color: var(--kc-mute); }
.kc-chip[aria-pressed="true"] { background: color-mix(in srgb, var(--kc-glass) 16%, var(--kc-raised)); color: var(--kc-glass); }
.kc-chip[aria-pressed="true"] b { color: inherit; }
.kc-chip--dashed { background: none; box-shadow: inset 0 0 0 1px var(--kc-line); }
.kc-sugg { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin: 8px 0; padding: 10px 14px; border-radius: var(--kc-r-key); background: color-mix(in srgb, var(--kc-hay) 12%, var(--kc-ground)); color: var(--kc-hay); font-size: var(--kc-t-small); }
.kc-sugg .kc-link { color: var(--kc-hay); min-height: 40px; }
.kc-count { color: var(--kc-mute); font-size: var(--kc-t-small); margin: 6px 0 0; min-height: 1.2em; }

.kc-list--ch { background: var(--kc-raised); border-radius: var(--kc-r-group); margin-top: 8px; overflow: hidden; }
.kc-lrow { display: flex; align-items: center; gap: 10px; padding: 0 12px 0 0; border-top: 1px solid var(--kc-line); }
.kc-lrow:first-child { border-top: 0; }
.kc-lrow__open { flex: 1; min-width: 0; display: flex; align-items: center; gap: 10px; padding: 10px 0 10px 16px; color: inherit; text-decoration: none; min-height: 44px; }
.kc-lrow__open:hover .kc-lrow__name { color: var(--kc-glass-text); }
.kc-lrow[aria-current="true"] { background: color-mix(in srgb, var(--kc-glass) 8%, var(--kc-raised)); }
.kc-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
.kc-lrow__text { min-width: 0; }
.kc-lrow__name { display: block; font-weight: 500; font-size: var(--kc-t-row); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.kc-lrow__meta { color: var(--kc-mute); font-size: var(--kc-t-small); font-variant-numeric: tabular-nums; }
.kc-spk { flex: none; width: 44px; height: 44px; border-radius: var(--kc-r-key); border: 0; background: var(--kc-key); color: var(--kc-ink); box-shadow: var(--kc-key-shadow); display: grid; place-items: center; cursor: pointer; }
.kc-spk[aria-pressed="false"] { background: var(--kc-raised); color: var(--kc-mute); box-shadow: none; }
.kc-spk:disabled { opacity: 0.5; cursor: progress; }

/* sheet: modal bottom sheet (phone, and management sheets) / right pane (desktop detail) */
.kc-sheet { background: var(--kc-ground); color: var(--kc-ink); border: 0; padding: 0; max-width: none; max-height: none; box-sizing: border-box; }
.kc-sheet::backdrop { background: var(--kc-backdrop); }
.kc-sheet[open]:modal { position: fixed; inset: auto 0 0 0; width: 100%; max-height: calc(100dvh - 56px); margin: 0; border-radius: var(--kc-r-sheet) var(--kc-r-sheet) 0 0; overflow: auto; padding-bottom: env(safe-area-inset-bottom, 0px); }
@media (min-width: 900px) {
  .kc-sheet[open]:modal { inset: 0; margin: auto; width: min(34rem, 92vw); max-height: 86dvh; border-radius: var(--kc-r-sheet); }
}
.kc-sheet--pane[open] { position: fixed; top: 64px; right: 0; bottom: 0; left: auto; width: 420px; margin: 0; overflow: auto; border-radius: var(--kc-r-sheet) 0 0 0; box-shadow: -1px 0 0 var(--kc-line); z-index: 20; }
html.kcDetail-pane-open .kc-lib { margin-right: 436px; }
.kc-sheet__head { position: sticky; top: 0; z-index: 1; display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 12px 12px 8px 18px; background: var(--kc-ground); }
.kc-sheet__title { margin: 0; font-size: var(--kc-t-lead); font-weight: 700; }
.kc-sheet__close { width: 44px; height: 44px; border: 0; border-radius: var(--kc-r-key); background: var(--kc-key); color: var(--kc-ink); display: grid; place-items: center; cursor: pointer; }
.kc-sheet__body { padding: 0 14px 18px; }
@media (prefers-reduced-motion: no-preference) {
  .kc-sheet[open]:modal { animation: kc-sheet-in 160ms ease-out; }
  @keyframes kc-sheet-in { from { transform: translateY(24px); opacity: 0; } }
}

/* detail */
.kc-keys--two { grid-template-columns: 1.4fr 1fr; }
.kc-detail .kc-group .kc-switchRow { margin: 0; padding: 12px 16px; border-top: 1px solid var(--kc-line); border-radius: 0; background: none; }
.kc-detail .kc-group .kc-switchRow:first-of-type { border-top: 0; }
.kc-field { display: grid; gap: 4px; padding: 10px 16px; border-top: 1px solid var(--kc-line); }
.kc-group > .kc-field:first-of-type { border-top: 0; }
.kc-field label { font-size: var(--kc-t-small); color: var(--kc-dim); font-weight: 600; }
.kc-field input, .kc-field select { min-height: 44px; background: var(--kc-key); color: var(--kc-ink); border: 0; border-radius: var(--kc-r-key); padding: 0 12px; font: inherit; }
.kc-field input[aria-invalid="true"] { box-shadow: inset 0 0 0 2px var(--kc-coral); }
.kc-field__hint { color: var(--kc-mute); font-size: var(--kc-t-meta); }
.kc-fieldErr { color: var(--kc-coral); font-size: var(--kc-t-small); }
.kc-banks { display: flex; flex-wrap: wrap; gap: 6px; }
.kc-banks .kc-chip[aria-disabled="true"] { cursor: default; opacity: 0.8; }
.kc-toneHeard { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; color: var(--kc-mute); font-size: var(--kc-t-small); }
.kc-facts { display: grid; grid-template-columns: max-content 1fr; gap: 6px 14px; margin: 8px 16px 12px; font-size: var(--kc-t-small); }
.kc-facts dt { color: var(--kc-mute); }
.kc-facts dd { margin: 0; overflow-wrap: anywhere; }
.kc-spark { width: 100%; height: 90px; display: block; }
.kc-spark polyline { fill: none; stroke: var(--kc-glass); stroke-width: 1.5; vector-effect: non-scaling-stroke; }
.kc-detail__status { min-height: 1.4em; margin: 10px 4px 0; color: var(--kc-dim); font-size: var(--kc-t-small); }
.kc-detail__add { margin-top: 14px; }

/* banks + suggestions sheets */
.kc-bank { border-top: 1px solid var(--kc-line); }
.kc-bank:first-child { border-top: 0; }
.kc-bank > summary { list-style: none; cursor: pointer; display: flex; justify-content: space-between; gap: 10px; padding: 12px 16px; min-height: 44px; box-sizing: border-box; }
.kc-bank > summary::-webkit-details-marker { display: none; }
.kc-bank__rule { color: var(--kc-mute); font-size: var(--kc-t-small); }
.kc-bank__acts { display: flex; flex-wrap: wrap; gap: 6px; padding: 4px 16px 14px; }
.kc-formRow { display: flex; flex-wrap: wrap; gap: 8px; padding: 4px 16px 14px; }

/* triage cards */
.kc-cards { display: grid; gap: 10px; margin-top: 4px; }
@media (min-width: 900px) { .kc-cards { grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); } }
.kc-card { background: var(--kc-raised); border-radius: var(--kc-r-group); padding: 12px 14px; }
.kc-card__top { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
.kc-card__freq { font-size: var(--kc-t-lead); font-weight: 700; font-variant-numeric: tabular-nums; }
.kc-card__hits { color: var(--kc-mute); font-size: var(--kc-t-small); }
.kc-card__guess { color: var(--kc-dim); margin: 2px 0 8px; }
.kc-card__note { color: var(--kc-hay); font-size: var(--kc-t-small); margin: -4px 0 8px; }
.kc-card__sample { display: flex; align-items: center; gap: 8px; color: var(--kc-mute); font-size: var(--kc-t-small); margin-bottom: 10px; }
.kc-card__acts { display: grid; grid-template-columns: 1.4fr 1fr 1fr; gap: 6px; }
.kc-card__sel { display: flex; align-items: center; gap: 8px; }
.kc-card__sel input { width: 22px; height: 22px; accent-color: var(--kc-glass); }
.kc-play { width: 40px; height: 40px; border-radius: 50%; border: 0; background: var(--kc-key); color: var(--kc-ink); box-shadow: var(--kc-key-shadow); display: grid; place-items: center; cursor: pointer; }
.kc-play[data-playing] { background: var(--kc-glass); color: var(--kc-glass-ink); }
.kc-bulkBar { position: sticky; bottom: calc(76px + env(safe-area-inset-bottom, 0px)); display: flex; gap: 8px; align-items: center; justify-content: space-between; background: var(--kc-key); border-radius: var(--kc-r-group); padding: 8px 8px 8px 16px; margin-top: 12px; box-shadow: var(--kc-lift-shadow); }
@media (min-width: 900px) { .kc-bulkBar { bottom: 16px; } }
.kc-lib__foot { margin-top: 14px; }
@media (max-width: 899px) { .kc-card__acts .kc-key span { white-space: nowrap; } }
```

If a token used above does not exist in `tokens.css`, use the nearest existing `--kc-*` token and record the substitution in your report. Candidates to check: `--kc-hay-ink`, `--kc-key-shadow`, `--kc-lift-shadow`, `--kc-backdrop`. Never introduce a raw colour.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/adminNext.kit.test.ts && npm run typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add kiosk/src/frontend/admin-next/ui kiosk/src/frontend/admin-next/live.ts kiosk/src/frontend/admin-next/library.css kiosk/test/adminNext.kit.test.ts
git commit -m "feat(admin-next): ui kit — segmented, chip, field, sheet; Library styles

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Library shell and the Channels list

**Files:**
- Create: `kiosk/src/frontend/admin-next/libraryStore.ts`, `kiosk/src/frontend/admin-next/library.ts`, `kiosk/src/frontend/admin-next/libraryChannels.ts`
- Modify: `kiosk/src/frontend/admin-next/index.ts`, `kiosk/src/frontend/admin-next/placeholder.ts`, `kiosk/src/frontend/admin-next/radio.ts`
- Test: `kiosk/test/adminNext.lane.test.ts` (expect the new files)

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces:

  ```ts
  // libraryStore.ts
  export interface SampleMeta { bytes: number; seconds: number; ts: number }
  export interface LibData { channels: Channel[]; cfg: Config; samples: Record<string, SampleMeta> }
  export class LibStore {
    data: LibData | null; dups: DuplicateSet[]; recs: ArchiveRec[]; loadError: string | null;
    subscribe(fn: () => void): void; set(p: Partial<Pick<LibStore, "data" | "dups" | "recs" | "loadError">>): void;
  }
  export interface LibCtx extends Ctx {
    store: LibStore;
    /** Write through the Poller lane, then refresh the Library data once. */
    run<T>(fn: () => Promise<T>): Promise<T>;
    /** Ask for a refresh of one Library poll ("library" | "suggestions" | "analytics"). */
    refresh(name?: string): void;
    /** Where the Library list lives right now (for closing the detail). */
    listHref(): string;
  }
  // library.ts
  export function mountLibrary(ctx: Ctx): void
  // libraryChannels.ts
  export function mountChannels(lib: LibCtx, host: HTMLElement, o: { openBanks(): void; openSuggestions(): void }): { paint(): void; setSelected(id: string | null): void }
  ```

- [ ] **Step 1: Update the lane test's file expectations**

In `test/adminNext.lane.test.ts`'s "finds the admin-next sources" test, add:

```ts
    expect(files).toContain("library.ts");
    expect(files).toContain("libraryChannels.ts");
```

Run: `npx vitest run test/adminNext.lane.test.ts` — Expected: FAIL (files missing).

- [ ] **Step 2: Implement the store**

`libraryStore.ts`:

```ts
// What the Library's polls load, shared by its views; and the LibCtx each
// view is mounted with. Writes go through lib.run (the Poller's single-flight
// lane — this box deadlocks on concurrent requests), which then requests one
// refresh of the Library poll rather than making every poll due.
import type { Channel, Config } from "../../backend/config/schema.js";
import type { ArchiveRec, DuplicateSet } from "../lib/api.js";
import { hrefFor } from "./route.js";
import type { Ctx } from "./ctx.js";

export interface SampleMeta { bytes: number; seconds: number; ts: number }
export interface LibData { channels: Channel[]; cfg: Config; samples: Record<string, SampleMeta> }

export class LibStore {
  data: LibData | null = null;
  dups: DuplicateSet[] = [];
  recs: ArchiveRec[] = [];
  loadError: string | null = null;
  private readonly subs: Array<() => void> = [];
  subscribe(fn: () => void): void { this.subs.push(fn); }
  set(p: Partial<Pick<LibStore, "data" | "dups" | "recs" | "loadError">>): void {
    Object.assign(this, p);
    for (const fn of this.subs) fn();
  }
}

export interface LibCtx extends Ctx {
  store: LibStore;
  run<T>(fn: () => Promise<T>): Promise<T>;
  refresh(name?: string): void;
  listHref(): string;
}

export function libCtx(ctx: Ctx, store: LibStore, view: () => "channels" | "new"): LibCtx {
  const refresh = (name = "library"): void => {
    ctx.poller.request(name);
    void ctx.poller.tick(ctx.shell.route().tab);
  };
  return {
    ...ctx, store, refresh,
    run<T>(fn: () => Promise<T>): Promise<T> {
      const p = ctx.poller.run(fn);
      // Refresh after success AND failure: a refused write (409 stale revision)
      // means our copy is old.
      void p.then(() => refresh(), () => refresh());
      return p;
    },
    listHref: () => hrefFor(view() === "new" ? { tab: "library", sub: "new" } : { tab: "library" }),
  };
}
```

- [ ] **Step 3: Implement `library.ts`**

This mounts the shell markup, the polls, the view switch, the detail and the sheets. It references `mountDetail` (Task 5), `mountSheets` (Task 6) and `mountNew` (Task 7). **In this task, create those three files as minimal stubs**, and later tasks replace them:
- `channelDetail.ts` exports `mountDetail(lib, host)` returning `{ show() {}, hide() {}, paint() {}, isOpen: () => false }`
- `librarySheets.ts` exports `mountSheets(lib, host)` returning `{ openBanks() {}, openSuggestions() {} }`
- `libraryNew.ts` exports `mountNew(lib, host)` returning `{ paint() {} }`

Their exact signatures appear in the code below.

```ts
// Library — channels and new discoveries (spec §5). Composes the list, the
// detail sheet/pane (route-driven: #/next/library/ch/<id> …), the Manage banks
// and Suggestions sheets, and the New (triage) cards.
//
// Every fetch rides the sequential Poller: the "library" poll loads channels,
// then config, then (when recording) the sample index, one after another;
// "suggestions" loads duplicates and archive ideas less often; writes go
// through lib.run (test/adminNext.lane.test.ts enforces it).
import "./library.css";
import { api } from "../lib/api.js";
import { esc } from "../lib/format.js";
import { hrefFor, type Route } from "./route.js";
import { segmented } from "./ui/kit.js";
import { ico } from "./ui/icons.js";
import { POLL_MS } from "./poller.js";
import { pendingDiscoveries } from "./libraryModel.js";
import { LibStore, libCtx, type LibCtx } from "./libraryStore.js";
import { mountChannels } from "./libraryChannels.js";
import { mountDetail } from "./channelDetail.js";
import { mountSheets } from "./librarySheets.js";
import { mountNew } from "./libraryNew.js";
import type { Ctx } from "./ctx.js";

export function mountLibrary(ctx: Ctx): void {
  const el = ctx.shell.panel("library");
  const store = new LibStore();
  let view: "channels" | "new" = "channels";
  const lib: LibCtx = libCtx(ctx, store, () => view);

  el.innerHTML = `<div class="kc-lib">
    <header class="kc-lib__head">
      <h1>Library</h1>
      <a class="kc-key kc-key--primary" id="kcLibAdd" href="${hrefFor({ tab: "library", detail: { kind: "add" } })}">${ico("plus")}<span>Add channel</span></a>
    </header>
    <div id="kcLibSeg"></div>
    <div id="kcLibChannels"></div>
    <div id="kcLibNew" hidden></div>
  </div>`;
  const $ = <T extends HTMLElement>(s: string): T => el.querySelector<T>(s)!;
  const seg = $("#kcLibSeg");
  const chHost = $("#kcLibChannels");
  const newHost = $("#kcLibNew");

  const sheets = mountSheets(lib, el);
  const channels = mountChannels(lib, chHost, sheets);
  const triage = mountNew(lib, newHost);
  const detail = mountDetail(lib, el);

  let segShown = "";
  function paintSeg(): void {
    const d = store.data;
    const nCh = d ? d.channels.filter((c) => c.enabled).length : undefined;
    const nNew = d ? pendingDiscoveries(d.cfg).length : undefined;
    const html = segmented({
      label: "Library view", current: view,
      items: [
        { id: "channels", label: "Channels", href: hrefFor({ tab: "library" }), count: nCh },
        { id: "new", label: "New", href: hrefFor({ tab: "library", sub: "new" }), count: nNew, attention: (nNew ?? 0) > 0 },
      ],
    });
    if (html !== segShown) { segShown = html; seg.innerHTML = html; }
  }

  store.subscribe(() => {
    paintSeg();
    if (view === "channels") channels.paint(); else triage.paint();
    detail.paint();
    const d = store.data;
    if (d) ctx.shell.setTriageCount(pendingDiscoveries(d.cfg).length);
  });

  // ── Polls (sequential; see header)
  ctx.poller.add({
    name: "library", everyMs: POLL_MS.library, tabs: ["library"],
    run: async () => {
      try {
        const chs = await api.getChannels();
        const cfg = await api.getConfig();
        const samples = cfg.scan.recordCloseCalls === true
          ? await api.getDiscoverySamples().catch(() => ({}))
          : {};
        store.set({ data: { channels: chs, cfg, samples }, loadError: null });
      } catch (e) {
        store.set({ loadError: e instanceof Error ? e.message : String(e) });
      }
    },
  });
  ctx.poller.add({
    name: "suggestions", everyMs: POLL_MS.suggestions, tabs: ["library"],
    run: async () => {
      // Each is best-effort: no history store → no archive ideas, not an error.
      const dups = await api.getDuplicates().catch(() => []);
      const recs = await api.getArchiveRecommendations().catch(() => []);
      store.set({ dups, recs });
    },
  });

  // ── Routing: the tab's view follows #/library vs #/library/new; a detail
  // route keeps whichever view was showing and opens the sheet over it.
  let prev: Route | null = null;
  function onRoute(r: Route): void {
    if (r.tab !== "library") { detail.hide(); prev = r; return; }
    if (!r.detail) view = r.sub === "new" ? "new" : "channels";
    chHost.hidden = view !== "channels";
    newHost.hidden = view !== "new";
    paintSeg();
    if (view === "channels") channels.paint(); else triage.paint();
    if (r.detail) detail.show(r.detail, { fromList: prev?.tab === "library" && !prev.detail });
    else detail.hide();
    channels.setSelected(r.detail?.kind === "ch" ? r.detail.id : null);
    prev = r;
  }
  ctx.shell.onRoute(onRoute);
  onRoute(ctx.shell.route());

  // "/" focuses search on the Channels view (not while typing anywhere).
  document.addEventListener("keydown", (ev) => {
    if (ev.key !== "/" || ev.metaKey || ev.ctrlKey || ev.altKey) return;
    const t = ev.target as HTMLElement | null;
    if (t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    if (ctx.shell.route().tab !== "library" || view !== "channels") return;
    const s = chHost.querySelector<HTMLInputElement>("#kcLibSearch");
    if (!s) return;
    ev.preventDefault(); s.focus(); s.select();
  });

  // First paint before any data: say so.
  if (!store.data) chHost.insertAdjacentHTML("afterbegin", `<p class="kc-empty" id="kcLibLoading">${esc("Loading the library…")}</p>`);
  store.subscribe(() => { el.querySelector("#kcLibLoading")?.remove(); });
}
```

The detail's `show` signature is therefore `show(d: Detail, o: { fromList: boolean }): void` (Task 5 uses `fromList` to decide how closing navigates).

- [ ] **Step 4: Implement `libraryChannels.ts`**

```ts
// Library · Channels: search, bank chips, suggestions strip, the list. The
// list is rebuilt only when what it shows changes (a string compare), and
// focus is put back on the same row control after a rebuild — polls every
// 15 s must not steal focus or swallow a tap.
import type { Channel } from "../../backend/config/schema.js";
import { api } from "../lib/api.js";
import { esc } from "../lib/format.js";
import { colorFor } from "../lib/serviceColor.js";
import { hrefFor } from "./route.js";
import { chip, emptyState } from "./ui/kit.js";
import { ico } from "./ui/icons.js";
import {
  CHIP_ALL, channelName, chipsFor, rowMeta, suggestionSummary, validChip, visibleChannels,
} from "./libraryModel.js";
import type { LibCtx } from "./libraryStore.js";

export function mountChannels(lib: LibCtx, host: HTMLElement, o: { openBanks(): void; openSuggestions(): void }): {
  paint(): void; setSelected(id: string | null): void;
} {
  host.innerHTML = `
    <label class="kc-visuallyHidden" for="kcLibSearch">Search channels</label>
    <input id="kcLibSearch" class="kc-search" type="search" autocomplete="off" placeholder="Search name, frequency or tag  ( / )" />
    <div class="kc-chips" id="kcLibChips" role="group" aria-label="Filter by bank"></div>
    <div id="kcLibSugg"></div>
    <p class="kc-count" id="kcLibCount" aria-live="polite"></p>
    <div class="kc-list--ch" id="kcLibRows"></div>`;
  const $ = <T extends HTMLElement>(s: string): T => host.querySelector<T>(s)!;
  const search = $<HTMLInputElement>("#kcLibSearch");
  const chipsEl = $("#kcLibChips");
  const suggEl = $("#kcLibSugg");
  const countEl = $("#kcLibCount");
  const rows = $("#kcLibRows");

  let chipSel = CHIP_ALL;
  let query = "";
  let selected: string | null = null;
  /** Rows whose speaker save is in flight: never repainted from a poll. */
  const pending = new Map<string, boolean>();
  let chipsShown = "", rowsShown = "", suggShown = "";

  search.addEventListener("input", () => { query = search.value; paint(); });

  chipsEl.addEventListener("click", (ev) => {
    const b = (ev.target as HTMLElement).closest<HTMLButtonElement>(".kc-chip");
    if (!b) return;
    if (b.dataset.chip === "manage") { o.openBanks(); return; }
    chipSel = b.dataset.chip ?? CHIP_ALL;
    paint();
  });

  suggEl.addEventListener("click", (ev) => {
    if ((ev.target as HTMLElement).closest("#kcLibReview")) o.openSuggestions();
  });

  rows.addEventListener("click", (ev) => {
    const b = (ev.target as HTMLElement).closest<HTMLButtonElement>(".kc-spk");
    if (!b || b.disabled) return;
    const id = b.dataset.id!;
    const next = b.getAttribute("aria-pressed") !== "true";
    pending.set(id, next);
    paintSpeaker(b, next, true);
    lib.run(() => api.updateChannel(id, { audible: next }))
      .then(() => { pending.delete(id); })
      .catch((e: unknown) => {
        pending.delete(id);
        paintSpeaker(b, !next, false);
        lib.dialogs.toast(`Couldn't change the speaker: ${e instanceof Error ? e.message : String(e)}`);
      });
  });

  function paintSpeaker(b: HTMLButtonElement, on: boolean, busy: boolean): void {
    b.setAttribute("aria-pressed", String(on));
    b.disabled = busy;
    b.innerHTML = ico(on ? "speaker" : "speakerOff");
  }

  function rowHtml(c: Channel): string {
    const name = channelName(c);
    const audible = pending.get(c.id) ?? c.audible !== false;
    const busy = pending.has(c.id);
    return `<div class="kc-lrow" data-id="${esc(c.id)}"${c.id === selected ? ' aria-current="true"' : ""}>
      <a class="kc-lrow__open" href="${hrefFor({ tab: "library", detail: { kind: "ch", id: c.id } })}">
        <i class="kc-dot" style="background:${colorFor(c.freq, "active", c.tags)}" aria-hidden="true"></i>
        <span class="kc-lrow__text"><span class="kc-lrow__name">${esc(name)}</span><span class="kc-lrow__meta">${esc(rowMeta(c))}</span></span>
      </a>
      ${c.enabled ? `<button type="button" class="kc-spk" data-id="${esc(c.id)}" aria-pressed="${audible}"${busy ? " disabled" : ""}
        aria-label="Play ${esc(name)} through the speaker">${ico(audible ? "speaker" : "speakerOff")}</button>` : ""}
    </div>`;
  }

  function paint(): void {
    const d = lib.store.data;
    if (!d) {
      if (lib.store.loadError && !rows.childElementCount) rows.innerHTML = emptyState(`The library couldn't load: ${lib.store.loadError}`);
      return;
    }
    const banks = d.cfg.banks ?? [];
    const chips = chipsFor(d.channels, banks);
    chipSel = validChip(chipSel, chips);
    const chipsHtml = chips.map((c) => chip({ id: c.id, label: c.label, count: c.count, pressed: c.id === chipSel })).join("")
      + chip({ id: "manage", label: "Manage banks", dashed: true });
    if (chipsHtml !== chipsShown) { chipsShown = chipsHtml; chipsEl.innerHTML = chipsHtml; }

    const summary = suggestionSummary(lib.store.dups, lib.store.recs);
    const suggHtml = summary
      ? `<div class="kc-sugg"><span>${esc(summary)}</span><button type="button" class="kc-link" id="kcLibReview">Review</button></div>` : "";
    if (suggHtml !== suggShown) { suggShown = suggHtml; suggEl.innerHTML = suggHtml; }

    const visible = visibleChannels(d.channels, banks, { chip: chipSel, query });
    const total = chips.find((c) => c.id === chipSel)?.count ?? visible.length;
    const count = query.trim() ? `${visible.length} of ${total}` : "";
    if (countEl.textContent !== count) countEl.textContent = count;

    const html = visible.length
      ? visible.map(rowHtml).join("")
      : emptyState(query.trim() ? `No channel matches “${query.trim()}”.` : d.channels.length ? "Nothing here." : "No channels yet. Use Add channel to create one.");
    if (html === rowsShown) return;
    // Put focus back where it was after the rebuild (same row, same control).
    const active = document.activeElement as HTMLElement | null;
    const focusRow = active && rows.contains(active) ? active.closest<HTMLElement>(".kc-lrow")?.dataset.id : undefined;
    const focusSpk = active?.classList.contains("kc-spk") ?? false;
    rowsShown = html;
    rows.innerHTML = html;
    if (focusRow) {
      const row = rows.querySelector<HTMLElement>(`.kc-lrow[data-id="${CSS.escape(focusRow)}"]`);
      row?.querySelector<HTMLElement>(focusSpk ? ".kc-spk" : ".kc-lrow__open")?.focus();
    }
  }

  return {
    paint,
    setSelected(id) { if (selected !== id) { selected = id; rowsShown = ""; paint(); } },
  };
}
```

Add `.kc-visuallyHidden` to `library.css`, unless `admin-next.css` already has an equivalent (`grep -n visuallyHidden kiosk/src/frontend/admin-next/admin-next.css`):

```css
.kc-visuallyHidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
```

- [ ] **Step 5: Wire it in**

`index.ts`:
- replace `renderPlaceholder(shell.panel("library"), "library");` with `mountLibrary(ctx);`
- import `mountLibrary` from `./library.js`
- mount order: `mountRadio(ctx); mountTune(ctx); mountLibrary(ctx);`

`placeholder.ts`: narrow `CLASSIC` and the function's parameter type to `"system"` only (`Exclude<Tab, "radio" | "tune" | "library">`).

`radio.ts`, recent rows: make each row a link into the detail. Replace the row template with:

```ts
rows.map((r) => `<a class="kc-row kc-row--link" href="${hrefFor({ tab: "library", detail: { kind: "hz", hz: r.freq } })}"><span class="kc-row__name">${esc(r.alphaTag || fmtFreq(r.freq))}</span><span class="kc-row__meta">${ago(r.ts)}</span></a>`).join("")
```

Also:
- import `hrefFor` from `./route.js`
- delete the "Rows are plain text in this PR…" comment
- add to `admin-next.css`: `.kc-row--link { color: inherit; text-decoration: none; min-height: 44px; box-sizing: border-box; } .kc-row--link:hover .kc-row__name { color: var(--kc-glass-text); }`

- [ ] **Step 6: Verify**

Run: `npx vitest run test/adminNext.lane.test.ts && npm run typecheck && npm run build:frontend && curl -s -X POST localhost:8080/api/kiosk/reload`
Expected: PASS, clean, build OK.

Then capture headless at 1440×1000 and 390×844 (write inside `$HOME`, e.g. `~/kc-shots/lib-1440.png`). Copy the exact chromium command from the PR 3 plan's Task 8 (`docs/superpowers/plans/2026-09-29-admin-redesign-pr3-tune.md`), with the URL `http://localhost:8080/admin#/next/library`. Read the PNGs and check:
- the count matches `curl -s localhost:8080/api/channels | jq 'map(select(.enabled)) | length'`
- the chips show the banks from `/api/config`
- rows show a dot, name, meta and a speaker key
- nothing scrolls horizontally at 390

- [ ] **Step 7: Commit**

```bash
git add kiosk/src/frontend/admin-next kiosk/test/adminNext.lane.test.ts
git commit -m "feat(admin-next): Library tab — channel list, bank chips, suggestions strip

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Channel detail — sheet on the phone, pane on the desktop

**Files:**
- Modify (replace stub): `kiosk/src/frontend/admin-next/channelDetail.ts`
- Create: `kiosk/src/frontend/admin-next/libraryActions.ts`
- Modify: `kiosk/src/frontend/admin-next/libraryModel.ts` (+ `resolveDetail`, `detailFieldsToPatch`, `lockoutSnapshot`)
- Test: `kiosk/test/adminNext.libraryModel.test.ts`

**Interfaces:**
- Consumes: `Detail` (Task 1), `mountSheet` (Task 3), `LibCtx` (Task 4), the model (Task 2), `lockoutFreqIn` from `lib/lockout.ts`, `CTCSS_TONES`, `DCS_CODES`, `dcsAlias`.
- Produces:
  - `mountDetail(lib: LibCtx, host: HTMLElement): { show(d: Detail, o: { fromList: boolean }): void; hide(): void; paint(): void; isOpen(): boolean }`
  - `libraryModel.resolveDetail(d: Detail, data: { channels: Channel[]; cfg: Pick<Config, "discoveries"> }): Resolved`, where `type Resolved = { kind: "edit"; channel: Channel } | { kind: "add"; draft: ChannelDraft; from?: Discovery } | { kind: "gone"; message: string }`
  - `libraryModel.detailFieldsToPatch(c: Channel, next: Channel, o: { focused: string | null; dirty: ReadonlySet<string>; inflight: ReadonlySet<string> }): string[]` — the ids of fields to repaint from `next` after a poll
  - `libraryModel.lockoutSnapshot(cfg: Config, freq: number): { discoveries: Discovery[]; enabled: Map<string, boolean> }`
  - `libraryActions.lockout(lib: LibCtx, freq: number, label: string): Promise<boolean>` — confirm + write + Undo toast; `true` when locked out

- [ ] **Step 1: Write the failing tests**

Append to `test/adminNext.libraryModel.test.ts` (extend the import with `resolveDetail`, `detailFieldsToPatch`, `lockoutSnapshot`):

```ts
describe("resolveDetail", () => {
  const disc: Discovery = { id: "cc_1", freq: 462_562_500, alphaTag: "Close Call 462.5625", ts: 1 };
  const data = { channels: [A, B, C], cfg: { discoveries: [disc] } };
  it("finds a channel by id, or says it's gone", () => {
    expect(resolveDetail({ kind: "ch", id: "a" }, data)).toEqual({ kind: "edit", channel: A });
    expect(resolveDetail({ kind: "ch", id: "zz" }, data)).toEqual({ kind: "gone", message: "This channel is no longer in the library." });
  });
  it("by frequency prefers a tracked channel, else offers to add it", () => {
    const twin = ch({ id: "a2", freq: A.freq, enabled: false });
    expect(resolveDetail({ kind: "hz", hz: A.freq }, { ...data, channels: [twin, A] })).toEqual({ kind: "edit", channel: A });
    expect(resolveDetail({ kind: "hz", hz: 121_800_000 }, data)).toEqual({ kind: "add", draft: emptyDraft({ freq: 121_800_000 }) });
  });
  it("add: blank, tagged, or from a discovery that may be gone", () => {
    expect(resolveDetail({ kind: "add" }, data)).toEqual({ kind: "add", draft: emptyDraft() });
    expect(resolveDetail({ kind: "add", tag: "air" }, data)).toEqual({ kind: "add", draft: emptyDraft({ tag: "air" }) });
    expect(resolveDetail({ kind: "add", from: "cc_1" }, data)).toEqual({ kind: "add", draft: draftFromDiscovery(disc), from: disc });
    expect(resolveDetail({ kind: "add", from: "cc_x" }, data)).toEqual({
      kind: "gone", message: "That discovery was already added, dismissed or locked out." });
  });
});

describe("detailFieldsToPatch", () => {
  it("repaints only changed fields the operator isn't touching", () => {
    const next = { ...A, alphaTag: "New name", audible: false, mode: "fm" as const, priority: true };
    expect(detailFieldsToPatch(A, next, { focused: null, dirty: new Set(), inflight: new Set() }).sort())
      .toEqual(["audible", "mode", "name", "priority"]);
    expect(detailFieldsToPatch(A, next, { focused: "name", dirty: new Set(["mode"]), inflight: new Set(["audible"]) }))
      .toEqual(["priority"]);
    expect(detailFieldsToPatch(A, A, { focused: null, dirty: new Set(), inflight: new Set() })).toEqual([]);
  });
});

describe("lockoutSnapshot", () => {
  it("captures dropped discoveries and prior enabled flags at the frequency", () => {
    const cfg = { version: 1, scan: {}, audio: {}, channels: [A, { ...C, freq: A.freq }], discoveries: [{ id: "d", freq: A.freq, alphaTag: "", ts: 0 }] } as unknown as import("../src/backend/config/schema.js").Config;
    const s = lockoutSnapshot(cfg, A.freq);
    expect(s.discoveries.map((d) => d.id)).toEqual(["d"]);
    expect([...s.enabled.entries()]).toEqual([["a", true], ["c", false]]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/adminNext.libraryModel.test.ts`
Expected: FAIL — `resolveDetail` is not exported.

- [ ] **Step 3: Implement the model additions**

Append to `libraryModel.ts` (import `Detail` type from `./route.js`):

```ts
// ── Detail ────────────────────────────────────────────────────────────────────

export type Resolved =
  | { kind: "edit"; channel: Channel }
  | { kind: "add"; draft: ChannelDraft; from?: Discovery }
  | { kind: "gone"; message: string };

export function resolveDetail(d: Detail, data: { channels: Channel[]; cfg: Pick<Config, "discoveries"> }): Resolved {
  switch (d.kind) {
    case "ch": {
      const c = data.channels.find((x) => x.id === d.id);
      return c ? { kind: "edit", channel: c } : { kind: "gone", message: "This channel is no longer in the library." };
    }
    case "hz": {
      const at = data.channels.filter((x) => x.freq === d.hz);
      const c = at.find((x) => x.enabled) ?? at[0];
      return c ? { kind: "edit", channel: c } : { kind: "add", draft: emptyDraft({ freq: d.hz }) };
    }
    case "add": {
      if (d.from) {
        const disc = (data.cfg.discoveries ?? []).find((x) => x.id === d.from);
        return disc ? { kind: "add", draft: draftFromDiscovery(disc), from: disc }
          : { kind: "gone", message: "That discovery was already added, dismissed or locked out." };
      }
      return { kind: "add", draft: emptyDraft({ tag: d.tag }) };
    }
  }
}

/** Detail fields, by the id the DOM uses, and how to read each from a channel. */
export const DETAIL_FIELDS: Record<string, (c: Channel) => string> = {
  audible: (c) => String(c.audible !== false),
  priority: (c) => String(!!c.priority),
  alert: (c) => String(!!c.alert),
  archive: (c) => String(!c.enabled),
  name: (c) => c.alphaTag,
  mode: (c) => c.mode,
  freq: (c) => String(c.freq),
  tone: (c) => toneValue(c),
  tags: (c) => (c.tags ?? []).join(", "),
  site: (c) => (c.location?.lat != null ? `${c.location.lat}, ${c.location.lon}` : ""),
};

/** After a poll, which fields to repaint from `next`: those whose value
 *  changed and that the operator isn't focused on, hasn't edited unsaved,
 *  and isn't saving right now. */
export function detailFieldsToPatch(
  c: Channel, next: Channel, o: { focused: string | null; dirty: ReadonlySet<string>; inflight: ReadonlySet<string> },
): string[] {
  return Object.entries(DETAIL_FIELDS)
    .filter(([id, read]) => read(c) !== read(next) && id !== o.focused && !o.dirty.has(id) && !o.inflight.has(id))
    .map(([id]) => id);
}

/** What a lockout will remove, so Undo restores exactly that (classic
 *  lockoutFreq's snapshot): the discoveries it drops and each channel's
 *  prior enabled flag at the frequency. */
export function lockoutSnapshot(cfg: Config, freq: number): { discoveries: Discovery[]; enabled: Map<string, boolean> } {
  const enabled = new Map<string, boolean>();
  for (const c of cfg.channels) if (c.freq === freq) enabled.set(c.id, c.enabled);
  return { discoveries: (cfg.discoveries ?? []).filter((d) => d.freq === freq), enabled };
}
```

- [ ] **Step 4: Implement `libraryActions.ts`**

```ts
// Library writes that span more than one channel field: lockout (with its
// exact Undo) and discovery mutations. Every write is inside lib.run.
import { api } from "../lib/api.js";
import { lockoutFreqIn } from "../lib/lockout.js";
import { lockoutSnapshot, type Discovery } from "./libraryModel.js";
import type { LibCtx } from "./libraryStore.js";

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Confirm, lock out (archives the channel, drops discoveries, adds to the
 *  lockout list — restarts scanning when a channel is archived), offer Undo. */
export async function lockout(lib: LibCtx, freq: number, label: string): Promise<boolean> {
  const ok = await lib.dialogs.confirm({
    title: `Lock out ${label}?`,
    message: "It stops being scanned and Close Call never reports it again. The channel is archived, not deleted. Scanning restarts briefly.",
    confirmLabel: "Lock out", danger: true,
  });
  if (!ok) return false;
  let snap: ReturnType<typeof lockoutSnapshot> | null = null;
  try {
    await lib.run(async () => {
      const cfg = await api.getConfig();
      snap = lockoutSnapshot(cfg, freq);
      await api.putConfig(lockoutFreqIn(cfg, freq));
    });
  } catch (e) { lib.dialogs.toast(`Couldn't lock out ${label}: ${msg(e)}`); return false; }
  const s = snap!;
  lib.dialogs.toast(`Locked out ${label}.`, {
    undo: () => lib.run(async () => {
      const cfg = await api.getConfig();
      cfg.scan = { ...cfg.scan, lockoutHz: (cfg.scan.lockoutHz ?? []).filter((f) => f !== freq) };
      cfg.channels = cfg.channels.map((c) => (s.enabled.has(c.id) ? { ...c, enabled: s.enabled.get(c.id)! } : c));
      if (s.discoveries.length) cfg.discoveries = [...(cfg.discoveries ?? []), ...s.discoveries];
      await api.putConfig(cfg);
    }),
  });
  return true;
}

/** Remove discoveries (and optionally lock their frequencies out) in one
 *  config write — live, no restart — with an Undo that puts them back. */
export async function removeDiscoveries(lib: LibCtx, ids: ReadonlySet<string>, o: { lockout: boolean }): Promise<Discovery[]> {
  let gone: Discovery[] = [];
  await lib.run(async () => {
    const cfg = await api.getConfig();
    gone = (cfg.discoveries ?? []).filter((d) => ids.has(d.id));
    cfg.discoveries = (cfg.discoveries ?? []).filter((d) => !ids.has(d.id));
    if (o.lockout) cfg.scan.lockoutHz = [...new Set([...(cfg.scan.lockoutHz ?? []), ...gone.map((d) => d.freq)])];
    await api.putConfig(cfg);
  });
  const back = gone;
  if (back.length) {
    const what = back.length === 1 ? (back[0]!.alphaTag || "1 discovery") : `${back.length} discoveries`;
    lib.dialogs.toast(`${o.lockout ? "Locked out" : "Dismissed"} ${what}.`, {
      undo: () => lib.run(async () => {
        const cfg = await api.getConfig();
        const have = new Set((cfg.discoveries ?? []).map((d) => d.id));
        cfg.discoveries = [...(cfg.discoveries ?? []), ...back.filter((d) => !have.has(d.id))];
        if (o.lockout) {
          const f = new Set(back.map((d) => d.freq));
          cfg.scan.lockoutHz = (cfg.scan.lockoutHz ?? []).filter((x) => !f.has(x));
        }
        await api.putConfig(cfg);
      }),
    });
  }
  return back;
}
```

- [ ] **Step 5: Implement `channelDetail.ts`**

Behaviour:
- **Mount**: `mountSheet(host, { id: "kcDetail", label: "Channel" })`. The id matters: the sheet sets `html.kcDetail-pane-open`, which `library.css` uses to make room for the desktop pane.
- **Open**: `show(d, {fromList})` resolves against `lib.store.data`. With no data yet, it opens with "Loading…" and re-resolves on `paint()`. It opens `sheet.open({ title, pane: true })`. Title: the channel name, "New channel", or "Channel".
- **Close** (any way — close button, Esc, backdrop): run `closeNav()`:
  - if `fromList`, `history.back()`
  - otherwise `location.replace(lib.listHref())`

  Guard with a `navigating` flag so a route-driven `hide()` doesn't navigate again.
- **Edit mode** renders, in order:
  1. `lcd({ state: "detail", meta: lcdMeta(c), name: channelName(c), freq: fmtFreq(c.freq), silent: null, canLock: false })`
  2. keys: **Listen now** (primary) → `lib.run(() => api.monitor(c.freq, channelName(c)))`, then toast "Listening on {name}"; **Lock out** (danger) → `lockout(lib, c.freq, name)`, then close on true
  3. a group of four `switchRow`s:
     - `kcDtAudible` "Play through speaker"
     - `kcDtPriority` "Priority" (hint "Takes the speaker from other channels in its group")
     - `kcDtAlert` "Alert when heard" (hint "Flashes the kiosk and lands in Alerts")
     - `kcDtArchive` "Archive" (hint "Keep it, stop scanning it")

     Alert and Priority are disabled while archived.
  4. a group of `field()`s: Name (`kcDtName`, text), Mode (`kcDtMode`, select of `MODES`), Banks (`kcDtBanks`: `bankToggles` chips — `aria-pressed=member`; `aria-disabled="true"` and no handler when `next === null`; hint "Tap to add or remove. Range-only banks follow the frequency.")
  5. `<details class="kc-group kc-disclosure" id="kcDtMore">` "More details", containing:
     - Frequency (`kcDtFreq`, `inputmode="decimal"`, value `fmtFreq`)
     - Tone (`kcDtTone`: select None / CTCSS optgroup / DCS optgroup, exactly as classic `toneOptions`, values per `toneValue`; plus the "Heard: …" buttons from classic `toneHint` — each sets the select and commits)
     - Tags (`kcDtTags`)
     - Site (`kcDtSite`, placeholder "39.1755, -94.4861")
     - a `<dl class="kc-facts">` port of the classic `dwInfo` (band, exact Hz, location + source, power, looked up, id)
     - "Last 24 hours" analytics (below)
  6. `<p class="kc-detail__status" id="kcDtStatus" role="status" aria-live="polite">`
- **Saving** (edit mode), one channel PUT per commit, always `lib.run(() => api.updateChannel(id, patch))`:
  - switches: on `change` — archive → `{ enabled: !checked }`, audible/priority/alert → their boolean. Mark the field in `inflight`. On success, status "Saved" (clears after `SAVED_SHOW_MS` from `tune.ts` — import it). On failure, revert the checkbox and put the message in the status line.
  - text/select fields commit on `change` (blur/Enter for inputs):
    - name → `{ alphaTag: value.trim() }`
    - mode → `{ mode }`
    - freq → `parseMhz` (a throw shows in `kcDtFreq-err` with `aria-invalid="true"` and sends nothing)
    - tone → `toneFromValue`
    - tags → `parseTags`
    - site → `siteLocation(c.location, parseSite(v))` sent as `{ location }` (throw → error slot)

    A field is `dirty` from its first `input` event until its commit settles. A server error (e.g. 409 "frequency already used by …") shows in that field's error slot and the value is kept.
  - bank chip tap → `{ tags: toggle.next }`.
- **Refresh without clobbering**: `paint()` (called on every store update):
  - edit mode, channel still present: compute `detailFieldsToPatch(shownChannel, fresh, { focused, dirty, inflight })`, write only those fields (checked / value), repaint the LCD and the Banks chips and facts (none of these are editable text), then set `shownChannel = fresh`
  - channel gone: render the "gone" message with a Close key

  `focused` is the `data-field` of `document.activeElement` if it's inside the sheet.
- **Add mode** (`resolveDetail` → add):
  - same LCD, reading "New channel"
  - fields: Frequency (pre-filled when known), Name, Mode, Play through speaker (switch, from the draft), Tags; a hint line with `discoveryNote(from)` when from a discovery
  - no auto-save. The primary **Add channel** key (`kcDtAdd`) validates (`parseMhz`, `parseTags`) and then:

    ```ts
    await lib.run(async () => {
      const created = await api.addChannel(newChannelBody({ ...draft, freq, alphaTag, mode, audible, tags }));
      if (from) {
        const cfg = await api.getConfig();
        cfg.discoveries = (cfg.discoveries ?? []).filter((x) => x.id !== from.id);
        await api.putConfig(cfg);
      }
      addedId = created.id;
    });
    location.replace(hrefFor({ tab: "library", detail: { kind: "ch", id: addedId } }));
    ```

    Toast: "Added {name}." A failure (409 collision) shows in the Frequency error slot; if `addChannel` succeeded but the discovery removal failed, the toast says "Added {name}; the discovery is still listed in New."
- **Analytics** (edit mode, inside More details): register once in `mountDetail` —

  ```ts
  lib.poller.add({
    name: "analytics", everyMs: POLL_MS.analytics, tabs: ["library"],
    when: () => analyticsFreq !== null && more.open,
    run: async () => {
      const f = analyticsFreq!;
      const rows = await api.getHistory<HistRow[]>({ freq: f, since: Date.now() - 86_400_000, limit: 1000 }).catch(() => null);
      if (f === analyticsFreq) paintAnalytics(rows);
    },
  });
  ```

  - Opening "More details" calls `lib.refresh("analytics")`.
  - `paintAnalytics` renders the `signalSeries(rows, 420, 90)` summary: "{n} transmissions · {airtime} airtime" (reuse `airtime` from `radio.ts` — export it from there).
  - It renders `<svg class="kc-spark" viewBox="0 0 420 90" preserveAspectRatio="none" role="img" aria-label="Signal strength per transmission, {min} to {max} dB"><polyline points="…"/></svg>`, then the last 10 transmissions as `.kc-row`s (time · duration · dB).
  - `null` rows → `emptyState("Activity is unavailable right now.")`; no signal → "Signal strength appears after new transmissions close."

Keep the file under ~450 lines. Split the markup builders (`editHtml`, `addHtml`, `toneSelect`, `factsHtml`) as pure functions at the top of the file, and keep the wiring in `mountDetail`.

- [ ] **Step 6: Verify**

Run: `npx vitest run && npm run typecheck && npm run build:frontend && curl -s -X POST localhost:8080/api/kiosk/reload`
Expected: all PASS; clean; build OK.

Headless captures (read-only — opening the detail makes no write):
- `#/next/library/ch/<an existing id from /api/channels>` at 1440 (pane beside the list, row highlighted) and 390 (bottom sheet)
- `#/next/library/add` at 390
- `#/next/library/hz/999999999` (add mode, frequency pre-filled)

Read each PNG and check that the values match `/api/channels` for that id.

- [ ] **Step 7: Commit**

```bash
git add kiosk/src/frontend/admin-next kiosk/test/adminNext.libraryModel.test.ts
git commit -m "feat(admin-next): channel detail — sheet/pane, save as you go, add from anywhere

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Manage banks and Suggestions sheets

**Files:**
- Modify (replace stub): `kiosk/src/frontend/admin-next/librarySheets.ts`

**Interfaces:**
- Consumes: `mountSheet`, `chip`, `field`, `key`, the model's `bankRule`, `profileText`, `bankFromForm`, `profileFromForm`, `withProfile`, `bulkPatch`, `channelName`; `api.resolveDuplicates`, `api.updateChannel`, `api.getConfig`/`putConfig`.
- Produces: `mountSheets(lib: LibCtx, host: HTMLElement): { openBanks(): void; openSuggestions(): void }`

- [ ] **Step 1: Implement**

One `mountSheet(host, { id: "kcLibSheet", label: "Banks" })` serves both, re-rendered on open and on store updates while open. Every body re-render first records whether focus was inside and the focused element's `data-focus` key, and restores it after — the same rule as the list.

**Manage banks** (`openBanks`). Title "Manage banks"; a `.kc-group` per bank as `<details class="kc-bank" data-bank="{id}">`:
- **summary**: name, `bankRule(b)`, "{n} channels" (tracked members), and `profileText(b)` when set.
- **scan profile form** (`.kc-formRow`) — three `field()`s with placeholders "global":
  - Squelch open (dB over the noise floor)
  - Hang time (ms)
  - Dwell weight (×, "2 = twice as long")

  Then a **Save profile** key. Save runs `profileFromForm` (a throw → the form's error line), then:

  ```ts
  lib.run(async () => { const cfg = await api.getConfig(); cfg.banks = (cfg.banks ?? []).map((x) => x.id === b.id ? withProfile(x, p) : x); await api.putConfig(cfg); })
  ```

  Status "Saved — scanning restarted briefly." If the profile didn't change (compare `profileText` before/after), say "No change." and send nothing.
- **actions** (`.kc-bank__acts`):
  - **Make audible**, **Make silent**, **Archive all** — archive confirms first: "Archive every channel in {name}?", "Archived channels stop being scanned but keep their name and location. Scanning restarts briefly.", confirm label "Archive channels". Each is:

    ```ts
    let before = new Map<string, Pick<Channel, "enabled" | "audible">>();
    await lib.run(async () => { const cfg = await api.getConfig(); const bank = (cfg.banks ?? []).find((x) => x.id === id); if (!bank) return; const r = bulkPatch(cfg.channels, bank, patch); cfg.channels = r.channels; before = r.before; await api.putConfig(cfg); });
    if (before.size) lib.dialogs.toast(`${label} — ${before.size} channel${before.size === 1 ? "" : "s"}.`, { undo: () => lib.run(async () => { const cfg = await api.getConfig(); cfg.channels = cfg.channels.map((c) => before.has(c.id) ? { ...c, ...before.get(c.id)! } : c); await api.putConfig(cfg); }) });
    ```

    Patches: audible `{ enabled: true, audible: true }`, silent `{ enabled: true, audible: false }`, archive `{ enabled: false }`.
  - **Add channel here** — an `<a>` to `hrefFor({ tab: "library", detail: { kind: "add", tag: b.tags?.[0] } })` (omit `tag` when the bank has none); closes the sheet first.
  - **Delete bank** (danger) — confirm "Delete bank {name}?", "Its channels stay in the library and keep scanning.", then filter `cfg.banks` and `putConfig`.

Below the list, **Create a bank** (`<details class="kc-group kc-disclosure">`): Name, Band (select Any/HF/VHF/UHF/SHF), From MHz, To MHz, Tags, and a **Create bank** key. Create:
- `bankFromForm(form, \`bk_${crypto.randomUUID().slice(0, 8)}\`)` — a throw → the form's error line
- `lib.run(async () => { const cfg = await api.getConfig(); cfg.banks = [...(cfg.banks ?? []), bank]; await api.putConfig(cfg); })`
- then clear the form and toast "Created {name}."

A failed write in any of these shows the server message in that bank's (or the create form's) status line and keeps the form values.

**Suggestions** (`openSuggestions`). Title "Suggestions". Two groups, each only when non-empty:
- **Duplicates**: per set, "{MHz}" then its rows, "keeps" beside the first and "removed" beside the others (classic `renderDuplicates`). Then one danger key "Delete {n} duplicate row(s)". It confirms ("The most complete row for each frequency is kept. GMRS frequencies are never affected. This can't be undone.") and then runs `lib.run(() => api.resolveDuplicates())`, `lib.refresh("suggestions")`, and toasts "Removed {removed} duplicate row(s)."
- **Not heard in 30 days**: intro "Priority and hand-located channels are never suggested." Then rows `channelName · MHz` with an **Archive** key each: `lib.run(() => api.updateChannel(id, { enabled: false }))`, toast "Archived {name}." with undo `lib.run(() => api.updateChannel(id, { enabled: true }))`, then `lib.refresh("suggestions")`. Show the first 12, as classic did.

When both groups empty, show `emptyState("Nothing to review.")`.

- [ ] **Step 2: Verify**

Run: `npx vitest run && npm run typecheck && npm run build:frontend && curl -s -X POST localhost:8080/api/kiosk/reload`
Expected: PASS; clean; OK.

Take no screenshots of pressed actions (no writes against the live radio). The operator verifies by hand (Task 8 checklist).

- [ ] **Step 3: Commit**

```bash
git add kiosk/src/frontend/admin-next/librarySheets.ts kiosk/src/frontend/admin-next/library.css
git commit -m "feat(admin-next): Manage banks and Suggestions sheets

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: New (triage) — cards, samples, bulk, suppressed

**Files:**
- Create: `kiosk/src/frontend/admin-next/samples.ts`
- Modify (replace stub): `kiosk/src/frontend/admin-next/libraryNew.ts`
- Test: `kiosk/test/adminNext.samples.test.ts`

**Interfaces:**
- Consumes: `LibCtx`, the model (`pendingDiscoveries`, `suppressedDiscoveries`, `hitsText`, `guessLine`, `discoveryNote`), `removeDiscoveries`, `mountSheet`, `restoreDiscovery` (from `admin/admin.ts` — **move it** to `libraryModel.ts` and re-export it from `admin.ts` so `adminForm.test.ts` keeps passing: `export { restoreDiscovery } from "../admin-next/libraryModel.js";`).
- Produces:

  ```ts
  // samples.ts — at most one clip plays; every control re-derives from playingId.
  export class SamplePlayer {
    constructor(makeAudio?: (url: string) => HTMLAudioElement);
    readonly playingId: string | null;
    /** Start id's clip, or stop it if it is the one playing. */
    toggle(id: string, ts: number): void;
    stop(): void;
    /** Seconds left of the playing clip, or null. */
    remaining(full: number): number | null;
    subscribe(fn: () => void): void;
  }
  export const sampleUrl: (id: string, ts: number) => string;
  export function mountNew(lib: LibCtx, host: HTMLElement): { paint(): void }  // libraryNew.ts
  ```

- [ ] **Step 1: Write the failing test**

Create `kiosk/test/adminNext.samples.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { SamplePlayer, sampleUrl } from "../src/frontend/admin-next/samples.js";

function fakeAudio() {
  const handlers: Record<string, Array<() => void>> = {};
  const a = {
    currentTime: 0, paused: true,
    play: vi.fn(async () => { a.paused = false; }),
    pause: vi.fn(() => { a.paused = true; }),
    addEventListener: (t: string, fn: () => void) => { (handlers[t] ??= []).push(fn); },
    fire: (t: string) => { for (const fn of handlers[t] ?? []) fn(); },
  };
  return a;
}

describe("SamplePlayer", () => {
  it("plays one clip at a time and toggles off", () => {
    const made: ReturnType<typeof fakeAudio>[] = [];
    const p = new SamplePlayer((url) => { const a = fakeAudio(); made.push(a); expect(url).toContain("/sample.wav?t="); return a as unknown as HTMLAudioElement; });
    const seen: Array<string | null> = [];
    p.subscribe(() => seen.push(p.playingId));
    p.toggle("cc_1", 5);
    expect(p.playingId).toBe("cc_1");
    p.toggle("cc_2", 6);
    expect(made[0]!.pause).toHaveBeenCalled();
    expect(p.playingId).toBe("cc_2");
    p.toggle("cc_2", 6);
    expect(p.playingId).toBeNull();
    expect(seen).toEqual(["cc_1", null, "cc_2", null]);
  });
  it("stops at the end and reports time left", () => {
    let a!: ReturnType<typeof fakeAudio>;
    const p = new SamplePlayer(() => { a = fakeAudio(); return a as unknown as HTMLAudioElement; });
    p.toggle("cc_1", 1);
    a.currentTime = 4;
    expect(p.remaining(10)).toBe(6);
    a.fire("ended");
    expect(p.playingId).toBeNull();
    expect(p.remaining(10)).toBeNull();
  });
  it("cache-busts by clip timestamp and encodes the id", () => {
    expect(sampleUrl("cc 1", 42)).toBe("/api/discoveries/cc%201/sample.wav?t=42");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/adminNext.samples.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `samples.ts`**

```ts
// Recorded Close Call samples: at most one plays at a time (two discoveries
// talking over each other is the confusion this exists to remove). State is
// keyed by discovery id, not by button, so a card rebuilt by a poll mid-clip
// repaints itself from playingId instead of cutting the clip off.
export const sampleUrl = (id: string, ts: number): string =>
  `/api/discoveries/${encodeURIComponent(id)}/sample.wav?t=${ts}`; // a clip is overwritten in place: bust by its ts

export class SamplePlayer {
  private cur: { id: string; audio: HTMLAudioElement } | null = null;
  private readonly subs: Array<() => void> = [];
  constructor(private readonly makeAudio: (url: string) => HTMLAudioElement = (u) => new Audio(u)) {}

  get playingId(): string | null { return this.cur?.id ?? null; }
  subscribe(fn: () => void): void { this.subs.push(fn); }
  private notify(): void { for (const fn of this.subs) fn(); }

  stop(): void {
    if (!this.cur) return;
    this.cur.audio.pause();
    this.cur = null;
    this.notify();
  }

  toggle(id: string, ts: number): void {
    const wasThis = this.cur?.id === id;
    this.stop();
    if (wasThis) return;
    const audio = this.makeAudio(sampleUrl(id, ts));
    const end = (): void => { if (this.cur?.audio === audio) this.stop(); };
    audio.addEventListener("ended", end);
    audio.addEventListener("error", end);
    audio.addEventListener("timeupdate", () => { if (this.cur?.audio === audio) this.notify(); });
    this.cur = { id, audio };
    this.notify();
    void audio.play().catch(end);
  }

  remaining(full: number): number | null {
    return this.cur ? Math.max(0, full - this.cur.audio.currentTime) : null;
  }
}
```

Note: `timeupdate` notifies subscribers (~4 Hz), so the card's subscriber must patch only the playing card's duration text and its button face — never rebuild the list.

Run: `npx vitest run test/adminNext.samples.test.ts` — Expected: PASS.

- [ ] **Step 4: Implement `libraryNew.ts`**

**Cards**: `pendingDiscoveries(cfg)` as `.kc-card[data-id]` in `.kc-cards`, each with:
- top: `fmtFreq` (`.kc-card__freq`) and `hitsText(d)` (`.kc-card__hits`)
- `guessLine(d, { lat: cfg.display.weatherLat, lon: cfg.display.weatherLon })` — pass `undefined` when `display` is absent
- `discoveryNote(d)` when non-empty (`.kc-card__note`)
- when `samples[d.id]`: `.kc-card__sample` with a `.kc-play` button (`data-play="{id}"`, `aria-label="Play the recorded sample, {s} seconds"`, face play/stop from `player.playingId`, `data-playing` when playing) and a `<span data-left="{id}">{s.toFixed(1)} s</span>`
- actions (`.kc-card__acts`):
  - `<a class="kc-key kc-key--primary" href="${hrefFor({ tab: "library", detail: { kind: "add", from: d.id } })}">Add channel</a>`
  - Dismiss key (`data-act="dismiss"`)
  - Lock out key, danger (`data-act="lockout"`)

**Single actions** — delegated click on the cards host:
- dismiss → `removeDiscoveries(lib, new Set([id]), { lockout: false })`
- lockout → `removeDiscoveries(lib, new Set([id]), { lockout: true })`, no confirm (Undo instead — matches the classic row, which had no confirm)

Failures → toast with the message.

**Select mode**: a "Select" `kc-link` in a header row above the cards toggles `selecting`.
- In select mode each card shows a leading checkbox (`.kc-card__sel input`, `aria-label="Select {MHz}"`), and the single-action keys are hidden.
- A sticky `.kc-bulkBar` shows "{n} selected" with **Dismiss** and **Lock out** (danger) keys, disabled at 0. Both confirm, with the classic `bulkDiscoveries` copy. Lock out confirms "Lock out permanently", danger.
- Then `removeDiscoveries(lib, selectedSet, { lockout })`, clear the selection, and leave select mode.
- The selection survives polls: drop ids no longer pending.
- The "Select" link reads "Done" while selecting.

**Footer**: when suppressed > 0, a `kc-link` "Suppressed as likely noise ({n})" opens a sheet (`mountSheet(host, { id: "kcSuppSheet", label: "Suppressed as likely noise" })`). It lists rows `{MHz} {name}` · `{reason ?? "Likely repeated noise"} · {hitCount ?? "several"} hits`, each with a **Restore** key:

```ts
lib.run(async () => { const cfg = await api.getConfig(); cfg.discoveries = (cfg.discoveries ?? []).map((d) => d.id === id ? restoreDiscovery(d) : d); await api.putConfig(cfg); })
```

Toast "Restored to New."

**Empty state**: no pending discoveries.
- If `cfg.scan.closeCall === false`: `<p class="kc-empty">Close Call is off, so nothing new will arrive. <a href="${hrefFor({ tab: "tune" })}">Turn it on in Tune</a></p>`
- otherwise: "Nothing new. Close Call is listening — new frequencies land here."

**Paint discipline**:
- rebuild the cards host only when a string of the card markup (excluding play state) changes
- after any rebuild, and on every `player` notify, run `paintPlay()`: for each `[data-play]`, set face/label/`data-playing` from `player.playingId`; for the playing id, set `[data-left]` text to `player.remaining(full)`
- restore focus to the same card's same control after a rebuild, as in the list
- stop the player when the tab or view changes (`lib.shell.onRoute` → if not library/new, `player.stop()`)

- [ ] **Step 5: Verify**

Run: `npx vitest run && npm run typecheck && npm run build:frontend && curl -s -X POST localhost:8080/api/kiosk/reload`
Expected: all PASS (including `adminForm.test.ts` after the `restoreDiscovery` move); clean; OK.

Headless captures of `#/next/library/new` at 390 and 1440. Check that the count matches `curl -s localhost:8080/api/config | jq '[.discoveries[]? | select(.suppressedAt|not)] | length'` and that cards show a guess line.

- [ ] **Step 6: Commit**

```bash
git add kiosk/src/frontend/admin-next kiosk/src/frontend/admin/admin.ts kiosk/test/adminNext.samples.test.ts
git commit -m "feat(admin-next): New — discovery cards, inline samples, bulk, suppressed

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Prove it and open the PR

**Files:** none new.

- [ ] **Step 1: The full definition of done**

Run from `kiosk/`:

```bash
npm test && npm run test:native && npm run typecheck && npm run build
```

Expected: all PASS; record the test counts for the PR body.

- [ ] **Step 2: Deploy the frontend build and reload**

`curl -s -X POST localhost:8080/api/kiosk/reload`. Do not restart `kerchunk-kiosk`: this PR changes no backend code, so the running server already serves the new `dist/` static files. Confirm that with `curl -s localhost:8080/admin | grep -o 'assets/[^"]*\.js' | head -3` against `ls dist/frontend/assets` (the path may differ — check `KERCHUNK_STATIC`).

- [ ] **Step 3: Live captures (read-only)**

Headless at 1440×1000 and 390×844 (PNGs in `$HOME`) for:
- `#/next/library`
- `#/next/library/new`
- `#/next/library/ch/<id>`
- `#/next/library/add`
- `#/next` (Radio, to confirm the recent rows now render as links and nothing else moved)

Read every PNG. Check:
- values match `/api/channels` and `/api/config`
- 390 has no horizontal scroll
- the pane sits beside the list at 1440
- the triage badge in the tab bar equals the New count

Check the journal for engine restarts during capture:

```bash
journalctl -u kerchunk-kiosk --since "-10 min" | grep -ci "engine start\|warming"
```

Expected: 0.

- [ ] **Step 4: Push and open the PR**

```bash
git push -u origin feat/admin-next-library
gh pr create --title "feat(admin-next): Library tab — channels, detail, banks, suggestions, New" --body-file <body>
```

The body follows the PR 3 shape:
- **What you get**, grouped: Channels, Channel detail, Banks and suggestions, New.
- **What each save costs**:
  - single-channel edits and duplicate cleanup re-tune, no warm-up
  - bank bulk edits, bank profiles and lockout restart scanning briefly and say so
  - dismiss and restore are live
  - promote is now a re-tune, not a restart
- **Dropped per spec** — the three items in "Decisions" 2 — ask the operator to object if any is missed.
- **Knobs**: `POLL_MS.library` / `.suggestions` / `.analytics` (`admin-next/poller.ts`), `PANE_MIN_WIDTH_PX` (`admin-next/ui/sheet.ts`).
- **Verified**: counts; live captures; 0 engine restarts while browsing.
- **Needs your by-hand check on the phone** (`http://kiosk:8080/admin#/next/library`):
  - [ ] Search: type a frequency; `/` focuses search on desktop.
  - [ ] Bank chip filters; Archived chip shows archived channels.
  - [ ] Speaker key toggles a channel silent/audible with no warm-up on the wall.
  - [ ] Tap a row: the sheet (phone) / pane (desktop) opens; Back closes it on the phone.
  - [ ] Detail: rename (blur saves, "Saved"), toggle Alert, change tone — no warm-up.
  - [ ] Detail: a bad frequency shows an error and saves nothing.
  - [ ] Banks chip in detail adds/removes the channel from a tag bank.
  - [ ] Manage banks: create a bank; edit a profile (one restart); Make silent + Undo.
  - [ ] Suggestions: Review opens; Archive one + Undo.
  - [ ] New: play a sample; Dismiss + Undo; Add channel → detail pre-filled → Add → the card is gone, the channel exists (silent), **no warm-up**.
  - [ ] New: Select two, Dismiss selected, Undo.
  - [ ] Radio: tap a Recently heard row → its channel detail.
- **Deferred** (carried from PR 3): pagehide flush; countdown on tab leave; curve label overlap at the flip.
- End with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

- [ ] **Step 5: Stop and wait for the operator's by-hand OK before merging.** After the merge: `gh pr merge <n> --merge --delete-branch`, `git checkout main && git pull --ff-only && git fetch --prune`, `git branch -d feat/admin-next-library`.
