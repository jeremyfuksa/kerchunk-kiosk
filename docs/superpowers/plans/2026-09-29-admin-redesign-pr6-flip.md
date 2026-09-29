# Admin Redesign — PR 6 (the flip) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the new admin the admin. Concretely:
- `/admin` renders the Faceplate tree.
- The classic admin (`admin/admin.ts` 2,847 lines, `admin/admin.css` 1,836 lines) is deleted.
- Old bookmarks (`#/triage`, `#/channels`, `#/banks`, `#/scan`, `#/next/…`) redirect.
- `admin-next/` becomes `admin/`.
- DESIGN.md is rewritten with the admin language as the primary system.

**Architecture:** Four mechanical-but-careful steps, each keeping the build green:
1. Move the one pure module the new admin still borrows from the classic tree (`engineKnobs.ts`) into it, and fix the loudness-curve label overlap on the way (deferred "to the flip" in PR 3).
2. Flip `main.ts`, wire the legacy-hash redirect, delete the classic files, and rehome the classic tests that cover shared helpers.
3. Rename `admin-next` → `admin` everywhere: directory, `data-page`, CSS scope, font key, comments, test file names.
4. Rewrite DESIGN.md and the `.impeccable` sidecars, and record the shipped redesign in the roadmap.

**Tech Stack:**
- TypeScript ESM (`.js` import suffixes, `strict` + `noUncheckedIndexedAccess`)
- vanilla DOM, Vite
- vitest (node env)
- the `impeccable` skill (`document`) for the design sidecar

**Spec:** `docs/superpowers/specs/2026-09-28-admin-redesign-design.md`:
- §7 step 6: "the admin route renders the new tree; old `admin/admin.ts` + `admin.css` deleted (pure modules such as `engineKnobs.ts` and form helpers move into `admin-next/` or `lib/`), old hash routes redirect, `admin-next` renamed to `admin`. `docs/API.md` untouched."
- §1.2 (DESIGN.md full rewrite at the flip)
- §2 (routing: `#/triage` → `#/library/new`, `#/channels` → `#/library`, `#/scan` → `#/tune`)

## Global Constraints

- All commands run from `kiosk/`; the branch is `feat/admin-flip` in `/home/kiosk/kerchunk-kiosk`.
- Relative imports carry `.js` even from `.ts`.
- **No behaviour change in the new admin** beyond:
  - it now answers at `/admin` without `#/next`
  - legacy-hash redirects
  - the curve label position

  Every existing admin-next test keeps passing, moved or renamed but not weakened.
- **No backend or API change.** `docs/API.md` untouched. `/api/status`, `/api/logs` and `/api/weather` are untouched.
- **The appliance deadlocks on 2+ concurrent requests.** The flip removes the classic ↔ next page-swap reload hack in `main.ts`, which existed only to stop two apps polling at once. After the flip there is one app, so nothing may reintroduce a second poller.
- **The wall, dashboard, map and art are untouched**, visually and in code. Only admin files, `main.ts`, docs and tests change. Tokens layer 1 is unchanged.
- **CSS:** after the rename every admin rule is scoped by `html[data-page="admin"]` or a `kc-` class; `kc-` class names stay as they are.
- **Live system:**
  - Never restart `kerchunk-kiosk` during tasks.
  - Frontend verification is `npm run typecheck` + `npm run build:frontend` + `curl -s -X POST localhost:8080/api/kiosk/reload`.
  - The full `npm run build` runs once, in Task 5.
  - Headless PNGs go inside `$HOME` and use real time (`--timeout=45000`).
  - Never press write controls against the live radio. Don't start other backends.
- **Commits** end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. **PR body** ends with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
- **Definition of done:** `npm test`, `npm run test:native`, `npm run typecheck` and `npm run build` pass; the PR is opened from the branch. After merge: `gh pr merge <n> --merge --delete-branch`, `git checkout main && git pull --ff-only && git fetch --prune`, `git branch -d feat/admin-flip`.

