# Admin Redesign — PR 1 (Kerchunk tokens) + PR 2 (new shell + Radio) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Campfire with Kerchunk's own token file (wall/dashboard pixel-identical), then stand up the new admin shell and its Radio tab at `/admin#/next`, alongside the classic admin.

**Architecture:** PR 1 adds `src/frontend/tokens.css` with two layers — Layer 1 re-declares every Campfire property the ambient pages use at its *current resolved* value (proven by a fixture test), Layer 2 is the new `--kc-*` admin language — and removes the package. PR 2 adds `src/frontend/admin-next/`: pure, unit-tested modules (route, poller, live-state reducer, verdict) plus thin DOM modules (shell, radio, dialogs, ui kit). `main.ts` renders admin-next when the admin URL's hash starts with `#/next`.

**Tech Stack:** TypeScript (ESM, `.js` import suffixes, `strict` + `noUncheckedIndexedAccess`), vanilla DOM, Vite, vitest (node env), lucide-static icons.

**Spec:** `docs/superpowers/specs/2026-09-28-admin-redesign-design.md`

**Later plans (written after PR 2 merges, against the real `ui/` kit):** PR 3 Tune, PR 4 Library, PR 5 System, PR 6 flip.

## Global Constraints

- All commands run from `kiosk/` unless stated.
- Relative imports carry `.js` even from `.ts` (`import { x } from "./route.js"`).
- `tsconfig` is `strict` + `noUncheckedIndexedAccess` — handle `T | undefined` from indexing.
- No frontend framework; icons from `lucide-static` only (`import ico from "lucide-static/icons/<name>.svg?raw"`), never hand-rolled SVG glyphs.
- The appliance deadlocks on concurrent requests: **never** `Promise.all` over fetches; every poll/write goes through one sequential queue.
- No backend/API changes. `/api/status`, `/api/logs`, `/api/weather` shapes untouched.
- No `backdrop-filter`; no full-screen overlays on the wall.
- All admin-next CSS is scoped under `html[data-page="admin-next"]` and every class is `kc-`-prefixed (all page CSS is bundled globally; `admin.css` and `dashboard.css` both carry an unscoped `body {}` rule).
- Text tokens must clear 4.5:1 on `--kc-ground`, `--kc-raised`, `--kc-key` (enforced by test).
- Copy: sentence case, no all-caps labels, actions named by what they do.
- Definition of done per PR: `npm test`, `npm run test:native`, `npm run typecheck`, `npm run build` all pass; proven on hardware; PR from a branch; after merge `gh pr merge <n> --merge --delete-branch`, `git checkout main && git pull --ff-only && git fetch --prune`, `git branch -d <branch>`.
- Frontend-only change: no `kerchunk-kiosk` restart. After build: `curl -X POST localhost:8080/api/kiosk/reload`.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`; PR bodies end with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

---

# PART 1 — PR `chore/kerchunk-tokens`

## File map

| File | Change |
|---|---|
| `kiosk/test/fixtures/campfire-dark-resolved.json` | **Create** — resolved values of every Campfire property the frontend uses, captured from the installed (night-ramp overlay) package |
| `kiosk/scripts/capture-campfire-fixture.mjs` | **Create** — one-shot script that produced the fixture (kept for provenance) |
| `kiosk/src/frontend/tokens.css` | **Create** — Layer 1 + Layer 2 |
| `kiosk/test/tokens.test.ts` | **Create** — Layer 1 equals fixture; Layer 2 contrast |
| `kiosk/test/cssTokens.ts` | **Create** — tiny CSS custom-property parser/resolver + WCAG contrast (test helper) |
| `kiosk/src/frontend/main.ts:1-3` | **Modify** — import `./tokens.css` instead of Campfire |
| `kiosk/package.json`, `kiosk/package-lock.json` | **Modify** — drop `@jeremyfuksa/campfire` |
| `DESIGN.md` (repo root; `kiosk/DESIGN.md` is a symlink) | **Modify** — Campfire references → Kerchunk tokens; add Admin (Faceplate) section |
| `.impeccable/design.json` | **Regenerate** via `/impeccable document` |

### Task 1: Capture the baseline (before touching anything)

**Files:** none committed except the fixture + script.

- [ ] **Step 1: Branch**

```bash
cd /home/kiosk/kerchunk-kiosk && git checkout main && git pull --ff-only && git checkout -b chore/kerchunk-tokens
```

- [ ] **Step 2: Screenshot the live wall and the classic admin (baseline)**

```bash
XDG_RUNTIME_DIR=/run/user/1000 WAYLAND_DISPLAY=wayland-0 grim $HOME/shots/wall-before.png
cd $HOME && for r in "" channels scan; do n=${r:-home}; timeout 40 chromium --headless --disable-gpu --hide-scrollbars --window-size=1440,1000 --virtual-time-budget=4000 --screenshot=$HOME/shots/admin-$n-before.png "http://localhost:8080/admin#/$r" >/dev/null 2>&1; done; ls $HOME/shots/*before*
```

Expected: `wall-before.png` plus three `admin-*-before.png` files exist.

- [ ] **Step 3: Write the fixture-capture script**

Create `kiosk/scripts/capture-campfire-fixture.mjs`:

```js
// One-shot provenance script (chore/kerchunk-tokens, 2026-09-28): resolve every
// Campfire custom property the frontend references, under `.dark` (index.html
// sets <html class="dark">), from the INSTALLED package — which carries the
// night-ramp overlay (campfire#59), i.e. what the wall shows today.
// Output: test/fixtures/campfire-dark-resolved.json. Re-running after Campfire
// is uninstalled is impossible by design; the fixture is the record.
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const css = readFileSync("node_modules/@jeremyfuksa/campfire/dist/tokens.css", "utf8");
function block(sel) {
  const i = css.indexOf(`${sel} {`);
  const j = css.indexOf("}", i);
  const out = {};
  for (const m of css.slice(i, j).matchAll(/(--[\w-]+):\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}
const props = { ...block(":root"), ...block(".dark") };
const resolve = (v, depth = 0) =>
  depth > 10 ? v : v.replace(/var\((--[\w-]+)\)/g, (_, n) => resolve(props[n] ?? `var(${n})`, depth + 1));

function walk(dir, acc = []) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (/\.(css|ts)$/.test(f)) acc.push(readFileSync(p, "utf8"));
  }
  return acc;
}
const used = new Set();
for (const src of walk("src/frontend")) for (const m of src.matchAll(/var\((--[\w-]+)/g)) used.add(m[1]);

const out = {};
for (const name of [...used].sort()) if (props[name] !== undefined) out[name] = resolve(props[name]);
writeFileSync("test/fixtures/campfire-dark-resolved.json", JSON.stringify(out, null, 2) + "\n");
console.log(`${Object.keys(out).length} properties captured`);
```

- [ ] **Step 4: Run it**

Run: `cd kiosk && mkdir -p test/fixtures && node scripts/capture-campfire-fixture.mjs && cat test/fixtures/campfire-dark-resolved.json`
Expected: prints `N properties captured` (≈21). The JSON includes, among others:
`"--bg-base": "#0e0f12"`, `"--bg-subtle": "#16181d"`, `"--border-default": "#23262d"`, `"--border-strong": "#343842"`, `"--neutral-300": "#b8bcc5"`, `"--neutral-500": "#7a8090"`, `"--neutral-600": "#4d525e"`, `"--neutral-700": "#343842"`, `"--spark": "#ff6b35"`, `"--pine": "#4a7c7e"`, `"--flamingo": "#dc3a38"`, `"--golden-amber": "#ef991f"`, `"--text-primary": "#f7f8f9"`, `"--text-secondary": "#9299a5"`, `"--text-tertiary": "#7a8090"`, `"--warning-500": "#f9c574"`, `"--success-400": "#9ac35d"`, `"--danger-400": "#f17d7b"`, `"--danger-50": "#fef5f4"`, `"--danger-800": "#9c2524"`, and `--font-sans`. If `--bg-base` is NOT `#0e0f12`, stop: the overlay is missing (see memory "night-ramp-retune") and the fixture would encode the wrong colors.

- [ ] **Step 5: Commit**

```bash
git add kiosk/scripts/capture-campfire-fixture.mjs kiosk/test/fixtures/campfire-dark-resolved.json
git commit -m "chore(tokens): capture Campfire's resolved dark values as a fixture

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

### Task 2: `tokens.css` with a test that proves Layer 1 and Layer 2

**Files:**
- Create: `kiosk/test/cssTokens.ts`, `kiosk/test/tokens.test.ts`, `kiosk/src/frontend/tokens.css`

**Interfaces:**
- Produces: CSS custom properties `--kc-ground --kc-raised --kc-key --kc-line --kc-well --kc-ink --kc-dim --kc-mute --kc-glass --kc-glass-ink --kc-glass-text --kc-coral --kc-hay --kc-ok`, type scale `--kc-t-meta --kc-t-small --kc-t-body --kc-t-row --kc-t-lead --kc-t-title --kc-t-lcd-name --kc-t-lcd-freq`, radii `--kc-r-key --kc-r-group --kc-r-sheet --kc-r-pill`, `--kc-key-shadow`, `--kc-font`. PR 2 consumes all of these.

- [ ] **Step 1: Write the test helper**

Create `kiosk/test/cssTokens.ts`:

```ts
// Test helper: parse custom properties out of a CSS file and resolve var()
// chains, plus WCAG 2.x contrast. Deliberately tiny — tokens.css is flat.
import { readFileSync } from "node:fs";

export function readProps(path: string, selector = ":root"): Record<string, string> {
  const css = readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`${selector} block not found in ${path}`);
  const end = css.indexOf("}", start);
  const out: Record<string, string> = {};
  for (const m of css.slice(start, end).matchAll(/(--[\w-]+):\s*([^;]+);/g)) out[m[1]!] = m[2]!.trim();
  return out;
}

export function resolve(props: Record<string, string>, value: string, depth = 0): string {
  if (depth > 10) return value;
  return value.replace(/var\((--[\w-]+)\)/g, (_, n: string) =>
    resolve(props, props[n] ?? `var(${n})`, depth + 1));
}

function lum(hex: string): number {
  const h = hex.replace("#", "");
  const c = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
    .map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}
```

- [ ] **Step 2: Write the failing test**

Create `kiosk/test/tokens.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { readProps, resolve, contrast } from "./cssTokens.js";

const TOKENS = "src/frontend/tokens.css";
const fixture = JSON.parse(readFileSync("test/fixtures/campfire-dark-resolved.json", "utf8")) as Record<string, string>;

describe("tokens.css layer 1 (ambient pages keep their look)", () => {
  const props = readProps(TOKENS);
  for (const [name, value] of Object.entries(fixture)) {
    it(`${name} resolves to Campfire's current value`, () => {
      expect(props[name], `${name} missing from tokens.css`).toBeDefined();
      expect(resolve(props, props[name]!).toLowerCase()).toBe(value.toLowerCase());
    });
  }
});

describe("tokens.css layer 2 (admin language) contrast", () => {
  const props = readProps(TOKENS);
  const v = (n: string): string => resolve(props, props[n] ?? "");
  const grounds = ["--kc-ground", "--kc-raised", "--kc-key"];
  const text = ["--kc-ink", "--kc-dim", "--kc-mute", "--kc-glass", "--kc-coral", "--kc-hay", "--kc-ok", "--kc-glass-text"];
  for (const t of text) for (const g of grounds) {
    it(`${t} on ${g} ≥ 4.5:1`, () => {
      expect(contrast(v(t), v(g))).toBeGreaterThanOrEqual(4.5);
    });
  }
  it("--kc-glass-ink on --kc-glass ≥ 4.5:1", () => {
    expect(contrast(v("--kc-glass-ink"), v("--kc-glass"))).toBeGreaterThanOrEqual(4.5);
  });
  it("LCD text on --kc-well ≥ 4.5:1", () => {
    expect(contrast(v("--kc-glass"), v("--kc-well"))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(v("--kc-glass-text"), v("--kc-well"))).toBeGreaterThanOrEqual(4.5);
  });
});
```

- [ ] **Step 3: Run it to see it fail**

Run: `cd kiosk && npx vitest run test/tokens.test.ts`
Expected: FAIL — `ENOENT ... src/frontend/tokens.css` (or ":root block not found").

- [ ] **Step 4: Write `tokens.css`**

Create `kiosk/src/frontend/tokens.css`. Layer 1 values below are the fixture's values; **if any fixture value from Task 1 differs from what is written here, the fixture wins** — edit this file to match it (the test will tell you which).

```css
/* ── Kerchunk design tokens ──────────────────────────────────────────────
   Replaces @jeremyfuksa/campfire (removed 2026-09-28, spec
   docs/superpowers/specs/2026-09-28-admin-redesign-design.md). Two layers:

   LAYER 1 — ambient surfaces (dashboard, wall, map, art). Every property
   those pages referenced from Campfire, at the value it resolved to on the
   appliance under `.dark` (night-ramp retune, campfire#59). Frozen: the
   wall's look is proven identical by test/tokens.test.ts against
   test/fixtures/campfire-dark-resolved.json. Change these only on purpose.

   LAYER 2 — the admin language (`--kc-*`): Faceplate structure, Night desk
   palette. Measured contrast (WCAG 2.x) on ground / raised / key:
     ink 14.5 / 12.5 / 11.4   dim 7.7 / 6.7 / 6.1   mute 5.9 / 5.1 / 4.7
     glass 9.8 / 8.5 / 7.8    coral 8.3 / 7.2 / 6.5  hay 10.5 / 9.1 / 8.3
     ok 8.9 / 7.7 / 7.0       glass-ink on glass 9.2
   (test/tokens.test.ts fails any text token under 4.5:1.) */

