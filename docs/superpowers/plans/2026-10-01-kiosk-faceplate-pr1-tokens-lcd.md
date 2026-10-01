# Kiosk Faceplate — PR 1: tokens + shared LCD — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the admin's LCD into a shared `src/frontend/faceplate/` module that the kiosk can use, teach it the service head, the segmented meter and a wall size, and add the kiosk's tokens, with **no visible change to the admin and no change to the kiosk yet**.

**Architecture:** `faceplate/` is a new frontend-only folder (typechecked only by `tsconfig.frontend.json`, so it may import `?raw` SVGs and CSS). `faceplate/lcd.ts` is the existing `lcd()` string builder plus three optional extras; `faceplate/serviceHead.ts` builds the head from the map's own pin SVGs; `faceplate/lcd.css` carries the LCD styles under a zero-specificity `:where()` scope shared by the admin and dashboard pages. New tokens go in `tokens.css` layer 2.

**Tech Stack:** TypeScript (ESM, `.js` import suffixes, `strict` + `noUncheckedIndexedAccess`), Vite `?raw` imports, vanilla CSS custom properties, vitest.

**Spec:** `docs/superpowers/specs/2026-10-01-kiosk-faceplate-design.md` (this PR = "Delivery" item 1). PRs 2 and 3 get their own plans after this one merges.

## Global Constraints

- All commands run from `kiosk/` (`cd /home/kiosk/kerchunk-kiosk/kiosk`).
- Relative imports carry `.js` even from `.ts` (`import { lcd } from "../../faceplate/lcd.js"`).
- No literal colour in any stylesheet except `tokens.css`. No `var(--x, #hex)` fallbacks. Every `var(--x)` must be declared (enforced by `test/cssVarsDeclared.test.ts`).
- Admin rules stay `kc-`-prefixed. Shared LCD rules are scoped `:where(html[data-page="admin"], html[data-page="dashboard"])`, which keeps specificity identical to today's bare `.kc-lcd` rules.
- Frequencies render to four decimals; numbers that change use `tabular-nums`.
- `lucide-static` only for icons; the service glyphs come from `src/frontend/map/pins/pin-*.svg` (which already embed lucide paths). Never hand-draw an icon.
- The admin must look identical after this PR. Any admin visual difference is a bug.
- Do not touch `src/frontend/dashboard/`, `src/frontend/map/` (except reading the pin SVGs), `main.ts` `FONT_QUERY`, or the DESIGN.md Layer Rule. Those belong to PRs 2 and 3.
- Frontend-only: never restart `kerchunk-kiosk`.

## Review Focus

- **A ringed head must still be findable:** business `#6D28D9` (2.67:1) and rail `#8B5034` (2.98:1) are under 3:1 on `--kc-well`. Expect `ringed: true` for exactly those two, and the ring colour (`--kc-pin-cream`) ≥ 3:1 on the well (Task 2 tests).
- **A pin SVG whose markup drifts** (re-exported from a design tool) would silently produce an empty glyph. Expect a loud failure: `glyphOf` throws, and a test runs every category (Task 2).
- **`segments.fill` outside 0…1 or NaN** (a dB mapping that overshoots, or a null reading) must clamp, never render 13 lit segments or `NaN` (Task 4 tests).
- **The admin's live dB updates** (`radio.ts` queries `.kc-meter i` and `.kc-lcd__db` after each rebuild) must keep working: the default LCD markup has to stay byte-compatible (Task 3 snapshot test).
- **Wall size without a head or segments** (the error state in PR 2) must still render a valid LCD with no empty row wrapper (Task 4 test).

---

## File structure

| File | Responsibility |
|---|---|
| `src/frontend/faceplate/lcd.ts` (create) | `lcd()`, `meterLit`, `dbText`, `METER_FLOOR_DB`, `segmentsLit`, the `LcdInput`/`LcdOpts` types. Imports `./lcd.css`. |
| `src/frontend/faceplate/lcd.css` (create) | Every `.kc-lcd*` / `.kc-meter*` rule, moved from `admin/admin.css`, plus head/segments/wall rules. |
| `src/frontend/faceplate/serviceHead.ts` (create) | `PinCategory` → `{ color, glyph, ringed }` from the pin SVGs. |
| `src/frontend/admin/ui/kit.ts` (modify) | Loses the LCD code; everything else unchanged. |
| `src/frontend/admin/admin.css` (modify) | Loses lines 95–111 (the LCD + meter block). |
| `src/frontend/admin/radio.ts`, `channelDetail.ts` (modify) | Import `lcd`/`meterLit`/`dbText` from `../faceplate/lcd.js`. |
| `src/frontend/tokens.css` (modify) | Kiosk ramp, motion, pin tokens in layer 2. |
| `test/faceplate.lcd.test.ts` (create) | LCD tests (moved from `admin.kit.test.ts` + new). |
| `test/faceplate.serviceHead.test.ts` (create) | Head tests. |
| `test/admin.kit.test.ts` (modify) | LCD tests move out; its imports follow. |
| `test/tokens.test.ts` (modify) | New-token presence and contrast. |
| `DESIGN.md` (modify, repo root; `kiosk/DESIGN.md` is a symlink) | The shared LCD, head, segments, wall size, new tokens. |

---

### Task 1: Kiosk tokens

**Files:**
- Modify: `src/frontend/tokens.css` (layer 2 block, before the closing `}` at line 82)
- Test: `test/tokens.test.ts`

**Interfaces:**
- Produces (CSS custom properties, used by Tasks 2/4 and PR 2):
  `--kc-k-pill`, `--kc-k-clock`, `--kc-k-date`, `--kc-k-glass-meta`, `--kc-k-glass-name`, `--kc-k-glass-freq`, `--kc-k-head`, `--kc-k-alert-title`, `--kc-grow-ms`, `--kc-release-ms`, `--kc-sweep-ms`, `--kc-pin-cream`, `--kc-pin-glyph`.

