# Kiosk Faceplate — PR 2: the dashboard — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the kiosk dashboard's Night Watch chrome with the approved Faceplate design: one corner (an idle pill with a sweep tick that grows into the wall-size LCD on a hit), the bare clock, the coral risk pill, the restyled storm card, and the no-Maps-key fallback — all twelve approved states.

**Architecture:** Pure, tested modules decide *what* the corner shows (`dashboard/cornerView.ts`) and *what to repaint* (`dashboard/corner.ts`); `dashboard.ts` becomes thin wiring; `dashboard.css` is rewritten under `html[data-page="dashboard"]` on layer 2 only. The grow/release is two CSS transitions on transform+opacity (a transition reverses from mid-flight on its own, which is the spec's "quick re-hit").

**Tech Stack:** TypeScript ESM (`.js` suffixes, `strict` + `noUncheckedIndexedAccess`), Vite `?raw` lucide icons, vanilla CSS custom properties, vitest (`environment: "node"` — no DOM; wiring is proven on the live wall).

**Spec:** `docs/superpowers/specs/2026-10-01-kiosk-faceplate-design.md` (Delivery item 2). Builds on PR 1 (#273): `faceplate/lcd.ts` (`lcd`, `segmentsLit`, `dbText`, `LcdInput`, `LcdOpts`), `faceplate/serviceHead.ts`, tokens `--kc-k-*`, `--kc-*-ms`.

## Global Constraints

- Branch: `feat/kiosk-faceplate-dashboard` off `main` (after #273). All commands from `kiosk/`.
- Relative imports carry `.js`. Icons: `lucide-static/icons/<name>.svg?raw` only — never hand-drawn SVG.
- Dashboard rules read **layer 2 only** (`--kc-*`), plus the storm palette (`--alert-color`/`--alert-on` and the `.alertBar[data-kind]` literals) — enforced by a new test.
- `dashboard.css` is bundled on every page: every dashboard rule is scoped `html[data-page="dashboard"]`. The shared ambient base (`:root` aliases + `body` rule used by wall/art/map) stays, labelled, untouched in meaning.
- No `backdrop-filter`, no blur, no full-screen overlay. Animations are transform/opacity only. Reduced motion kills all `.dash` animation and transition.
- Sentence case everywhere on the dashboard (the storm card included). Frequencies four decimals, tabular numerals.
- Do not change `map.css`, `map.ts`, the wall or art (PR 3 / out of scope). `map.css` still uses `--k-meta`: keep it declared.
- Frontend-only: never restart `kerchunk-kiosk`. Wall refresh = `npm run build` then `curl -X POST localhost:8080/api/kiosk/reload`.
- Never unmute or change volume on the appliance to stage a screenshot (it's the operator's live radio).

## Review Focus

- **A hit while the glass is releasing** (channel hops faster than 360 ms): the glass must reverse from where it is, not snap or flash the pill. Covered by transitions (CSS) + `cornerPaint` keeping the old glass content while it shrinks (Task 3 test).
- **A channel with no service tag and an unrecognised frequency** → `unknown`: the glass must still render (grey head, meta just "Live"), never throw (Task 1 test).
- **`warmupOf` = 0 or a phase the labels don't know** → no `NaN` segments, the raw phase shown (Task 1 test).
- **A storm label that is already mixed case** (a flagged channel's alphaTag like "KC Fire Dispatch" raised via "Alert when heard") must not be lower-cased into "Kc fire dispatch" (Task 1 test).
- **Status poll not yet answered** (`scanCount` = −1): must read as scanning, never "Standby" (Task 1 test).

---

## File structure

| File | Responsibility |
|---|---|
| `src/frontend/dashboard/cornerView.ts` (create) | Pure: dashboard state → `CornerView` (pill or glass, with a content key); `windowLabel`, `serviceLabel`, `sentenceCase`, `meterFill`, constants. |
| `src/frontend/dashboard/corner.ts` (create) | Pure: `pillHtml`, `glassHtml`, `cornerPaint` (what to rebuild). |
| `src/frontend/dashboard/dashboard.ts` (modify) | Wiring: new skeleton, corner paint, risk pill, clock + lucide weather, alert card in the corner, status poll (mode/breakIn). Removes rail, badge, boot overlay, old now-card. `NowPlaying` gains `tags`. |
| `src/frontend/dashboard/dashboard.css` (rewrite) | Shared ambient base (kept) + the dashboard on layer 2. |
| `src/frontend/faceplate/lcd.ts`, `lcd.css` (modify) | Wall size never draws the 4-bar meter; `hint` option; error state styling; export `segmentsHtml`. |
| `src/frontend/tokens.css` (modify) | `--kc-k-glass-error`. |
| `src/frontend/main.ts` (modify) | `FONT_QUERY.dashboard` → Schibsted Grotesk. |
| `test/dashboard.cornerView.test.ts`, `test/dashboard.corner.test.ts`, `test/dashboardLayer.test.ts` (create) | Unit + layer-rule tests. |
| `test/dashboardState.test.ts`, `test/faceplate.lcd.test.ts`, `test/tokens.test.ts` (modify) | Tags on nowPlaying; LCD wall/hint/error; new token. |
| `DESIGN.md`, `kiosk/src/frontend/tokens.css` header, `CLAUDE.md` (modify) | Layer Rule rewrite, dashboard subsection, banner-scope line. |

---

### Task 1: The corner view model

**Files:**
- Create: `src/frontend/dashboard/cornerView.ts`, `test/dashboard.cornerView.test.ts`
- Modify: `src/frontend/dashboard/dashboard.ts` (`NowPlaying`, `reduce` cases `active`/`audible`), `test/dashboardState.test.ts`

**Interfaces:**
- Consumes: `categoryFor`, `PinCategory` (`lib/serviceColor.ts`); `spectrumLabelFor` (`backend/config/banks.ts`); `fmtFreq` (`lib/format.ts`); `LcdInput`, `segmentsLit` (`faceplate/lcd.ts`); `serviceHead`, `ServiceHead` (`faceplate/serviceHead.ts`).
- Produces:
  ```ts
  export const METER_SEGMENTS = 12;
  export const METER_RANGE_DB = { floor: -35, ceil: 5 } as const;
  export const WARM_LABELS: Record<string, string>;
  export const ERROR_HINT: string;
  export function meterFill(db: number | null): number;          // unclamped; lcd clamps
  export function windowLabel(hz: number): string;               // "VHF high 160.9"
  export function serviceLabel(cat: PinCategory): string;        // "Public safety", "" for unknown
  export function sentenceCase(s: string): string;               // only rewrites ALL-CAPS
  export interface CornerInput {
    warmed: boolean; warmupPhase: string | null; warmupStep: number; warmupOf: number;
    error: string | null; engineState: string;
    nowPlaying: { freq: number; alphaTag: string; tags?: readonly string[] } | null;
    tunedHz: number | null; scanCount: number; muted: boolean;
    mode: "scan" | "weather" | "monitor"; breakIn: boolean;
  }
  export interface PillView { show: "pill"; key: string; word: string; detail: string; tone: "plain" | "hay"; muted: boolean; sweep: boolean; warmLit: number | null }
  export interface GlassView { show: "glass"; key: string; lcd: LcdInput; head: ServiceHead | null; hint: string | null; meter: boolean }
  export type CornerView = PillView | GlassView;
  export function cornerView(i: CornerInput): CornerView;
  ```
  `NowPlaying` (dashboard.ts) becomes `{ freq: number; alphaTag: string; tags?: readonly string[] }`.

- [ ] **Step 1: Write the failing tests** — `test/dashboard.cornerView.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { cornerView, windowLabel, serviceLabel, sentenceCase, meterFill, METER_SEGMENTS, type CornerInput } from "../src/frontend/dashboard/cornerView.js";

const base: CornerInput = {
  warmed: true, warmupPhase: null, warmupStep: 0, warmupOf: 4, error: null, engineState: "running",
  nowPlaying: null, tunedHz: 160_900_000, scanCount: 41, muted: false, mode: "scan", breakIn: false,
};
const live = { freq: 154_430_000, alphaTag: "KC Fire Dispatch", tags: ["public-safety"] };

describe("cornerView — pill states", () => {
  it("scanning: pill with the window label and the sweep", () => {
    const v = cornerView(base);
    expect(v).toMatchObject({ show: "pill", word: "Scanning", detail: "VHF high 160.9", tone: "plain", sweep: true, muted: false, warmLit: null });
  });
  it("scanning while muted carries the muted flag", () => {
    expect(cornerView({ ...base, muted: true })).toMatchObject({ show: "pill", muted: true });
  });
  it("an unanswered status poll (scanCount −1) reads as scanning, not standby", () => {
    expect(cornerView({ ...base, scanCount: -1 })).toMatchObject({ word: "Scanning" });
  });
  it("retuning while the engine starts", () => {
    expect(cornerView({ ...base, engineState: "starting" })).toMatchObject({ word: "Retuning", detail: "changing windows", sweep: true });
  });
  it("standby is a hay pill with no sweep", () => {
    expect(cornerView({ ...base, scanCount: 0 })).toMatchObject({ word: "Standby", tone: "hay", sweep: false, detail: "no channels are on — turn a bank on in the admin" });
  });
  it("weather-only and monitor modes name themselves", () => {
    expect(cornerView({ ...base, mode: "weather" })).toMatchObject({ word: "Weather only" });
    expect(cornerView({ ...base, mode: "monitor" })).toMatchObject({ word: "Listening to one channel" });
  });
  it("warming up fills the pill's segments by step", () => {
    const v = cornerView({ ...base, warmed: false, warmupPhase: "spawning", warmupStep: 2, warmupOf: 4 });
    expect(v).toMatchObject({ show: "pill", word: "Warming up", detail: "step 2 of 4 · building signal processing", sweep: false, warmLit: 6 });
  });
  it("warm-up with of=0 or an unknown phase never yields NaN", () => {
    const v = cornerView({ ...base, warmed: false, warmupPhase: "mystery", warmupStep: 1, warmupOf: 0 });
    expect(v).toMatchObject({ warmLit: 0, detail: "step 1 of 0 · mystery" });
  });
  it("no tuned window yet → empty detail", () => {
    expect(cornerView({ ...base, tunedHz: null })).toMatchObject({ detail: "" });
  });
});

describe("cornerView — glass states", () => {
  it("live: service head, sentence-case meta, tag-first name, four-decimal freq", () => {
    const v = cornerView({ ...base, nowPlaying: live });
    expect(v.show).toBe("glass");
    if (v.show !== "glass") return;
    expect(v.lcd).toEqual({ state: "live", meta: "Live · Public safety", name: "KC Fire Dispatch", freq: "154.4300", silent: null });
    expect(v.head?.color).toBe("#E5383B");
    expect(v.meter).toBe(true);
    expect(v.hint).toBeNull();
  });
  it("muted live glass shows Muted in the silent slot", () => {
    const v = cornerView({ ...base, nowPlaying: live, muted: true });
    expect(v.show === "glass" && v.lcd.silent).toBe("Muted");
  });
  it("an untagged unknown frequency still renders (grey head, bare Live meta)", () => {
    const v = cornerView({ ...base, nowPlaying: { freq: 30_000_000, alphaTag: "" } });
    if (v.show !== "glass") throw new Error("expected glass");
    expect(v.lcd.meta).toBe("Live");
    expect(v.lcd.name).toBe("30.0000");
    expect(v.lcd.freq).toBe("");
    expect(v.head?.color).toBe("#747B8A");
  });
  it("weather break-in: breakin state, hay meta prefix", () => {
    const v = cornerView({ ...base, mode: "weather", breakIn: true, nowPlaying: { freq: 162_550_000, alphaTag: "NWS Kansas City" } });
    if (v.show !== "glass") throw new Error("expected glass");
    expect(v.lcd.state).toBe("breakin");
    expect(v.lcd.meta).toBe("Weather break-in · NOAA");
  });
  it("error takes the glass with the recovery hint, no head, no meter", () => {
    const v = cornerView({ ...base, error: "SDR KIOSK01 not found", nowPlaying: live });
    expect(v).toMatchObject({ show: "glass", head: null, meter: false, lcd: { state: "error", meta: "Radio error", name: "SDR KIOSK01 not found", freq: "" } });
    expect(v.show === "glass" && v.hint).toMatch(/restart the radio from System/);
  });
  it("keys change with what's drawn, not with signal level", () => {
    const a = cornerView({ ...base, nowPlaying: live });
    expect(cornerView({ ...base, nowPlaying: live }).key).toBe(a.key);
    expect(cornerView({ ...base, nowPlaying: live, muted: true }).key).not.toBe(a.key);
    expect(cornerView({ ...base, nowPlaying: { ...live, freq: 154_445_000 } }).key).not.toBe(a.key);
  });
});

describe("cornerView helpers", () => {
  it("windowLabel sentence-cases the spectrum names", () => {
    expect(windowLabel(120_000_000)).toBe("Airband 120.0");
    expect(windowLabel(146_000_000)).toBe("2 m 146.0");
    expect(windowLabel(462_000_000)).toBe("UHF-T 462.0");
  });
  it("serviceLabel", () => {
    expect(serviceLabel("publicsafety")).toBe("Public safety");
    expect(serviceLabel("biz")).toBe("Business");
    expect(serviceLabel("unknown")).toBe("");
  });
  it("sentenceCase rewrites ALL-CAPS only", () => {
    expect(sentenceCase("TORNADO WARNING")).toBe("Tornado warning");
    expect(sentenceCase("KC Fire Dispatch")).toBe("KC Fire Dispatch");
    expect(sentenceCase("")).toBe("");
  });
  it("meterFill maps the kiosk dB range onto 0..1", () => {
    expect(meterFill(null)).toBe(0);
    expect(meterFill(-35)).toBe(0);
    expect(meterFill(5)).toBe(1);
    expect(meterFill(-15)).toBe(0.5);
    expect(METER_SEGMENTS).toBe(12);
  });
});
```

Append to `test/dashboardState.test.ts` (inside the `describe("dashboard reduce", …)` block, before its closing `});`):

```ts
  it("audible carries the channel's service tags onto nowPlaying", () => {
    const ch = { id: "c1", freq: 154_430_000, alphaTag: "KC Fire", mode: "nfm" as const, enabled: true, tags: ["public-safety"] };
    const s = reduce(initialState(), { type: "audible", channel: ch, ts: 1 } as never);
    expect(s.nowPlaying).toEqual({ freq: 154_430_000, alphaTag: "KC Fire", tags: ["public-safety"] });
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/dashboard.cornerView.test.ts test/dashboardState.test.ts`
Expected: FAIL — cornerView module missing; the audible test fails on the missing `tags`.

- [ ] **Step 3: Implement** — `src/frontend/dashboard/cornerView.ts`:

```ts
// What the kiosk's bottom-left corner shows (spec 2026-10-01): the small idle
// pill or the wall-size glass. Pure — dashboard.ts feeds it state and paints
// the result; tests pin every one of the twelve approved states.
import { categoryFor, type PinCategory } from "../lib/serviceColor.js";
import { spectrumLabelFor } from "../../backend/config/banks.js";
import { fmtFreq } from "../lib/format.js";
import { segmentsLit, type LcdInput } from "../faceplate/lcd.js";
import { serviceHead, type ServiceHead } from "../faceplate/serviceHead.js";

/** Segments in the glass meter and the warm-up pill — one instrument. */
export const METER_SEGMENTS = 12;
/** The kiosk meter's dB range: the floor lights nothing, the ceiling all. */
export const METER_RANGE_DB = { floor: -35, ceil: 5 } as const;

export const WARM_LABELS: Record<string, string> = {
  booting: "starting the radio",
  spawning: "building signal processing",
  tuned: "acquiring channels",
  ready: "ready",
};

export const ERROR_HINT = "Scanning resumes on its own. If this stays up, restart the radio from System in the admin.";

/** dB → 0..1 across METER_RANGE_DB (unclamped; the LCD clamps). */
export function meterFill(db: number | null): number {
  return db === null ? 0 : (db - METER_RANGE_DB.floor) / (METER_RANGE_DB.ceil - METER_RANGE_DB.floor);
}

const WINDOW_NAMES: Record<string, string> = {
  AIRBAND: "Airband", "2M": "2 m", "VHF-HI": "VHF high", "1.25M": "1.25 m", "70CM": "70 cm",
  "UHF-T": "UHF-T", "T-BAND": "T-band", "700": "700 MHz", "800": "800 MHz", "900": "900 MHz",
};

/** The tuned window, e.g. "VHF high 160.9" — the old bank rail's spectrum chip, in words. */
export function windowLabel(hz: number): string {
  const raw = spectrumLabelFor(hz);
  return `${WINDOW_NAMES[raw] ?? raw} ${(hz / 1e6).toFixed(1)}`;
}

const SERVICE_LABEL: Record<PinCategory, string> = {
  air: "Air", rail: "Rail", ham: "Ham", gmrs: "GMRS", biz: "Business", marine: "Marine",
  weather: "Weather", publicsafety: "Public safety", unknown: "",
};
export function serviceLabel(cat: PinCategory): string { return SERVICE_LABEL[cat]; }

/** "TORNADO WARNING" → "Tornado warning". Mixed case (an operator's channel name) is left alone. */
export function sentenceCase(s: string): string {
  return /[a-z]/.test(s) ? s : s.charAt(0) + s.slice(1).toLowerCase();
}

export interface CornerInput {
  warmed: boolean; warmupPhase: string | null; warmupStep: number; warmupOf: number;
  error: string | null; engineState: string;
  nowPlaying: { freq: number; alphaTag: string; tags?: readonly string[] } | null;
  tunedHz: number | null; scanCount: number; muted: boolean;
  mode: "scan" | "weather" | "monitor"; breakIn: boolean;
}
export interface PillView { show: "pill"; key: string; word: string; detail: string; tone: "plain" | "hay"; muted: boolean; sweep: boolean; warmLit: number | null }
export interface GlassView { show: "glass"; key: string; lcd: LcdInput; head: ServiceHead | null; hint: string | null; meter: boolean }
export type CornerView = PillView | GlassView;

// A head that can't be built (a pin SVG that lost its glyph group) must not
// take the wall down: the glass renders without it.
function safeHead(cat: PinCategory): ServiceHead | null {
  try { return serviceHead(cat); } catch { return null; }
}

function pill(p: Omit<PillView, "show" | "key">): PillView {
  return { show: "pill", key: `pill|${p.word}|${p.detail}|${p.tone}|${p.muted}|${p.sweep}|${p.warmLit}`, ...p };
}

function glass(g: Omit<GlassView, "show" | "key">): GlassView {
  const l = g.lcd;
  return { show: "glass", key: `glass|${l.state}|${l.meta}|${l.name}|${l.freq}|${l.silent}|${g.head?.color ?? ""}|${g.hint ?? ""}`, ...g };
}

function modeWord(mode: CornerInput["mode"]): string {
  return mode === "weather" ? "Weather only" : mode === "monitor" ? "Listening to one channel" : "Scanning";
}

export function cornerView(i: CornerInput): CornerView {
  if (!i.warmed) {
    const label = i.warmupPhase ? (WARM_LABELS[i.warmupPhase] ?? i.warmupPhase) : WARM_LABELS.booting!;
    return pill({
      word: "Warming up", detail: `step ${i.warmupStep} of ${i.warmupOf} · ${label}`, tone: "plain",
      muted: i.muted, sweep: false, warmLit: segmentsLit(i.warmupStep / i.warmupOf, METER_SEGMENTS),
    });
  }
  if (i.error) {
    return glass({ lcd: { state: "error", meta: "Radio error", name: i.error, freq: "", silent: null }, head: null, hint: ERROR_HINT, meter: false });
  }
  if (i.nowPlaying) {
    const { freq, alphaTag, tags } = i.nowPlaying;
    const cat = categoryFor(freq, tags);
    const prefix = i.breakIn ? "Weather break-in"
      : i.mode === "weather" ? "Weather only"
      : i.mode === "monitor" ? "Listening to one channel" : "Live";
    // A break-in is always NOAA weather radio — say so, not "· Weather".
    const svc = i.breakIn ? "NOAA" : serviceLabel(cat);
    return glass({
      lcd: {
        state: i.breakIn ? "breakin" : "live",
        meta: svc ? `${prefix} · ${svc}` : prefix,
        name: alphaTag || fmtFreq(freq),
        freq: alphaTag ? fmtFreq(freq) : "",
        silent: i.muted ? "Muted" : null,
      },
      head: safeHead(cat), hint: null, meter: true,
    });
  }
  if (i.engineState === "starting") {
    return pill({ word: "Retuning", detail: "changing windows", tone: "plain", muted: i.muted, sweep: true, warmLit: null });
  }
  if (i.scanCount === 0) {
    return pill({ word: "Standby", detail: "no channels are on — turn a bank on in the admin", tone: "hay", muted: i.muted, sweep: false, warmLit: null });
  }
  return pill({
    word: modeWord(i.mode), detail: i.tunedHz !== null ? windowLabel(i.tunedHz) : "",
    tone: "plain", muted: i.muted, sweep: true, warmLit: null,
  });
}
```

In `src/frontend/dashboard/dashboard.ts`:
- `export interface NowPlaying { freq: number; alphaTag: string; }` → `export interface NowPlaying { freq: number; alphaTag: string; tags?: readonly string[]; }`
- In `reduce`, case `"active"`, the `nowPlaying:` line becomes
  `nowPlaying: s.audibleDriven ? s.nowPlaying : { freq: ev.freq, alphaTag: ev.channel.alphaTag, ...(ev.channel.tags ? { tags: ev.channel.tags } : {}) },`
- case `"audible"`, the `nowPlaying:` line becomes
  `nowPlaying: ev.channel ? { freq: ev.channel.freq, alphaTag: ev.channel.alphaTag, ...(ev.channel.tags ? { tags: ev.channel.tags } : {}) } : null,`

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run test/dashboard.cornerView.test.ts test/dashboardState.test.ts && npm run typecheck`
Expected: PASS; typecheck clean. If `"2 m 146.0"` fails because 146 MHz sits outside `2M` (144–148), it won't — but if `UHF-T` fails, read `SPECTRUM` in `backend/config/banks.ts` and fix the *test's* frequency, not the map.

- [ ] **Step 5: Commit**

```bash
git add src/frontend/dashboard/cornerView.ts src/frontend/dashboard/dashboard.ts test/dashboard.cornerView.test.ts test/dashboardState.test.ts
git commit -m "feat(dashboard): corner view model — the twelve states as a pure function

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: LCD fit for the wall (no dead bars, a hint line, error styling)

**Files:**
- Modify: `src/frontend/faceplate/lcd.ts`, `src/frontend/faceplate/lcd.css`, `src/frontend/tokens.css`
- Test: `test/faceplate.lcd.test.ts`, `test/tokens.test.ts`

**Interfaces:**
- Produces: `LcdOpts.hint?: string` (renders `<div class="kc-lcd__hint">`); `export function segmentsHtml(s: { count: number; fill: number }): string` (the existing private `segs`, renamed and exported — the warm-up pill reuses it); wall size (`size: "wall"`) never renders `.kc-meter`; token `--kc-k-glass-error`.

- [ ] **Step 1: Write the failing tests** — append to `test/faceplate.lcd.test.ts`:

```ts
import { segmentsHtml } from "../src/frontend/faceplate/lcd.js";

describe("faceplate lcd — wall fit (PR 2)", () => {
  it("wall size never draws the four-bar meta meter (the error glass has no dead bars)", () => {
    const h = lcd({ state: "error", meta: "Radio error", name: "x", freq: "", silent: null }, { size: "wall" });
    expect(h).not.toContain("kc-meter");
  });
  it("panel size keeps the four-bar meter (the admin)", () => {
    expect(lcd({ state: "live", meta: "m", name: "n", freq: "1", silent: null })).toContain("kc-meter");
  });
  it("hint renders escaped under the name", () => {
    const h = lcd({ state: "error", meta: "Radio error", name: "x", freq: "", silent: null }, { size: "wall", hint: "Restart <it>" });
    expect(h).toContain('<div class="kc-lcd__hint">Restart &lt;it&gt;</div>');
    expect(h.indexOf("kc-lcd__name")).toBeLessThan(h.indexOf("kc-lcd__hint"));
  });
  it("segmentsHtml is the exported segment row", () => {
    expect(segmentsHtml({ count: 4, fill: 0.5 })).toBe('<div class="kc-lcd__seg" aria-hidden="true"><i class="on"></i><i class="on"></i><i></i><i></i></div>');
  });
});
```

In `test/tokens.test.ts`, add `"--kc-k-glass-error"` to the `ramp` array.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/faceplate.lcd.test.ts test/tokens.test.ts`
Expected: FAIL — `segmentsHtml` not exported; wall error has `kc-meter`; no hint; `--kc-k-glass-error missing`.

- [ ] **Step 3: Implement**

`src/frontend/faceplate/lcd.ts`:
- In `LcdOpts`, after `size?`, add:
  ```ts
  /** A muted line under the name — the kiosk's error glass says how it recovers. */
  hint?: string;
  ```
- Rename `function segs(` → `export function segmentsHtml(` and its one call site `segs(o.segments)` → `segmentsHtml(o.segments)`. Give it the doc comment `/** The segmented meter row (also the kiosk's warm-up pill). */`.
- `const bars = v.state === "detail" || o.segments ? "" : meter(...)` → `const bars = v.state === "detail" || o.segments || o.size === "wall" ? "" : meter(v.state === "live" ? o.dbfs : null);`
- In the returned template, after `${body}`, add `${o.hint ? `<div class="kc-lcd__hint">${esc(o.hint)}</div>` : ""}` on its own line before the segments line.

Append to `src/frontend/faceplate/lcd.css`:
```css

/* ── error glass + hint (PR 2) ── */
:where(html[data-page="admin"], html[data-page="dashboard"]) .kc-lcd[data-state="error"] .kc-lcd__meta { color: var(--kc-coral); opacity: 1; }
:where(html[data-page="admin"], html[data-page="dashboard"]) .kc-lcd[data-state="error"] .kc-lcd__name { color: var(--kc-ink); }
:where(html[data-page="admin"], html[data-page="dashboard"]) .kc-lcd--wall[data-state="error"] .kc-lcd__name { font-size: var(--kc-k-glass-error); }
:where(html[data-page="admin"], html[data-page="dashboard"]) .kc-lcd__hint { color: var(--kc-mute); font-size: var(--kc-t-small); line-height: 1.4; margin-top: 6px; }
:where(html[data-page="admin"], html[data-page="dashboard"]) .kc-lcd--wall .kc-lcd__hint { font-size: var(--kc-k-glass-meta); margin-top: 0.8rem; }
```

`src/frontend/tokens.css`, after `--kc-k-alert-title`:
```css
  --kc-k-glass-error: 2.6rem;  /* the error text on the wall glass (smaller than a channel name) */
```

- [ ] **Step 4: Run to verify they pass** (the PR 1 byte-identical admin test must stay green)

Run: `npx vitest run test/faceplate.lcd.test.ts test/tokens.test.ts test/admin.kit.test.ts test/cssVarsDeclared.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/frontend/faceplate/lcd.ts src/frontend/faceplate/lcd.css src/frontend/tokens.css test/faceplate.lcd.test.ts test/tokens.test.ts
git commit -m "feat(faceplate): wall glass — no dead bars, a hint line, coral error

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Corner markup and repaint decisions

**Files:**
- Create: `src/frontend/dashboard/corner.ts`, `test/dashboard.corner.test.ts`

**Interfaces:**
- Consumes: `PillView`, `GlassView`, `CornerView`, `METER_SEGMENTS`, `meterFill` (Task 1); `lcd`, `segmentsHtml` (Task 2).
- Produces:
  ```ts
  export function pillHtml(p: PillView): string;
  export function glassHtml(g: GlassView, db: number | null): string;
  export interface CornerMemo { show: "pill" | "glass"; pillKey: string; glassKey: string }
  export interface CornerPaint { show: "pill" | "glass"; rebuildPill: boolean; rebuildGlass: boolean; memo: CornerMemo }
  export function cornerPaint(prev: CornerMemo | null, v: CornerView): CornerPaint;
  ```

- [ ] **Step 1: Write the failing tests** — `test/dashboard.corner.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { pillHtml, glassHtml, cornerPaint } from "../src/frontend/dashboard/corner.js";
import { cornerView, type CornerInput } from "../src/frontend/dashboard/cornerView.js";

const base: CornerInput = {
  warmed: true, warmupPhase: null, warmupStep: 0, warmupOf: 4, error: null, engineState: "running",
  nowPlaying: null, tunedHz: 160_900_000, scanCount: 41, muted: false, mode: "scan", breakIn: false,
};
const scanning = cornerView(base);
const live = cornerView({ ...base, nowPlaying: { freq: 154_430_000, alphaTag: "KC Fire Dispatch", tags: ["public-safety"] } });
const live2 = cornerView({ ...base, nowPlaying: { freq: 155_010_000, alphaTag: "KC Police", tags: ["public-safety"] } });

describe("pillHtml", () => {
  it("word, detail and the sweep tick", () => {
    const h = pillHtml(scanning as never);
    expect(h).toContain('class="kc-pill" data-sweep="on"');
    expect(h).toContain('<span class="kc-pill__word">Scanning</span>');
    expect(h).toContain('<span class="kc-pill__detail"> · VHF high 160.9</span>');
    expect(h).toContain('<span class="kc-pill__tick" aria-hidden="true"></span>');
  });
  it("hay tone, muted, and no sweep", () => {
    const h = pillHtml(cornerView({ ...base, scanCount: 0, muted: true }) as never);
    expect(h).toContain('class="kc-pill kc-pill--hay" data-sweep="off"');
    expect(h).toContain("kc-pill__muted");
    expect(h).toContain("Muted");
  });
  it("warm-up pill carries the 12-segment row", () => {
    const h = pillHtml(cornerView({ ...base, warmed: false, warmupPhase: "tuned", warmupStep: 3, warmupOf: 4 }) as never);
    expect(h.match(/<i class="on"><\/i>/g)?.length).toBe(9);
  });
  it("escapes the detail", () => {
    const v = { ...(scanning as object), detail: "<b>" } as never;
    expect(pillHtml(v)).toContain("&lt;b&gt;");
  });
});

describe("glassHtml", () => {
  it("is a wall-size LCD with the head and a 12-segment meter filled from dB", () => {
    const h = glassHtml(live as never, -15);
    expect(h).toContain('class="kc-lcd kc-lcd--wall" data-state="live"');
    expect(h).toContain("kc-lcd__head");
    expect(h.match(/<i class="on"><\/i>/g)?.length).toBe(6);
    expect(h).not.toContain("kc-meter");
  });
  it("the error glass has its hint and no meter", () => {
    const h = glassHtml(cornerView({ ...base, error: "boom" }) as never, null);
    expect(h).toContain("kc-lcd__hint");
    expect(h).not.toContain("kc-lcd__seg");
  });
});

describe("cornerPaint", () => {
  it("first paint builds what it shows", () => {
    expect(cornerPaint(null, scanning)).toMatchObject({ show: "pill", rebuildPill: true, rebuildGlass: false });
  });
  it("a hit grows the glass and leaves the pill's content alone", () => {
    const p0 = cornerPaint(null, scanning);
    const p1 = cornerPaint(p0.memo, live);
    expect(p1).toMatchObject({ show: "glass", rebuildGlass: true, rebuildPill: false });
  });
  it("a release keeps the glass content while it shrinks (no rebuild of the glass)", () => {
    const p1 = cornerPaint(cornerPaint(null, scanning).memo, live);
    const p2 = cornerPaint(p1.memo, scanning);
    expect(p2).toMatchObject({ show: "pill", rebuildGlass: false, rebuildPill: false });
  });
  it("a different channel while live swaps the glass in place", () => {
    const p1 = cornerPaint(cornerPaint(null, scanning).memo, live);
    expect(cornerPaint(p1.memo, live2)).toMatchObject({ show: "glass", rebuildGlass: true });
  });
  it("same view → nothing rebuilt (signal ticks update in place)", () => {
    const p1 = cornerPaint(cornerPaint(null, scanning).memo, live);
    expect(cornerPaint(p1.memo, live)).toMatchObject({ rebuildGlass: false, rebuildPill: false });
  });
  it("a re-hit on the same channel during a release reuses the glass (reverses, no rebuild)", () => {
    const p1 = cornerPaint(cornerPaint(null, scanning).memo, live);
    const p2 = cornerPaint(p1.memo, scanning);
    expect(cornerPaint(p2.memo, live)).toMatchObject({ show: "glass", rebuildGlass: false });
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/dashboard.corner.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement** — `src/frontend/dashboard/corner.ts`:

```ts
// The corner's markup and its repaint decisions (spec 2026-10-01). The pill
// and the glass both stay mounted; CSS transitions on the corner's .is-glass
// class do the grow/release. A release must not rebuild the glass — it is
// still visible while it shrinks — and a re-hit on the same channel then
// simply reverses the transition.
import icoVolumeX from "lucide-static/icons/volume-x.svg?raw";
import { esc } from "../lib/format.js";
import { lcd, segmentsHtml } from "../faceplate/lcd.js";
import { METER_SEGMENTS, meterFill, type CornerView, type GlassView, type PillView } from "./cornerView.js";

export function pillHtml(p: PillView): string {
  const cls = p.tone === "hay" ? "kc-pill kc-pill--hay" : "kc-pill";
  const muted = p.muted ? `<span class="kc-pill__muted"> · ${icoVolumeX}Muted</span>` : "";
  const detail = p.detail ? `<span class="kc-pill__detail"> · ${esc(p.detail)}</span>` : "";
  const warm = p.warmLit !== null ? segmentsHtml({ count: METER_SEGMENTS, fill: p.warmLit / METER_SEGMENTS }) : "";
  return `<div class="${cls}" data-sweep="${p.sweep ? "on" : "off"}">`
    + `<div class="kc-pill__line"><span class="kc-pill__word">${esc(p.word)}</span>${muted}${detail}</div>`
    + `${warm}<span class="kc-pill__tick" aria-hidden="true"></span></div>`;
}

export function glassHtml(g: GlassView, db: number | null): string {
  return lcd(g.lcd, {
    dbfs: db,
    size: "wall",
    ...(g.head ? { head: g.head } : {}),
    ...(g.meter ? { segments: { count: METER_SEGMENTS, fill: meterFill(db) } } : {}),
    ...(g.hint ? { hint: g.hint } : {}),
  });
}

export interface CornerMemo { show: "pill" | "glass"; pillKey: string; glassKey: string }
export interface CornerPaint { show: "pill" | "glass"; rebuildPill: boolean; rebuildGlass: boolean; memo: CornerMemo }

export function cornerPaint(prev: CornerMemo | null, v: CornerView): CornerPaint {
  const pillKey = prev?.pillKey ?? "";
  const glassKey = prev?.glassKey ?? "";
  if (v.show === "pill") {
    return { show: "pill", rebuildPill: v.key !== pillKey, rebuildGlass: false, memo: { show: "pill", pillKey: v.key, glassKey } };
  }
  return { show: "glass", rebuildPill: false, rebuildGlass: v.key !== glassKey, memo: { show: "glass", pillKey, glassKey: v.key } };
}
```

> `pillHtml`'s muted span puts the lucide `volume-x` SVG inline; it is sized in CSS (Task 5). `esc()` is applied to `word` and `detail`; the muted label and icon are constants.

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run test/dashboard.corner.test.ts && npm run typecheck`
Expected: PASS. (The "escapes the detail" test spreads a view object with a hostile detail; the warm-up count is `round(3/4 × 12) = 9`.)

- [ ] **Step 5: Commit**

```bash
git add src/frontend/dashboard/corner.ts test/dashboard.corner.test.ts
git commit -m "feat(dashboard): corner markup and repaint decisions

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Wire the dashboard

**Files:**
- Modify: `src/frontend/dashboard/dashboard.ts`, `src/frontend/main.ts:21-25`

**Interfaces:**
- Consumes: everything from Tasks 1–3; `segmentsLit`, `dbText` (`faceplate/lcd.ts`); `alertTheme` (unchanged).
- Produces: DOM ids/classes Task 5 styles: `.dash`, `#mapBase.mapBase`, `#riskPill.kc-risk`, `header.kc-clock` (`#clock.kc-clock__time`, `.kc-clock__sub` with `#clockDate` and `#wx.kc-wx`), `.kc-stage`, `#corner.kc-corner` (`.is-glass` toggled), `#alertBar.alertBar` (tier class + `data-kind`, children `.alertHead > .alertGlyph + .alertLabel`, `.alertTag`, `.alertCounties`), `.kc-corner__slot` (`role="status"`) with `#pillHost.kc-corner__pill` and `#glassHost.kc-corner__glass`, `aside.kc-recent` (`h2`, `ul#logList` with `li > span.t`).

No unit test can see the DOM here (`environment: "node"`); this task's gate is `npm test` (nothing regressed), `npm run typecheck`, and the live-wall proof in Task 6.

- [ ] **Step 1: Imports.** Replace the import block at the top of `dashboard.ts` (lines 1–10) with:

```ts
import type { EngineEvent } from "../../backend/engine/ScannerEngine.js";
import { ReconnectingWs } from "../lib/wsClient.js";
import { api } from "../lib/api.js";
import { fmtFreq, esc } from "../lib/format.js";
import { alertTheme } from "./alertTheme.js";
import { mountActivityMap } from "../map/map.js";
import { cornerView, sentenceCase, meterFill, METER_SEGMENTS } from "./cornerView.js";
import { pillHtml, glassHtml, cornerPaint, type CornerMemo } from "./corner.js";
import { segmentsLit, dbText } from "../faceplate/lcd.js";
import icoSun from "lucide-static/icons/sun.svg?raw";
import icoMoon from "lucide-static/icons/moon.svg?raw";
import icoCloud from "lucide-static/icons/cloud.svg?raw";
import icoCloudSun from "lucide-static/icons/cloud-sun.svg?raw";
import icoRain from "lucide-static/icons/cloud-rain.svg?raw";
import icoStorm from "lucide-static/icons/cloud-lightning.svg?raw";
import icoSnow from "lucide-static/icons/cloud-snow.svg?raw";
import icoFog from "lucide-static/icons/cloud-fog.svg?raw";
import icoWind from "lucide-static/icons/wind.svg?raw";
import icoArrow from "lucide-static/icons/navigation-2.svg?raw";
import "./dashboard.css";
```

(Removed: `icoVolumeX` — now in corner.ts; `matchesBank`, `spectrumLabelFor`, `Bank`, `Channel` — the bank rail is gone.)

- [ ] **Step 2: Skeleton.** Replace the `root.innerHTML = \`…\`;` block (lines 133–158) with:

```ts
  root.innerHTML = `
    <div class="dash">
      <div id="mapBase" class="mapBase"></div>
      <div id="riskPill" class="kc-risk" role="status" hidden></div>
      <header class="kc-clock">
        <div id="clock" class="kc-clock__time"></div>
        <div class="kc-clock__sub"><span id="clockDate"></span><span id="wx" class="kc-wx"></span></div>
      </header>
      <div class="kc-stage">
        <div id="corner" class="kc-corner">
          <div id="alertBar" class="alertBar"></div>
          <div class="kc-corner__slot" role="status">
            <div id="pillHost" class="kc-corner__pill"></div>
            <div id="glassHost" class="kc-corner__glass"></div>
          </div>
        </div>
        <aside class="kc-recent"><h2>Recently heard</h2><ul id="logList"></ul></aside>
      </div>
    </div>`;
```

- [ ] **Step 3: Risk pill.** Replace `const systemRisk = …` and the whole `paintSystemRisk` body so it writes the coral pill:

```ts
  const riskEl = root.querySelector<HTMLElement>("#riskPill")!;
```
and inside `paintSystemRisk`, replace the two writes (`systemRisk.innerHTML = …` and `systemRisk.classList.toggle(…)`) with:
```ts
      riskEl.textContent = severe.length
        ? `Machine warning · ${severe.map((a: { title: string }) => a.title).join(" · ")}`
        : "";
      riskEl.hidden = severe.length === 0;
```

- [ ] **Step 4: Status poll → mode and break-in.** Replace `const nowEl …`, `const modeBadge …` and `paintBadge` with:

```ts
  const logEl = root.querySelector<HTMLElement>("#logList")!;
  let rafPending = false;
  function schedule(): void {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => { rafPending = false; paint(); });
  }
  let mode: "scan" | "weather" | "monitor" = "scan";
  let breakIn = false;
  function paintStatus(): Promise<void> {
    return api.getStatus()
      .then((s) => {
        const sc = s.scanCount ?? -1;
        const mu = s.muted ?? false;
        const bi = s.breakIn ?? false;
        // Late-load correction ONLY (see the warm-up notes below): once the WS
        // warmup stream is seen it owns `warmed`.
        const wm = (!sawWarmupEvent && typeof s.warmed === "boolean") ? s.warmed : state.warmed;
        const changed = s.mode !== mode || sc !== scanCount || mu !== muted || bi !== breakIn || wm !== state.warmed;
        mode = s.mode; scanCount = sc; muted = mu; breakIn = bi;
        if (wm !== state.warmed) state = { ...state, warmed: wm };
        if (changed) schedule();
      })
      .catch(() => {});
  }
  // Mute flips in the admin without an engine restart — polled so the kiosk
  // tracks it within a few seconds.
  poll(paintStatus, POLL_MS.status);
```

Keep the existing `let scanCount = -1;`, `let sawWarmupEvent = false;`, `let muted = false;` lines.

- [ ] **Step 5: Delete the retired machinery.** Remove entirely: the bank-rail block (`railEl`, `cfgBanks`, `cfgChannels`, `loadBanks`, `loadBanks();`, `paintRail`), the warm-up overlay block (`bootEl` … `paintBoot`), the old now-card block (`lastView`, `meterFillEl`, `meterDbEl`, `meterPct`), `syncMutedBadge`, and the old `paint()`.

- [ ] **Step 6: Alert card into the corner, sentence case.** In `paintAlert`, replace the `tierLabel` expression and the tag line:

```ts
      const tierLabel = theme.tier === "watch" ? "Watch"
        : theme.tier === "statement" ? "Statement" : "Warning";
```
and
```ts
        + `<div class="alertTag">${esc(sentenceCase(state.alert.alphaTag))}</div>`
```
(The element already lives inside `#corner` from Step 2; nothing else in `paintAlert` changes. Update its comment's "Lower-right overlay card" to "Stacked above the corner".)

- [ ] **Step 7: The corner paint.** Add, where the old `paint()` was:

```ts
  // ── The corner (spec 2026-10-01): the idle pill or the wall-size glass.
  // cornerView decides what shows; cornerPaint decides what to rebuild; the
  // .is-glass class drives the CSS grow/release transitions. Signal ticks on
  // the same channel only move the segments and the dB text.
  const cornerEl = root.querySelector<HTMLElement>("#corner")!;
  const pillHost = root.querySelector<HTMLElement>("#pillHost")!;
  const glassHost = root.querySelector<HTMLElement>("#glassHost")!;
  let memo: CornerMemo | null = null;
  let segEls: HTMLElement[] = [];
  let dbEl: HTMLElement | null = null;

  function paint(): void {
    paintAlert();
    const v = cornerView({
      warmed: state.warmed, warmupPhase: state.warmupPhase, warmupStep: state.warmupStep, warmupOf: state.warmupOf,
      error: state.error, engineState: state.engineState, nowPlaying: state.nowPlaying, tunedHz: state.tunedHz,
      scanCount, muted, mode, breakIn,
    });
    const p = cornerPaint(memo, v);
    memo = p.memo;
    if (v.show === "pill" && p.rebuildPill) pillHost.innerHTML = pillHtml(v);
    if (v.show === "glass") {
      if (p.rebuildGlass) {
        glassHost.innerHTML = glassHtml(v, state.signalDb);
        segEls = Array.from(glassHost.querySelectorAll<HTMLElement>(".kc-lcd__seg i"));
        dbEl = glassHost.querySelector<HTMLElement>(".kc-lcd__db");
      } else {
        const lit = segmentsLit(meterFill(state.signalDb), METER_SEGMENTS);
        segEls.forEach((el, i) => el.classList.toggle("on", i < lit));
        if (dbEl) dbEl.textContent = dbText(state.signalDb);
      }
    }
    cornerEl.classList.toggle("is-glass", v.show === "glass");
    paintLog();
  }
```

- [ ] **Step 8: Clock + lucide weather.** Replace the `WX_ICONS` map and `wxIcon` with:

```ts
  const WX_ICONS: Record<string, string> = {
    sun: icoSun, moon: icoMoon, cloud: icoCloud, cloudsun: icoCloudSun, rain: icoRain,
    storm: icoStorm, snow: icoSnow, fog: icoFog, wind: icoWind,
  };
  function wxIcon(condition: string, day: boolean): string {
    const c = condition.toLowerCase();
    const name =
      /thunder|t-storm|tstm/.test(c) ? "storm"
      : /snow|sleet|ice|flurr|wintry/.test(c) ? "snow"
      : /rain|shower|drizzle/.test(c) ? "rain"
      : /fog|mist|haze|smoke/.test(c) ? "fog"
      : /wind|breezy|blustery/.test(c) ? "wind"
      : /partly|mostly sunny|mostly clear/.test(c) ? (day ? "cloudsun" : "moon")
      : /cloud|overcast/.test(c) ? "cloud"
      : day ? "sun" : "moon";
    return `<span class="kc-wx__icon" aria-hidden="true">${WX_ICONS[name]}</span>`;
  }
```
and in `windBlock`, the arrow becomes the lucide `navigation-2` glyph rotated in a wrapper:
```ts
    const arrow = fromDeg === undefined ? ""
      : `<span class="kc-wx__arrow" aria-hidden="true" style="transform:rotate(${(fromDeg + 180) % 360}deg)">${icoArrow}</span>`;
    return `<span class="kc-wx__wind">${arrow}<span>${speed}</span></span>`;
```
and in `paintWeather` the line becomes
```ts
          ? ` · ${wxIcon(wx.condition, wx.isDaytime)}<span class="kc-wx__temp">${Math.round(wx.tempF)}°</span>${wx.wind ? windBlock(wx.wind) : ""}`
```
(the leading ` · ` joins it to the date on one line: "Thu, Oct 1 · ☁ 72° ↗ 6").

- [ ] **Step 9: WS handler.** In the `ReconnectingWs` callback, replace
```ts
    if (ev.type === "status") { paintBadge(); loadBanks(); }
    if (ev.type === "tuned") paintRail();
```
with
```ts
    if (ev.type === "status") void paintStatus();
```
(`tuned` already flows through `reduce` → `schedule()`; the pill key changes with the window.)

- [ ] **Step 10: Fonts.** In `src/frontend/main.ts`, `FONT_QUERY.dashboard` becomes `"family=Schibsted+Grotesk:wght@400;500;600;700;800"`. Update the comment above `FONT_QUERY` to say the dashboard draws in Schibsted Grotesk (spec 2026-10-01) and the map/wall/art in Inter.

- [ ] **Step 11: Verify**

Run: `npx vitest run test/dashboardState.test.ts test/dashboard.cornerView.test.ts test/dashboard.corner.test.ts && npm run typecheck`
Expected: PASS, typecheck clean (an "unused variable" or "cannot find name" error means a Step 5 deletion missed a reference — fix it, don't silence it). `grep -n "bankRail\|modeBadge\|bootMsg\|mutedBadge\|systemRisk\|meterPct" src/frontend/dashboard/dashboard.ts` prints nothing.

- [ ] **Step 12: Commit**

```bash
git add src/frontend/dashboard/dashboard.ts src/frontend/main.ts
git commit -m "feat(dashboard): wire the corner, risk pill, bare clock and lucide weather

Removes the bank rail, mode badge, warm-up overlay and the old now-card.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: The dashboard's CSS on layer 2

**Files:**
- Rewrite: `src/frontend/dashboard/dashboard.css`
- Create: `test/dashboardLayer.test.ts`

**Interfaces:**
- Consumes: the DOM from Task 4; tokens `--kc-*` (layer 2), `--kc-k-*`, `--kc-grow-ms`, `--kc-release-ms`, `--kc-sweep-ms`.
- Produces: the marker comment `/* ── Dashboard (layer 2) ── */` — everything after it reads only `--kc-*` / `--alert-*`.

- [ ] **Step 1: Write the failing test** — `test/dashboardLayer.test.ts`:

```ts
// The Layer Rule for the dashboard (spec 2026-10-01): below the marker,
// dashboard.css reads layer 2 only. The storm palette is the one carve-out:
// its literals live in the .alertBar[data-kind] rules, and the card reads
// them through --alert-color / --alert-on.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const MARK = "/* ── Dashboard (layer 2) ── */";
// Strip every comment except the marker itself.
const css = readFileSync("src/frontend/dashboard/dashboard.css", "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, (c) => (c === MARK ? c : ""));

describe("dashboard.css Layer Rule", () => {
  it("has the layer-2 marker", () => {
    expect(css.includes(MARK)).toBe(true);
  });
  const dash = css.slice(css.indexOf(MARK) + MARK.length)
    .split("\n").filter((l) => !/\.alertBar\[data-kind=/.test(l)).join("\n");
  it("reads only --kc-* and --alert-* below the marker", () => {
    const vars = [...dash.matchAll(/var\((--[\w-]+)\)/g)].map((m) => m[1]!);
    expect(vars.length).toBeGreaterThan(20);
    expect(vars.filter((v) => !/^--(kc-|alert-)/.test(v))).toEqual([]);
  });
  it("has no literal colours below the marker (storm kinds excepted)", () => {
    expect(dash.match(/#[0-9a-f]{3,8}\b|rgba?\(/gi) ?? []).toEqual([]);
  });
  it("scopes every dashboard rule to the dashboard page", () => {
    const selectors = [...dash.matchAll(/(^|})\s*([^{}@]+)\{/g)].map((m) => m[2]!.trim()).filter((s) => !/^(from|to|\d+%)/.test(s));
    expect(selectors.filter((s) => !s.split(",").every((p) => p.trim().startsWith('html[data-page="dashboard"]')))).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/dashboardLayer.test.ts`
Expected: FAIL — no marker.

- [ ] **Step 3: Rewrite `src/frontend/dashboard/dashboard.css`** with exactly this content:

```css
/* ── Shared ambient base (wall, art, map — tokens.css layer 1) ─────────────
   This stylesheet is bundled on every page. These :root aliases and the body
   rule are what the wall, art and map pages still render with; the map's
   callsign chips read --k-meta (map.css). They are NOT the dashboard's
   language any more — that is the layer-2 section below. */
:root {
  color-scheme: dark;
  --bg: var(--bg-base);
  --ink: var(--text-primary);
  --k-meta: 0.95rem;      /* map.css: aircraft callsign chips (until the map PR) */
}
body {
  margin: 0;
  font-family: var(--font-sans);
  background: var(--bg);
  color: var(--ink);
}
html[data-page="map"] body,
html[data-page="wall"] body,
html[data-page="art"] body { font-size: 0.92rem; }

/* ── Dashboard (layer 2) ── */
html[data-page="dashboard"] { color-scheme: dark; background: var(--kc-ground); }
html[data-page="dashboard"] body {
  font: 400 var(--kc-t-body)/1.4 var(--kc-font);
  background: var(--kc-ground);
  color: var(--kc-ink);
  -webkit-font-smoothing: antialiased;
}
/* Output-only kiosk: no cursor. */
html[data-page="dashboard"] .dash, html[data-page="dashboard"] .dash * { cursor: none !important; }
html[data-page="dashboard"] .dash { position: relative; height: 100vh; overflow: hidden; }
html[data-page="dashboard"] .mapBase { display: none; }
html[data-page="dashboard"] .dash.mapStage .mapBase { display: block; position: absolute; inset: 0; z-index: 0; }

/* The clock: bare text top-right, a soft dark halo so it reads over any map. */
html[data-page="dashboard"] .kc-clock {
  position: absolute; top: 2rem; right: 2.2rem; z-index: 3;
  text-align: right; text-shadow: 0 2px 18px var(--kc-backdrop);
}
html[data-page="dashboard"] .kc-clock__time {
  font-size: var(--kc-k-clock); font-weight: 700; line-height: 1;
  font-variant-numeric: tabular-nums; color: var(--kc-ink);
}
html[data-page="dashboard"] .kc-clock__sub {
  display: flex; justify-content: flex-end; align-items: center; gap: 0.35em;
  margin-top: 0.5rem; font-size: var(--kc-k-date); font-weight: 500; color: var(--kc-dim);
  font-variant-numeric: tabular-nums;
}
html[data-page="dashboard"] .kc-wx { display: inline-flex; align-items: center; gap: 0.35em; }
html[data-page="dashboard"] .kc-wx__icon svg, html[data-page="dashboard"] .kc-wx__arrow svg { width: 1.15em; height: 1.15em; display: block; }
html[data-page="dashboard"] .kc-wx__arrow { display: inline-block; }
html[data-page="dashboard"] .kc-wx__wind { display: inline-flex; align-items: center; gap: 0.2em; }
html[data-page="dashboard"] .kc-wx__temp { color: var(--kc-ink); font-weight: 700; }

/* Machine warning: a coral pill, top centre. */
html[data-page="dashboard"] .kc-risk {
  position: absolute; top: 2rem; left: 50%; transform: translateX(-50%); z-index: 4;
  padding: 0.7rem 1.4rem; border-radius: var(--kc-r-key); white-space: nowrap;
  background: color-mix(in srgb, var(--kc-coral) 16%, var(--kc-ground));
  color: var(--kc-coral); font-weight: 600; font-size: var(--kc-k-pill);
  box-shadow: var(--kc-lift-shadow);
}
html[data-page="dashboard"] .kc-risk[hidden] { display: none; }

/* The corner: alert card stacked over the pill/glass slot, bottom-left. */
html[data-page="dashboard"] .kc-corner {
  position: absolute; left: 1.8rem; bottom: 1.8rem; z-index: 3;
  width: min(40vw, 48rem);
  display: flex; flex-direction: column; align-items: flex-start; gap: 1.1rem;
}
html[data-page="dashboard"] .kc-corner__slot { position: relative; width: 100%; }
/* Both stay mounted. Whichever is NOT showing leaves the flow (absolute at the
   same bottom-left anchor), so the slot — and the alert above it — sits on
   the visible one. Transitions on transform + opacity only: compositor work,
   and a transition reverses from mid-flight on its own (a quick re-hit). */
html[data-page="dashboard"] .kc-corner__glass {
  transform-origin: 0 100%;
  transform: scale(0.26); opacity: 0;
  transition: transform var(--kc-release-ms) ease-in, opacity var(--kc-release-ms) ease-in;
}
html[data-page="dashboard"] .kc-corner:not(.is-glass) .kc-corner__glass { position: absolute; left: 0; bottom: 0; width: 100%; }
html[data-page="dashboard"] .kc-corner.is-glass .kc-corner__glass {
  transform: none; opacity: 1;
  transition-duration: var(--kc-grow-ms); transition-timing-function: cubic-bezier(0.2, 0.8, 0.2, 1);
}
html[data-page="dashboard"] .kc-corner__pill {
  transform-origin: 0 100%;
  transition: transform var(--kc-grow-ms) ease-out, opacity var(--kc-grow-ms) ease-out;
}
html[data-page="dashboard"] .kc-corner.is-glass .kc-corner__pill { position: absolute; left: 0; bottom: 0; opacity: 0; transform: scale(1.15); }

/* The pill: small glass, one line, barely there from across the room. */
html[data-page="dashboard"] .kc-pill {
  position: relative; display: inline-block;
  padding: 0.9rem 1.4rem 1.25rem; border-radius: var(--kc-r-key);
  background: var(--kc-well);
  box-shadow: inset 0 0 0 1px var(--kc-well-edge), var(--kc-lift-shadow);
  font-size: var(--kc-k-pill); font-weight: 600; color: var(--kc-dim);
  white-space: nowrap; font-variant-numeric: tabular-nums;
}
html[data-page="dashboard"] .kc-pill__detail { color: var(--kc-mute); font-weight: 500; }
html[data-page="dashboard"] .kc-pill--hay .kc-pill__word { color: var(--kc-hay); }
html[data-page="dashboard"] .kc-pill__muted { color: var(--kc-hay); }
html[data-page="dashboard"] .kc-pill__muted svg { width: 1em; height: 1em; vertical-align: -0.12em; margin-right: 0.25em; }
html[data-page="dashboard"] .kc-pill .kc-lcd__seg { height: 6px; gap: 3px; margin-top: 0.7rem; }
/* The sweep tick: a short glint crossing the pill's foot. */
html[data-page="dashboard"] .kc-pill__tick { position: absolute; left: 1.4rem; right: 1.4rem; bottom: 0.45rem; height: 2px; overflow: hidden; }
html[data-page="dashboard"] .kc-pill__tick::after {
  content: ""; position: absolute; top: 0; bottom: 0; left: 0; width: 18%;
  background: linear-gradient(90deg, transparent, var(--kc-glass), transparent);
  opacity: 0.7; transform: translateX(-100%);
  animation: kc-sweep var(--kc-sweep-ms) linear infinite;
}
html[data-page="dashboard"] .kc-pill[data-sweep="off"] .kc-pill__tick { display: none; }
/* Hidden pill: stop the sweep so the compositor can idle under the glass. */
html[data-page="dashboard"] .kc-corner.is-glass .kc-pill__tick::after { animation: none; }
@keyframes kc-sweep { to { transform: translateX(556%); } }

/* The weather alert card — NWS storm colours, the three tiers. */
html[data-page="dashboard"] .alertBar { display: none; position: relative; --alert-color: var(--kc-coral); --alert-on: var(--kc-well); }
html[data-page="dashboard"] .alertBar[data-kind="tornado"]  { --alert-color: #e01a2b; --alert-on: #ffffff; }
html[data-page="dashboard"] .alertBar[data-kind="severe"]   { --alert-color: #f5a623; --alert-on: #1a1205; }
html[data-page="dashboard"] .alertBar[data-kind="flood"]    { --alert-color: #15924f; --alert-on: #ffffff; }
html[data-page="dashboard"] .alertBar[data-kind="winter"]   { --alert-color: #d23a9d; --alert-on: #ffffff; }
html[data-page="dashboard"] .alertBar[data-kind="wind"]     { --alert-color: #c59a2c; --alert-on: #1a1205; }
html[data-page="dashboard"] .alertBar[data-kind="tropical"] { --alert-color: #a8327f; --alert-on: #ffffff; }
html[data-page="dashboard"] .alertBar[data-kind="fire"]     { --alert-color: #e8501e; --alert-on: #ffffff; }
html[data-page="dashboard"] .alertBar[data-kind="civil"]    { --alert-color: #c8102e; --alert-on: #ffffff; }
html[data-page="dashboard"] .alertBar[data-kind="test"]     { --alert-color: #5b6b7a; --alert-on: #e8eef3; }
html[data-page="dashboard"] .alertBar.on {
  display: flex; flex-direction: column; align-items: flex-start; gap: 0.4rem;
  width: 100%; box-sizing: border-box; padding: 1.3rem 1.8rem 1.5rem;
  border-radius: var(--kc-r-group); background: var(--kc-well); color: var(--kc-ink);
  box-shadow: var(--kc-lift-shadow);
}
html[data-page="dashboard"] .alertBar .alertHead { display: flex; align-items: center; gap: 0.55rem; }
html[data-page="dashboard"] .alertBar .alertGlyph svg { width: 1.7rem; height: 1.7rem; display: block; color: var(--alert-color); }
html[data-page="dashboard"] .alertBar .alertLabel { font-size: var(--kc-k-pill); font-weight: 700; color: var(--alert-color); }
html[data-page="dashboard"] .alertBar .alertTag { font-size: var(--kc-k-alert-title); font-weight: 800; line-height: 1.05; }
html[data-page="dashboard"] .alertBar .alertCounties { font-size: var(--kc-k-pill); font-weight: 600; color: var(--alert-color); }
/* Pulse rides on an overlay's opacity (composited), never a repainted background. */
html[data-page="dashboard"] .alertBar.on::before {
  content: ""; position: absolute; inset: 0; border-radius: inherit; pointer-events: none;
  box-shadow: 0 0 22px 3px color-mix(in srgb, var(--alert-color) 60%, transparent);
  animation: kc-alert-fade 1.6s ease-in-out infinite;
}
/* WATCH: a 2px storm ring + the slow pulse. */
html[data-page="dashboard"] .alertBar.watch.on { box-shadow: inset 0 0 0 2px var(--alert-color), var(--kc-lift-shadow); }
/* STATEMENT: quiet — a 4px storm spine, smaller title, no pulse. */
html[data-page="dashboard"] .alertBar.statement.on { box-shadow: inset 4px 0 0 var(--alert-color), var(--kc-lift-shadow); }
html[data-page="dashboard"] .alertBar.statement.on::before { animation: none; opacity: 0; }
html[data-page="dashboard"] .alertBar.statement .alertTag { font-size: calc(var(--kc-k-alert-title) * 0.72); }
/* WARNING: a solid slab of the storm colour. */
html[data-page="dashboard"] .alertBar.warning.on { background: var(--alert-color); color: var(--alert-on); }
html[data-page="dashboard"] .alertBar.warning .alertGlyph svg,
html[data-page="dashboard"] .alertBar.warning .alertLabel,
html[data-page="dashboard"] .alertBar.warning .alertCounties { color: var(--alert-on); }
html[data-page="dashboard"] .alertBar.warning .alertGlyph svg { animation: kc-alert-ring 1.2s ease-in-out infinite; }
@keyframes kc-alert-fade { 0%, 100% { opacity: 0; } 50% { opacity: 1; } }
@keyframes kc-alert-ring { 0%, 100% { transform: rotate(0deg); } 20% { transform: rotate(12deg); } 40% { transform: rotate(-10deg); } 60% { transform: rotate(6deg); } }

/* No Maps key: the same corner, centred on the ground, with Recently heard. */
html[data-page="dashboard"] .dash.mapStage .kc-recent { display: none; }
html[data-page="dashboard"] .dash:not(.mapStage) .kc-stage {
  height: 100vh; display: grid; grid-template-columns: minmax(0, 48rem) minmax(0, 28rem);
  gap: 2rem; justify-content: center; align-content: center;
}
html[data-page="dashboard"] .dash:not(.mapStage) .kc-corner { position: static; width: auto; }
html[data-page="dashboard"] .kc-recent { background: var(--kc-raised); border-radius: var(--kc-r-group); padding: 0.6rem 0 0.8rem; max-height: 70vh; overflow: hidden; }
html[data-page="dashboard"] .kc-recent h2 { margin: 0.6rem 1.2rem 0.4rem; font-size: var(--kc-t-small); font-weight: 600; color: var(--kc-dim); }
html[data-page="dashboard"] .kc-recent ul { list-style: none; margin: 0; padding: 0; }
html[data-page="dashboard"] .kc-recent li { padding: 0.6rem 1.2rem; border-top: 1px solid var(--kc-line); font-size: var(--kc-k-pill); font-variant-numeric: tabular-nums; }
html[data-page="dashboard"] .kc-recent li:first-child { border-top: 0; }
html[data-page="dashboard"] .kc-recent .t { color: var(--kc-mute); margin-right: 0.6rem; }

@media (prefers-reduced-motion: reduce) {
  html[data-page="dashboard"] .dash *, html[data-page="dashboard"] .dash *::before, html[data-page="dashboard"] .dash *::after {
    animation: none !important; transition: none !important;
  }
}
```

> The `.alertBar[data-kind]` lines carry `#ffffff` (was `#fff`) and are excluded from the literal check by the test. Statement's 0.72× title is a `calc()` on the token, not a new size.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/dashboardLayer.test.ts test/cssVarsDeclared.test.ts test/tokens.test.ts`
Expected: PASS. If `cssVarsDeclared` flags a layer-1 name that used to be declared in the old `:root` block (e.g. `--k-alert` used by some file you didn't touch), grep for its user: if it's `map.css`, re-declare it in the shared base with the same value and a "(until the map PR)" comment; anything else is a missed dashboard reference — fix that reference.

- [ ] **Step 5: Commit**

```bash
git add src/frontend/dashboard/dashboard.css test/dashboardLayer.test.ts
git commit -m "feat(dashboard): the Faceplate on layer 2 — corner, pill, sweep, storm card, clock

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Docs, the definition of done, and the live wall

**Files:**
- Modify: `DESIGN.md`, `kiosk/src/frontend/tokens.css` (header comment only), `CLAUDE.md`

- [ ] **Step 1: Thermal baseline BEFORE deploying** (the wall still runs main's frontend; `dist/` is untouched until Step 4):

```bash
W=/home/kiosk/kerchunk-kiosk/.superpowers/sdd/2026-10-01-kiosk-faceplate-pr2-dashboard
( for i in $(seq 1 30); do date +%s; sensors 2>/dev/null | grep -m1 -E "Package id 0|Tctl"; \
  ps -C chrome,chromium -o %cpu= | awk '{s+=$1} END {print "chromium_cpu", s}'; sleep 10; done ) > $W/thermal-before.txt
```
(5 minutes. Read the file: note mean package °C and mean chromium %CPU.)

- [ ] **Step 2: Docs**

DESIGN.md:
1. Front-matter `description:` → "Dark-only interfaces for an always-on SDR scanner appliance. The admin and the kiosk dashboard are the scanner's front panel (the Faceplate); the wall, art and map are quiet rooms with exactly one thing lit."
2. In the intro list, item 2 becomes "**The ambient displays** (tokens.css layer 1) — the wall, map and art." and add item 3: "**The kiosk dashboard** reads layer 2 (since 2026-10-01): one piece of glass on the map."
3. **The Layer Rule** paragraph becomes:
   "**The Layer Rule.** The admin and the kiosk dashboard read only `--kc-*`. The wall, art and map read only layer 1. A colour that isn't a token doesn't go in, not even as a `var(--token, #hex)` fallback. The carve-outs are the NWS storm palette (`dashboard.css`, the `.alertBar[data-kind]` rules), the service palette (`PIN_COLORS`, pins and hits), the hit-kind marks (`--flamingo` close call, `--pine` no fix), and the wall/art canvas grounds. `--kc-pin-cream` and `--kc-pin-glyph` mirror the map pin's literal body and glyph colours so the shared LCD never carries them as hex. `test/dashboardLayer.test.ts` enforces the dashboard's side."
4. In "## Ambient displays (tokens.css layer 1)", change the first sentence's list to "The wall, map and art" and drop "dashboard (the HDMI kiosk view, where the fullscreen map *is* the dashboard)". In "The Frozen-Ambient Rule", say layer 1 now serves the wall, map and art. Delete the Night-Watch bullets that only described the dashboard: "One glow" (amber name), "The signal meter (signature)", "Scoped warning banners"; keep "One lit thing", "Flat plates", "Over the map". Move "The weather alert card (signature)" into the new section below, rewritten for the card's new form.
5. Add a new section before "## Do's and Don'ts":
   ```markdown
   ## The kiosk dashboard (layer 2)

   The HDMI wall view, where the fullscreen map *is* the dashboard. Spec:
   `docs/superpowers/specs/2026-10-01-kiosk-faceplate-design.md`. It speaks the
   admin's language at room distance (`--kc-k-*`), with one piece of glass.

   - **The corner** (bottom-left, `dashboard/corner.ts`, `cornerView.ts`): the
     idle **pill** or the wall-size **glass** (`lcd()` with `size: "wall"`, the
     service head and the 12-segment meter). Alerts stack above it.
   - **The pill**: one line on `--kc-well` ("Scanning · VHF high 160.9"), a
     sea-glass **sweep tick** crossing its foot every `--kc-sweep-ms` while the
     radio searches. Hay for Standby and Muted. Warm-up fills the meter's 12
     segments inside the pill; there is no full-screen overlay.
   - **Grow / release**: a hit grows the glass out of the pill's corner
     (`--kc-grow-ms`, decelerating); release shrinks it back
     (`--kc-release-ms`, ease-in). Transform and opacity transitions only; a
     quick re-hit reverses mid-flight. Reduced motion swaps instantly.
   - **The error glass**: coral meta, the error in ink, the recovery hint.
   - **The clock**: bare text top-right (`--kc-k-clock`), date · lucide weather
     icon · temperature · wind arrow underneath, a dark halo for legibility.
   - **Machine warning**: a coral-tinted pill, top centre.
   - **The weather alert card (signature)**: NWS severity encoded, on the
     storm palette — a **statement** is quiet with a 4px storm spine, a
     **watch** has a 2px storm ring and a slow pulse, a **warning** is a solid
     slab of the storm colour. Sentence case. This is the one place border
     weight does semantic work.
   - **No Maps key**: the same corner, centred, with "Recently heard" as a
     raised group beside it.
   ```
6. Fix the PR 1 present-tense lines now that they are true (the Typography kiosk-ramp note: "used by the dashboard" stays; the LCD section's "Three options are used by the kiosk only" stays) — no change needed if they already read correctly; otherwise make them present tense.

`kiosk/src/frontend/tokens.css` header: "LAYER 1 — ambient surfaces (dashboard, wall, map, art)" → "LAYER 1 — ambient surfaces (wall, map, art; the dashboard moved to layer 2 on 2026-10-01)" and "LAYER 2 — the admin language" → "LAYER 2 — the admin and kiosk dashboard language".

`CLAUDE.md` ("Previewing wall states"): replace "Warning-banner styling is scoped under `.dash.mapStage` — it only applies when a Google Maps key is configured." with "The storm card and the corner render the same with or without a Google Maps key (no key = centred layout with Recently heard)."

- [ ] **Step 3: Definition of done**

```bash
npm test > $W/dod-test.txt 2>&1; echo test $?; grep -E "Test Files|Tests " $W/dod-test.txt
npm run test:native > $W/dod-native.txt 2>&1; echo native $?; tail -1 $W/dod-native.txt
npm run typecheck > $W/dod-tc.txt 2>&1; echo typecheck $?
npm run build > $W/dod-build.txt 2>&1; echo build $?
```
Expected: all exit 0.

- [ ] **Step 4: Deploy to the wall and capture the states** (frontend-only)

```bash
curl -s -X POST localhost:8080/api/kiosk/reload; sleep 15
cap() { XDG_RUNTIME_DIR=/run/user/1000 WAYLAND_DISPLAY=wayland-0 grim /tmp/claude-1000/kiosk-$1.png; }
cap scanning
for t in "TORNADO WARNING" "SEVERE THUNDERSTORM WATCH" "FLOOD STATEMENT"; do
  curl -s -X POST localhost:8080/api/test/alert -H 'content-type: application/json' -d "{\"alphaTag\":\"$t\"}"; sleep 3
  cap "alert-$(echo $t | tr ' ' '-' | tr A-Z a-z)"
done
curl -s -X POST localhost:8080/api/test/alert -H 'content-type: application/json' -d '{"clear":true}'
for i in $(seq 1 20); do cap live-$i; sleep 3; done   # catch live hits as traffic arrives
```
Read each PNG. Expected: the pill bottom-left with the sweep; the three storm tiers stacked above the corner in their NWS colours, sentence case; at least one live capture showing the glass with the service head and segments. If the wall page is stale/blank after the reload, `sudo systemctl restart kerchunk-display`, wait 15 s, and capture again — never restart `kerchunk-kiosk`.

States not drivable without disturbing the radio — **warm-up** (needs an engine restart), **radio error**, **machine warning**, and **un-muted live** (the operator's mute is not ours to flip) — are proven by the Task 1/3 unit tests and called out as "not shown on the wall" in the PR.

- [ ] **Step 5: Thermal after** — repeat Step 1's loop into `$W/thermal-after.txt` (5 min, the new frontend on the wall). Compare means. Expected: package °C within +1 °C and chromium %CPU not higher by more than a few points; if worse, record the numbers honestly in the PR and in the final report.

- [ ] **Step 6: Commit, push, PR**

```bash
git add DESIGN.md CLAUDE.md kiosk/src/frontend/tokens.css
git commit -m "docs: the kiosk dashboard on layer 2 — Layer Rule, dashboard section, banner note

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push -u origin HEAD
gh pr create --base main --title "Kiosk Faceplate PR 2: the dashboard" --body-file <(…PR body: what changed, the states shown on the wall with what was/wasn't driven, thermal before/after numbers, test counts; end with the 🤖 line…)
```