:root {
  /* ── Layer 1: ambient surfaces ── */
  --neutral-300: #b8bcc5;
  --neutral-500: #7a8090;
  --neutral-600: #4d525e;
  --neutral-700: #343842;
  --bg-base: #0e0f12;
  --bg-subtle: #16181d;
  --border-default: #23262d;
  --border-strong: #343842;
  --text-primary: #f7f8f9;
  --text-secondary: #9299a5;
  --text-tertiary: #7a8090;
  --spark: #ff6b35;
  --pine: #4a7c7e;
  --flamingo: #dc3a38;
  --golden-amber: #ef991f;
  --warning-500: #f9c574;
  --success-400: #9ac35d;
  --danger-400: #f17d7b;
  --danger-50: #fef5f4;
  --danger-800: #9c2524;
  --font-sans: 'Space Grotesk', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;

  /* ── Layer 2: admin (Faceplate × Night desk) ── */
  --kc-ground: #15191f;      /* page ground, blue-slate */
  --kc-raised: #20262d;      /* grouped surfaces */
  --kc-key: #262d35;         /* key / button face */
  --kc-line: #232a31;        /* row separators — the only hairline */
  --kc-well: #0c1113;        /* LCD glass */
  --kc-ink: #e6e9ee;
  --kc-dim: #a4acb7;
  --kc-mute: #8d96a3;
  --kc-glass: #5fd4c3;       /* LIVE — the emphasis budget */
  --kc-glass-ink: #08231f;   /* text on glass */
  --kc-glass-text: #d9f5f0;  /* LCD channel name */
  --kc-coral: #f29b8f;       /* destructive */
  --kc-hay: #e8c37a;         /* needs attention */
  --kc-ok: #7fc79a;          /* healthy */

  --kc-font: "Schibsted Grotesk", system-ui, -apple-system, "Segoe UI", sans-serif;
  --kc-t-meta: 0.78rem;
  --kc-t-small: 0.82rem;
  --kc-t-body: 0.94rem;
  --kc-t-row: 1rem;
  --kc-t-lead: 1.25rem;
  --kc-t-title: 1.6rem;
  --kc-t-lcd-name: 1.5rem;
  --kc-t-lcd-freq: 2.6rem;

  --kc-r-key: 10px;
  --kc-r-group: 14px;
  --kc-r-sheet: 18px;
  --kc-r-pill: 999px;
  --kc-key-shadow: 0 2px 0 #0009, inset 0 1px 0 #ffffff12;
}
```

- [ ] **Step 5: Run the test**

Run: `cd kiosk && npx vitest run test/tokens.test.ts`
Expected: PASS. If a Layer 1 case fails, copy the fixture's value into `tokens.css`. If the fixture contains a property not listed above, add it to Layer 1 with the fixture value. If a contrast case fails, re-measure and lift that token (keep the header comment's ratios in sync — recompute them with `contrast()` in a scratch vitest run).

- [ ] **Step 6: Commit**

```bash
git add kiosk/src/frontend/tokens.css kiosk/test/tokens.test.ts kiosk/test/cssTokens.ts
git commit -m "feat(tokens): Kerchunk token file — frozen ambient layer + admin layer

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

### Task 3: Swap the import and remove Campfire

**Files:** Modify `kiosk/src/frontend/main.ts:1-3`, `kiosk/package.json`, `kiosk/package-lock.json`

- [ ] **Step 1: Replace the import in `main.ts`**

Replace lines 1–3:

```ts
// Campfire design tokens (the operator's own design system) — tokens only;
// the React component layer is not used (this app is framework-free).
import "@jeremyfuksa/campfire/tokens.css";
```

with:

```ts
// Kerchunk's own design tokens (replaced Campfire 2026-09-28): a frozen
// ambient layer for dashboard/wall/map/art and the admin's --kc-* language.
import "./tokens.css";
```

- [ ] **Step 2: Uninstall the package**

Run: `cd kiosk && npm uninstall @jeremyfuksa/campfire && grep -rn "campfire" package.json src/ || echo "no references"`
Expected: `no references` from package.json/src (comments in CSS that mention Campfire by name are fine; imports are not).

- [ ] **Step 3: Full verification**

Run: `cd kiosk && npm test && npm run typecheck && npm run build && npm run test:native`
Expected: all pass. `npm run build` includes the native compile (thermal cost — run once).

- [ ] **Step 4: Commit**