## Review Focus

- **An operator's old bookmark or the kiosk's link opens the admin.** `/admin`, `/admin#/`, `#/home`, `#/triage`, `#/channels`, `#/banks`, `#/scan`, `#/system`, `#/next`, `#/next/library/ch/<id>` each land on the right tab, and the Back button doesn't bounce into a redirect loop. Pinned by the `legacyRedirect` tests (Task 2).
- **A stale deep link from the PR 3–5 era** (`#/next/library/hz/146520000`, `#/next/library/add/tag/air%20band`) keeps its detail after the redirect: encoded segments survive the prefix strip. Pinned by the redirect tests (Task 2).
- **Helpers the new admin still needs** (`lockoutFreqIn`/`unlockFreqIn`, `restoreDiscovery`) keep their tests after `adminForm.test.ts` is retired. Pinned by moving those tests (Task 2).
- **The loudness curve's labels never overlap** at the default settings or at extreme ones (limiter ceiling 0.3–1.0, hold −70…−30). Pinned by the label-box test (Task 1).
- **Nothing still imports a deleted path.** Guarded by typecheck + build + a grep gate in Tasks 2–3.

---

## File map

| File | Change |
|---|---|
| `kiosk/src/frontend/admin/engineKnobs.ts` → `kiosk/src/frontend/admin-next/engineKnobs.ts` | **Move** (Task 1); curve label fix |
| `kiosk/test/engineKnobs.test.ts` | **Modify:** import path; label-overlap test |
| `kiosk/src/frontend/admin-next/tune.ts`, `tuneFields.ts` | **Modify:** import `./engineKnobs.js` |
| `kiosk/src/frontend/main.ts` | **Modify:** one admin renderer; drop the swap-reload hack; font key |
| `kiosk/src/frontend/admin-next/route.ts` | **Modify:** `NEXT_PREFIX = ""`; `legacyRedirect` handles `#/next/…` and the classic pages |
| `kiosk/src/frontend/admin-next/index.ts` | **Modify:** apply `legacyRedirect` before the shell mounts and on `hashchange` |
| `kiosk/src/frontend/admin/admin.ts`, `admin.css` | **Delete** (Task 2) |
| `kiosk/test/adminForm.test.ts` | **Delete** after moving its shared-helper tests |
| `kiosk/test/lockout.test.ts` | **Create** (moved lockout/unlock tests) |
| `kiosk/src/frontend/admin-next/` → `kiosk/src/frontend/admin/` | **Rename** (Task 3) |
| `kiosk/test/adminNext.*.test.ts` → `kiosk/test/admin.*.test.ts` | **Rename** (Task 3) |
| `DESIGN.md`, `.impeccable/design.json`, `.impeccable/surfaces/admin.md` | **Rewrite** (Task 4) |
| `docs/ROADMAP.md`, `README.md`, `kiosk/README.md` | **Modify** (Task 4) |

---

### Task 1: Move `engineKnobs.ts` into the new tree; fix the curve label overlap

**Files:**
- Move: `kiosk/src/frontend/admin/engineKnobs.ts` → `kiosk/src/frontend/admin-next/engineKnobs.ts`
- Modify: `kiosk/src/frontend/admin-next/tune.ts`, `kiosk/src/frontend/admin-next/tuneFields.ts`, `kiosk/src/frontend/admin/admin.ts` (import path only — the classic file lives one more task), `kiosk/test/engineKnobs.test.ts`

**Interfaces:**
- Produces: `admin-next/engineKnobs.ts`, exporting everything it exported before, unchanged except `curveSvg`'s label positions.

- [ ] **Step 1: Move the file and fix the imports**

```bash
git mv kiosk/src/frontend/admin/engineKnobs.ts kiosk/src/frontend/admin-next/engineKnobs.ts
```