- [ ] **Step 1: Write the failing tests** — append to `test/tokens.test.ts`:

```ts
describe("tokens.css layer 2 — the kiosk at room distance (spec 2026-10-01)", () => {
  const props = readProps(TOKENS);
  const v = (n: string): string => resolve(props, props[n] ?? "");
  const ramp = ["--kc-k-pill", "--kc-k-clock", "--kc-k-date", "--kc-k-glass-meta", "--kc-k-glass-name",
    "--kc-k-glass-freq", "--kc-k-head", "--kc-k-alert-title"];
  for (const n of ramp) it(`${n} is a rem size`, () => {
    expect(props[n], `${n} missing`).toMatch(/^\d+(\.\d+)?rem$/);
  });
  it("motion tokens are milliseconds", () => {
    for (const n of ["--kc-grow-ms", "--kc-release-ms", "--kc-sweep-ms"]) expect(props[n], n).toMatch(/^\d+ms$/);
  });
  it("the glass outranks the clock, which outranks the pill", () => {
    const rem = (n: string): number => parseFloat(props[n] ?? "0");
    expect(rem("--kc-k-glass-freq")).toBeGreaterThan(rem("--kc-k-clock"));
    expect(rem("--kc-k-clock")).toBeGreaterThan(rem("--kc-k-pill"));
  });
  it("--kc-pin-cream (head ring) ≥ 3:1 on --kc-well", () => {
    expect(contrast(v("--kc-pin-cream"), v("--kc-well"))).toBeGreaterThanOrEqual(3);
  });
  it("the pin tokens mirror the pin SVGs", () => {
    expect(v("--kc-pin-cream").toLowerCase()).toBe("#f5ebe8");
    expect(v("--kc-pin-glyph").toLowerCase()).toBe("#ffffff");
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/tokens.test.ts`
Expected: FAIL — `--kc-k-pill missing` (and the rest).

- [ ] **Step 3: Add the tokens** — in `src/frontend/tokens.css`, insert before the final `}` (after `--kc-backdrop`):

```css

  /* ── Layer 2: the kiosk at room distance (spec 2026-10-01) ──
     Sized from the approved mockups on the 1920×1080 wall. */
  --kc-k-pill: 1.25rem;        /* the idle pill's one line */
  --kc-k-clock: 4rem;          /* bare clock, top-right */
  --kc-k-date: 1.25rem;        /* date · temp · wind under it */
  --kc-k-glass-meta: 1.25rem;  /* LCD meta line at wall size */
  --kc-k-glass-name: 3.25rem;  /* LCD channel name at wall size */
  --kc-k-glass-freq: 6.25rem;  /* LCD frequency — the largest thing on the wall */
  --kc-k-head: 10rem;          /* service head: the height of name + frequency */
  --kc-k-alert-title: 3.1rem;  /* weather alert card title */
  --kc-grow-ms: 420ms;         /* pill → glass on a hit */
  --kc-release-ms: 360ms;      /* glass → pill on release */
  --kc-sweep-ms: 4500ms;       /* one pass of the idle sweep tick */
  /* The map pin carve-out, mirrored so no stylesheet carries the literal. */
  --kc-pin-cream: #f5ebe8;     /* pin body; ring on a low-contrast service head (≥3:1 on well) */
  --kc-pin-glyph: #ffffff;     /* the pin/head icon stroke */
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run test/tokens.test.ts test/cssVarsDeclared.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/frontend/tokens.css test/tokens.test.ts
git commit -m "feat(tokens): kiosk room-distance ramp, motion and pin tokens

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Service head from the pin SVGs

**Files:**
- Create: `src/frontend/faceplate/serviceHead.ts`
- Test: `test/faceplate.serviceHead.test.ts`

**Interfaces:**
- Consumes: `PIN_COLORS`, `type PinCategory` from `src/frontend/lib/serviceColor.ts`; the `?raw` pin SVGs.
- Produces:
  ```ts
  export interface ServiceHead { color: string; glyph: string; ringed: boolean }
  export const HEAD_MIN_CONTRAST = 3;
  export const WELL_HEX = "#0c1113";
  export function glyphOf(pinSvg: string): string;      // throws if the glyph group is missing
  export function serviceHead(cat: PinCategory): ServiceHead;
  ```

- [ ] **Step 1: Write the failing tests** — `test/faceplate.serviceHead.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { glyphOf, serviceHead, WELL_HEX, HEAD_MIN_CONTRAST } from "../src/frontend/faceplate/serviceHead.js";
import { PIN_COLORS, type PinCategory } from "../src/frontend/lib/serviceColor.js";
import { readProps, resolve, contrast } from "./cssTokens.js";

const CATS = Object.keys(PIN_COLORS) as PinCategory[];

