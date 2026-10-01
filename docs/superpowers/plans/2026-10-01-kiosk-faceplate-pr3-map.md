# Kiosk Faceplate — PR 3: the map — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Retint the map to Night desk (cartography, legend, callsign chips, home pin, no-frequency live glow), move the map onto tokens.css layer 2, and leave layer 1 serving only the wall and art.

**Architecture:** The cartography colours become `--kc-map-*` tokens; `kiosk-assets/map-style.json` (the console master) and `map.ts`'s `DARK_STYLE` fallback are pinned to them by a test, since neither can read CSS. Amber "live/yours" accents move to sea-glass. `map.css` joins the dashboard's layer-2 lint.

**Tech Stack:** TypeScript ESM, vanilla CSS custom properties, vitest, Google Maps cloud styling (manual console paste + Publish).

**Spec:** `docs/superpowers/specs/2026-10-01-kiosk-faceplate-design.md` (Delivery item 3). Builds on #273 and #274.

## Global Constraints

- Branch `feat/kiosk-faceplate-map` off `main`. Commands from `kiosk/`.
- Pins and hits keep their service colours (`PIN_COLORS`); the close-call (`--flamingo`) and no-fix (`--pine`) marks keep theirs — recorded carve-outs.
- No literal colour in `map.css`; no `var(--x, #hex)` fallbacks; lucide icons only.
- Sentence case on every map label we draw (callsigns are uppercase by nature; leave their text alone).
- The map style change needs the **operator** to paste `map-style.json` into the Google Cloud console and **Publish**. PR 3 is not proven until they confirm.
- Frontend-only: never restart `kerchunk-kiosk`.

## Review Focus

- **The console style and the fallback drift apart** (someone edits one): a test pins both to the same tokens (Task 1).
- **A no-frequency live hit** must glow sea-glass, not amber, and a no-frequency close call must stay flamingo (Task 2).
- **The home pin on the new ground** must still read as "yours" and its glyph must be visible on the cream head (Task 2: glyph is `--kc-glass-ink`, not sea-glass, which would vanish on cream).
- **The /map page** (interactive, opened from the admin) must look like the same product as the wall: Schibsted, layer-2 legend (Task 3).
- **Pins framed under the clock or the idle pill** on the kiosk: the fit padding follows the new chrome (Task 3).

---

### Task 1: Map cartography tokens, pinned

**Files:** Modify `src/frontend/tokens.css`, `kiosk-assets/map-style.json`, `src/frontend/map/map.ts` (export `DARK_STYLE`, new values); Create `test/mapStyle.test.ts`.

**Produces:** tokens `--kc-map-land` (`var(--kc-ground)`), `--kc-map-water` (`var(--kc-well)`), `--kc-map-road` (`var(--kc-line)`), `--kc-map-road-edge` (`#2c343e`), `--kc-map-label` (`#5d6672`), `--kc-map-poi` (`#747e8b`); `export const DARK_STYLE`.

- [ ] **Step 1: failing test** — `test/mapStyle.test.ts`:

```ts
// The map's cartography can't read CSS: the console style (map-style.json) and
// the raster fallback (DARK_STYLE) carry hex. Pin both to the --kc-map-* tokens
// so the three can never drift apart silently.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { readProps, resolve, contrast } from "./cssTokens.js";
import { DARK_STYLE } from "../src/frontend/map/map.js";

const props = readProps("src/frontend/tokens.css");
const v = (n: string): string => resolve(props, props[n] ?? "").toLowerCase();
const MAP_TOKENS = ["--kc-map-land", "--kc-map-water", "--kc-map-road", "--kc-map-road-edge", "--kc-map-label", "--kc-map-poi"];
const allowed = new Set(MAP_TOKENS.map(v));
const hexes = (s: string): string[] => (s.match(/#[0-9a-f]{6}\b/gi) ?? []).map((h) => h.toLowerCase());

describe("map cartography is the --kc-map-* tokens", () => {
  it("every token resolves to a hex", () => {
    for (const n of MAP_TOKENS) expect(v(n), n).toMatch(/^#[0-9a-f]{6}$/);
  });
  it("map-style.json (the console master) uses only map tokens", () => {
    const used = hexes(readFileSync("kiosk-assets/map-style.json", "utf8"));
    expect(used.length).toBeGreaterThan(5);
    expect(used.filter((h) => !allowed.has(h))).toEqual([]);
  });
  it("DARK_STYLE (the no-Map-ID fallback) uses only map tokens", () => {
    const used = hexes(JSON.stringify(DARK_STYLE));
    expect(used.filter((h) => !allowed.has(h))).toEqual([]);
  });
  it("land is the Night desk ground and water the LCD well", () => {
    expect(v("--kc-map-land")).toBe(v("--kc-ground"));
    expect(v("--kc-map-water")).toBe(v("--kc-well"));
  });
  it("labels stay deliberately quiet but findable (≥ 2.5:1 on land)", () => {
    expect(contrast(v("--kc-map-label"), v("--kc-map-land"))).toBeGreaterThanOrEqual(2.5);
    expect(contrast(v("--kc-map-poi"), v("--kc-map-land"))).toBeGreaterThan(contrast(v("--kc-map-label"), v("--kc-map-land")));
  });
});
```