```bash
git add kiosk/src/frontend/main.ts kiosk/package.json kiosk/package-lock.json
git commit -m "chore: drop @jeremyfuksa/campfire for Kerchunk's tokens.css

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

### Task 4: Prove on hardware — wall and admin unchanged

- [ ] **Step 1: Reload the kiosk page (frontend-only; do NOT restart kerchunk-kiosk)**

Run: `curl -s -X POST localhost:8080/api/kiosk/reload; sleep 15`

- [ ] **Step 2: Screenshot after**

```bash
XDG_RUNTIME_DIR=/run/user/1000 WAYLAND_DISPLAY=wayland-0 grim $HOME/shots/wall-after.png
cd $HOME && for r in "" channels scan; do n=${r:-home}; timeout 40 chromium --headless --disable-gpu --hide-scrollbars --window-size=1440,1000 --virtual-time-budget=4000 --screenshot=$HOME/shots/admin-$n-after.png "http://localhost:8080/admin#/$r" >/dev/null 2>&1; done
```

- [ ] **Step 3: Compare by eye**

Read `wall-before.png` / `wall-after.png` and each admin before/after pair with the Read tool. Expected: identical palette and type (live content — channel names, map position — will differ; colors, fonts, spacing must not). If the wall page looks stale, `sudo systemctl restart kerchunk-display` and wait 15 s — do not restart the backend.

### Task 5: Rewrite `DESIGN.md` for the Kerchunk token system

**Files:** Modify `DESIGN.md` (repo root), regenerate `.impeccable/design.json`.

- [ ] **Step 1: Replace Campfire provenance lines**

In `DESIGN.md`:
- Line ~261 (Overview): replace "The system takes its palette and its ramps from Campfire, the operator's own design system, and its type from a single face." with "The ambient surfaces take their palette from Kerchunk's own token file (`kiosk/src/frontend/tokens.css`, layer 1 — frozen at the values Campfire resolved to when it was removed on 2026-09-28) and their type from a single face."
- Line ~276: replace "It is Campfire's `--spark` under the dark theme." with "It is `--spark` in `tokens.css` layer 1."
- Line ~310 (The Dark-Value Rule): replace the paragraph with "**The Frozen-Ambient Rule.** Layer 1 of `tokens.css` is a record of what the wall shows, pinned by `test/tokens.test.ts`. Consequence colours for ambient pages come from its numbered steps (`--danger-400`, `--success-400`, `--warning-500`); do not retune them as a side effect of admin work."
- Line ~369: replace "None of Campfire's `--shadow-*` ramp is used as a general elevation scale." with "There is no shadow ramp; elevation is tonal."
- Line ~438: replace with "- **Do** take ambient consequence colours from `tokens.css` layer 1's numbered steps."
- Line ~457: replace with "- **Don't** repeat a token's hex as a `var(--token, #hex)` fallback; `tokens.css` is always loaded, and a duplicated hex drifts silently."
- Run `grep -n -i campfire DESIGN.md` — remaining mentions must be historical only (e.g. "replaced Campfire").

- [ ] **Step 2: Add the admin section**

Append before `## Do's and Don'ts`:

```markdown
## Admin: Faceplate (tokens.css layer 2)

The admin is the scanner's front panel, not a dashboard. Spec:
`docs/superpowers/specs/2026-09-28-admin-redesign-design.md`.

- **Ground and surfaces:** `--kc-ground` #15191f (blue-slate), `--kc-raised`
  #20262d for grouped surfaces, `--kc-key` #262d35 for key faces. Surfaces are
  separated by tone; the only hairline is `--kc-line` between rows.
- **The LCD (signature):** a recessed `--kc-well` #0c1113 panel whose
  characters glow `--kc-glass` #5fd4c3 — glow on glass, never a lit slab. It
  shows what is live: meta line, channel name (`--kc-glass-text`), frequency
  in large tabular numerals.
- **Keys:** `--kc-key` faces with the single tactile shadow
  (`--kc-key-shadow`); the one primary key per screen is `--kc-glass` with
  `--kc-glass-ink` text. Destructive keys use `--kc-coral` text.
- **Emphasis budget:** sea-glass marks only what is live or the one primary
  action. `--kc-hay` marks needs-attention (triage badge, suggestions).
  Service colours appear only as a row dot.
- **Type:** Schibsted Grotesk (`--kc-font`), sentence case, no all-caps
  labels; scale `--kc-t-meta` 0.78rem → `--kc-t-lcd-freq` 2.6rem.
- **Shape:** keys 10px, groups 14px, sheets 18px, chips pill.
- **Contrast:** every `--kc-*` text token ≥ 4.5:1 on ground, raised and key
  (test/tokens.test.ts).
```

Also add to the frontmatter `colors:` map (keep existing keys):

```yaml
  kc-ground: "#15191f"
  kc-raised: "#20262d"
  kc-key: "#262d35"
  kc-line: "#232a31"
  kc-well: "#0c1113"
  kc-ink: "#e6e9ee"
  kc-dim: "#a4acb7"
  kc-mute: "#8d96a3"
  kc-glass: "#5fd4c3"
  kc-glass-ink: "#08231f"
  kc-glass-text: "#d9f5f0"
  kc-coral: "#f29b8f"
  kc-hay: "#e8c37a"
  kc-ok: "#7fc79a"
```

and to `typography:` an `admin-body` entry:

```yaml
  admin-body:
    fontFamily: "'Schibsted Grotesk', system-ui, sans-serif"
    fontSize: "0.94rem"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "normal"
```

- [ ] **Step 3: Refresh the impeccable sidecar**

Invoke the `impeccable` skill with args `document` to regenerate `.impeccable/design.json` from the new DESIGN.md.

- [ ] **Step 4: Commit**

```bash
git add DESIGN.md .impeccable/design.json
git commit -m "docs(design): Kerchunk token system replaces Campfire; admin Faceplate section

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

### Task 6: PR, merge, clean up

- [ ] **Step 1: Push and open the PR**

```bash
git push -u origin chore/kerchunk-tokens
gh pr create --title "chore: replace Campfire with Kerchunk's own tokens" --body "$(cat <<'EOF'
Removes @jeremyfuksa/campfire. `src/frontend/tokens.css` layer 1 freezes every Campfire property the ambient pages used at its current resolved value (fixture-tested — the wall is unchanged), layer 2 adds the admin's `--kc-*` language (contrast-tested). DESIGN.md updated. Retires the "npm ci reverts the night-ramp colors" hazard.

Spec: docs/superpowers/specs/2026-09-28-admin-redesign-design.md

Verified: npm test, test:native, typecheck, build; wall + admin before/after screenshots identical.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 2: After operator OK and green CI, merge and clean up**

```bash
gh pr merge <n> --merge --delete-branch
git checkout main && git pull --ff-only && git fetch --prune && git branch -d chore/kerchunk-tokens
```

---

# PART 2 — PR `feat/admin-next-shell-radio`

## File map

| File | Responsibility |
|---|---|
| `kiosk/src/frontend/lib/lockout.ts` | **Create** — `lockoutFreqIn` / `unlockFreqIn` moved from admin.ts (both admins use them) |
| `kiosk/src/frontend/admin/admin.ts` | **Modify** — re-export the two from `../lib/lockout.js` (tests keep importing from admin.js) |
| `kiosk/src/frontend/admin-next/route.ts` | Hash → `Route`; `hrefFor`; legacy redirects |
| `kiosk/src/frontend/admin-next/poller.ts` | Sequential single-flight poller (one request group at a time) |
| `kiosk/src/frontend/admin-next/live.ts` | Pure live-radio state: reducer over engine events, status/audio merges, LCD view model |
| `kiosk/src/frontend/admin-next/verdict.ts` | Worse-of health verdict + reason |
| `kiosk/src/frontend/admin-next/ui/icons.ts` | lucide-static imports + `ico()` |
| `kiosk/src/frontend/admin-next/ui/kit.ts` | HTML-string builders: `key`, `lcd`, `group`, `emptyState` |
| `kiosk/src/frontend/admin-next/dialogs.ts` | toast (with undo) + confirm dialog |
| `kiosk/src/frontend/admin-next/liveStore.ts` | Wires WS + status + config audio into `live.ts`; subscribe API |
| `kiosk/src/frontend/admin-next/shell.ts` | Top bar / bottom tabs / mini-player / verdict / tab panels |
| `kiosk/src/frontend/admin-next/radio.ts` | Radio tab |
| `kiosk/src/frontend/admin-next/placeholder.ts` | Interim Tune/Library/System panels linking to the classic admin |
| `kiosk/src/frontend/admin-next/index.ts` | `renderAdminNext(root)` — composes everything |
| `kiosk/src/frontend/admin-next/admin-next.css` | All styles, scoped + `kc-` prefixed |
| `kiosk/src/frontend/main.ts` | Route `/admin` + `#/next…` → admin-next; Schibsted font query |
| `kiosk/test/adminNext.route.test.ts`, `…poller.test.ts`, `…live.test.ts`, `…verdict.test.ts`, `…kit.test.ts` | Unit tests |

### Task 7: Move the lockout helpers to `lib/`

**Files:** Create `kiosk/src/frontend/lib/lockout.ts`; Modify `kiosk/src/frontend/admin/admin.ts` (the `LockoutCfg` type, `lockoutFreqIn`, `unlockFreqIn` block, ~lines 132–166)

**Interfaces:**
- Produces: `export type LockoutCfg`, `export function lockoutFreqIn<T extends LockoutCfg>(cfg: T, freq: number): T`, `export function unlockFreqIn<T extends LockoutCfg>(cfg: T, freq: number): T` from `src/frontend/lib/lockout.js`.

- [ ] **Step 1: Branch from updated main**

```bash
cd /home/kiosk/kerchunk-kiosk && git checkout main && git pull --ff-only && git checkout -b feat/admin-next-shell-radio
```

- [ ] **Step 2: Create `lib/lockout.ts`** — cut the `LockoutCfg` type and both functions *with their doc comments* verbatim out of `admin.ts` and paste them into `kiosk/src/frontend/lib/lockout.ts`, adding `export` to the type. Header comment:

```ts
// Lockout / unlock as pure config transforms, shared by the classic admin and
// admin-next (moved out of admin/admin.ts, 2026-09-28).
```

- [ ] **Step 3: Re-export from admin.ts** — where the block was, add:

```ts
import { lockoutFreqIn, unlockFreqIn } from "../lib/lockout.js";
export { lockoutFreqIn, unlockFreqIn };
```

(admin.ts uses both internally, so import then re-export.)

- [ ] **Step 4: Verify nothing moved behaviorally**

Run: `cd kiosk && npx vitest run test/adminForm.test.ts && npm run typecheck`
Expected: PASS (the lockout tests import from `admin.js` and still resolve).

- [ ] **Step 5: Commit**

```bash
git add kiosk/src/frontend/lib/lockout.ts kiosk/src/frontend/admin/admin.ts
git commit -m "refactor(admin): move lockout transforms to lib/ for reuse

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

### Task 8: Routes

**Files:** Create `kiosk/src/frontend/admin-next/route.ts`; Test `kiosk/test/adminNext.route.test.ts`

**Interfaces:**
- Produces: `type Tab = "radio" | "tune" | "library" | "system"`; `interface Route { tab: Tab; sub?: "new" }`; `const NEXT_PREFIX: string` (`"next"` now; PR 6 sets `""`); `parseRoute(hash: string): Route`; `hrefFor(r: Route): string`; `legacyRedirect(hash: string): string | null`; `TAB_TITLES: Record<Tab, string>`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { parseRoute, hrefFor, legacyRedirect } from "../src/frontend/admin-next/route.js";

describe("admin-next routes", () => {
  it("defaults to radio", () => {
    expect(parseRoute("")).toEqual({ tab: "radio" });
    expect(parseRoute("#/next")).toEqual({ tab: "radio" });
    expect(parseRoute("#/next/")).toEqual({ tab: "radio" });
    expect(parseRoute("#/next/bogus")).toEqual({ tab: "radio" });
  });
  it("parses tabs and the triage sub-route", () => {
    expect(parseRoute("#/next/tune")).toEqual({ tab: "tune" });
    expect(parseRoute("#/next/library")).toEqual({ tab: "library" });
    expect(parseRoute("#/next/library/new")).toEqual({ tab: "library", sub: "new" });
    expect(parseRoute("#/next/system")).toEqual({ tab: "system" });
  });
  it("builds hrefs under the prefix", () => {
    expect(hrefFor({ tab: "radio" })).toBe("#/next");
    expect(hrefFor({ tab: "library", sub: "new" })).toBe("#/next/library/new");
  });
  it("round-trips", () => {
    for (const r of [{ tab: "radio" }, { tab: "tune" }, { tab: "library" }, { tab: "library", sub: "new" }, { tab: "system" }] as const) {
      expect(parseRoute(hrefFor(r))).toEqual(r);
    }
  });
  it("maps classic routes to the new tabs", () => {
    expect(legacyRedirect("#/triage")).toBe("#/next/library/new");
    expect(legacyRedirect("#/channels")).toBe("#/next/library");
    expect(legacyRedirect("#/banks")).toBe("#/next/library");
    expect(legacyRedirect("#/scan")).toBe("#/next/tune");
    expect(legacyRedirect("#/system")).toBeNull();
    expect(legacyRedirect("#/next/tune")).toBeNull();
  });
});
```

- [ ] **Step 2: Run to fail** — `cd kiosk && npx vitest run test/adminNext.route.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement**

```ts
// Hash routes for admin-next. While the classic admin is still the default
// the new tree lives under #/next; the flip PR sets NEXT_PREFIX to "".
export type Tab = "radio" | "tune" | "library" | "system";
export interface Route { tab: Tab; sub?: "new" }

export const NEXT_PREFIX: string = "next";

export const TAB_TITLES: Record<Tab, string> = {
  radio: "Radio", tune: "Tune", library: "Library", system: "System",
};

function segments(hash: string): string[] {
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  if (NEXT_PREFIX && parts[0] === NEXT_PREFIX) parts.shift();
  return parts;
}

export function parseRoute(hash: string): Route {
  const [head, sub] = segments(hash);
  switch (head) {
    case "tune": return { tab: "tune" };
    case "library": return sub === "new" ? { tab: "library", sub: "new" } : { tab: "library" };
    case "system": return { tab: "system" };
    default: return { tab: "radio" };
  }
}

export function hrefFor(r: Route): string {
  const path = [NEXT_PREFIX, r.tab === "radio" ? "" : r.tab, r.sub ?? ""].filter(Boolean).join("/");
  return `#/${path}`;
}

/** Classic-admin bookmarks → the new tab. null = nothing to redirect. */
const LEGACY: Record<string, Route> = {
  triage: { tab: "library", sub: "new" },
  channels: { tab: "library" },
  banks: { tab: "library" },
  scan: { tab: "tune" },
};
export function legacyRedirect(hash: string): string | null {
  const head = hash.replace(/^#\/?/, "").split("/")[0] ?? "";
  const to = LEGACY[head];
  return to ? hrefFor(to) : null;
}
```

- [ ] **Step 4: Run to pass** — same command → PASS.

- [ ] **Step 5: Commit** — `git add kiosk/src/frontend/admin-next/route.ts kiosk/test/adminNext.route.test.ts && git commit -m "feat(admin-next): hash routes with legacy redirects" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"`

### Task 9: Sequential poller

**Files:** Create `kiosk/src/frontend/admin-next/poller.ts`; Test `kiosk/test/adminNext.poller.test.ts`

**Interfaces:**
- Consumes: `Tab` from `route.js`.
- Produces: `class Poller { constructor(opts?: { now?: () => number; hidden?: () => boolean }); add(p: PollSpec): void; tick(tab: Tab): Promise<void>; makeDue(tab: Tab): void; start(getTab: () => Tab, tickMs?: number): void }`, `interface PollSpec { name: string; run: () => Promise<void>; everyMs: number; tabs?: Tab[]; when?: () => boolean }`, `const POLL_MS` (the tuning knobs).

- [ ] **Step 1: Failing test**

```ts
import { describe, it, expect } from "vitest";
import { Poller } from "../src/frontend/admin-next/poller.js";

function harness() {
  let t = 0;
  const log: string[] = [];
  const p = new Poller({ now: () => t, hidden: () => false });
  return { p, log, advance: (ms: number) => { t += ms; } };
}

describe("Poller", () => {
  it("runs due polls in registration order, one at a time", async () => {
    const { p, log } = harness();
    let inFlight = 0; let maxInFlight = 0;
    const mk = (name: string) => async () => {
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve(); log.push(name); inFlight--;
    };
    p.add({ name: "a", run: mk("a"), everyMs: 1000 });
    p.add({ name: "b", run: mk("b"), everyMs: 1000 });
    await p.tick("radio");
    expect(log).toEqual(["a", "b"]);
    expect(maxInFlight).toBe(1);
  });
  it("respects cadence and tab filters", async () => {
    const { p, log, advance } = harness();
    p.add({ name: "every", run: async () => { log.push("every"); }, everyMs: 1000 });
    p.add({ name: "sys", run: async () => { log.push("sys"); }, everyMs: 1000, tabs: ["system"] });
    await p.tick("radio");
    advance(500); await p.tick("radio");
    advance(600); await p.tick("system");
    expect(log).toEqual(["every", "every", "sys"]);
  });
  it("makeDue forces a tab's polls to run now", async () => {
    const { p, log } = harness();
    p.add({ name: "a", run: async () => { log.push("a"); }, everyMs: 60_000 });
    await p.tick("radio");
    p.makeDue("radio");
    await p.tick("radio");
    expect(log).toEqual(["a", "a"]);
  });
  it("does not overlap ticks and swallows run errors", async () => {
    const { p, log } = harness();
    p.add({ name: "boom", run: async () => { throw new Error("x"); }, everyMs: 1 });
    p.add({ name: "ok", run: async () => { log.push("ok"); }, everyMs: 1 });
    await Promise.all([p.tick("radio"), p.tick("radio")]);
    expect(log).toEqual(["ok"]);
  });
  it("skips when hidden or when() is false", async () => {
    let hidden = true; const log: string[] = [];
    const p = new Poller({ now: () => 0, hidden: () => hidden });
    p.add({ name: "a", run: async () => { log.push("a"); }, everyMs: 1 });
    p.add({ name: "b", run: async () => { log.push("b"); }, everyMs: 1, when: () => false });
    await p.tick("radio"); hidden = false; await p.tick("radio");
    expect(log).toEqual(["a"]);
  });
});
```

- [ ] **Step 2: Run to fail** — `npx vitest run test/adminNext.poller.test.ts` → FAIL.

- [ ] **Step 3: Implement**

```ts
// The polite poller, carried over from the classic admin: this box runs near
// its thermal trip and deadlocks on concurrent requests, so polls run one at a
// time, only while the tab is visible, and only for the tab on screen.
import type { Tab } from "./route.js";

/** Tuning knobs — every admin-next poll cadence lives here. */
export const POLL_MS = {
  verdict: 30_000,    // every tab: top-bar health verdict
  audio: 15_000,      // every tab: volume/mute/remote-listening sync
  recent: 10_000,     // Radio: recently heard
  activity: 60_000,   // Radio: today's totals + by-hour
  insights: 60_000,   // Radio: channel activity (when expanded)
  alerts: 60_000,     // Radio: alert feed
} as const;

export interface PollSpec {
  name: string;
  run: () => Promise<void>;
  everyMs: number;
  tabs?: Tab[];
  when?: () => boolean;
}

export class Poller {
  private readonly polls: Array<PollSpec & { lastAt: number }> = [];
  private ticking = false;
  private readonly now: () => number;
  private readonly hidden: () => boolean;

  constructor(opts: { now?: () => number; hidden?: () => boolean } = {}) {
    this.now = opts.now ?? Date.now;
    this.hidden = opts.hidden ?? (() => document.hidden);
  }

  add(p: PollSpec): void { this.polls.push({ ...p, lastAt: -Infinity }); }

  async tick(tab: Tab): Promise<void> {
    if (this.ticking || this.hidden()) return;
    this.ticking = true;
    try {
      for (const p of this.polls) {
        if (this.hidden()) break;
        if (p.tabs && !p.tabs.includes(tab)) continue;
        if (p.when && !p.when()) continue;
        if (this.now() - p.lastAt < p.everyMs) continue;
        p.lastAt = this.now();
        // Sequential on purpose — see the header.
        await p.run().catch(() => {});
      }
    } finally { this.ticking = false; }
  }

  makeDue(tab: Tab): void {
    for (const p of this.polls) if (!p.tabs || p.tabs.includes(tab)) p.lastAt = -Infinity;
  }

  start(getTab: () => Tab, tickMs = 1_000): void {
    setInterval(() => { void this.tick(getTab()); }, tickMs);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) { this.makeDue(getTab()); void this.tick(getTab()); }
    });
  }
}
```

Note: the test's `harness()` starts `t` at 0 and the first tick must run everything — `lastAt: -Infinity` guarantees that.

- [ ] **Step 4: Run to pass**, then **Step 5: Commit** (`feat(admin-next): sequential poller`, same trailer).

### Task 10: Live-radio state (pure)

**Files:** Create `kiosk/src/frontend/admin-next/live.ts`; Test `kiosk/test/adminNext.live.test.ts`

**Interfaces:**
- Consumes: `EngineEvent` from `../../backend/engine/ScannerEngine.js`; `Channel` from `../../backend/config/schema.js`; `fmtFreq` from `../lib/format.js`.
- Produces:
  - `interface Tuned { freq: number; alphaTag: string; mode?: Channel["mode"] }`
  - `interface LiveState { mode: "scan"|"weather"|"monitor"; breakIn: boolean; monitoring: Tuned|null; nowPlaying: Tuned|null; audibleDriven: boolean; weatherChannel: Tuned|null; muted: boolean; volume: number; remoteListening: boolean; dbfs: number|null }`
  - `const initialLive: LiveState`
  - `reduceEvent(s: LiveState, ev: EngineEvent): { state: LiveState; resync: boolean; alert: boolean }`
  - `withStatus(s, st: { mode: LiveState["mode"]; monitor: Channel|null; breakIn?: boolean }): LiveState`
  - `withAudio(s, a: { volume: number; muted: boolean; remoteListening?: boolean }): LiveState`
  - `interface LcdView { state: "live"|"scanning"|"monitor"|"weather"|"breakin"; meta: string; name: string; freq: string; silent: "Muted"|"Volume 0"|null; canLock: boolean }`
  - `lcdView(s: LiveState): LcdView`

- [ ] **Step 1: Failing test**

```ts
import { describe, it, expect } from "vitest";
import { initialLive, reduceEvent, withStatus, withAudio, lcdView } from "../src/frontend/admin-next/live.js";
import { fmtFreq } from "../src/frontend/lib/format.js";
import type { Channel } from "../src/backend/config/schema.js";

const ch = (freq: number, alphaTag: string, mode: Channel["mode"] = "am"): Channel =>
  ({ id: "c1", freq, alphaTag, mode, enabled: true }) as Channel;

describe("live reducer", () => {
  it("audible drives nowPlaying and then wins over active/idle", () => {
    let s = reduceEvent(initialLive, { type: "audible", channel: ch(118_400_000, "KC Approach"), ts: 1 }).state;
    expect(s.nowPlaying).toEqual({ freq: 118_400_000, alphaTag: "KC Approach", mode: "am" });
    s = reduceEvent(s, { type: "idle", ts: 2 }).state;
    expect(s.nowPlaying?.alphaTag).toBe("KC Approach");
    s = reduceEvent(s, { type: "audible", channel: null, ts: 3 }).state;
    expect(s.nowPlaying).toBeNull();
  });
  it("active/idle drive nowPlaying until audible is seen", () => {
    let s = reduceEvent(initialLive, { type: "active", channel: ch(121_800_000, "MCI Ground"), freq: 121_800_000, ts: 1 }).state;
    expect(s.nowPlaying?.alphaTag).toBe("MCI Ground");
    s = reduceEvent(s, { type: "idle", ts: 2 }).state;
    expect(s.nowPlaying).toBeNull();
  });
  it("status resets and asks for a resync", () => {
    const a = reduceEvent(initialLive, { type: "audible", channel: ch(1, "x"), ts: 1 }).state;
    const r = reduceEvent(a, { type: "status", state: "running" as never, ts: 2 });
    expect(r.resync).toBe(true);
    expect(r.state.nowPlaying).toBeNull();
    expect(r.state.audibleDriven).toBe(false);
  });
  it("signal updates dbfs; alert flags the feed", () => {
    expect(reduceEvent(initialLive, { type: "signal", dbfs: -41, ts: 1 }).state.dbfs).toBe(-41);
    expect(reduceEvent(initialLive, { type: "alert", channel: ch(1, "x"), freq: 1, holdSeconds: 30, ts: 1 }).alert).toBe(true);
  });
  it("unrelated events leave state untouched", () => {
    const r = reduceEvent(initialLive, { type: "reload", ts: 1 });
    expect(r.state).toBe(initialLive);
    expect(r.resync).toBe(false);
  });
});

describe("lcdView", () => {
  it("scanning when nothing is open", () => {
    const v = lcdView(initialLive);
    expect(v.state).toBe("scanning");
    expect(v.name).toBe("Scanning…");
    expect(v.freq).toBe("");
    expect(v.canLock).toBe(false);
  });
  it("live channel", () => {
    const s = reduceEvent(initialLive, { type: "audible", channel: ch(118_400_000, "KC Approach"), ts: 1 }).state;
    const v = lcdView(s);
    expect(v).toMatchObject({ state: "live", name: "KC Approach", freq: fmtFreq(118_400_000), canLock: true });
    expect(v.meta).toBe("Live · AM");
  });
  it("monitor, weather and break-in", () => {
    const mon = withStatus(initialLive, { mode: "monitor", monitor: ch(462_562_500, "GMRS 1", "nfm") });
    expect(lcdView(mon)).toMatchObject({ state: "monitor", name: "GMRS 1", canLock: false });
    const wx = { ...withStatus(initialLive, { mode: "weather", monitor: null }), weatherChannel: { freq: 162_550_000, alphaTag: "NOAA KC" } };
    expect(lcdView(wx)).toMatchObject({ state: "weather", name: "NOAA KC", freq: fmtFreq(162_550_000) });
    const bi = withStatus(wx, { mode: "weather", monitor: null, breakIn: true });
    expect(lcdView(bi).state).toBe("breakin");
    expect(lcdView(bi).meta).toBe("Weather alert");
  });
  it("names alphaTag-less channels by frequency", () => {
    const s = reduceEvent(initialLive, { type: "audible", channel: ch(151_820_000, ""), ts: 1 }).state;
    expect(lcdView(s).name).toBe(fmtFreq(151_820_000));
  });
  it("reports speaker silence", () => {
    expect(lcdView(withAudio(initialLive, { volume: 40, muted: true })).silent).toBe("Muted");
    expect(lcdView(withAudio(initialLive, { volume: 0, muted: false })).silent).toBe("Volume 0");
    expect(lcdView(withAudio(initialLive, { volume: 40, muted: false })).silent).toBeNull();
  });
});
```

- [ ] **Step 2: Run to fail.**

- [ ] **Step 3: Implement**

```ts
// Live radio state for admin-next, as pure functions (the classic admin kept
// this in closure locals inside a 2,900-line function). Mirrors the classic
// Now panel's rules exactly: `audible` (speaker ownership) wins once seen;
// before that `active`/`idle` drive the display; `status` resets and resyncs.
import type { EngineEvent } from "../../backend/engine/ScannerEngine.js";
import type { Channel } from "../../backend/config/schema.js";
import { fmtFreq } from "../lib/format.js";

export interface Tuned { freq: number; alphaTag: string; mode?: Channel["mode"] }

export interface LiveState {
  mode: "scan" | "weather" | "monitor";
  breakIn: boolean;
  monitoring: Tuned | null;
  nowPlaying: Tuned | null;
  audibleDriven: boolean;
  weatherChannel: Tuned | null;
  muted: boolean;
  volume: number;
  remoteListening: boolean;
  dbfs: number | null;
}

export const initialLive: LiveState = {
  mode: "scan", breakIn: false, monitoring: null, nowPlaying: null, audibleDriven: false,
  weatherChannel: null, muted: false, volume: 100, remoteListening: false, dbfs: null,
};

const tuned = (c: Channel): Tuned => ({ freq: c.freq, alphaTag: c.alphaTag, mode: c.mode });

export function reduceEvent(s: LiveState, ev: EngineEvent): { state: LiveState; resync: boolean; alert: boolean } {
  switch (ev.type) {
    case "audible":
      return { state: { ...s, audibleDriven: true, nowPlaying: ev.channel ? tuned(ev.channel) : null }, resync: false, alert: false };
    case "active":
      return s.audibleDriven ? { state: s, resync: false, alert: false }
        : { state: { ...s, nowPlaying: { ...tuned(ev.channel), freq: ev.freq } }, resync: false, alert: false };
    case "idle":
      return s.audibleDriven ? { state: s, resync: false, alert: false }
        : { state: { ...s, nowPlaying: null }, resync: false, alert: false };
    case "status":
      return { state: { ...s, nowPlaying: null, audibleDriven: false }, resync: true, alert: false };
    case "signal":
      return { state: { ...s, dbfs: ev.dbfs }, resync: false, alert: false };
    case "alert":
      return { state: s, resync: false, alert: true };
    default:
      return { state: s, resync: false, alert: false };
  }
}

export function withStatus(s: LiveState, st: { mode: LiveState["mode"]; monitor: Channel | null; breakIn?: boolean }): LiveState {
  return {
    ...s,
    mode: st.mode,
    breakIn: st.breakIn === true,
    monitoring: st.mode === "monitor" && st.monitor ? tuned(st.monitor) : null,
  };
}

export function withAudio(s: LiveState, a: { volume: number; muted: boolean; remoteListening?: boolean }): LiveState {
  return { ...s, volume: a.volume, muted: a.muted, remoteListening: a.remoteListening ?? false };
}

export interface LcdView {
  state: "live" | "scanning" | "monitor" | "weather" | "breakin";
  meta: string;
  name: string;
  freq: string;
  silent: "Muted" | "Volume 0" | null;
  canLock: boolean;
}

const label = (t: Tuned): string => t.alphaTag || fmtFreq(t.freq);
const modeTag = (t: Tuned): string => (t.mode ? ` · ${t.mode.toUpperCase()}` : "");

export function lcdView(s: LiveState): LcdView {
  const silent = s.muted ? "Muted" : s.volume === 0 ? "Volume 0" : null;
  if (s.monitoring) {
    return { state: "monitor", meta: `Listening to one channel${modeTag(s.monitoring)}`, name: label(s.monitoring), freq: fmtFreq(s.monitoring.freq), silent, canLock: false };
  }
  if (s.mode === "weather") {
    const wx = s.weatherChannel;
    return {
      state: s.breakIn ? "breakin" : "weather",
      meta: s.breakIn ? "Weather alert" : "Weather only",
      name: wx ? label(wx) : "NOAA weather",
      freq: wx ? fmtFreq(wx.freq) : "",
      silent, canLock: false,
    };
  }
  if (s.nowPlaying) {
    return { state: "live", meta: `Live${modeTag(s.nowPlaying)}`, name: label(s.nowPlaying), freq: fmtFreq(s.nowPlaying.freq), silent, canLock: true };
  }
  return { state: "scanning", meta: "Scanning", name: "Scanning…", freq: "", silent, canLock: false };
}
```

- [ ] **Step 4: Run to pass.** If the `status` event's `state` field type rejects the test literal, keep the `as never` cast in the test (the reducer ignores the field).

- [ ] **Step 5: Commit** (`feat(admin-next): pure live-radio state + LCD view model`).

### Task 11: Verdict

**Files:** Create `kiosk/src/frontend/admin-next/verdict.ts`; Test `kiosk/test/adminNext.verdict.test.ts`

**Interfaces:**
- Produces: `type Verdict = "healthy"|"stressed"|"trouble"`; `interface SystemAlert { id: string; severity: "attention"|"severe"; title: string; message: string; help: string }`; `worseVerdict(health: { verdict: Verdict; reason: string }, alerts: SystemAlert[]): { verdict: Verdict; text: string }`.

- [ ] **Step 1: Failing test**

```ts
import { describe, it, expect } from "vitest";
import { worseVerdict } from "../src/frontend/admin-next/verdict.js";

const alert = (severity: "attention" | "severe", title: string) => ({ id: "t", severity, title, message: "", help: "" });

describe("worseVerdict", () => {
  it("passes health through when there are no alerts", () => {
    expect(worseVerdict({ verdict: "healthy", reason: "Scanning normally." }, [])).toEqual({ verdict: "healthy", text: "Scanning normally." });
  });
  it("an alert can only make it worse, and names the reason", () => {
    expect(worseVerdict({ verdict: "healthy", reason: "ok" }, [alert("attention", "Running hot")])).toEqual({ verdict: "stressed", text: "Running hot" });
    expect(worseVerdict({ verdict: "stressed", reason: "busy" }, [alert("severe", "Overheating")])).toEqual({ verdict: "trouble", text: "Overheating" });
  });
  it("never reads calmer than health", () => {
    expect(worseVerdict({ verdict: "trouble", reason: "helper down" }, [alert("attention", "x")])).toEqual({ verdict: "trouble", text: "helper down" });
  });
});
```

- [ ] **Step 2: Run to fail.** **Step 3: Implement**

```ts
// The verdict may not read calmer than the alert list: /api/system can say
// "healthy" while carrying an over-temperature alert (same rule as the
// classic admin's Now panel).
export type Verdict = "healthy" | "stressed" | "trouble";
export interface SystemAlert { id: string; severity: "attention" | "severe"; title: string; message: string; help: string }

const RANK: Record<Verdict, number> = { healthy: 0, stressed: 1, trouble: 2 };

export function worseVerdict(health: { verdict: Verdict; reason: string }, alerts: SystemAlert[]): { verdict: Verdict; text: string } {
  const fromAlerts: Verdict = alerts.some((a) => a.severity === "severe") ? "trouble" : alerts.length ? "stressed" : "healthy";
  if (RANK[fromAlerts] > RANK[health.verdict]) {
    const loudest = alerts.find((a) => a.severity === "severe") ?? alerts[0];
    return { verdict: fromAlerts, text: loudest?.title ?? health.reason };
  }
  return { verdict: health.verdict, text: health.reason };
}
```

- [ ] **Step 4: Run to pass.** **Step 5: Commit** (`feat(admin-next): health verdict`).

### Task 12: UI kit (icons + HTML builders)

**Files:** Create `kiosk/src/frontend/admin-next/ui/icons.ts`, `kiosk/src/frontend/admin-next/ui/kit.ts`; Test `kiosk/test/adminNext.kit.test.ts`

**Interfaces:**
- Produces: `ico(name: IconName, cls?: string): string` with `type IconName = "radio"|"tune"|"library"|"system"|"play"|"stop"|"skip"|"weather"|"pause"|"lockout"|"volume"|"volumeOff"|"close"|"external"|"chevron"|"trash"`; `key(o: { id?: string; label: string; icon?: IconName; variant?: "primary"|"danger"|"plain"; wide?: boolean; disabled?: boolean; title?: string }): string`; `lcd(v: LcdView, o?: { dbfs?: number|null }): string`; `group(title: string, bodyHtml: string, o?: { id?: string }): string`; `emptyState(text: string): string`. All user-visible strings pass through `esc`.

- [ ] **Step 1: Failing test**

```ts
import { describe, it, expect } from "vitest";
import { key, lcd, group } from "../src/frontend/admin-next/ui/kit.js";
import { initialLive, lcdView, reduceEvent } from "../src/frontend/admin-next/live.js";

describe("ui kit", () => {
  it("key escapes its label and carries variant + disabled", () => {
    const h = key({ id: "k", label: "<b>Lock</b>", variant: "danger", disabled: true });
    expect(h).toContain("&lt;b&gt;Lock&lt;/b&gt;");
    expect(h).toContain('class="kc-key kc-key--danger"');
    expect(h).toContain(" disabled");
    expect(h).toContain('id="k"');
  });
  it("lcd renders name, freq and state", () => {
    const s = reduceEvent(initialLive, { type: "audible", channel: { id: "a", freq: 118_400_000, alphaTag: "A&B", mode: "am", enabled: true } as never, ts: 1 }).state;
    const h = lcd(lcdView(s), { dbfs: -41 });
    expect(h).toContain('data-state="live"');
    expect(h).toContain("A&amp;B");
    expect(h).toContain("118.4000");
    expect(h).toContain("−41 dB");
  });
  it("lcd omits the MHz unit while scanning", () => {
    expect(lcd(lcdView(initialLive))).not.toContain("MHz");
  });
  it("group wraps a titled section", () => {
    expect(group("Alerts", "<p>x</p>", { id: "g" })).toMatch(/<section class="kc-group" id="g"[^>]*>\s*<h2 class="kc-group__title">Alerts<\/h2>/);
  });
});
```

- [ ] **Step 2: Run to fail.**

- [ ] **Step 3: Implement `ui/icons.ts`**

```ts
// Every glyph in admin-next comes from lucide-static (operator mandate).
import radio from "lucide-static/icons/radio.svg?raw";
import tune from "lucide-static/icons/sliders-horizontal.svg?raw";
import library from "lucide-static/icons/library.svg?raw";
import system from "lucide-static/icons/cpu.svg?raw";
import play from "lucide-static/icons/play.svg?raw";
import stop from "lucide-static/icons/square.svg?raw";
import skip from "lucide-static/icons/skip-forward.svg?raw";
import weather from "lucide-static/icons/cloud-lightning.svg?raw";
import pause from "lucide-static/icons/timer.svg?raw";
import lockout from "lucide-static/icons/ban.svg?raw";
import volume from "lucide-static/icons/volume-2.svg?raw";
import volumeOff from "lucide-static/icons/volume-x.svg?raw";
import close from "lucide-static/icons/x.svg?raw";
import external from "lucide-static/icons/arrow-up-right.svg?raw";
import chevron from "lucide-static/icons/chevron-right.svg?raw";
import trash from "lucide-static/icons/trash-2.svg?raw";

const ICONS = { radio, tune, library, system, play, stop, skip, weather, pause, lockout, volume, volumeOff, close, external, chevron, trash } as const;
export type IconName = keyof typeof ICONS;

export function ico(name: IconName, cls = "kc-ico"): string {
  return ICONS[name].replace("<svg", `<svg class="${cls}" aria-hidden="true" focusable="false"`);
}
```

Vitest runs in node and does not understand `?raw` imports by default — check `vite.config.ts`/`vitest.config.ts`: vitest uses Vite's resolver, so `?raw` works (the classic admin's tests already import admin.ts, which imports `?raw` icons). If the kit test fails on the import, that assumption is wrong: stop and report.

- [ ] **Step 4: Implement `ui/kit.ts`**

```ts
// HTML-string builders for admin-next. Strings, not nodes: callers render with
// innerHTML and wire events by id/data-attributes, like the rest of the app.
import { esc } from "../../lib/format.js";
import { ico, type IconName } from "./icons.js";
import type { LcdView } from "../live.js";

export function key(o: {
  id?: string; label: string; icon?: IconName;
  variant?: "primary" | "danger" | "plain"; wide?: boolean; disabled?: boolean; title?: string;
}): string {
  const cls = ["kc-key", o.variant && o.variant !== "plain" ? `kc-key--${o.variant}` : "", o.wide ? "kc-key--wide" : ""]
    .filter(Boolean).join(" ");
  return `<button type="button" class="${cls}"${o.id ? ` id="${o.id}"` : ""}${o.title ? ` title="${esc(o.title)}"` : ""}${o.disabled ? " disabled" : ""}>`
    + `${o.icon ? ico(o.icon) : ""}<span>${esc(o.label)}</span></button>`;
}

/** Level meter bars from dBFS (−60 → 0 dB mapped over 4 bars). */
function meter(dbfs: number | null | undefined): string {
  const lit = dbfs == null ? 0 : Math.max(0, Math.min(4, Math.round(((dbfs + 60) / 60) * 4)));
  return `<span class="kc-meter" aria-hidden="true">${[1, 2, 3, 4].map((i) => `<i${i <= lit ? ' class="on"' : ""}></i>`).join("")}</span>`;
}

export function lcd(v: LcdView, o: { dbfs?: number | null } = {}): string {
  const db = v.state === "live" && o.dbfs != null ? `<span class="kc-lcd__db">${String(Math.round(o.dbfs)).replace("-", "−")} dB</span>` : "";
  const silent = v.silent ? ` <span class="kc-lcd__silent">${v.silent}</span>` : "";
  return `<div class="kc-lcd" data-state="${v.state}" role="status" aria-live="polite">
    <div class="kc-lcd__meta"><span>${meter(v.state === "live" ? o.dbfs : null)}${esc(v.meta)}${silent}</span>${db}</div>
    <div class="kc-lcd__name">${esc(v.name)}</div>
    ${v.freq ? `<div class="kc-lcd__freq">${esc(v.freq)}<small>MHz</small></div>` : ""}
  </div>`;
}

export function group(title: string, bodyHtml: string, o: { id?: string } = {}): string {
  return `<section class="kc-group"${o.id ? ` id="${o.id}"` : ""} aria-label="${esc(title)}">
    <h2 class="kc-group__title">${esc(title)}</h2>
    ${bodyHtml}
  </section>`;
}

export function emptyState(text: string): string {
  return `<p class="kc-empty">${esc(text)}</p>`;
}
```

- [ ] **Step 5: Run to pass.** **Step 6: Commit** (`feat(admin-next): ui kit — keys, LCD, groups`).

### Task 13: Dialogs (toast + confirm)

**Files:** Create `kiosk/src/frontend/admin-next/dialogs.ts`

**Interfaces:**
- Produces: `interface Dialogs { toast(text: string, o?: { undo?: () => Promise<void>; ms?: number }): void; confirm(o: { title: string; message: string; confirmLabel: string; danger?: boolean }): Promise<boolean> }`; `mountDialogs(host: HTMLElement): Dialogs`; `const TOAST_MS = 8000`.

DOM-only; behavior is a port of the classic admin's `showToast` / `confirmAdminAction` (admin.ts ~lines 590–690), which were live-proven. No unit test (node env has no DOM); verified in Task 17.

- [ ] **Step 1: Implement**

```ts
// Toast (with undo) and confirm, ported from the classic admin's
// acknowledgement layer: keep the toast mounted until an undo settles, so a
// rejected undo (409) keeps its retry affordance.
import { esc } from "../lib/format.js";
import { ico } from "./ui/icons.js";

/** How long a toast (and its undo) stays offered. */
export const TOAST_MS = 8000;

export interface Dialogs {
  toast(text: string, o?: { undo?: () => Promise<void>; ms?: number }): void;
  confirm(o: { title: string; message: string; confirmLabel: string; danger?: boolean }): Promise<boolean>;
}

export function mountDialogs(host: HTMLElement): Dialogs {
  host.insertAdjacentHTML("beforeend", `
    <div class="kc-toastHost" role="status" aria-live="polite"></div>
    <dialog class="kc-confirm" aria-labelledby="kcConfirmTitle" aria-describedby="kcConfirmMsg">
      <form method="dialog">
        <h2 id="kcConfirmTitle"></h2>
        <p id="kcConfirmMsg"></p>
        <div class="kc-confirm__actions">
          <button class="kc-key" value="cancel">Cancel</button>
          <button class="kc-key" id="kcConfirmGo" value="confirm"></button>
        </div>
      </form>
    </dialog>`);
  const toastHost = host.querySelector<HTMLElement>(".kc-toastHost")!;
  const dlg = host.querySelector<HTMLDialogElement>(".kc-confirm")!;
  const go = dlg.querySelector<HTMLButtonElement>("#kcConfirmGo")!;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function close(): void {
    if (timer !== undefined) { clearTimeout(timer); timer = undefined; }
    toastHost.innerHTML = "";
  }

  return {
    toast(text, o = {}) {
      close();
      toastHost.innerHTML = `<div class="kc-toast"><span class="kc-toast__text">${esc(text)}</span>${
        o.undo ? `<button type="button" class="kc-toast__undo">Undo</button>` : ""
      }<button type="button" class="kc-toast__close" aria-label="Dismiss">${ico("close")}</button></div>`;
      toastHost.querySelector(".kc-toast__close")!.addEventListener("click", close);
      const undo = o.undo;
      if (undo) {
        const b = toastHost.querySelector<HTMLButtonElement>(".kc-toast__undo")!;
        b.addEventListener("click", async () => {
          if (timer !== undefined) { clearTimeout(timer); timer = undefined; }
          b.disabled = true; b.textContent = "Undoing…";
          try { await undo(); close(); this.toast("Undone."); }
          catch (e) {
            b.disabled = false; b.textContent = "Undo";
            const line = toastHost.querySelector<HTMLElement>(".kc-toast__text");
            if (line) line.textContent = (e as Error).message;
            timer = setTimeout(close, o.ms ?? TOAST_MS);
          }
        });
      }
      timer = setTimeout(close, o.ms ?? TOAST_MS);
    },
    confirm(o) {
      dlg.querySelector("#kcConfirmTitle")!.textContent = o.title;
      dlg.querySelector("#kcConfirmMsg")!.textContent = o.message;
      go.textContent = o.confirmLabel;
      go.className = `kc-key ${o.danger ? "kc-key--danger" : "kc-key--primary"}`;
      dlg.returnValue = "cancel";
      dlg.showModal();
      return new Promise((resolve) => {
        dlg.addEventListener("close", () => resolve(dlg.returnValue === "confirm"), { once: true });
      });
    },
  };
}
```

- [ ] **Step 2: Typecheck** — `cd kiosk && npm run typecheck` → clean.

- [ ] **Step 3: Commit** (`feat(admin-next): toast + confirm dialogs`).

### Task 14: Live store (WS + status + audio)

**Files:** Create `kiosk/src/frontend/admin-next/liveStore.ts`

**Interfaces:**
- Consumes: `reduceEvent`, `withStatus`, `withAudio`, `initialLive`, `LiveState` (Task 10); `ReconnectingWs` (`../lib/wsClient.js`); `api` (`../lib/api.js`).
- Produces: `class LiveStore { state: LiveState; readonly streaming: boolean; subscribe(fn: (s: LiveState) => void): () => void; onAlert(fn: () => void): void; connect(): void; syncStatus(): Promise<void>; syncAudio(): Promise<void>; loadWeatherChannel(): Promise<void>; toggleStream(): void; set(patch: Partial<LiveState>): void }`. The in-browser stream lives here (not in radio.ts) so the Radio key and the mini-player's Listen key share one `<audio>`.

- [ ] **Step 1: Implement**

```ts
// Owns the live radio state for admin-next: one WebSocket (the same feed the
// dashboard uses; the hub replays the current audible channel on connect),
// plus /api/status and the audio slice of /api/config, merged through the
// pure reducers in live.ts. Every consumer (LCD, keys, mini-player) renders
// from `state` via subscribe — one source, no drift between them.
import { api } from "../lib/api.js";
import { ReconnectingWs } from "../lib/wsClient.js";
import { initialLive, reduceEvent, withAudio, withStatus, type LiveState } from "./live.js";

export class LiveStore {
  state: LiveState = initialLive;
  private readonly subs = new Set<(s: LiveState) => void>();
  private readonly alertSubs = new Set<() => void>();

  subscribe(fn: (s: LiveState) => void): () => void {
    this.subs.add(fn); fn(this.state);
    return () => this.subs.delete(fn);
  }
  onAlert(fn: () => void): void { this.alertSubs.add(fn); }

  set(patch: Partial<LiveState>): void {
    this.state = { ...this.state, ...patch };
    for (const fn of this.subs) fn(this.state);
  }

  connect(): void {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    new ReconnectingWs(`${proto}://${location.host}/ws`, (ev) => {
      const r = reduceEvent(this.state, ev);
      if (r.state !== this.state) this.set(r.state);
      if (r.resync) void this.syncStatus();
      if (r.alert) for (const fn of this.alertSubs) fn();
    }).connect();
  }

  async syncStatus(): Promise<void> {
    try { this.set(withStatus(this.state, await api.getStatus())); } catch { /* transient */ }
  }

  async syncAudio(): Promise<void> {
    try { this.set(withAudio(this.state, (await api.getConfig()).audio)); } catch { /* transient */ }
  }

  // In-browser listening: one <audio> on the endless-WAV stream, recreated per
  // press (reusing a stalled element resumes seconds in the past). Shared by
  // the Radio key and the mini-player.
  private stream: HTMLAudioElement | null = null;
  get streaming(): boolean { return this.stream !== null; }
  toggleStream(): void {
    if (this.stream) { this.stream.pause(); this.stream.src = ""; this.stream = null; }
    else if (this.state.remoteListening) {
      const a = new Audio(`/api/stream.wav?t=${Date.now()}`);
      this.stream = a;
      void a.play().catch(() => { if (this.stream === a) { this.stream = null; this.set({}); } });
    }
    this.set({});
  }

  async loadWeatherChannel(): Promise<void> {
    try {
      const { weatherChannel: w } = await api.getWeatherChannel();
      this.set({ weatherChannel: w ? { freq: w.freq, alphaTag: w.alphaTag, mode: w.mode } : null });
    } catch { /* transient */ }
  }
}
```

- [ ] **Step 2: Typecheck** → clean. **Step 3: Commit** (`feat(admin-next): live store`).

### Task 15: Shell, placeholders, CSS, and the `#/next` mount