describe("serviceHead", () => {
  it("every category has its PIN_COLORS colour and a non-empty lucide glyph", () => {
    for (const cat of CATS) {
      const h = serviceHead(cat);
      expect(h.color, cat).toBe(PIN_COLORS[cat]);
      expect(h.glyph, cat).toMatch(/<(path|circle|rect|line|polyline)\b/);
      expect(h.glyph, cat).not.toContain("<g");
    }
  });
  it("rings exactly the heads under 3:1 on the well (today: business, rail)", () => {
    const ringed = CATS.filter((c) => serviceHead(c).ringed).sort();
    expect(ringed).toEqual(["biz", "rail"]);
    for (const c of CATS) {
      const h = serviceHead(c);
      expect(h.ringed, c).toBe(contrast(h.color, WELL_HEX) < HEAD_MIN_CONTRAST);
    }
  });
  it("WELL_HEX is --kc-well", () => {
    const p = readProps("src/frontend/tokens.css");
    expect(resolve(p, p["--kc-well"]!).toLowerCase()).toBe(WELL_HEX);
  });
  it("glyphOf fails loudly when a pin's glyph group is missing", () => {
    expect(() => glyphOf("<svg><circle r='1'/></svg>")).toThrow(/glyph group/);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/faceplate.serviceHead.test.ts`
Expected: FAIL — cannot resolve `../src/frontend/faceplate/serviceHead.js`.

- [ ] **Step 3: Implement** — `src/frontend/faceplate/serviceHead.ts`:

```ts
// The service head: the round, service-coloured disc with its icon that sits
// on the kiosk's glass beside a live channel (spec 2026-10-01). Built from the
// map's own pin SVGs, so the pin stays the one source of each service's icon —
// the head is the pin's head, without the teardrop.
import { PIN_COLORS, type PinCategory } from "../lib/serviceColor.js";
import pinAir from "../map/pins/pin-air.svg?raw";
import pinRail from "../map/pins/pin-rail.svg?raw";
import pinHam from "../map/pins/pin-ham.svg?raw";
import pinGmrs from "../map/pins/pin-gmrs.svg?raw";
import pinBiz from "../map/pins/pin-biz.svg?raw";
import pinPublicSafety from "../map/pins/pin-publicsafety.svg?raw";
import pinMarine from "../map/pins/pin-marine.svg?raw";
import pinWeather from "../map/pins/pin-weather.svg?raw";
import pinUnknown from "../map/pins/pin-unknown.svg?raw";

export interface ServiceHead {
  /** The disc fill — PIN_COLORS for the category. */
  color: string;
  /** The lucide glyph's inner SVG elements (paths etc.), no wrapper. */
  glyph: string;
  /** True when the disc is under HEAD_MIN_CONTRAST on the glass; the LCD then
   *  draws a --kc-pin-cream ring so the head stays findable. */
  ringed: boolean;
}

/** Non-text contrast floor (WCAG 1.4.11) for the disc against the glass. */
export const HEAD_MIN_CONTRAST = 3;
/** --kc-well, the LCD glass the head sits on (pinned to tokens.css by a test). */
export const WELL_HEX = "#0c1113";

const PIN_SVG: Record<PinCategory, string> = {
  air: pinAir, rail: pinRail, ham: pinHam, gmrs: pinGmrs, biz: pinBiz,
  publicsafety: pinPublicSafety, marine: pinMarine, weather: pinWeather, unknown: pinUnknown,
};

// Every pin draws its glyph in one group scaled into the head:
// <g transform="translate(10.5 10.5) scale(0.875)" …>…</g></g>
const GLYPH_GROUP = /<g transform="translate\(10\.5 10\.5\) scale\(0\.875\)"[^>]*>([\s\S]*?)<\/g>\s*<\/g>/;

export function glyphOf(pinSvg: string): string {
  const m = GLYPH_GROUP.exec(pinSvg);
  if (!m || !m[1]!.trim()) throw new Error("serviceHead: pin SVG has no glyph group");
  return m[1]!.trim();
}

function luminance(hex: string): number {
  const h = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
    .map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4)) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastOnWell(hex: string): number {
  const [hi, lo] = [luminance(hex), luminance(WELL_HEX)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const HEADS = new Map<PinCategory, ServiceHead>();

export function serviceHead(cat: PinCategory): ServiceHead {
  let h = HEADS.get(cat);
  if (!h) {
    const color = PIN_COLORS[cat] ?? PIN_COLORS.unknown!;
    h = { color, glyph: glyphOf(PIN_SVG[cat]), ringed: contrastOnWell(color) < HEAD_MIN_CONTRAST };
    HEADS.set(cat, h);
  }
  return h;
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run test/faceplate.serviceHead.test.ts && npm run typecheck`
Expected: PASS; typecheck clean (the `?raw` imports resolve via `tsconfig.frontend.json`'s `vite/client` types; `faceplate/` is not in the backend tsconfig's `include`).

- [ ] **Step 5: Commit**

```bash
git add src/frontend/faceplate/serviceHead.ts test/faceplate.serviceHead.test.ts
git commit -m "feat(faceplate): service head built from the map's pin SVGs

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Move the LCD to `faceplate/` (no visual change)

**Files:**
- Create: `src/frontend/faceplate/lcd.ts`, `src/frontend/faceplate/lcd.css`, `test/faceplate.lcd.test.ts`
- Modify: `src/frontend/admin/ui/kit.ts:1-51`, `src/frontend/admin/admin.css:95-111`, `src/frontend/admin/radio.ts:19`, `src/frontend/admin/channelDetail.ts:23`, `test/admin.kit.test.ts:2,13-46`

**Interfaces:**
- Consumes: nothing new.
- Produces (unchanged behaviour, new home):
  ```ts
  export const METER_FLOOR_DB = -60;
  export function meterLit(dbfs: number | null | undefined): number;
  export function dbText(dbfs: number | null | undefined): string;
  export interface LcdInput { state: string; meta: string; name: string; freq: string; silent: string | null }
  export interface LcdOpts { dbfs?: number | null }   // Task 4 extends this
  export function lcd(v: LcdInput, o?: LcdOpts): string;
  ```
  `admin/live.ts`'s `LcdView` stays where it is and satisfies `LcdInput` structurally.

- [ ] **Step 0: Capture the admin "before" screenshot** (the visual guard for this task)

```bash
cd ~ && timeout -k 3 40 chromium --headless --disable-gpu --window-size=1280,900 \
  --screenshot=$HOME/admin-lcd-before.png "http://localhost:8080/admin#/radio" >/dev/null 2>&1; ls -la ~/admin-lcd-before.png
```
(Headless screenshots work for the DOM-only admin, but the PNG must be written inside `$HOME`.)

- [ ] **Step 1: Write the failing test** — create `test/faceplate.lcd.test.ts` with the LCD tests moved verbatim from `test/admin.kit.test.ts` (lines 13–46) re-pointed at the new module, plus a byte-compatibility pin:

```ts
import { describe, it, expect } from "vitest";
import { dbText, lcd, meterLit, METER_FLOOR_DB } from "../src/frontend/faceplate/lcd.js";
import { initialLive, lcdView, reduceEvent } from "../src/frontend/admin/live.js";

const liveState = () => reduceEvent(initialLive, { type: "audible", channel: { id: "a", freq: 118_400_000, alphaTag: "A&B", mode: "am", enabled: true } as never, ts: 1 }).state;

describe("faceplate lcd (moved from the admin kit)", () => {
  it("lcd renders name, freq and state", () => {
    const h = lcd(lcdView(liveState()), { dbfs: -41 });
    expect(h).toContain('data-state="live"');
    expect(h).toContain("A&amp;B");
    expect(h).toContain("118.4000");
    expect(h).toContain("−41 dB");
  });
  it("lcd omits the MHz unit while scanning", () => {
    expect(lcd(lcdView(initialLive))).not.toContain("MHz");
  });
  it("lcd keeps an aria-hidden dB slot while live, even before a reading", () => {
    expect(lcd(lcdView(liveState()))).toContain('<span class="kc-lcd__db" aria-hidden="true"></span>');
    expect(lcd(lcdView(initialLive))).not.toContain("kc-lcd__db");
  });
  it("lcd markup is not itself a live region (the persistent host is)", () => {
    expect(lcd(lcdView(initialLive))).not.toContain("aria-live");
    expect(lcd(lcdView(initialLive))).not.toContain('role="status"');
  });
  it("meter floor is the knob: at the floor no bars, halfway two", () => {
    expect(meterLit(METER_FLOOR_DB)).toBe(0);
    expect(meterLit(METER_FLOOR_DB / 2)).toBe(2);
    expect(meterLit(0)).toBe(4);
  });
  it("meterLit / dbText map dBFS for in-place level updates", () => {
    expect(meterLit(null)).toBe(0);
    expect(meterLit(-60)).toBe(0);
    expect(meterLit(-30)).toBe(2);
    expect(meterLit(5)).toBe(4);
    expect(dbText(null)).toBe("");
    expect(dbText(-41.4)).toBe("−41 dB");
  });
  it("default markup is byte-identical to the admin's (radio.ts queries .kc-meter i / .kc-lcd__db)", () => {
    expect(lcd(lcdView(liveState()), { dbfs: -30 }).replace(/\s+/g, " ")).toBe(
      '<div class="kc-lcd" data-state="live"> <div class="kc-lcd__meta"><span><span class="kc-meter" aria-hidden="true"><i class="on"></i><i class="on"></i><i></i><i></i></span>Live · AM</span><span class="kc-lcd__db" aria-hidden="true">−30 dB</span></div> <div class="kc-lcd__name">A&amp;B</div> <div class="kc-lcd__freq">118.4000<small>MHz</small></div> </div>',
    );
  });
});
```

> This expected string was captured from the pre-move `admin/ui/kit.ts` `lcd()` on 2026-10-01 (`Live · AM` is what `lcdView` produces for an AM channel with no service tag). It must not change.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/faceplate.lcd.test.ts`
Expected: FAIL — cannot resolve `../src/frontend/faceplate/lcd.js`.

- [ ] **Step 3: Create `src/frontend/faceplate/lcd.ts`** — the code moved from `admin/ui/kit.ts` lines 18–51, unchanged except for the input type and the CSS import:

```ts
// The LCD — the Faceplate's signature glass, shared by the admin (panel size)
// and the kiosk (wall size, spec 2026-10-01). An HTML-string builder like the
// rest of the app: callers render with innerHTML.
import { esc } from "../lib/format.js";
import "./lcd.css";

/** What the glass shows. The admin's LcdView (admin/live.ts) satisfies this. */
export interface LcdInput {
  /** "live" carries the dB slot; "detail" (a Library channel) has no meter. */
  state: string;
  meta: string;
  name: string;
  freq: string;
  silent: string | null;
}

export interface LcdOpts { dbfs?: number | null }

/** The level meter's floor: dBFS at or below this lights no bars; 0 dBFS
 *  lights all four. */
export const METER_FLOOR_DB = -60;

/** How many of the 4 level-meter bars are lit for a dBFS (METER_FLOOR_DB → 0 dB). */
export function meterLit(dbfs: number | null | undefined): number {
  return dbfs == null ? 0 : Math.max(0, Math.min(4, Math.round(((dbfs - METER_FLOOR_DB) / -METER_FLOOR_DB) * 4)));
}

/** The LCD's dB readout text ("−41 dB"), or "" with no reading. */
export function dbText(dbfs: number | null | undefined): string {
  return dbfs == null ? "" : `${String(Math.round(dbfs)).replace("-", "−")} dB`;
}

/** Level meter bars from dBFS (METER_FLOOR_DB → 0 dB mapped over 4 bars). */
function meter(dbfs: number | null | undefined): string {
  const lit = meterLit(dbfs);
  return `<span class="kc-meter" aria-hidden="true">${[1, 2, 3, 4].map((i) => `<i${i <= lit ? ' class="on"' : ""}></i>`).join("")}</span>`;
}

/** The LCD's markup. Not itself a live region: the caller's persistent host
 *  element carries role="status" (a region recreated on every rebuild isn't
 *  reliably announced). */
export function lcd(v: LcdInput, o: LcdOpts = {}): string {
  // Live state always carries the dB slot (empty until the first reading) so a
  // caller can update it in place at signal rate; aria-hidden because it
  // changes ~4×/s inside the host's polite live region.
  const db = v.state === "live" ? `<span class="kc-lcd__db" aria-hidden="true">${dbText(o.dbfs)}</span>` : "";
  const silent = v.silent ? ` <span class="kc-lcd__silent">${v.silent}</span>` : "";
  return `<div class="kc-lcd" data-state="${v.state}">
    <div class="kc-lcd__meta"><span>${v.state === "detail" ? "" : meter(v.state === "live" ? o.dbfs : null)}${esc(v.meta)}${silent}</span>${db}</div>
    <div class="kc-lcd__name">${esc(v.name)}</div>
    ${v.freq ? `<div class="kc-lcd__freq">${esc(v.freq)}<small>MHz</small></div>` : ""}
  </div>`;
}
```

- [ ] **Step 4: Create `src/frontend/faceplate/lcd.css`** — the block from `admin/admin.css` lines 95–111, re-scoped with zero-specificity `:where()`:

```css
/* The LCD — shared by the admin and the kiosk (spec 2026-10-01). Moved from
   admin/admin.css. :where() keeps every selector at the specificity it had as
   a bare class, so nothing in admin.css changes how it cascades. */
:where(html[data-page="admin"], html[data-page="dashboard"]) .kc-lcd {
  background: var(--kc-well); border-radius: var(--kc-r-group); padding: 16px 18px 14px;
  box-shadow: var(--kc-well-shadow);
}
:where(html[data-page="admin"], html[data-page="dashboard"]) .kc-lcd__meta { display: flex; justify-content: space-between; align-items: center; color: var(--kc-glass); opacity: 0.75; font-size: var(--kc-t-small); font-weight: 600; }
:where(html[data-page="admin"], html[data-page="dashboard"]) .kc-lcd__meta > span { display: inline-flex; align-items: center; gap: 8px; }
:where(html[data-page="admin"], html[data-page="dashboard"]) .kc-lcd__silent { color: var(--kc-hay); opacity: 1; }
:where(html[data-page="admin"], html[data-page="dashboard"]) .kc-lcd__name { color: var(--kc-glass-text); font-size: var(--kc-t-lcd-name); font-weight: 700; line-height: 1.15; margin: 8px 0 4px; overflow-wrap: anywhere; }
:where(html[data-page="admin"], html[data-page="dashboard"]) .kc-lcd__freq { color: var(--kc-glass); font-size: var(--kc-t-lcd-freq); font-weight: 800; line-height: 1; letter-spacing: -0.02em; font-variant-numeric: tabular-nums; text-shadow: 0 0 12px color-mix(in srgb, var(--kc-glass) 35%, transparent); }
:where(html[data-page="admin"], html[data-page="dashboard"]) .kc-lcd__freq small { font-size: 0.38em; font-weight: 600; letter-spacing: 0; margin-left: 6px; }
:where(html[data-page="admin"], html[data-page="dashboard"]) .kc-lcd[data-state="scanning"] .kc-lcd__name { color: var(--kc-dim); font-weight: 500; }
:where(html[data-page="admin"], html[data-page="dashboard"]) .kc-lcd[data-state="breakin"] .kc-lcd__meta { color: var(--kc-hay); opacity: 1; }
:where(html[data-page="admin"], html[data-page="dashboard"]) .kc-meter { display: inline-flex; gap: 2px; align-items: flex-end; height: 12px; }
:where(html[data-page="admin"], html[data-page="dashboard"]) .kc-meter i { width: 3px; background: currentColor; opacity: 0.25; border-radius: 1px; }
:where(html[data-page="admin"], html[data-page="dashboard"]) .kc-meter i:nth-child(1) { height: 4px; }
:where(html[data-page="admin"], html[data-page="dashboard"]) .kc-meter i:nth-child(2) { height: 7px; }
:where(html[data-page="admin"], html[data-page="dashboard"]) .kc-meter i:nth-child(3) { height: 10px; }
:where(html[data-page="admin"], html[data-page="dashboard"]) .kc-meter i:nth-child(4) { height: 12px; }
:where(html[data-page="admin"], html[data-page="dashboard"]) .kc-meter i.on { opacity: 1; }
```

> Before deleting from `admin.css`, diff the two blocks property-by-property (`sed -n 95,111p src/frontend/admin/admin.css`). Every declaration must appear above with the same value; only the selector prefix changes.

- [ ] **Step 5: Remove the moved code from the admin**

- `src/frontend/admin/admin.css`: delete lines 95–111 (from `.kc-lcd {` through `.kc-meter i.on { opacity: 1; }`), keeping the blank line before `/* ── groups, rows, empty ── */`.
- `src/frontend/admin/ui/kit.ts`: delete `METER_FLOOR_DB`, `meterLit`, `dbText`, `meter`, `lcd` (lines 18–51) and the now-unused `import type { LcdView } from "../live.js";`.
- `src/frontend/admin/radio.ts:19` →
  ```ts
  import { emptyState, group, key, switchRow } from "./ui/kit.js";
  import { dbText, lcd, meterLit } from "../faceplate/lcd.js";
  ```
- `src/frontend/admin/channelDetail.ts:23` →
  ```ts
  import { chip, emptyState, field, key, switchRow } from "./ui/kit.js";
  import { lcd } from "../faceplate/lcd.js";
  ```
- `test/admin.kit.test.ts`: delete the moved LCD/meter `it(...)` blocks (lines 13–46) and change line 2 to
  ```ts
  import { key, group, slider, switchRow, segmented, chip, field } from "../src/frontend/admin/ui/kit.js";
  ```
  (No remaining test in this file calls `lcd`, `meterLit` or `dbText` after the move. Line 3's `initialLive, lcdKey, lcdView, reduceEvent` import stays.)

- [ ] **Step 6: Run everything**

Run: `npx vitest run test/faceplate.lcd.test.ts test/admin.kit.test.ts test/admin.radio.test.ts test/cssVarsDeclared.test.ts && npm run typecheck`
Expected: PASS; typecheck clean (unused-import errors mean Step 5 missed one).

- [ ] **Step 7: Build and capture "after"**

```bash
npm run build:frontend
cd ~ && timeout -k 3 40 chromium --headless --disable-gpu --window-size=1280,900 \
  --screenshot=$HOME/admin-lcd-after.png "http://localhost:8080/admin#/radio" >/dev/null 2>&1
```
Read both PNGs. The LCD must look the same: bezel, glow, meter bars, sizes, colours (its *content* may differ with live traffic). Any styling difference → stop and fix before committing. Then `rm ~/admin-lcd-before.png ~/admin-lcd-after.png`.

- [ ] **Step 8: Commit**

```bash
git add src/frontend/faceplate/lcd.ts src/frontend/faceplate/lcd.css src/frontend/admin/ui/kit.ts \
  src/frontend/admin/admin.css src/frontend/admin/radio.ts src/frontend/admin/channelDetail.ts \
  test/faceplate.lcd.test.ts test/admin.kit.test.ts
git commit -m "refactor(faceplate): the LCD moves to faceplate/ for the admin and kiosk to share

No visual change: same markup (pinned byte-for-byte), same rules under a
zero-specificity :where() scope.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Head, segmented meter and wall size

**Files:**
- Modify: `src/frontend/faceplate/lcd.ts`, `src/frontend/faceplate/lcd.css`
- Test: `test/faceplate.lcd.test.ts`

**Interfaces:**
- Consumes: `ServiceHead`, `serviceHead()` from Task 2; tokens `--kc-k-*`, `--kc-pin-cream`, `--kc-pin-glyph` from Task 1.
- Produces (PR 2 relies on these exact names):
  ```ts
  export interface LcdOpts {
    dbfs?: number | null;
    head?: ServiceHead;                           // service disc left of name + freq
    segments?: { count: number; fill: number };   // fill 0..1 (clamped); replaces the 4-bar meta meter
    size?: "panel" | "wall";                      // "wall" adds .kc-lcd--wall
  }
  export function segmentsLit(fill: number, count: number): number;  // for in-place updates
  ```
  Classes: `.kc-lcd--wall`, `.kc-lcd__row`, `.kc-lcd__text`, `.kc-lcd__head`, `.kc-lcd__head--ringed`, `.kc-lcd__seg` (children `i`, lit ones `i.on`).

- [ ] **Step 1: Write the failing tests** — append to `test/faceplate.lcd.test.ts`:

```ts
import { segmentsLit } from "../src/frontend/faceplate/lcd.js";
import { serviceHead } from "../src/frontend/faceplate/serviceHead.js";

describe("faceplate lcd — kiosk extras", () => {
  const live = { state: "live", meta: "Live · Public safety", name: "KC Fire Dispatch", freq: "154.4300", silent: null };

  it("head renders the disc + glyph left of name and freq, aria-hidden", () => {
    const h = lcd(live, { head: serviceHead("publicsafety") });
    expect(h).toMatch(/<div class="kc-lcd__row"><svg class="kc-lcd__head" viewBox="0 0 42 42" aria-hidden="true"><circle cx="21" cy="21" r="21" fill="#E5383B"\/>/);
    expect(h).toContain('stroke="currentColor"');
    expect(h.indexOf("kc-lcd__head")).toBeLessThan(h.indexOf("kc-lcd__name"));
    expect(h).toContain('<div class="kc-lcd__text">');
  });
  it("a low-contrast head is ringed", () => {
    expect(lcd(live, { head: serviceHead("rail") })).toContain('class="kc-lcd__head kc-lcd__head--ringed"');
    expect(lcd(live, { head: serviceHead("air") })).not.toContain("kc-lcd__head--ringed");
  });
  it("segments replace the four-bar meta meter and light round(fill × count)", () => {
    const h = lcd(live, { segments: { count: 12, fill: 0.6 } });
    expect(h).not.toContain("kc-meter");
    expect(h.match(/<i class="on"><\/i>/g)?.length).toBe(7);
    expect(h.match(/<i><\/i>/g)?.length).toBe(5);
    expect(h).toContain('<div class="kc-lcd__seg" aria-hidden="true">');
  });
  it("segmentsLit clamps out-of-range and NaN fills", () => {
    expect(segmentsLit(-0.5, 12)).toBe(0);
    expect(segmentsLit(1.7, 12)).toBe(12);
    expect(segmentsLit(Number.NaN, 12)).toBe(0);
    expect(segmentsLit(0.5, 12)).toBe(6);
  });
  it("wall size adds the modifier class", () => {
    expect(lcd(live, { size: "wall" })).toContain('class="kc-lcd kc-lcd--wall"');
    expect(lcd(live, { size: "panel" })).toContain('class="kc-lcd"');
  });
  it("wall size with no head and no freq (the error state) has no empty row wrapper", () => {
    const h = lcd({ state: "error", meta: "Radio error", name: "SDR KIOSK01 not found", freq: "", silent: null }, { size: "wall" });
    expect(h).not.toContain("kc-lcd__row");
    expect(h).not.toContain("MHz");
    expect(h).toContain("SDR KIOSK01 not found");
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/faceplate.lcd.test.ts`
Expected: FAIL — `segmentsLit` is not exported; head/segments/size are ignored.

- [ ] **Step 3: Implement** — in `src/frontend/faceplate/lcd.ts`:

Add the import under the existing ones:
```ts
import type { ServiceHead } from "./serviceHead.js";
```
Replace `export interface LcdOpts { dbfs?: number | null }` with:
```ts
export interface LcdOpts {
  dbfs?: number | null;
  /** The kiosk's service disc, left of the name and frequency. */
  head?: ServiceHead;
  /** The kiosk's segmented meter under the frequency; fill is 0..1 (clamped).
   *  When present it replaces the four-bar meter on the meta line. Each caller
   *  owns its dB→fill mapping (the admin and kiosk scales differ). */
  segments?: { count: number; fill: number };
  /** "wall" is the kiosk's room-distance glass. */
  size?: "panel" | "wall";
}

/** Lit segments for a 0..1 fill; NaN and out-of-range clamp. */
export function segmentsLit(fill: number, count: number): number {
  if (!Number.isFinite(fill)) return 0;
  return Math.round(Math.max(0, Math.min(1, fill)) * count);
}

function headSvg(h: ServiceHead): string {
  return `<svg class="kc-lcd__head${h.ringed ? " kc-lcd__head--ringed" : ""}" viewBox="0 0 42 42" aria-hidden="true">`
    + `<circle cx="21" cy="21" r="21" fill="${h.color}"/>`
    + `<g transform="translate(9 9)" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${h.glyph}</g></svg>`;
}

function segs(s: { count: number; fill: number }): string {
  const lit = segmentsLit(s.fill, s.count);
  return `<div class="kc-lcd__seg" aria-hidden="true">${Array.from({ length: s.count }, (_, i) => (i < lit ? '<i class="on"></i>' : "<i></i>")).join("")}</div>`;
}
```
Replace the body of `lcd()` with:
```ts
export function lcd(v: LcdInput, o: LcdOpts = {}): string {
  // Live state always carries the dB slot (empty until the first reading) so a
  // caller can update it in place at signal rate; aria-hidden because it
  // changes ~4×/s inside the host's polite live region.
  const db = v.state === "live" ? `<span class="kc-lcd__db" aria-hidden="true">${dbText(o.dbfs)}</span>` : "";
  const silent = v.silent ? ` <span class="kc-lcd__silent">${v.silent}</span>` : "";
  const bars = v.state === "detail" || o.segments ? "" : meter(v.state === "live" ? o.dbfs : null);
  const cls = o.size === "wall" ? "kc-lcd kc-lcd--wall" : "kc-lcd";
  const text = `<div class="kc-lcd__name">${esc(v.name)}</div>
    ${v.freq ? `<div class="kc-lcd__freq">${esc(v.freq)}<small>MHz</small></div>` : ""}`;
  const body = o.head
    ? `<div class="kc-lcd__row">${headSvg(o.head)}<div class="kc-lcd__text">${text}</div></div>`
    : text;
  return `<div class="${cls}" data-state="${v.state}">
    <div class="kc-lcd__meta"><span>${bars}${esc(v.meta)}${silent}</span>${db}</div>
    ${body}
  ${o.segments ? segs(o.segments) : ""}</div>`;
}
```

> Re-run the Task 3 byte-identical test after this edit. With no options the output must be unchanged; if the whitespace normalisation in that test differs, fix the template, not the expectation.

- [ ] **Step 4: Add the CSS** — append to `src/frontend/faceplate/lcd.css`:

```css

/* ── kiosk extras (spec 2026-10-01) ── */
:where(html[data-page="admin"], html[data-page="dashboard"]) .kc-lcd__row { display: flex; align-items: center; gap: 0.6em; margin-top: 8px; }
:where(html[data-page="admin"], html[data-page="dashboard"]) .kc-lcd__row .kc-lcd__name { margin-top: 0; }
:where(html[data-page="admin"], html[data-page="dashboard"]) .kc-lcd__text { min-width: 0; }
:where(html[data-page="admin"], html[data-page="dashboard"]) .kc-lcd__head { flex: none; width: 4.5rem; height: 4.5rem; border-radius: 50%; color: var(--kc-pin-glyph); }
:where(html[data-page="admin"], html[data-page="dashboard"]) .kc-lcd__head--ringed { box-shadow: 0 0 0 2px var(--kc-pin-cream); }
:where(html[data-page="admin"], html[data-page="dashboard"]) .kc-lcd__seg { display: flex; gap: 3px; height: 8px; margin-top: 12px; }
:where(html[data-page="admin"], html[data-page="dashboard"]) .kc-lcd__seg i { flex: 1; border-radius: 2px; background: var(--kc-glass); opacity: 0.14; }
:where(html[data-page="admin"], html[data-page="dashboard"]) .kc-lcd__seg i.on { opacity: 1; box-shadow: 0 0 8px color-mix(in srgb, var(--kc-glass) 40%, transparent); }

/* wall size — the kiosk's glass, read from across the room */
:where(html[data-page="admin"], html[data-page="dashboard"]) .kc-lcd--wall { padding: 1.9rem 2.4rem 2rem; border-radius: var(--kc-r-sheet); }
:where(html[data-page="admin"], html[data-page="dashboard"]) .kc-lcd--wall .kc-lcd__meta { font-size: var(--kc-k-glass-meta); }
:where(html[data-page="admin"], html[data-page="dashboard"]) .kc-lcd--wall .kc-lcd__name { font-size: var(--kc-k-glass-name); }
:where(html[data-page="admin"], html[data-page="dashboard"]) .kc-lcd--wall .kc-lcd__freq { font-size: var(--kc-k-glass-freq); text-shadow: 0 0 24px color-mix(in srgb, var(--kc-glass) 35%, transparent); }
:where(html[data-page="admin"], html[data-page="dashboard"]) .kc-lcd--wall .kc-lcd__head { width: var(--kc-k-head); height: var(--kc-k-head); }
:where(html[data-page="admin"], html[data-page="dashboard"]) .kc-lcd--wall .kc-lcd__row { gap: 1.8rem; margin-top: 1rem; }
:where(html[data-page="admin"], html[data-page="dashboard"]) .kc-lcd--wall .kc-lcd__seg { height: 12px; gap: 5px; margin-top: 1.4rem; }
```

- [ ] **Step 5: Run to verify they pass**

Run: `npx vitest run test/faceplate.lcd.test.ts test/admin.kit.test.ts test/cssVarsDeclared.test.ts && npm run typecheck`
Expected: PASS, typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add src/frontend/faceplate/lcd.ts src/frontend/faceplate/lcd.css test/faceplate.lcd.test.ts
git commit -m "feat(faceplate): LCD service head, segmented meter and wall size

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: DESIGN.md, full verification, PR

**Files:**
- Modify: `DESIGN.md` (repo root; `kiosk/DESIGN.md` is a symlink to it)

**Interfaces:**
- Consumes: everything above. Produces: documentation only.

- [ ] **Step 1: Update DESIGN.md**

1. Front-matter `colors:` under the layer-2 block, after `kc-ok`:
   ```yaml
   kc-pin-cream: "#f5ebe8"
   kc-pin-glyph: "#ffffff"
   ```
2. In `### The LCD (signature)`, change its first line to name the new home and append:
   ```markdown
   `lcd()` lives in `src/frontend/faceplate/lcd.ts` (styles in
   `faceplate/lcd.css`), shared by the admin and the kiosk. Three options
   are used by the kiosk only:
   - **Service head** (`head`, from `faceplate/serviceHead.ts`): the
     service-coloured disc with its pin's lucide glyph in `--kc-pin-glyph`,
     left of the name and frequency. The glyph is extracted from the map's
     pin SVG, so the pin stays the one source. A disc under 3:1 on the well
     (business, rail) wears a 2px `--kc-pin-cream` ring.
   - **Segmented meter** (`segments`): a row of sea-glass segments under the
     frequency (unlit at 14%), replacing the four-bar meter on the meta line.
     Each caller owns its dB→fill mapping.
   - **Wall size** (`size: "wall"`, `.kc-lcd--wall`): the room-distance
     glass, sized by the `--kc-k-glass-*` tokens.
   ```
3. In `## Typography`, after the admin table, add:
   ```markdown
   **The kiosk at room distance** (`--kc-k-*`, layer 2; used by the dashboard
   from the kiosk Faceplate work, spec 2026-10-01): pill 1.25rem · date
   1.25rem · glass meta 1.25rem · glass name 3.25rem · clock 4rem · alert
   title 3.1rem · glass frequency 6.25rem (the largest thing on the wall) ·
   service head 10rem.
   ```
4. In `## Elevation & Depth`, append:
   ```markdown
   **Motion tokens** (`--kc-grow-ms` 420ms, `--kc-release-ms` 360ms,
   `--kc-sweep-ms` 4500ms) time the kiosk's pill ↔ glass growth and its idle
   sweep. Transform and opacity only.
   ```
5. In `### Named rules` under Colors (The Layer Rule paragraph), add one sentence at the end: "`--kc-pin-cream` and `--kc-pin-glyph` mirror the map pin's literal body and glyph colours so the shared LCD never carries them as hex."

Do **not** rewrite the Layer Rule or the Ambient displays section. That is PR 2.

- [ ] **Step 2: Full definition-of-done run**

```bash
npm test
npm run test:native
npm run typecheck
npm run build
```
Expected: all pass. `npm run build` compiles the C++ helper at `--parallel 2`, which is a real thermal cost on the appliance; run it once, here.

- [ ] **Step 3: Live check** (frontend-only, so no service restart)

The build replaced `dist/` in place. Re-run the Task 3 Step 7 admin screenshot and confirm the Radio tab LCD still looks the same. Also open the Library tab's channel detail (it uses `lcd()` in `state: "detail"`) and confirm it renders. The kiosk wall is unaffected (the dashboard doesn't import `faceplate/` yet): `curl -X POST localhost:8080/api/kiosk/reload` is **not** needed.

- [ ] **Step 4: Commit, push, PR** (the spec and its amendments ride along in this PR)

```bash
git add DESIGN.md
git commit -m "docs(design): the shared LCD, the service head, kiosk tokens

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push -u origin HEAD
gh pr create --title "Kiosk Faceplate PR 1: tokens + shared LCD" --body "$(cat <<'EOF'
First of three PRs bringing the kiosk into the Faceplate × Night desk language
(spec: docs/superpowers/specs/2026-10-01-kiosk-faceplate-design.md).

- `faceplate/lcd.ts` + `lcd.css`: the admin's LCD moved to a folder the admin
  and kiosk share. Markup pinned byte-for-byte; the CSS is the same under a
  zero-specificity `:where()` scope. The admin looks identical.
- The LCD learns a service head, a segmented meter and a wall size (kiosk
  only, used from PR 2).
- `faceplate/serviceHead.ts`: the head is built from the map's own pin SVGs;
  business and rail get a pin-cream ring (under 3:1 on the glass).
- `tokens.css`: the kiosk's room-distance ramp, motion and pin tokens.
- DESIGN.md: the shared LCD and new tokens. The Layer Rule rewrite comes
  with PR 2.

Proof: npm test, test:native, typecheck, build; admin Radio/Library LCD
screenshots before/after match. The kiosk is unchanged by this PR.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 5: After merge** (per the repo's git workflow)

```bash
gh pr merge <n> --merge --delete-branch
git checkout main && git pull --ff-only && git fetch --prune
git branch -d <branch>
```
Then write the PR 2 plan against the merged code.