- [ ] **Step 2:** `npx vitest run test/mapStyle.test.ts` → FAIL (tokens missing; `DARK_STYLE` not exported).

- [ ] **Step 3: implement.**
  - `tokens.css`, after the pin tokens:
    ```css
    /* The map's cartography (spec 2026-10-01). map-style.json (the Google
       console master) and map.ts DARK_STYLE carry these as hex — test/mapStyle
       pins them. Labels are deliberately quiet: the activity is the subject. */
    --kc-map-land: var(--kc-ground);
    --kc-map-water: var(--kc-well);
    --kc-map-road: var(--kc-line);
    --kc-map-road-edge: #2c343e;   /* highway casing, a half-step above the road */
    --kc-map-label: #5d6672;       /* towns, water names (≈2.9:1 on land, on purpose) */
    --kc-map-poi: #747e8b;         /* hospitals, police, fire, airports — a step brighter */
    ```
  - `kiosk-assets/map-style.json`: replace colours — land `#1c1f26`→`#15191f`; water `#13161c`→`#0c1113`; road fill `#2b303b`→`#232a31`, road stroke `#42454e`→`#2c343e`; water label text `#4d515c`→`#5d6672` (stroke `#13161c`→`#0c1113`); POI label text `#747b8a`→`#747e8b`, POI text stroke `#1c1f26`→`#15191f`, POI pin `#5e6371`→`#5d6672`; settlement text `#5e6371`→`#5d6672`, stroke `#1c1f26`→`#15191f`. Keep `"variant": "dark"` and every visibility rule.
  - `map.ts`: `const DARK_STYLE = [` → `export const DARK_STYLE = [` with: geometry `#15191f`; labels fill `#5d6672`, stroke `#15191f`; road `#232a31`; highway `#2c343e`; water `#0c1113`; transit `#232a31`.
  - `kiosk-assets/README.md`: rewrite the colour table to the `--kc-map-*` tokens and their hex; keep the paste → **Publish** → wait → restart `kerchunk-display` steps.

- [ ] **Step 4:** `npx vitest run test/mapStyle.test.ts test/tokens.test.ts test/cssVarsDeclared.test.ts && npm run typecheck` → PASS.

- [ ] **Step 5:** commit `feat(map): Night desk cartography, pinned to --kc-map-* tokens`.

---

### Task 2: Sea-glass accents (no-frequency live glow, home pin, legend dot)

**Files:** Modify `src/frontend/lib/serviceColor.ts:66`, `src/frontend/map/pins/pin-home.svg`, `test/serviceColor.test.ts:18,65`; Create assertions in `test/mapStyle.test.ts`.