**Files:** Create `admin-next/shell.ts`, `admin-next/placeholder.ts`, `admin-next/admin-next.css`, `admin-next/index.ts`; Modify `kiosk/src/frontend/main.ts`

**Interfaces:**
- Consumes: `parseRoute`, `hrefFor`, `TAB_TITLES`, `Tab`, `Route` (Task 8); `Poller`, `POLL_MS` (Task 9); `lcdView` (Task 10); `worseVerdict`, `SystemAlert`, `Verdict` (Task 11); `ico`, `key` (Task 12); `mountDialogs`, `Dialogs` (Task 13); `LiveStore` (Task 14).
- Produces: `interface Shell { panel(tab: Tab): HTMLElement; route(): Route; onRoute(fn: (r: Route) => void): void; setVerdict(v: Verdict, text: string): void; setTriageCount(n: number): void }`; `mountShell(root: HTMLElement, live: LiveStore): Shell`; `renderAdminNext(root: HTMLElement): void`; `interface Ctx { shell: Shell; live: LiveStore; poller: Poller; dialogs: Dialogs }`.

- [ ] **Step 1: `shell.ts`**

```ts
// admin-next chrome: wordmark, four tabs (top bar ≥900px, bottom bar below),
// health verdict, and the mini-player that follows you off the Radio tab.
import { esc } from "../lib/format.js";
import { api } from "../lib/api.js";
import { ico } from "./ui/icons.js";
import { hrefFor, parseRoute, TAB_TITLES, type Route, type Tab } from "./route.js";
import { lcdView } from "./live.js";
import type { LiveStore } from "./liveStore.js";
import type { Verdict } from "./verdict.js";

export interface Shell {
  panel(tab: Tab): HTMLElement;
  route(): Route;
  onRoute(fn: (r: Route) => void): void;
  setVerdict(v: Verdict, text: string): void;
  setTriageCount(n: number): void;
}

const TABS: Tab[] = ["radio", "tune", "library", "system"];

export function mountShell(root: HTMLElement, live: LiveStore): Shell {
  const tabLink = (t: Tab): string =>
    `<a class="kc-tab" data-tab="${t}" href="${hrefFor({ tab: t })}">${ico(t)}<span>${TAB_TITLES[t]}</span>${
      t === "library" ? `<b class="kc-badge kc-triage" hidden></b>` : ""}</a>`;
  root.innerHTML = `
    <div class="kc-app">
      <button type="button" class="kc-skipLink">Skip to content</button>
      <header class="kc-top">
        <a class="kc-brand" href="${hrefFor({ tab: "radio" })}">Kerchunk</a>
        <nav class="kc-tabs kc-tabs--top" aria-label="Sections">${TABS.map(tabLink).join("")}</nav>
        <div class="kc-mini" id="kcMini" hidden></div>
        <a class="kc-verdict" id="kcVerdict" href="${hrefFor({ tab: "system" })}"><i></i><span>Checking…</span></a>
        <span class="kc-top__links">
          <a href="/" target="_blank" rel="noopener">Kiosk ${ico("external")}</a>
          <a href="/map" target="_blank" rel="noopener">Map ${ico("external")}</a>
        </span>
      </header>
      <main class="kc-main" id="kcMain" tabindex="-1">
        ${TABS.map((t) => `<section class="kc-panel" data-panel="${t}" aria-label="${TAB_TITLES[t]}" hidden></section>`).join("")}
      </main>
      <nav class="kc-tabs kc-tabs--bottom" aria-label="Sections">${TABS.map(tabLink).join("")}</nav>
    </div>`;

  const routeSubs: Array<(r: Route) => void> = [];
  const mini = root.querySelector<HTMLElement>("#kcMini")!;
  let current = parseRoute(location.hash);

  function applyRoute(): void {
    current = parseRoute(location.hash);
    document.title = `${TAB_TITLES[current.tab]} · Kerchunk`;
    root.querySelectorAll<HTMLElement>(".kc-panel").forEach((p) => { p.hidden = p.dataset.panel !== current.tab; });
    root.querySelectorAll<HTMLAnchorElement>(".kc-tab").forEach((a) => {
      if (a.dataset.tab === current.tab) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
    });
    paintMini();
    for (const fn of routeSubs) fn(current);
  }

  function paintMini(): void {
    // Radio IS the player — no mini-player there.
    mini.hidden = current.tab === "radio";
    if (mini.hidden) return;
    const v = lcdView(live.state);
    mini.innerHTML = `<a class="kc-mini__open" href="${hrefFor({ tab: "radio" })}" aria-label="Open radio">
        <span class="kc-mini__name">${esc(v.name)}</span>${v.freq ? `<span class="kc-mini__freq">${esc(v.freq)}</span>` : ""}</a>
      <button type="button" class="kc-mini__key" data-act="skip" aria-label="Skip transmission">${ico("skip")}</button>
      <button type="button" class="kc-mini__key" data-act="listen" aria-label="${live.streaming ? "Stop listening" : "Listen here"}"${
        live.state.remoteListening || live.streaming ? "" : " disabled"}>${ico(live.streaming ? "stop" : "play")}</button>`;
    mini.querySelector('[data-act="skip"]')!.addEventListener("click", () => { void api.skip(); });
    mini.querySelector('[data-act="listen"]')!.addEventListener("click", () => live.toggleStream());
  }
  live.subscribe(paintMini);

  // A fragment href would change location.hash in a hash-routed app — move
  // focus directly instead (same fix as the classic admin).
  root.querySelector<HTMLButtonElement>(".kc-skipLink")!.addEventListener("click", () =>
    root.querySelector<HTMLElement>("#kcMain")!.focus());

  window.addEventListener("hashchange", applyRoute);
  applyRoute();

  return {
    panel: (t) => root.querySelector<HTMLElement>(`.kc-panel[data-panel="${t}"]`)!,
    route: () => current,
    onRoute: (fn) => { routeSubs.push(fn); },
    setVerdict(v, text) {
      const el = root.querySelector<HTMLElement>("#kcVerdict")!;
      el.dataset.verdict = v;
      el.querySelector("span")!.textContent = text;
    },
    setTriageCount(n) {
      root.querySelectorAll<HTMLElement>(".kc-triage").forEach((b) => {
        b.hidden = n === 0; b.textContent = String(n);
        b.setAttribute("aria-label", `${n} to review`);
      });
    },
  };
}
```