Then fix the imports:
- `admin-next/tune.ts` and `admin-next/tuneFields.ts`: `"../admin/engineKnobs.js"` → `"./engineKnobs.js"`
- `admin/admin.ts`: `"./engineKnobs.js"` → `"../admin-next/engineKnobs.js"`
- `test/engineKnobs.test.ts`: `"../src/frontend/admin/engineKnobs.js"` → `"../src/frontend/admin-next/engineKnobs.js"`

Check the moved file's own relative imports (it imports from `../../backend/…` and `../lib/…`; those paths stay valid because `admin/` and `admin-next/` are siblings).

Run: `npm run typecheck && npx vitest run test/engineKnobs.test.ts test/adminNext.tune.test.ts test/adminNext.tuneFields.test.ts`
Expected: clean; PASS.

- [ ] **Step 2: Write the failing label-overlap test**

Append to `kiosk/test/engineKnobs.test.ts`, inside the `describe` that holds "renders SVG with the curve…":

```ts
  it("never overlaps its labels (default and extreme settings)", () => {
    const boxes = (svg: string) => [...svg.matchAll(/<text x="([\d.]+)" y="([\d.]+)"(?: text-anchor="(\w+)")?>([^<]*)<\/text>/g)]
      .map(([, x, y, anchor, t]) => {
        const w = t!.length * 6.2; // ~0.62em at the chart's 10px label size
        const left = anchor === "end" ? Number(x) - w : anchor === "middle" ? Number(x) - w / 2 : Number(x);
        return { t: t!, left, right: left + w, top: Number(y) - 10, bottom: Number(y) };
      });
    const cases = [
      P,
      { ...P, limiterCeiling: 0.3 }, { ...P, limiterCeiling: 1 },
      { ...P, holdBelowDb: -70 }, { ...P, holdBelowDb: -30 },
      { ...P, targetDb: -3 }, { ...P, targetDb: -30 },
    ];
    for (const p of cases) {
      const b = boxes(curveSvg(p));
      for (let i = 0; i < b.length; i++) for (let j = i + 1; j < b.length; j++) {
        const [u, v] = [b[i]!, b[j]!];
        const overlap = u.left < v.right && v.left < u.right && u.top < v.bottom && v.top < u.bottom;
        expect(overlap, `${u.t} vs ${v.t} at ${JSON.stringify(p)}`).toBe(false);
      }
    }
  });
```

`P` is the params object already defined in that file. Check its name with `grep -n "const P" test/engineKnobs.test.ts` and use it. If the field names differ (`limiterCeiling`, `holdBelowDb`, `targetDb`), use the file's names.

Run: `npx vitest run test/engineKnobs.test.ts`
Expected: FAIL — "gain held vs limiter" at the default settings. Both are drawn at the top left: the hold label at `y = T + 12`, and the limiter label just above the ≈−3 dB ceiling line.

- [ ] **Step 3: Fix `curveSvg`**

Move the hold label to the bottom of the hold region, just above the axis. It still reads as the region's name, and it no longer shares the top band with the limiter label. In `admin-next/engineKnobs.ts` `curveSvg`, replace:

```ts
    `<text x="${L + 4}" y="${T + 12}">gain held</text>` +
```

with:

```ts
    // Bottom of the hold band: the limiter label owns the top-left corner
    // (the ceiling sits ~3 dB under 0 at the default 0.7), and a -30..-70 dB
    // hold region is always tall enough at the bottom.
    `<text x="${L + 4}" y="${B - 5}">gain held</text>` +
```

If the test still reports an overlap at an extreme case — for example "gain held" vs a tick label, or "target" vs "limiter" at `targetDb: -3` — fix it the same way in `curveSvg`, and keep each label beside the thing it names:
- Move "target" below its line (`sy(p.targetDb) + 12`) when it sits within 14 px of the limiter line.
- Shrink "gain held" to "held" when the hold band is narrower than the text.

Keep a comment for each rule.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/engineKnobs.test.ts && npm run typecheck && npm run build:frontend && curl -s -X POST localhost:8080/api/kiosk/reload`
Expected: PASS; clean; OK.

Capture `#/next/tune` at 1440×1000 (real time, `--timeout=45000`, PNG in `~/kc-shots/`). Read it and check that the curve's labels are all legible.