- [ ] **Step 1: failing tests.**
  - `test/serviceColor.test.ts` line 18 → `expect(colorFor(undefined, "active")).toBe("#5fd4c3");` and line 65 → `expect(colorFor(undefined, "active")).toBe("#5fd4c3"); // sea-glass: live, no tag` (line 19's `#dc3a38` close call stays).
  - Append to `test/mapStyle.test.ts`:
    ```ts
    describe("home pin on Night desk", () => {
      const svg = readFileSync("src/frontend/map/pins/pin-home.svg", "utf8").toLowerCase();
      it("body is sea-glass, glyph is glass-ink (visible on the cream head)", () => {
        expect(svg).toContain(`fill="${v("--kc-glass")}"`);
        expect(svg).toContain(`stroke="${v("--kc-glass-ink")}"`);
        expect(svg).not.toContain("#ff5a1f");
      });
      it("the glyph clears 3:1 on the cream head", () => {
        expect(contrast(v("--kc-glass-ink"), v("--kc-pin-cream"))).toBeGreaterThanOrEqual(3);
      });
    });
    ```
- [ ] **Step 2:** run both files → FAIL.
- [ ] **Step 3: implement.**
  - `serviceColor.ts`: `return kind === "closecall" ? "#dc3a38" : "#ff6b35";` → `return kind === "closecall" ? "#dc3a38" : "#5fd4c3";` and the comment above: "No frequency AND no classifying tag → close calls stay flamingo; a live hit glows sea-glass (spec 2026-10-01)."
  - `pin-home.svg`: path `fill="#ff5a1f"` → `fill="#5fd4c3"`; glyph group `stroke="#ff5a1f"` → `stroke="#08231f"`.
  - `map.ts` line 12 comment "(spark ring, cream head)" → "(sea-glass ring, cream head)".
- [ ] **Step 4:** `npx vitest run test/serviceColor.test.ts test/mapStyle.test.ts` → PASS.
- [ ] **Step 5:** commit `feat(map): live and home accents move from amber to sea-glass`.

---

### Task 3: map.css on layer 2, Schibsted, framing

**Files:** Rewrite `src/frontend/map/map.css`; Modify `src/frontend/dashboard/dashboard.css` (shared base), `src/frontend/main.ts` (`FONT_QUERY.map`), `src/frontend/map/map.ts` (legend copy, `KIOSK_FIT_PAD`); Modify `test/dashboardLayer.test.ts` → generalise to both files.

- [ ] **Step 1: failing test** — in `test/dashboardLayer.test.ts`, add a second `describe` for `src/frontend/map/map.css` with the same marker convention (`/* ── Map (layer 2) ── */`), allowing `--kc-*`, `--glow-color` (set at runtime), `--flamingo`, `--pine` (recorded hit-kind carve-outs), with no literal colours and every selector scoped `html[data-page="map"]` or `html[data-page="dashboard"]` (the map renders inside both). Also assert `map.ts` exports `KIOSK_FIT_PAD` with `top ≥ 180` (clears the clock + weather) and `bottom ≥ 100` (clears the pill):
  ```ts
  import { KIOSK_FIT_PAD } from "../src/frontend/map/map.js";
  it("kiosk framing clears the clock and the idle pill", () => {
    expect(KIOSK_FIT_PAD.top).toBeGreaterThanOrEqual(180);
    expect(KIOSK_FIT_PAD.bottom).toBeGreaterThanOrEqual(100);
  });
  ```
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3: implement.**
  - `map.css` rewritten: drop the `html[data-page="map"]` Inter aliases; marker `/* ── Map (layer 2) ── */`; every rule prefixed `:is(html[data-page="map"], html[data-page="dashboard"])`:
    - `html[data-page="map"]` and its `body`: `background: var(--kc-ground); color: var(--kc-ink); font: 400 var(--kc-t-body)/1.4 var(--kc-font);` (the /map page).
    - `.mapWrap`, `#gmap` (`background: var(--kc-map-land)`), `.edgeGlow` (unchanged mechanics; `box-shadow: inset 0 0 90px 24px var(--glow-color)` — `--glow-color` is set at runtime before the pulse class lands, so no fallback).
    - `.mapLegend`: `background: color-mix(in srgb, var(--kc-ground) 88%, transparent); color: var(--kc-dim); font: 500 var(--kc-t-small)/1.4 var(--kc-font); border-radius: var(--kc-r-key); padding: 0.5rem 0.9rem;` no border; `.lgAnt svg` `color: var(--kc-dim)`; `.lgNote` `color: var(--kc-mute)`; `.lgBlip.active` `var(--kc-glass)`; `.lgBlip.cc` `var(--flamingo)`; `.lgBlip.nofix` `var(--pine)` (glows via `color-mix` of the same var).
    - `.mapMsg`: `color: var(--kc-dim); font-family: var(--kc-font);`.
    - `.blipInfo` (Google info window, white bubble): `color: var(--kc-ground); font-weight: 600;` `.blipMeta`: `color: var(--kc-key); font-size: 0.8em; font-weight: 400;`.
    - `.acLabel`: `font-family: var(--kc-font) !important; font-size: var(--kc-t-row) !important; font-weight: 600 !important; letter-spacing: 0 !important;` no `text-transform`; `padding: 2px 7px; border-radius: var(--kc-r-key); background: color-mix(in srgb, var(--kc-well) 78%, transparent); box-shadow: inset 0 0 0 1px var(--kc-well-edge); text-shadow: none; transform: translateY(24px); white-space: nowrap;`.
  - `dashboard.css` shared base: remove `--k-meta` and its comment; the base now serves wall + art only (`html[data-page="wall"] body, html[data-page="art"] body { font-size: 0.92rem; }` — drop the map selector).
  - `main.ts`: `FONT_QUERY.map` → `"family=Schibsted+Grotesk:wght@400;500;600;700;800"`; comment: the admin, dashboard and map draw in Schibsted; wall/art canvases use system-ui.
  - `map.ts` legend copy (sentence case): `<span class="lgAnt"></span> Pins are sites by service · a grey ? is unclassified <span class="lgNote">Edge glow: activity with no known location · Weather: live NEXRAD</span>`.
  - `map.ts`: `export const KIOSK_FIT_PAD = { top: 200, left: 80, right: 80, bottom: 120 };` above `mountActivityMap`, with a comment (clock + weather top-right ≈ 190 px; the idle pill bottom-left ≈ 70 px + margin), and `const fitPad = interactive ? 56 : KIOSK_FIT_PAD;`.
- [ ] **Step 4:** `npx vitest run test/dashboardLayer.test.ts test/cssVarsDeclared.test.ts test/mapStyle.test.ts && npm run typecheck` → PASS.
- [ ] **Step 5:** commit `feat(map): legend, chips and /map page on layer 2; Schibsted; framing clears the new chrome`.

---

### Task 4: Docs, done, wall, console

- [ ] **DESIGN.md:** Layer Rule → "The admin, the kiosk dashboard and the map read only `--kc-*`. The wall and art read only layer 1." Intro list and "Ambient displays" → wall and art only. Palette: Signal Amber no longer has a home on the map (say layer 1 keeps it for the wall); `--golden-amber` antenna mark → gone (legend icon is `--kc-dim`). Add to "The kiosk dashboard" (rename "The kiosk dashboard and map"): cartography = `--kc-map-*` (land = ground, water = well, quiet labels), pins/hits keep service colours, home pin sea-glass with glass-ink glyph, no-frequency live glow sea-glass, close call flamingo, no fix pine; legend and callsign chips in Schibsted, sentence case. Front-matter: Layer 1 comment → "(wall, art)"; drop `map-chip` typography entry; add `kc-map-*` colours.
- [ ] **tokens.css header**: LAYER 1 → "(wall, art; the dashboard and map moved to layer 2 on 2026-10-01 …)".
- [ ] **Definition of done:** `npm test`, `npm run test:native`, `npm run typecheck`, `npm run build` — all exit 0.
- [ ] **Wall:** `curl -X POST localhost:8080/api/kiosk/reload`, wait 15 s, `grim`; expected: legend-free kiosk map (the kiosk is non-interactive — legend only on /map), sea-glass home pin, framing clear of the clock. Headless-screenshot `/map` (DOM page; PNG inside `$HOME`) for the legend.
- [ ] **Push, PR**, body includes the **console steps for the operator**: Google Cloud console → Maps Platform → Map styles → the kerchunk style → JSON → paste `kiosk/kiosk-assets/map-style.json` → Save → **Publish** → wait a few minutes → `sudo systemctl restart kerchunk-display`. The cartography retint is not visible on the wall until then (the Map ID style is cloud-side).