The badge appears in both navs (top + bottom), so it is a class (`.kc-triage`), not an id.

- [ ] **Step 2: `placeholder.ts`**

```ts
// Interim panels for tabs not rebuilt yet (PRs 3–5 replace these). Each links
// to the working classic-admin page for the same job.
import type { Tab } from "./route.js";

const CLASSIC: Record<Exclude<Tab, "radio">, { href: string; what: string }> = {
  tune: { href: "/admin#/scan", what: "Settings" },
  library: { href: "/admin#/channels", what: "Channels and Triage" },
  system: { href: "/admin#/system", what: "System" },
};

export function renderPlaceholder(el: HTMLElement, tab: Exclude<Tab, "radio">): void {
  const c = CLASSIC[tab];
  el.innerHTML = `<div class="kc-placeholder">
    <p>This tab is being rebuilt. ${c.what} still works in the classic admin.</p>
    <a class="kc-key kc-key--primary" href="${c.href}">Open classic ${c.what}</a>
  </div>`;
}
```

The anchor reuses the `kc-key` classes directly, so no kit import is needed.

- [ ] **Step 3: `admin-next.css`** — create with the full stylesheet:

```css
/* admin-next — Faceplate × Night desk (spec 2026-09-28). Scoped: every page's
   CSS is bundled globally, so everything here hangs off
   html[data-page="admin-next"] and every class is kc-prefixed. Colours come
   only from tokens.css layer 2. */
html[data-page="admin-next"] { color-scheme: dark; background: var(--kc-ground); }
html[data-page="admin-next"] body {
  margin: 0; background: var(--kc-ground); color: var(--kc-ink);
  font: 400 var(--kc-t-body)/1.5 var(--kc-font);
  -webkit-font-smoothing: antialiased;
}
html[data-page="admin-next"] :focus-visible { outline: 2px solid var(--kc-glass); outline-offset: 2px; border-radius: 4px; }
html[data-page="admin-next"] a { color: inherit; }
@media (prefers-reduced-motion: reduce) {
  html[data-page="admin-next"] * { transition: none !important; animation: none !important; }
}

.kc-ico { width: 1.1em; height: 1.1em; flex: none; }

/* ── shell ── */
.kc-app { min-height: 100vh; display: flex; flex-direction: column; }
.kc-top {
  display: flex; align-items: center; gap: 16px;
  padding: calc(10px + env(safe-area-inset-top, 0px)) 18px 10px;
  position: sticky; top: 0; z-index: 10; background: var(--kc-ground);
}
.kc-brand { font-weight: 700; font-size: var(--kc-t-lead); text-decoration: none; }
.kc-tabs { display: flex; gap: 4px; }
.kc-tab {
  display: inline-flex; align-items: center; gap: 6px; padding: 8px 12px;
  border-radius: var(--kc-r-key); color: var(--kc-mute); text-decoration: none; font-weight: 600;
}
.kc-tab:hover { color: var(--kc-ink); }
.kc-tab[aria-current="page"] { color: var(--kc-glass); background: var(--kc-raised); }
.kc-badge {
  background: var(--kc-hay); color: #2a1d05; border-radius: var(--kc-r-pill);
  padding: 0 7px; font-size: var(--kc-t-meta); font-weight: 700;
}
.kc-verdict { margin-left: auto; display: inline-flex; align-items: center; gap: 8px; color: var(--kc-dim); text-decoration: none; font-size: var(--kc-t-small); }
.kc-verdict i { width: 8px; height: 8px; border-radius: 50%; background: var(--kc-mute); }
.kc-verdict[data-verdict="healthy"] i { background: var(--kc-ok); }
.kc-verdict[data-verdict="stressed"] i { background: var(--kc-hay); }
.kc-verdict[data-verdict="trouble"] i { background: var(--kc-coral); }
.kc-top__links { display: inline-flex; gap: 12px; font-size: var(--kc-t-small); color: var(--kc-dim); }
.kc-top__links a { display: inline-flex; align-items: center; gap: 2px; text-decoration: none; }
.kc-main { flex: 1; width: 100%; max-width: 1180px; margin: 0 auto; padding: 8px 18px 32px; box-sizing: border-box; }
.kc-main:focus { outline: none; }
.kc-tabs--bottom { display: none; }

.kc-mini { display: flex; align-items: center; gap: 6px; background: var(--kc-raised); border-radius: var(--kc-r-key); padding: 4px 4px 4px 12px; min-width: 0; }
.kc-mini[hidden] { display: none; }
.kc-mini__open { display: flex; gap: 8px; align-items: baseline; min-width: 0; text-decoration: none; }
.kc-mini__name { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 16em; }
.kc-mini__freq { color: var(--kc-glass); font-variant-numeric: tabular-nums; font-size: var(--kc-t-small); }
.kc-mini__key { background: var(--kc-key); color: var(--kc-ink); border: 0; border-radius: 8px; padding: 6px 8px; box-shadow: var(--kc-key-shadow); cursor: pointer; display: inline-flex; }
.kc-mini__key:disabled { opacity: 0.45; box-shadow: none; cursor: not-allowed; }
.kc-skipLink { position: absolute; left: 8px; top: -60px; z-index: 40; }
.kc-skipLink:focus { top: 8px; }

@media (max-width: 899px) {
  .kc-tabs--top, .kc-top__links { display: none; }
  .kc-top { flex-wrap: wrap; gap: 8px; }
  .kc-mini { order: 3; flex-basis: 100%; }
  .kc-tabs--bottom {
    display: flex; justify-content: space-around; position: sticky; bottom: 0; z-index: 10;
    background: var(--kc-ground); box-shadow: 0 -1px 0 var(--kc-line);
    padding: 6px 4px calc(8px + env(safe-area-inset-bottom, 0px));
  }
  .kc-tabs--bottom .kc-tab { flex-direction: column; gap: 2px; font-size: var(--kc-t-meta); padding: 6px 10px; }
  .kc-tabs--bottom .kc-tab[aria-current="page"] { background: none; }
  .kc-main { padding: 4px 14px 24px; }
}

/* ── keys ── */
.kc-key {
  display: inline-flex; align-items: center; justify-content: center; gap: 8px;
  min-height: 44px; padding: 10px 14px; border: 0; border-radius: var(--kc-r-key);
  background: var(--kc-key); color: var(--kc-ink); box-shadow: var(--kc-key-shadow);
  font: 600 var(--kc-t-body) var(--kc-font); cursor: pointer; text-decoration: none;
  transition: transform 60ms ease;
}
.kc-key:active:not(:disabled) { transform: translateY(1px); box-shadow: 0 1px 0 #0009; }
.kc-key:disabled { opacity: 0.45; cursor: not-allowed; box-shadow: none; }
.kc-key--primary { background: var(--kc-glass); color: var(--kc-glass-ink); }
.kc-key--danger { color: var(--kc-coral); }
.kc-key--wide { width: 100%; font-size: var(--kc-t-row); }

/* ── LCD (glow on glass) ── */
.kc-lcd {
  background: var(--kc-well); border-radius: var(--kc-r-group); padding: 16px 18px 14px;
  box-shadow: inset 0 0 0 1px #2a3a3a, inset 0 8px 18px #0008;
}
.kc-lcd__meta { display: flex; justify-content: space-between; align-items: center; color: var(--kc-glass); opacity: 0.75; font-size: var(--kc-t-small); font-weight: 600; }
.kc-lcd__meta > span { display: inline-flex; align-items: center; gap: 8px; }
.kc-lcd__silent { color: var(--kc-hay); opacity: 1; }
.kc-lcd__name { color: var(--kc-glass-text); font-size: var(--kc-t-lcd-name); font-weight: 700; line-height: 1.15; margin: 8px 0 4px; overflow-wrap: anywhere; }
.kc-lcd__freq { color: var(--kc-glass); font-size: var(--kc-t-lcd-freq); font-weight: 800; line-height: 1; letter-spacing: -0.02em; font-variant-numeric: tabular-nums; text-shadow: 0 0 12px color-mix(in srgb, var(--kc-glass) 35%, transparent); }
.kc-lcd__freq small { font-size: 0.38em; font-weight: 600; letter-spacing: 0; margin-left: 6px; }
.kc-lcd[data-state="scanning"] .kc-lcd__name { color: var(--kc-dim); font-weight: 500; }
.kc-lcd[data-state="breakin"] .kc-lcd__meta { color: var(--kc-hay); opacity: 1; }
.kc-meter { display: inline-flex; gap: 2px; align-items: flex-end; height: 12px; }
.kc-meter i { width: 3px; background: currentColor; opacity: 0.25; border-radius: 1px; }
.kc-meter i:nth-child(1) { height: 4px; } .kc-meter i:nth-child(2) { height: 7px; }
.kc-meter i:nth-child(3) { height: 10px; } .kc-meter i:nth-child(4) { height: 12px; }
.kc-meter i.on { opacity: 1; }

/* ── groups, rows, empty ── */
.kc-group { background: var(--kc-raised); border-radius: var(--kc-r-group); padding: 6px 0 8px; margin-top: 14px; }
.kc-group__title { margin: 10px 16px 6px; font-size: var(--kc-t-small); font-weight: 600; color: var(--kc-dim); }
.kc-row { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 10px 16px; border-top: 1px solid var(--kc-line); font-size: var(--kc-t-row); }
.kc-row:first-of-type { border-top: 0; }
.kc-row__meta { color: var(--kc-mute); font-size: var(--kc-t-small); font-variant-numeric: tabular-nums; white-space: nowrap; }
.kc-empty { margin: 6px 16px 10px; color: var(--kc-mute); font-size: var(--kc-t-small); }
.kc-placeholder { background: var(--kc-raised); border-radius: var(--kc-r-group); padding: 24px 20px; margin-top: 14px; max-width: 36rem; }
.kc-placeholder p { margin: 0 0 14px; color: var(--kc-dim); }

/* ── dialogs ── */
.kc-toastHost { position: fixed; left: 50%; bottom: calc(84px + env(safe-area-inset-bottom, 0px)); transform: translateX(-50%); z-index: 30; }
.kc-toast { display: flex; align-items: center; gap: 12px; background: var(--kc-key); color: var(--kc-ink); border-radius: var(--kc-r-key); padding: 10px 10px 10px 16px; box-shadow: 0 6px 20px #000a; }
.kc-toast__undo { background: none; border: 0; color: var(--kc-glass); font: 600 var(--kc-t-body) var(--kc-font); cursor: pointer; }
.kc-toast__close { background: none; border: 0; color: var(--kc-dim); cursor: pointer; display: inline-flex; }
.kc-confirm { background: var(--kc-raised); color: var(--kc-ink); border: 0; border-radius: var(--kc-r-sheet); padding: 20px; max-width: 26rem; }
.kc-confirm::backdrop { background: #000a; }
.kc-confirm h2 { margin: 0 0 8px; font-size: var(--kc-t-lead); }
.kc-confirm p { margin: 0 0 18px; color: var(--kc-dim); }
.kc-confirm__actions { display: flex; justify-content: flex-end; gap: 8px; }
```