- [ ] **Step 5: Commit**

```bash
git add -A kiosk/src/frontend kiosk/test/engineKnobs.test.ts
git commit -m "refactor(admin-next): own engineKnobs; loudness-curve labels never overlap

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: The flip — `/admin` renders the new tree; classic deleted; old hashes redirect

**Files:**
- Modify: `kiosk/src/frontend/main.ts`, `kiosk/src/frontend/admin-next/route.ts`, `kiosk/src/frontend/admin-next/index.ts`, `kiosk/test/adminNext.route.test.ts`, `kiosk/test/adminNext.libraryModel.test.ts`
- Create: `kiosk/test/lockout.test.ts`
- Delete: `kiosk/src/frontend/admin/admin.ts`, `kiosk/src/frontend/admin/admin.css`, `kiosk/test/adminForm.test.ts`

**Interfaces:**
- Produces: `NEXT_PREFIX = ""`; `legacyRedirect(hash: string): string | null` redirects:
  - classic pages: `#/home` → `#/`, `#/triage` → `#/library/new`, `#/channels`/`#/banks` → `#/library`, `#/scan` → `#/tune`
  - any `#/next[/…]` → the same path without `next`

  It returns `null` for current routes (including `#/system`, `#/`, `""`).

- [ ] **Step 1: Write the failing route tests**

In `kiosk/test/adminNext.route.test.ts`:
- Update every expectation that includes `#/next`: `hrefFor({ tab: "radio" })` becomes `"#/"`, `"#/next/library/new"` becomes `"#/library/new"`, and so on.
- Update the parse inputs to the prefix-less form (`parseRoute("#/tune")` …).
- Keep one test showing the parser still ignores nothing else.
- Replace the "maps classic routes" test with:

```ts
  it("redirects classic pages and the #/next era to the current routes", () => {
    expect(legacyRedirect("#/home")).toBe("#/");
    expect(legacyRedirect("#/triage")).toBe("#/library/new");
    expect(legacyRedirect("#/channels")).toBe("#/library");
    expect(legacyRedirect("#/banks")).toBe("#/library");
    expect(legacyRedirect("#/scan")).toBe("#/tune");
    expect(legacyRedirect("#/next")).toBe("#/");
    expect(legacyRedirect("#/next/")).toBe("#/");
    expect(legacyRedirect("#/next/tune")).toBe("#/tune");
    expect(legacyRedirect("#/next/library/hz/146520000")).toBe("#/library/hz/146520000");
    expect(legacyRedirect("#/next/library/add/tag/air%20band")).toBe("#/library/add/tag/air%20band");
    expect(legacyRedirect("#/next/library/ch/ch_x%2Fy")).toBe("#/library/ch/ch_x%2Fy");
  });
  it("leaves current routes alone", () => {
    for (const h of ["", "#", "#/", "#/tune", "#/library", "#/library/new", "#/system", "#/library/ch/a"]) {
      expect(legacyRedirect(h)).toBeNull();
    }
  });
  it("redirected routes parse to the intended tab", () => {
    expect(parseRoute(legacyRedirect("#/triage")!)).toEqual({ tab: "library", sub: "new" });
    expect(parseRoute(legacyRedirect("#/next/library/hz/146520000")!)).toEqual({ tab: "library", detail: { kind: "hz", hz: 146_520_000 } });
  });
```

Run: `npx vitest run test/adminNext.route.test.ts`
Expected: FAIL.

- [ ] **Step 2: Implement the route change**

In `route.ts`:
- set `export const NEXT_PREFIX: string = "";`
- update the header comment: "the new admin answers at /admin; `#/next/…` from before the flip redirects"
- replace the `LEGACY` block and `legacyRedirect` with:

```ts
/** Classic-admin pages → the tab that does their job now. */
const LEGACY: Record<string, Route> = {
  home: { tab: "radio" },
  triage: { tab: "library", sub: "new" },
  channels: { tab: "library" },
  banks: { tab: "library" },
  scan: { tab: "tune" },
};

/** Where an old bookmark should go, or null when the hash is a current
 *  route. Two eras: the classic admin's pages, and the new admin's
 *  pre-flip home under `#/next/…` (path kept verbatim, still encoded). */
export function legacyRedirect(hash: string): string | null {
  const path = hash.replace(/^#\/?/, "");
  if (path === "next" || path.startsWith("next/")) return `#/${path.replace(/^next\/?/, "")}`;
  const to = LEGACY[path.split("/")[0] ?? ""];
  return to ? hrefFor(to) : null;
}
```

Check that `hrefFor({ tab: "radio" })` now returns `"#/"`. The join filters empty parts, giving `"#/"`. Make the tests match.

In `index.ts`, at the very top of `renderAdminNext` (before `mountShell`):

```ts
  // Old bookmarks (classic pages, the pre-flip #/next/…) land on the right
  // tab. replaceState keeps Back from bouncing into the redirect; the
  // hashchange guard is registered before the shell's own listener so a
  // typed legacy hash never renders its fallback tab first.
  const legacy = legacyRedirect(location.hash);
  if (legacy) history.replaceState(null, "", legacy);
  window.addEventListener("hashchange", (e) => {
    const to = legacyRedirect(location.hash);
    if (to) { e.stopImmediatePropagation(); location.replace(to); }
  });
```

Import `legacyRedirect` from `./route.js`.

- [ ] **Step 3: Flip `main.ts`**

- Replace the `renderAdmin` import with nothing.
- Make the admin entry `["/admin", "admin-next", renderAdminNext]` inside `RENDERERS`. The `data-page` stays `"admin-next"` until Task 3 renames it.
- Delete the `isAdminNext` selection and the whole "Crossing between the classic admin and admin-next" `hashchange` block with its comment. There is one app now, so the reload guard has nothing to guard.
- In `FONT_QUERY`, delete the `admin: "family=Inter…"` line. Keep `"admin-next": "family=Schibsted…"`; Task 3 renames the key.

The result:

```ts
const RENDERERS: Array<[string, string, (root: HTMLElement) => void]> = [
  ["/admin", "admin-next", renderAdminNext],
  ["/map", "map", renderMap],
  ["/wall", "wall", renderWall],
  ["/art", "art", renderArt],
];
const [, page, render] = RENDERERS.find(([prefix]) => location.pathname.startsWith(prefix))
  ?? ["", "dashboard", renderDashboard];
```

- [ ] **Step 4: Rehome the shared-helper tests, then delete the classic admin**

Read `kiosk/test/adminForm.test.ts`:
- Move the `lockoutFreqIn` / `unlockFreqIn` `describe` blocks verbatim into a new `kiosk/test/lockout.test.ts`, importing from `../src/frontend/lib/lockout.js`.
- Move the `restoreDiscovery` `describe` block verbatim into `kiosk/test/adminNext.libraryModel.test.ts`, importing `restoreDiscovery` from `../src/frontend/admin-next/libraryModel.js`.
- The remaining blocks test classic-only helpers (`mhzToHz`, `formToChannel`, `weatherFormToChannel`, `readStoredStringSet`) that die with `admin.ts`. Before dropping them, confirm the new admin doesn't use them: `grep -rn "mhzToHz\|formToChannel\|weatherFormToChannel\|readStoredStringSet" kiosk/src/frontend/admin-next` must print nothing. If anything prints, move that helper into `admin-next/` with its test instead of dropping it.

Then:

```bash
git rm kiosk/src/frontend/admin/admin.ts kiosk/src/frontend/admin/admin.css kiosk/test/adminForm.test.ts
```

`kiosk/src/frontend/admin/` must now be empty; remove the directory if git left it.

Update the `lib/lockout.ts` header comment: "shared by the admin (moved out of the classic admin, 2026-09-28)".

Gate:
- `grep -rn "admin/admin\|admin\.css\|renderAdmin\b" kiosk/src kiosk/test` must print nothing.
- `map.css:81-83` mentions `admin.css` in a comment. Reword it to "the admin's type scale" without the filename.

- [ ] **Step 5: Verify**

Run: `npx vitest run && npm run typecheck && npm run build:frontend && curl -s -X POST localhost:8080/api/kiosk/reload`
Expected: all PASS (the test count drops only by the deleted classic-only cases — record before/after in the report); clean; OK.

Headless captures (real time) in `~/kc-shots/`: `/admin`, `/admin#/triage`, `/admin#/next/tune`, `/admin#/system`, each at 390×844. Read them:
- `/admin` shows Radio
- `#/triage` shows Library › New
- `#/next/tune` shows Tune
- System shows System

- [ ] **Step 6: Commit**

```bash
git add -A kiosk/src/frontend kiosk/test
git commit -m "feat(admin): the flip — /admin is the Faceplate admin; classic admin removed; old hashes redirect

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Rename `admin-next` → `admin`

**Files:** every file under `kiosk/src/frontend/admin-next/` (moved), `kiosk/src/frontend/main.ts`, `kiosk/test/adminNext.*.test.ts` (renamed to `admin.*.test.ts`), and `kiosk/test/adminNext.lane.test.ts`'s directory path.

**Interfaces:**
- Produces:
  - `kiosk/src/frontend/admin/` (the new admin)
  - `renderAdmin(root)` (renamed from `renderAdminNext`)
  - `data-page="admin"`
  - `admin/admin.css` (renamed from `admin-next.css`)

- [ ] **Step 1: Move the tree and tests**

```bash
git mv kiosk/src/frontend/admin-next kiosk/src/frontend/admin
git mv kiosk/src/frontend/admin/admin-next.css kiosk/src/frontend/admin/admin.css
for f in kiosk/test/adminNext.*.test.ts; do git mv "$f" "${f/adminNext./admin.}"; done
```

- [ ] **Step 2: Rewrite references**

Use a script and review every hunk. `sed -i` on these patterns, limited to `kiosk/src/frontend` and `kiosk/test`:
- `admin-next/` → `admin/`: import paths in tests (`../src/frontend/admin-next/…`)
- `"./admin-next.css"` → `"./admin.css"` (in `index.ts`)
- `renderAdminNext` → `renderAdmin` (`index.ts`, `main.ts`)
- `html[data-page="admin-next"]` → `html[data-page="admin"]` (all admin CSS files)
- in `main.ts`: the renderer tuple's page `"admin-next"` → `"admin"`, and the `FONT_QUERY` key `"admin-next"` → `admin`
- lane test: `join(import.meta.dirname, "../src/frontend/admin-next")` → `…/admin"`

Comments that say "admin-next" become "the admin". Leave `kc-` class names, `NEXT_PREFIX` (now `""`) and route semantics alone. Rename `NEXT_PREFIX` → `ROUTE_PREFIX` only if every use is updated.

Gate:
- `grep -rn "admin-next\|adminNext\|AdminNext" kiosk/src kiosk/test` prints nothing, except commit-history-style mentions that explain the redirect ("pre-flip #/next/…") — those stay.
- `grep -rn 'data-page="admin-next"' kiosk` prints nothing.

- [ ] **Step 3: Verify**

Run: `npx vitest run && npm run typecheck && npm run build:frontend && curl -s -X POST localhost:8080/api/kiosk/reload`
Expected: the same test count as after Task 2, all passing; clean; OK.

Capture `/admin` at 1440×1000 and 390×844. Read them and check:
- the page is styled (a missed `data-page` rename renders unstyled on a white ground)
- the Schibsted font is loaded (`FONT_QUERY` key)
- the wall is untouched: capture it with `XDG_RUNTIME_DIR=/run/user/1000 WAYLAND_DISPLAY=wayland-0 grim ~/kc-shots/wall-after.png` and read it

- [ ] **Step 4: Commit**

```bash
git add -A kiosk
git commit -m "refactor(admin): rename admin-next to admin

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: DESIGN.md rewrite, design sidecar, roadmap and READMEs

**Files:**
- Rewrite: `DESIGN.md`, `.impeccable/design.json`, `.impeccable/surfaces/admin.md`
- Modify: `docs/ROADMAP.md`, `README.md` (only if its admin description is stale), `kiosk/README.md` (same)

**Interfaces:** none (documentation).

- [ ] **Step 1: Rewrite DESIGN.md (spec §1.2)**

Today DESIGN.md describes the classic admin's "Night Watch" language (amber spent on live state, tracked uppercase legends, nav rail, Now panel) as the system, with the Faceplate appended as a section. Rewrite it so that:

- **The admin language (tokens.css layer 2, `--kc-*`) is the primary system.** Cover:
  - **Overview:** the Faceplate — the admin is the scanner's front panel.
  - **Colors:** every `--kc-*` token with its role.
  - **Typography:** Schibsted Grotesk and the `--kc-t-*` scale; sentence case; tabular numerals.
  - **Shapes:** the `--kc-r-*` tokens, including `--kc-r-seg`.
  - **Elevation:** the single key shadow and the lift shadow; no borders on surfaces; `--kc-line` between rows only.
  - **Components:**
    - the LCD (the signature)
    - keys (primary / plain / danger)
    - groups
    - rows
    - switches
    - sliders with named ends
    - chips
    - the segmented control
    - sheets (bottom sheet on the phone / pane on desktop)
    - toasts with Undo
    - the status line
    - vitals with sparklines
  - **Behaviour rules the code enforces:**
    - one request on the wire
    - cost-aware saving (live / re-tune / restart, and the copy that says which)
    - the emphasis budget (sea-glass = live or the one primary action; coral = destructive; hay = attention)
- **The wall, dashboard, map and art keep a second, clearly labelled section: "Ambient displays (tokens.css layer 1)."** It holds the frozen palette, including the service and storm colours and the Night-Watch rules that still govern those surfaces (the amber live tag, the one glow, flat plates). Keep the YAML front-matter colour list for layer 1, and add a front-matter block for layer 2.
- **Retire the classic-admin narrative:** no nav rail, Now panel, tables with `table-layout: fixed`, or uppercase tracked labels as admin rules.
- **Keep the Do's and Don'ts that still apply to both:**
  - no `backdrop-filter` (thermal)
  - no coloured side borders
  - lucide-static icons only
  - four-decimal frequencies
  - 44px targets
  - contrast floors (4.5:1 text on ground/raised/key, 3:1 non-text)
  - no `var(--token, #hex)` fallbacks

  Add the admin ones:
  - sentence case
  - one primary key per screen
  - never an unlabelled restart

Take values from `kiosk/src/frontend/tokens.css`, never from memory. Every hex in DESIGN.md must appear in `tokens.css` or in `lib/serviceColor.ts`. Gate: `grep -oE "#[0-9a-fA-F]{6}" DESIGN.md | sort -u`, then check each one against those two files.

- [ ] **Step 2: Refresh the sidecars**

- Invoke the `impeccable` skill with `document` (Skill tool, skill `impeccable`, args `document`) to regenerate `.impeccable/design.json` from the new DESIGN.md.
  - If the skill can't run in this context, update `design.json` by hand.
  - Replace the classic component snippets (nav rail `#/system`, stat tile `#/triage`) with Faceplate equivalents (key, LCD, row, chip), each built from the real `kc-` markup the ui kit emits (`admin/ui/kit.ts`).
  - Keep the file valid JSON (`node -e 'JSON.parse(require("fs").readFileSync(".impeccable/design.json","utf8"))'`).
- Rewrite `.impeccable/surfaces/admin.md` for the shipped admin. Its current text describes the 2026-07-28 nav-rail/Now-panel direction. Cover:
  - scope: four tabs, Radio home
  - audience and jobs, in the spec's priority order
  - the Faceplate direction and its refusals (no dashboard cards, no borders, no all-caps)
  - `related_targets: ["kiosk/src/frontend/admin"]`, which stays correct after the rename

- [ ] **Step 3: Roadmap and READMEs**

- `docs/ROADMAP.md`: add a short entry in the style of the file's other shipped items:

  > **Admin redesign (Faceplate) — *SHIPPED 2026-09-29 (PRs #266–#271)*.** Radio-first four-tab admin (Radio · Tune · Library · System) in Kerchunk's own design language (tokens.css layer 2); Campfire removed; classic admin retired at the flip. Spec `docs/superpowers/specs/2026-09-28-admin-redesign-design.md`.

  Put it where the file lists recent shipped work. Read the top of the file for the convention.
- `README.md:55` and `kiosk/README.md:24`: the `/admin` URLs stay the same. Change the wording only if it describes the classic layout.
- `CLAUDE.md`: check that the "Where the code is" line (`admin/` (web admin from any device)) is still true. Headless screenshots of `/admin` still work, so the "Verifying changes" note needs no change. Edit only a line that became false.

- [ ] **Step 4: Verify and commit**

Run: `npx vitest run test/tokens.test.ts` (the contrast fixtures still pass — DESIGN.md is prose, but make sure no token file was touched).

```bash
git add DESIGN.md .impeccable/design.json .impeccable/surfaces/admin.md docs/ROADMAP.md README.md kiosk/README.md CLAUDE.md
git commit -m "docs: DESIGN.md leads with the admin's Faceplate language; ambient displays documented as layer 1

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Prove it and open the PR

- [ ] **Step 1: The full definition of done**

Run from `kiosk/`:

```bash
npm test && npm run test:native && npm run typecheck && npm run build
```

Expected: all PASS; record the counts.

- [ ] **Step 2: Live proof (read-only)**

- `curl -s -X POST localhost:8080/api/kiosk/reload`.
- Headless captures at 390 and 1440 of:
  - `/admin`
  - `/admin#/tune`
  - `/admin#/library`
  - `/admin#/library/new`
  - `/admin#/system`
  - one legacy hash (`/admin#/channels`)
- Grim capture of the live wall, which must look as it did before this PR.
- Bundle size: `ls -la kiosk/dist/frontend/assets/*.js kiosk/dist/frontend/assets/*.css` before and after. The classic admin's ~4,700 lines should drop out; record it.
- `journalctl -u kerchunk-kiosk --since "-10 min" | grep -ci "warming\|engine start"` → 0.

- [ ] **Step 3: Push and open the PR**

```bash
git push -u origin feat/admin-flip
gh pr create --title "feat(admin): the flip — Faceplate admin at /admin, classic admin removed" --body-file <body>
```

The body:
- **What changes:**
  - `/admin` is the new admin
  - classic removed (line counts, bundle size)
  - old bookmarks redirect (list them)
  - `admin-next/` → `admin/`
  - DESIGN.md rewritten
  - the curve labels fixed
- **Verified:**
  - counts
  - captures
  - the wall is unchanged (grim)
  - 0 restarts
- **Needs your check on the phone:**
  - [ ] `http://kiosk:8080/admin` opens Radio (no `#/next` needed); your old bookmarks land on the right tab
  - [ ] Tune: the loudness curve's labels are clean
  - [ ] The kiosk wall looks exactly as before
- **Deferred** (carried; not in this PR):
  - pagehide flush for a pending Tune countdown
  - Library stale-data note
  - `channelDetail.ts` builder split
  - `/api/config` read twice per 15 s on Library
  - volume/mute optimistic value during a watch
  - the decimal-point spacing question from PR 5, if it showed on the phone

End with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

- [ ] **Step 4: Stop and wait for the operator's OK before merging.**