- [ ] **Step 4: `index.ts`** (radio import added in Task 16; for now Radio also uses the placeholder text)

```ts
// admin-next entry: composes shell, live store, poller, dialogs and tabs.
import "./admin-next.css";
import { api } from "../lib/api.js";
import { mountShell, type Shell } from "./shell.js";
import { LiveStore } from "./liveStore.js";
import { Poller, POLL_MS } from "./poller.js";
import { mountDialogs, type Dialogs } from "./dialogs.js";
import { worseVerdict, type SystemAlert, type Verdict } from "./verdict.js";
import { renderPlaceholder } from "./placeholder.js";

export interface Ctx { shell: Shell; live: LiveStore; poller: Poller; dialogs: Dialogs }

export function renderAdminNext(root: HTMLElement): void {
  const live = new LiveStore();
  const shell = mountShell(root, live);
  const dialogs = mountDialogs(root);
  const poller = new Poller();
  const ctx: Ctx = { shell, live, poller, dialogs };

  // Registered first: the verdict is the glance (polls run in order).
  poller.add({
    name: "verdict", everyMs: POLL_MS.verdict,
    run: async () => {
      const sys = await fetch("/api/system").then((r) => r.json()) as {
        health: { verdict: Verdict; reason: string }; alerts: SystemAlert[];
      };
      const v = worseVerdict(sys.health, sys.alerts);
      shell.setVerdict(v.verdict, v.text);
    },
  });
  poller.add({
    name: "audio+triage", everyMs: POLL_MS.audio,
    run: async () => {
      const cfg = await api.getConfig();
      live.set({ volume: cfg.audio.volume, muted: cfg.audio.muted, remoteListening: cfg.audio.remoteListening ?? false });
      shell.setTriageCount((cfg.discoveries ?? []).length);
    },
  });

  renderPlaceholder(shell.panel("tune"), "tune");
  renderPlaceholder(shell.panel("library"), "library");
  renderPlaceholder(shell.panel("system"), "system");
  mountRadioTab(ctx);

  live.connect();
  void live.syncStatus().then(() => live.loadWeatherChannel());
  shell.onRoute((r) => { poller.makeDue(r.tab); void poller.tick(r.tab); });
  poller.start(() => shell.route().tab);
  void poller.tick(shell.route().tab);
}

// Replaced in Task 16 by `import { mountRadio } from "./radio.js"`.
function mountRadioTab(ctx: Ctx): void {
  ctx.shell.panel("radio").textContent = "Radio";
}
```

- [ ] **Step 5: Mount in `main.ts`**

In `main.ts`, add `import { renderAdminNext } from "./admin-next/index.js";` beside the other renderer imports, add `"admin-next": "family=Schibsted+Grotesk:wght@400;500;600;700;800"` to `FONT_QUERY`, and replace the `RENDERERS.find(...)` resolution block with:

```ts
// admin-next is built alongside the classic admin (spec 2026-09-28): same
// /admin path, selected by a #/next hash until the flip PR makes it default.
const isAdminNext = location.pathname.startsWith("/admin") && location.hash.startsWith("#/next");
const [, page, render] = isAdminNext
  ? (["/admin", "admin-next", renderAdminNext] as const)
  : RENDERERS.find(([prefix]) => location.pathname.startsWith(prefix))
    ?? ["", "dashboard", renderDashboard] as const;
```

Switching between classic and next inside one tab needs a reload (different page); the placeholder links are full-URL `href`s and hashchange across `#/next` ↔ classic is handled by adding, right after `render(root);`:

```ts
// Crossing between the classic admin and admin-next swaps the whole page.
if (location.pathname.startsWith("/admin")) {
  window.addEventListener("hashchange", () => {
    if (location.hash.startsWith("#/next") !== isAdminNext) location.reload();
  });
}
```

- [ ] **Step 6: Build and look**

Run: `cd kiosk && npm run typecheck && npm run build:frontend && curl -s -X POST localhost:8080/api/kiosk/reload`
Then: `cd $HOME && for w in 390,844 1440,1000; do timeout 40 chromium --headless --disable-gpu --hide-scrollbars --window-size=$w --virtual-time-budget=4000 --screenshot=$HOME/shots/next-shell-${w%%,*}.png "http://localhost:8080/admin#/next/tune" >/dev/null 2>&1; done`
Read both PNGs. Expected: dark slate ground, Schibsted Grotesk, Tune tab highlighted sea-glass, mini-player visible, placeholder card; at 390 px the tabs sit at the bottom. Also confirm `http://localhost:8080/admin#/` still shows the classic admin unchanged.

- [ ] **Step 7: Commit** (`feat(admin-next): shell, tabs, mini-player, #/next mount`).

### Task 16: Radio tab

**Files:** Create `kiosk/src/frontend/admin-next/radio.ts`, append Radio styles to `admin-next.css`; Modify `admin-next/index.ts` (swap the stub for `mountRadio`)

**Interfaces:**
- Consumes: `Ctx` (Task 15), `lcd`, `key`, `group`, `emptyState` (Task 12), `lcdView` (Task 10), `lockoutFreqIn` (Task 7), `POLL_MS` (Task 9), `api`, `fmtFreq`, `esc`.
- Produces: `mountRadio(ctx: Ctx): void`; `const RECENT_COUNT = 8` (knob).
- Deferred to PR 4 (needs the Library channel detail): tapping a "Recently heard" row or a channel-activity row opens that channel's detail. In this PR the rows are plain text.

- [ ] **Step 1: Implement `radio.ts`**

```ts
// Radio — admin-next home: the faceplate. LCD for what's live, keys for what
// you can do about it, then volume, recently heard, activity and alerts.
// Handlers are the classic Now panel's, ported (same API calls, same guards).
import type { Config } from "../../backend/config/schema.js";
import { api } from "../lib/api.js";
import { esc, fmtFreq } from "../lib/format.js";
import { lockoutFreqIn } from "../lib/lockout.js";
import { ico } from "./ui/icons.js";
import { emptyState, group, key, lcd } from "./ui/kit.js";
import { lcdView, type LiveState } from "./live.js";
import { POLL_MS } from "./poller.js";
import type { Ctx } from "./index.js";

/** How many "recently heard" rows to show. */
export const RECENT_COUNT = 8;

type Stats = {
  totalHits: number; totalAirtimeMs: number; discoveries: number;
  topChannels: Array<{ alphaTag: string; freq: number; hits: number; airtimeMs: number }>;
  byHour: number[];
};

function ago(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h} h ago` : new Date(ts).toLocaleDateString();
}

function airtime(ms: number): string {
  const m = Math.round(ms / 60000);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
}

export function mountRadio(ctx: Ctx): void {
  const { live, poller, dialogs } = ctx;
  const el = ctx.shell.panel("radio");
  el.innerHTML = `
    <div class="kc-radio">
      <div class="kc-radio__main">
        <div id="kcHealth" class="kc-healthStrip" hidden></div>
        <div id="kcLcd"></div>
        <div class="kc-keys">
          ${key({ id: "kcListen", label: "Listen here", icon: "play", variant: "primary", wide: true })}
          ${key({ id: "kcSkip", label: "Skip", icon: "skip", title: "Force-close the current transmission" })}
          ${key({ id: "kcWeather", label: "Weather", icon: "weather", title: "Park the radio on the NOAA weather channel" })}
          ${key({ id: "kcPause", label: "Pause 30 min", icon: "pause", title: "Suppress this channel for 30 minutes (clears on restart)" })}
          ${key({ id: "kcLock", label: "Lock out", icon: "lockout", variant: "danger", title: "Stop scanning this frequency and never Close-Call it" })}
        </div>
        <div class="kc-volume">
          <label for="kcVol" id="kcVolLabel">Volume <b id="kcVolPct"></b></label>
          <input id="kcVol" type="range" min="0" max="100" />
          <button type="button" class="kc-key" id="kcMute" aria-pressed="false"></button>
        </div>
        <label class="kc-switchRow"><span>Remote listening <small>Stream the speaker to this browser — restarts scanning</small></span><input id="kcRemote" type="checkbox" role="switch" /></label>
        ${group("Recently heard", `<div id="kcRecent"></div>`)}
      </div>
      <div class="kc-radio__side">
        ${group("Today", `<div id="kcToday"></div>`)}
        <details class="kc-group kc-disclosure" id="kcInsights">
          <summary class="kc-group__title">Channel activity</summary>
          <div class="kc-periods" role="group" aria-label="Period">
            <button type="button" data-h="24">24 h</button><button type="button" data-h="168">7 d</button><button type="button" data-h="720">30 d</button>
          </div>
          <div id="kcInBody"></div>
        </details>
        ${group("Alerts", `<ul id="kcAlerts" class="kc-list"></ul><div class="kc-group__foot"><button type="button" class="kc-link" id="kcClearAlerts" hidden>Clear all</button></div>`)}
      </div>
    </div>`;

  const $ = <T extends HTMLElement>(sel: string): T => el.querySelector<T>(sel)!;
  const lcdHost = $("#kcLcd");
  const listen = $<HTMLButtonElement>("#kcListen");
  const weather = $<HTMLButtonElement>("#kcWeather");
  const pause = $<HTMLButtonElement>("#kcPause");
  const lock = $<HTMLButtonElement>("#kcLock");
  const vol = $<HTMLInputElement>("#kcVol");
  const volPct = $("#kcVolPct");
  const mute = $<HTMLButtonElement>("#kcMute");
  const remote = $<HTMLInputElement>("#kcRemote");

  // ── Stream: owned by LiveStore (shared with the mini-player)
  function paintListen(s: LiveState): void {
    listen.disabled = !s.remoteListening && !live.streaming;
    listen.title = s.remoteListening ? "Listen to the live speaker feed in this browser" : "Turn on remote listening to stream the feed";
    listen.innerHTML = live.streaming ? `${ico("stop")}<span>Stop listening</span>` : `${ico("play")}<span>Listen here</span>`;
  }
  listen.addEventListener("click", () => live.toggleStream());

  function paint(s: LiveState): void {
    const v = lcdView(s);
    lcdHost.innerHTML = lcd(v, { dbfs: s.dbfs });
    paintListen(s);
    if (s.monitoring) {
      weather.innerHTML = `${ico("stop")}<span>Resume scan</span>`;
      weather.disabled = false;
    } else {
      weather.innerHTML = `${ico("weather")}<span>${s.mode === "weather" ? "Resume scan" : "Weather"}</span>`;
      weather.disabled = s.mode !== "weather" && s.weatherChannel === null;
    }
    pause.disabled = !v.canLock;
    lock.disabled = !v.canLock;
    if (document.activeElement !== vol) vol.value = String(s.volume);
    volPct.textContent = `${s.volume}%`;
    mute.setAttribute("aria-pressed", String(s.muted));
    mute.innerHTML = s.muted ? `${ico("volumeOff")}<span>Muted</span>` : `${ico("volume")}<span>Mute</span>`;
    if (document.activeElement !== remote) remote.checked = s.remoteListening;
  }
  live.subscribe(paint);

  $<HTMLButtonElement>("#kcSkip").addEventListener("click", () => { void api.skip(); });
  weather.addEventListener("click", async () => {
    const s = live.state;
    if (s.monitoring) await api.monitorStop();
    else await api.setMode(s.mode === "weather" ? "scan" : "weather");
    await live.syncStatus();
  });
  pause.addEventListener("click", () => { void api.skip(1800); dialogs.toast("Paused this channel for 30 minutes."); });
  lock.addEventListener("click", async () => {
    const np = live.state.nowPlaying;
    if (!np) return;
    const name = np.alphaTag || fmtFreq(np.freq);
    if (!await dialogs.confirm({
      title: `Lock out ${name}?`,
      message: "This stops the frequency being scanned or Close-Called. The channel is archived, not deleted — unlock restores it.",
      confirmLabel: "Lock out", danger: true,
    })) return;
    // Snapshot what lockout drops so Undo restores what was actually there
    // (same rule as the classic admin's lockoutFreq).
    const before = await api.getConfig();
    const dropped = (before.discoveries ?? []).filter((d) => d.freq === np.freq);
    const priorEnabled = new Map(before.channels.filter((c) => c.freq === np.freq).map((c) => [c.id, c.enabled]));
    try {
      await api.putConfig(lockoutFreqIn(before, np.freq));
    } catch (e) { dialogs.toast((e as Error).message); return; }
    dialogs.toast(`Locked out ${name}.`, {
      undo: async () => {
        const cfg: Config = await api.getConfig();
        cfg.scan = { ...cfg.scan, lockoutHz: (cfg.scan.lockoutHz ?? []).filter((f) => f !== np.freq) };
        cfg.channels = cfg.channels.map((c) => (priorEnabled.has(c.id) ? { ...c, enabled: priorEnabled.get(c.id)! } : c));
        if (dropped.length) cfg.discoveries = [...(cfg.discoveries ?? []), ...dropped];
        await api.putConfig(cfg);
      },
    });
  });

  // `input` keeps the readout live while dragging; the write waits for `change`
  // so a drag is one request.
  vol.addEventListener("input", () => { volPct.textContent = `${vol.value}%`; });
  vol.addEventListener("change", () => { const v = Number(vol.value); live.set({ volume: v }); void api.setVolume(v); });
  mute.addEventListener("click", () => { const m = !live.state.muted; live.set({ muted: m }); void api.setMuted(m); });
  remote.addEventListener("change", async () => {
    const on = remote.checked;
    if (!await dialogs.confirm({
      title: on ? "Turn on remote listening?" : "Turn off remote listening?",
      message: "The scanner restarts briefly to rebuild its audio tap.",
      confirmLabel: on ? "Turn on" : "Turn off",
    })) { remote.checked = !on; return; }
    try {
      const cfg = await api.getConfig();
      await api.putConfig({ ...cfg, audio: { ...cfg.audio, remoteListening: on } });
      live.set({ remoteListening: on });
    } catch (e) { remote.checked = !on; dialogs.toast((e as Error).message); }
  });

  // ── Recently heard
  const recent = $("#kcRecent");
  poller.add({
    name: "recent", everyMs: POLL_MS.recent, tabs: ["radio"],
    run: async () => {
      const rows = (await api.getLogs()).slice().sort((a, b) => b.ts - a.ts).slice(0, RECENT_COUNT);
      recent.innerHTML = rows.length
        ? rows.map((r) => `<div class="kc-row"><span>${esc(r.alphaTag || fmtFreq(r.freq))}</span><span class="kc-row__meta">${ago(r.ts)}</span></div>`).join("")
        : emptyState("Nothing heard yet. Transmissions appear here as they happen.");
    },
  });

  // ── Today (sequential fetches — never concurrent)
  const today = $("#kcToday");
  poller.add({
    name: "today", everyMs: POLL_MS.activity, tabs: ["radio"],
    run: async () => {
      const st = await fetch(`/api/stats?since=${Date.now() - 86_400_000}`).then((r) => r.json()) as Stats;
      const max = Math.max(1, ...st.byHour);
      const nowH = new Date().getHours();
      const total = st.byHour.reduce((a, b) => a + b, 0);
      today.innerHTML = `<div class="kc-today">
          <div><b>${st.totalHits.toLocaleString()}</b><small>transmissions</small></div>
          <div><b>${airtime(st.totalAirtimeMs)}</b><small>airtime</small></div>
          <div><b>${st.discoveries}</b><small>close calls</small></div>
        </div>
        <div class="kc-hours" role="img" aria-label="${total ? `${total} transmissions today by hour` : "No traffic yet today"}">${
          st.byHour.map((n, h) => `<i${h === nowH ? ' class="now"' : ""} style="height:${Math.max(4, (n / max) * 100)}%"></i>`).join("")}</div>`;
    },
  });

  // ── Channel activity (only fetched while expanded)
  const IN_KEY = "kerchunk.adminNext.insightHours";
  let inHours = Number(localStorage.getItem(IN_KEY)) || 24;
  const insights = $<HTMLDetailsElement>("#kcInsights");
  const inBody = $("#kcInBody");
  async function renderInsights(): Promise<void> {
    insights.querySelectorAll<HTMLButtonElement>(".kc-periods button").forEach((b) =>
      b.setAttribute("aria-pressed", String(Number(b.dataset.h) === inHours)));
    const r = await fetch(`/api/stats?since=${Date.now() - inHours * 3_600_000}`);
    if (!r.ok) { inBody.innerHTML = emptyState("History is unavailable. Restart the radio if this persists."); return; }
    const st = await r.json() as Stats;
    const max = Math.max(1, ...st.topChannels.map((c) => c.hits));
    inBody.innerHTML = st.topChannels.length
      ? st.topChannels.slice(0, 8).map((c) => `<div class="kc-row kc-bar">
          <span class="kc-bar__name">${esc(c.alphaTag || fmtFreq(c.freq))}</span>
          <span class="kc-bar__track"><i style="width:${Math.round((100 * c.hits) / max)}%"></i></span>
          <span class="kc-row__meta">${c.hits} · ${airtime(c.airtimeMs)}</span></div>`).join("")
      : emptyState("No traffic in this window.");
  }
  insights.addEventListener("toggle", () => { if (insights.open) void renderInsights(); });
  insights.querySelectorAll<HTMLButtonElement>(".kc-periods button").forEach((b) => b.addEventListener("click", () => {
    inHours = Number(b.dataset.h);
    try { localStorage.setItem(IN_KEY, String(inHours)); } catch { /* private mode */ }
    void renderInsights();
  }));
  poller.add({ name: "insights", everyMs: POLL_MS.insights, tabs: ["radio"], when: () => insights.open, run: renderInsights });

  // ── Alerts
  const alertList = $("#kcAlerts");
  const clearAll = $<HTMLButtonElement>("#kcClearAlerts");
  async function renderAlerts(): Promise<void> {
    const rows = await fetch("/api/history?kind=alert&limit=25").then((r) => (r.ok ? r.json() : [])) as
      Array<{ id: number; ts: number; freq: number; alphaTag: string }>;
    clearAll.hidden = rows.length === 0;
    alertList.innerHTML = rows.length
      ? rows.map((r) => `<li class="kc-row"><span>${esc(r.alphaTag || fmtFreq(r.freq))}<small class="kc-row__meta"> ${ago(r.ts)}</small></span>
          <button type="button" class="kc-iconKey" data-id="${r.id}" aria-label="Dismiss this alert">${ico("trash")}</button></li>`).join("")
      : `<li>${emptyState("No alerts. Turn on “Alert when heard” for a channel in Library to get one.")}</li>`;
    alertList.querySelectorAll<HTMLButtonElement>("[data-id]").forEach((b) => b.addEventListener("click", async () => {
      await api.dismissAlert(Number(b.dataset.id));
      void renderAlerts();
    }));
  }
  clearAll.addEventListener("click", async () => {
    if (!await dialogs.confirm({ title: "Clear all alerts?", message: "Removes every alert from the feed. Activity history is kept.", confirmLabel: "Clear all", danger: true })) return;
    await api.clearAlerts();
    void renderAlerts();
  });
  poller.add({ name: "alerts", everyMs: POLL_MS.alerts, tabs: ["radio"], run: renderAlerts });
  live.onAlert(() => { void renderAlerts(); });
}
```

Before writing the lockout handler, confirm `lockoutFreqIn(before, ...)` typechecks against `Config` (it is generic over `LockoutCfg`; `Config` has `channels`, `discoveries?`, `scan.lockoutHz?`). The health strip (`#kcHealth`) is filled in Step 3.

- [ ] **Step 2: Wire it** — in `index.ts` replace the `mountRadioTab` stub function and its call with `import { mountRadio } from "./radio.js";` and `mountRadio(ctx);`.

- [ ] **Step 3: Health strip on Radio** — in `index.ts`'s verdict poll, after `shell.setVerdict(...)`, add:

```ts
      const strip = shell.panel("radio").querySelector<HTMLElement>("#kcHealth");
      if (strip) {
        strip.hidden = v.verdict === "healthy";
        strip.dataset.verdict = v.verdict;
        strip.innerHTML = v.verdict === "healthy" ? "" : `<span>${esc(v.text)}</span><a href="${hrefFor({ tab: "system" })}">Open System</a>`;
      }
```

with `import { esc } from "../lib/format.js";` and `import { hrefFor } from "./route.js";` added to `index.ts`.

- [ ] **Step 4: Radio styles** — append to `admin-next.css`:

```css
/* ── Radio ── */
.kc-radio { display: grid; gap: 18px; grid-template-columns: minmax(0, 1.25fr) minmax(0, 1fr); align-items: start; }
@media (max-width: 899px) { .kc-radio { grid-template-columns: minmax(0, 1fr); gap: 0; } }
.kc-healthStrip { display: flex; justify-content: space-between; gap: 12px; padding: 10px 14px; margin-bottom: 10px; border-radius: var(--kc-r-key); background: color-mix(in srgb, var(--kc-hay) 14%, var(--kc-ground)); color: var(--kc-hay); }
.kc-healthStrip[data-verdict="trouble"] { background: color-mix(in srgb, var(--kc-coral) 14%, var(--kc-ground)); color: var(--kc-coral); }
.kc-keys { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; margin-top: 12px; }
.kc-keys .kc-key--wide { grid-column: 1 / -1; }
@media (max-width: 420px) { .kc-keys { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
.kc-volume { display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: 12px; margin-top: 16px; color: var(--kc-dim); font-size: var(--kc-t-small); }
.kc-volume b { color: var(--kc-ink); font-weight: 600; font-variant-numeric: tabular-nums; }
.kc-volume input[type="range"] { width: 100%; accent-color: var(--kc-glass); }
.kc-switchRow { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-top: 14px; padding: 12px 16px; background: var(--kc-raised); border-radius: var(--kc-r-group); cursor: pointer; }
.kc-switchRow small { display: block; color: var(--kc-mute); font-size: var(--kc-t-small); }
.kc-switchRow input { appearance: none; width: 42px; height: 26px; border-radius: 13px; background: var(--kc-key); position: relative; cursor: pointer; flex: none; margin: 0; }
.kc-switchRow input::after { content: ""; position: absolute; top: 3px; left: 3px; width: 20px; height: 20px; border-radius: 50%; background: var(--kc-mute); transition: transform 120ms ease; }
.kc-switchRow input:checked { background: var(--kc-glass); }
.kc-switchRow input:checked::after { transform: translateX(16px); background: var(--kc-glass-ink); }
.kc-today { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; padding: 4px 16px 10px; }
.kc-today b { display: block; font-size: var(--kc-t-lead); font-weight: 700; font-variant-numeric: tabular-nums; }
.kc-today small { color: var(--kc-mute); font-size: var(--kc-t-small); }
.kc-hours { display: flex; align-items: flex-end; gap: 2px; height: 56px; padding: 0 16px 8px; }
.kc-hours i { flex: 1; background: var(--kc-key); border-radius: 2px 2px 0 0; }
.kc-hours i.now { background: var(--kc-glass); }
.kc-disclosure > summary { cursor: pointer; list-style: none; }
.kc-disclosure > summary::-webkit-details-marker { display: none; }
.kc-disclosure > summary::after { content: " ›"; color: var(--kc-mute); }
.kc-disclosure[open] > summary::after { content: " ⌄"; }
.kc-periods { display: flex; gap: 6px; padding: 0 16px 8px; }
.kc-periods button { background: var(--kc-key); color: var(--kc-dim); border: 0; border-radius: var(--kc-r-pill); padding: 5px 12px; font: 600 var(--kc-t-small) var(--kc-font); cursor: pointer; }
.kc-periods button[aria-pressed="true"] { background: color-mix(in srgb, var(--kc-glass) 18%, var(--kc-key)); color: var(--kc-glass); }
.kc-bar { display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr) auto; }
.kc-bar__name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.kc-bar__track { height: 6px; background: var(--kc-key); border-radius: 3px; overflow: hidden; }
.kc-bar__track i { display: block; height: 100%; background: var(--kc-dim); }
.kc-list { list-style: none; margin: 0; padding: 0; }
.kc-iconKey { background: none; border: 0; color: var(--kc-mute); cursor: pointer; padding: 6px; border-radius: 8px; display: inline-flex; }
.kc-iconKey:hover { color: var(--kc-coral); }
.kc-group__foot { display: flex; justify-content: flex-end; padding: 0 16px; }
.kc-link { background: none; border: 0; color: var(--kc-dim); font: 600 var(--kc-t-small) var(--kc-font); cursor: pointer; padding: 6px 0; }
```

The pseudo-content `" ›"` / `" ⌄"` characters are decorative disclosure carets in CSS; if the operator's lucide-only mandate is read to cover them, swap for a `ico("chevron")` span rotated via `[open]` (the classic admin did the same in `.chev`).

- [ ] **Step 5: Verify**

Run: `cd kiosk && npm test && npm run typecheck && npm run build:frontend && curl -s -X POST localhost:8080/api/kiosk/reload`
Screenshots at 390 and 1440 of `http://localhost:8080/admin#/next` (same loop as Task 15 Step 6, file names `next-radio-*.png`). Read them. Expected: LCD with glowing sea-glass frequency when a channel is live (or "Scanning…" dimmed), key grid, volume row, remote-listening switch, Recently heard list; desktop shows Today/Channel activity/Alerts in the right column.

- [ ] **Step 6: Commit** (`feat(admin-next): Radio tab`).

### Task 17: Prove on hardware, full DoD, PR

- [ ] **Step 1: Full DoD run** — `cd kiosk && npm test && npm run test:native && npm run typecheck && npm run build` → all pass. Report any failure verbatim.

- [ ] **Step 2: Live behavior checks** (no backend restart needed — frontend only; `curl -X POST localhost:8080/api/kiosk/reload` after build)
  - Open `http://kiosk:8080/admin#/next` from the operator's phone: tabs at bottom, LCD follows live traffic within a second of the wall.
  - Skip: press while a channel is open → LCD returns to "Scanning…" and the wall agrees.
  - Volume: drag to a new value → `curl -s localhost:8080/api/config | grep -o '"volume":[0-9]*'` shows it; the classic admin's slider matches after its 15 s sync.
  - Mute toggles `aria-pressed` and the LCD shows "Muted".
  - Weather → LCD shows "Weather only" and the NOAA channel; press again → scanning resumes.
  - Lock out on a live channel → confirm → toast with Undo → Undo restores (check the channel is enabled again in classic Channels).
  - `journalctl -u kerchunk-kiosk --since "-10 min" | grep -ci "engine start"` stays 0 unless remote listening was toggled (expected: exactly one restart per toggle).
  - With the phone at 390 px, nothing scrolls horizontally.

- [ ] **Step 3: PR**

```bash
git push -u origin feat/admin-next-shell-radio
gh pr create --title "feat(admin-next): new shell + Radio tab at /admin#/next" --body "$(cat <<'EOF'
First slice of the admin redesign (spec docs/superpowers/specs/2026-09-28-admin-redesign-design.md): four-tab shell (Radio · Tune · Library · System), mini-player, health verdict, and the Radio tab (glow-on-glass LCD, keys, volume, remote listening, recently heard, today, channel activity, alerts). Lives at `/admin#/next`; the classic admin stays default. Tune/Library/System link to their classic pages until PRs 3–5.

Pure logic unit-tested (routes, poller, live reducer, verdict, ui kit). Lockout transforms moved to lib/ (classic admin re-exports).

Verified on the appliance: <fill in from Task 17 Step 2 results>.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Replace the `<fill in …>` line with the actual Step 2 results before creating the PR.

- [ ] **Step 4: After operator OK + green CI: merge and clean up**

```bash
gh pr merge <n> --merge --delete-branch
git checkout main && git pull --ff-only && git fetch --prune && git branch -d feat/admin-next-shell-radio
```

Then write the PR 3 (Tune) plan against the merged `ui/` kit.
