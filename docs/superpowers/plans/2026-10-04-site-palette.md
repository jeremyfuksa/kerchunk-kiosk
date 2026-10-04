# Site Palette Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the service palette with the glow-tuned, CVD-checked family colours (SVG pin icons included), give every site its own variation of its family colour on the glass and map dots, and let the strongest smoke puff keep its colour where puffs overlap.

**Architecture:** One OKLCH colour module (`lib/oklch.ts`) feeds a single family table in `lib/serviceColor.ts` (`FAMILY_OKLCH` → derived `PIN_COLORS` + `PIN_GLYPH_INK`). `lib/siteColor.ts` varies a family base per site key. The pin SVGs, the live-card head and the glass all read from those; two new `display.glass` knobs (`siteColor`, `hueDominance`) switch the glass behaviour.

**Tech Stack:** TypeScript (vanilla, ESM `.js` imports), WebGL2 GLSL ES 3.0, zod, vitest.

**Spec:** `docs/superpowers/specs/2026-10-04-site-palette-design.md` · preview reference (throwaway): branch `preview/site-palette`.

## Global Constraints

- All commands run from `kiosk/`. Relative imports carry `.js`. `strict` + `noUncheckedIndexedAccess`.
- Family palette, OKLCH (L C h) → hex — must match exactly:
  publicsafety 0.62 0.20 17 `#e63e58` · rail 0.70 0.20 60 `#e58312` · weather 0.81 0.18 82 `#f4b313` · gmrs 0.80 0.16 155 `#55dc8f` · marine 0.71 0.14 184 `#1abbab` · biz 0.80 0.23 212 `#06d5f1` · air 0.66 0.20 252 `#1d92ff` · ham 0.64 0.19 327 `#c55ac7` · unknown `#747B8A` (literal, unchanged).
- Glyph ink: white `#ffffff` for publicsafety and unknown; ink `#1f2530` for every other family.
- Per-site arcs (± hue°, L spread): biz 28/0.12 · ham 20/0.12 · gmrs 12/0.10 · air 8/0.10 · publicsafety 6/0.06 · rail 6/0.08 · marine 4/0.08 · weather 0/0 · unknown 0/0.
- CVD worst-case pairwise ΔE_ok ≥ 0.10 (normal, deuteranopia, protanopia; Machado 2009).
- Knobs: `display.glass.siteColor` `"site"` (default) | `"service"`; `display.glass.hueDominance` 1–8, default 4. Both apply on kiosk/reload.
- Site colour applies ONLY to glass rings/smoke/sparks and `dot` site markers; Close Call hits keep `colorFor`. Family colour everywhere else.
- `pin-home.svg` is not a service: do not touch it.
- No standing animation; the shader change rides the existing event-paced, cached smoke render.
- Definition of done (CLAUDE.md): `npm test`, `npm run test:native`, `npm run typecheck`, `npm run build`, proven on the wall.

## Review Focus

1. A site key never seen before (new transmitter) must get a stable colour on first sight and the same colour after a reload. → Task 3, test "same key, same colour; different keys usually differ".
2. `siteColor: "service"` must reproduce plain family colours on glass and dots (the escape hatch). → Task 3, test "service mode returns the family base".
3. `hueDominance: 1` must reproduce today's averaged smoke exactly (the shader escape hatch). → Task 4, test "k = 1 path is the plain average".
4. A palette edit that forgets the SVG icons must fail CI, not ship mismatched pins. → Task 2, drift test.
5. A per-site variant must never read as another family that actually draws plumes (only business→marine is allowed). → Task 3, containment test.

---

### Task 1: OKLCH module + family palette

**Files:**
- Create: `kiosk/src/frontend/lib/oklch.ts`
- Modify: `kiosk/src/frontend/lib/serviceColor.ts:6-10` (the `PIN_COLORS` literal)
- Test: `kiosk/test/oklch.test.ts` (new), `kiosk/test/serviceColor.test.ts`
- Modify (fixture): `kiosk/test/dashboard.cornerView.test.ts` (`"#E5383B"` → `"#e63e58"`)

**Interfaces:**
- Produces: `type Lch = { L: number; C: number; h: number }`; `oklchHex(c: Lch): string` (lower-case `#rrggbb`, chroma pulled in until in gamut); `hexToOklab(hex: string): [number, number, number]`; `linearRgb(hex: string): [number, number, number]`; `linearToOklab(rgb: [number, number, number]): [number, number, number]`.
- Produces (serviceColor.ts): `FAMILY_OKLCH: Record<Exclude<PinCategory, "unknown">, Lch>`; `PIN_COLORS` (derived, same shape as today); `PIN_GLYPH_INK: Record<PinCategory, string>`; `GLYPH_INK_DARK = "#1f2530"`.

- [ ] **Step 1: Write the failing tests**

`test/oklch.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { oklchHex, hexToOklab } from "../src/frontend/lib/oklch.js";

describe("oklch", () => {
  it("converts known OKLCH colours to sRGB hex", () => {
    expect(oklchHex({ L: 0.62, C: 0.20, h: 17 })).toBe("#e63e58");
    expect(oklchHex({ L: 0.80, C: 0.23, h: 212 })).toBe("#06d5f1");
  });
  it("pulls an out-of-gamut chroma in instead of clipping channels", () => {
    const hex = oklchHex({ L: 0.8, C: 0.5, h: 212 });
    expect(hex).toMatch(/^#[0-9a-f]{6}$/);
  });
  it("hexToOklab round-trips lightness", () => {
    expect(hexToOklab("#ffffff")[0]).toBeCloseTo(1, 3);
    expect(hexToOklab("#000000")[0]).toBeCloseTo(0, 3);
  });
});
```

In `test/serviceColor.test.ts`, replace the test "pins the recolored/added head hexes (blip + pin palette)" with:

```ts
  it("pins the glow-tuned family palette (spec 2026-10-04)", () => {
    expect(PIN_COLORS).toEqual({
      publicsafety: "#e63e58", rail: "#e58312", weather: "#f4b313", gmrs: "#55dc8f",
      marine: "#1abbab", biz: "#06d5f1", air: "#1d92ff", ham: "#c55ac7", unknown: "#747B8A",
    });
  });
  it("glyph ink: white on public safety and unknown, dark ink elsewhere", () => {
    expect(PIN_GLYPH_INK.publicsafety).toBe("#ffffff");
    expect(PIN_GLYPH_INK.unknown).toBe("#ffffff");
    for (const k of ["rail", "weather", "gmrs", "marine", "biz", "air", "ham"] as const) {
      expect(PIN_GLYPH_INK[k], k).toBe("#1f2530");
    }
  });
  it("families stay apart under colour-vision deficiency (worst ΔE_ok ≥ 0.10)", () => {
    // Machado 2009 severity-1.0 matrices, applied in linear RGB.
    const M: Record<string, number[][]> = {
      normal: [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
      deutan: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.011820, 0.042940, 0.968881]],
      protan: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
    };
    const fams = Object.keys(FAMILY_OKLCH);
    for (const [name, m] of Object.entries(M)) {
      const P = fams.map((f) => {
        const v = linearRgb(PIN_COLORS[f]!);
        const sim = m.map((r) => Math.min(1, Math.max(0, r[0]! * v[0] + r[1]! * v[1] + r[2]! * v[2]))) as [number, number, number];
        return linearToOklab(sim);
      });
      for (let i = 0; i < P.length; i++) {
        for (let j = i + 1; j < P.length; j++) {
          const d = Math.hypot(P[i]![0] - P[j]![0], P[i]![1] - P[j]![1], P[i]![2] - P[j]![2]);
          expect(d, `${name} ${fams[i]}/${fams[j]}`).toBeGreaterThanOrEqual(0.10);
        }
      }
    }
  });
```

and extend its import line to:

```ts
import { PIN_COLORS, PIN_GLYPH_INK, FAMILY_OKLCH, colorFor, categoryFor } from "../src/frontend/lib/serviceColor.js";
import { linearRgb, linearToOklab } from "../src/frontend/lib/oklch.js";
```

In `test/dashboard.cornerView.test.ts`, change `expect(v.head?.color).toBe("#E5383B");` to `expect(v.head?.color).toBe("#e63e58");` (the `#747B8A` assertion stays).

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/oklch.test.ts test/serviceColor.test.ts test/dashboard.cornerView.test.ts`
Expected: FAIL — `oklch.js` missing; `PIN_GLYPH_INK`/`FAMILY_OKLCH` undefined; cornerView expects the new red.

- [ ] **Step 3: Implement**

`src/frontend/lib/oklch.ts`:

```ts
// OKLCH / OKLab <-> sRGB (Björn Ottosson's matrices). The palette's one colour
// space: family bases, per-site variation and the CVD/containment tests.
export interface Lch { L: number; C: number; h: number }

function oklchToLinear({ L, C, h }: Lch): [number, number, number] {
  const a = C * Math.cos((h * Math.PI) / 180), b = C * Math.sin((h * Math.PI) / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  ];
}

/** OKLCH -> lower-case sRGB hex, pulling chroma in (0.005 steps) until the
 *  colour fits the gamut — hue and lightness are kept, never clipped apart. */
export function oklchHex(c: Lch): string {
  let C = c.C;
  let rgb = oklchToLinear({ ...c, C });
  while (C > 0 && rgb.some((v) => v < 0 || v > 1)) { C -= 0.005; rgb = oklchToLinear({ ...c, C }); }
  const enc = (v: number): number => {
    const x = Math.min(1, Math.max(0, v));
    return Math.round(255 * (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055));
  };
  return "#" + rgb.map((v) => enc(v).toString(16).padStart(2, "0")).join("");
}

/** "#rrggbb" -> linear-light RGB 0..1. */
export function linearRgb(hex: string): [number, number, number] {
  const ch = (i: number): number => {
    const x = parseInt(hex.slice(i, i + 2), 16) / 255;
    return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };
  return [ch(1), ch(3), ch(5)];
}

export function linearToOklab([r, g, b]: [number, number, number]): [number, number, number] {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
  ];
}

export function hexToOklab(hex: string): [number, number, number] {
  return linearToOklab(linearRgb(hex));
}
```

`src/frontend/lib/serviceColor.ts` — move the `PinCategory` type above the palette and replace the `PIN_COLORS` literal with:

```ts
import { oklchHex, type Lch } from "./oklch.js";

export type PinCategory =
  "air" | "rail" | "ham" | "gmrs" | "biz" | "marine" | "weather" | "publicsafety" | "unknown";

// Service family palette (spec 2026-10-04 site palette): OKLCH bases searched
// for the best worst-case separation under normal / deuteranopic / protanopic
// vision inside a glow-friendly band (L 0.62–0.84). One source: PIN_COLORS,
// the pin SVGs (drift-tested), the live-card head and the glass all follow it.
export const FAMILY_OKLCH: Record<Exclude<PinCategory, "unknown">, Lch> = {
  publicsafety: { L: 0.62, C: 0.20, h: 17 },
  rail: { L: 0.70, C: 0.20, h: 60 },
  weather: { L: 0.81, C: 0.18, h: 82 },
  gmrs: { L: 0.80, C: 0.16, h: 155 },
  marine: { L: 0.71, C: 0.14, h: 184 },
  biz: { L: 0.80, C: 0.23, h: 212 },
  air: { L: 0.66, C: 0.20, h: 252 },
  ham: { L: 0.64, C: 0.19, h: 327 },
};

export const PIN_COLORS: Record<string, string> = {
  ...Object.fromEntries(Object.entries(FAMILY_OKLCH).map(([k, c]) => [k, oklchHex(c)])),
  unknown: "#747B8A",
};

/** The pin/head glyph colour: whichever of white / dark ink reads better on
 *  the head (all >= 4.04:1). */
export const GLYPH_INK_DARK = "#1f2530";
export const PIN_GLYPH_INK: Record<PinCategory, string> = {
  publicsafety: "#ffffff", unknown: "#ffffff",
  rail: GLYPH_INK_DARK, weather: GLYPH_INK_DARK, gmrs: GLYPH_INK_DARK, marine: GLYPH_INK_DARK,
  biz: GLYPH_INK_DARK, air: GLYPH_INK_DARK, ham: GLYPH_INK_DARK,
};
```

(delete the old `PinCategory` declaration further down; update the file's top comment, which still says rail "rust" / ham "pink").

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run test/oklch.test.ts test/serviceColor.test.ts test/dashboard.cornerView.test.ts && npm run typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/frontend/lib/oklch.ts src/frontend/lib/serviceColor.ts test/oklch.test.ts test/serviceColor.test.ts test/dashboard.cornerView.test.ts
git commit -m "feat(palette): glow-tuned, CVD-checked service family colours (OKLCH)"
```

---

### Task 2: Recolour the SVG icons + live-card head

**Files:**
- Modify: `kiosk/src/frontend/map/pins/pin-{air,rail,ham,gmrs,biz,publicsafety,marine,weather,unknown}.svg`
- Modify: `kiosk/src/frontend/faceplate/serviceHead.ts` (`ServiceHead`, `serviceHead()`)
- Modify: `kiosk/src/frontend/faceplate/lcd.ts:44` (`headSvg` glyph stroke)
- Create: `kiosk/test/pins.palette.test.ts`
- Modify: `kiosk/test/faceplate.serviceHead.test.ts`, `kiosk/test/faceplate.lcd.test.ts`

**Interfaces:**
- Consumes: `PIN_COLORS`, `PIN_GLYPH_INK`, `PinCategory` (Task 1).
- Produces: `ServiceHead.ink: string` (the glyph stroke colour).

- [ ] **Step 1: Write the failing tests**

`test/pins.palette.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PIN_COLORS, PIN_GLYPH_INK, type PinCategory } from "../src/frontend/lib/serviceColor.js";

const DIR = join(__dirname, "..", "src", "frontend", "map", "pins");
const CATS = Object.keys(PIN_COLORS) as PinCategory[];

// Drift guard (spec 2026-10-04 §2): the pin SVGs bake the head colour and the
// glyph stroke in as literals; a palette edit that forgets them must fail.
describe("pin SVGs follow the palette", () => {
  for (const cat of CATS) {
    it(cat, () => {
      const svg = readFileSync(join(DIR, `pin-${cat}.svg`), "utf8");
      const head = /<circle cx="21" cy="21" r="17\.5" fill="(#[0-9A-Fa-f]{6})"/.exec(svg)?.[1];
      const ink = /<g transform="translate\(10\.5 10\.5\) scale\(0\.875\)"[^>]*stroke="(#[0-9A-Fa-f]{6})"/.exec(svg)?.[1];
      expect(head?.toLowerCase(), "head fill").toBe(PIN_COLORS[cat]!.toLowerCase());
      expect(ink?.toLowerCase(), "glyph stroke").toBe(PIN_GLYPH_INK[cat].toLowerCase());
    });
  }
});
```

In `test/faceplate.serviceHead.test.ts`:
- in "every category has its PIN_COLORS colour …" add `expect(h.ink, cat).toBe(PIN_GLYPH_INK[cat]);` and import `PIN_GLYPH_INK` from `../src/frontend/lib/serviceColor.js`;
- rename "rings exactly the heads under 3:1 on the well (today: business, rail)" to "rings exactly the heads under 3:1 on the well (today: none)" and change `expect(ringed).toEqual(["biz", "rail"]);` to `expect(ringed).toEqual([]);`.

In `test/faceplate.lcd.test.ts` ("head renders the disc + glyph …"): change `fill="#E5383B"` in the regex to `fill="#e63e58"` and `expect(h).toContain('stroke="currentColor"');` to `expect(h).toContain('stroke="#ffffff"');`.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/pins.palette.test.ts test/faceplate.serviceHead.test.ts test/faceplate.lcd.test.ts`
Expected: FAIL — SVG heads still the old hexes; `h.ink` undefined; ringed is `["biz","rail"]`… (computed from the new colours it is already `[]`, so that line may pass); LCD still `currentColor`.

- [ ] **Step 3: Implement**

SVGs — in each `pin-<cat>.svg` set the head `<circle cx="21" cy="21" r="17.5" fill="…">` to `PIN_COLORS[cat]` and the glyph group's `stroke="…"` (the `<g transform="translate(10.5 10.5) scale(0.875)" …>`) to `PIN_GLYPH_INK[cat]`:

| file | head fill | glyph stroke |
|---|---|---|
| pin-publicsafety.svg | `#e63e58` | `#ffffff` |
| pin-rail.svg | `#e58312` | `#1f2530` |
| pin-weather.svg | `#f4b313` | `#1f2530` (was `#2B303B`) |
| pin-gmrs.svg | `#55dc8f` | `#1f2530` |
| pin-marine.svg | `#1abbab` | `#1f2530` (was `#2B303B`) |
| pin-biz.svg | `#06d5f1` | `#1f2530` |
| pin-air.svg | `#1d92ff` | `#1f2530` |
| pin-ham.svg | `#c55ac7` | `#1f2530` |
| pin-unknown.svg | `#747B8A` (unchanged) | `#ffffff` (unchanged) |

Edit only those two attributes (e.g. `sed -i 's/fill="#6D28D9"/fill="#06d5f1"/'` then the glyph-group stroke); leave the cream body, shadow and inner glyph paths alone.

`serviceHead.ts` — add to the interface:

```ts
  /** The glyph stroke — PIN_GLYPH_INK for the category (white or dark ink). */
  ink: string;
```

import `PIN_GLYPH_INK` beside `PIN_COLORS`, and build the head as:

```ts
    h = {
      color, ink: PIN_GLYPH_INK[known as PinCategory] ?? PIN_GLYPH_INK.unknown,
      glyph: glyphOf(PIN_SVG[known]), ringed: contrastOnWell(color) < HEAD_MIN_CONTRAST,
    };
```

`lcd.ts` `headSvg` — `stroke="currentColor"` → `stroke="${h.ink}"`.

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run test/pins.palette.test.ts test/faceplate.serviceHead.test.ts test/faceplate.lcd.test.ts test/dashboard.cornerView.test.ts && npm run typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/frontend/map/pins src/frontend/faceplate/serviceHead.ts src/frontend/faceplate/lcd.ts test/pins.palette.test.ts test/faceplate.serviceHead.test.ts test/faceplate.lcd.test.ts
git commit -m "feat(palette): recolour the service pin SVGs + live-card head; drift-tested"
```

---

### Task 3: Per-site colour

**Files:**
- Create: `kiosk/src/frontend/lib/siteColor.ts`
- Create: `kiosk/test/siteColor.test.ts`

**Interfaces:**
- Consumes: `oklchHex`, `hexToOklab` (Task 1); `FAMILY_OKLCH`, `PIN_COLORS`, `PinCategory` (Task 1).
- Produces: `type SiteColorMode = "site" | "service"`; `SITE_ARC: Record<PinCategory, { hue: number; light: number }>`; `siteColor(key: string, cat: PinCategory, mode: SiteColorMode): string`.

- [ ] **Step 1: Write the failing tests**

`test/siteColor.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { siteColor, SITE_ARC } from "../src/frontend/lib/siteColor.js";
import { PIN_COLORS, FAMILY_OKLCH, type PinCategory } from "../src/frontend/lib/serviceColor.js";
import { hexToOklab } from "../src/frontend/lib/oklch.js";

const keys = Array.from({ length: 1500 }, (_, i) => `${(39 + i * 1e-4).toFixed(5)},${(-94.5 - i * 3e-4).toFixed(5)}`);

describe("siteColor", () => {
  it("same key, same colour; different keys usually differ", () => {
    expect(siteColor("39.16139,-94.46806", "biz", "site")).toBe(siteColor("39.16139,-94.46806", "biz", "site"));
    const distinct = new Set(keys.slice(0, 50).map((k) => siteColor(k, "biz", "site")));
    expect(distinct.size).toBeGreaterThan(30);
  });
  it("service mode returns the family base", () => {
    for (const cat of Object.keys(PIN_COLORS) as PinCategory[]) {
      expect(siteColor(keys[0]!, cat, "service"), cat).toBe(PIN_COLORS[cat]);
    }
  });
  it("families with no arc (weather, unknown) never vary", () => {
    expect(SITE_ARC.weather).toEqual({ hue: 0, light: 0 });
    expect(siteColor(keys[7]!, "weather", "site")).toBe(PIN_COLORS.weather);
    expect(siteColor(keys[7]!, "unknown", "site")).toBe(PIN_COLORS.unknown);
  });
  it("every variant is a valid hex", () => {
    for (const k of keys.slice(0, 200)) expect(siteColor(k, "ham", "site")).toMatch(/^#[0-9a-f]{6}$/);
  });
  it("containment: each variant's nearest family base is its own (business may sit nearer marine)", () => {
    const fams = Object.keys(FAMILY_OKLCH) as Array<keyof typeof FAMILY_OKLCH>;
    const base = Object.fromEntries(fams.map((f) => [f, hexToOklab(PIN_COLORS[f]!)]));
    for (const f of fams) {
      for (const k of keys) {
        const p = hexToOklab(siteColor(k, f, "site"));
        let best = "", bd = Infinity;
        for (const g of fams) {
          const q = base[g]!;
          const d = Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
          if (d < bd) { bd = d; best = g; }
        }
        const ok = best === f || (f === "biz" && best === "marine");
        expect(ok, `${f} key ${k} nearer ${best}`).toBe(true);
      }
    }
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/siteColor.test.ts`
Expected: FAIL — `siteColor.js` missing.

- [ ] **Step 3: Implement** — `src/frontend/lib/siteColor.ts`:

```ts
// Per-site colour (spec 2026-10-04 site palette): each site wears its own
// variation of its family's base — hue within ±arc, lightness within ±spread/2
// — seeded from the site key, so a transmitter keeps its colour across reloads.
// Applies to the glass (rings, smoke, sparks) and the "dot" site markers only.
import { oklchHex } from "./oklch.js";
import { FAMILY_OKLCH, PIN_COLORS, type PinCategory } from "./serviceColor.js";

export type SiteColorMode = "site" | "service";

/** ± hue degrees and total lightness spread per family. Business gets the most
 *  room (it is ~half the smoke); public safety and rail stay tight so a hospital
 *  plume never drifts toward rail orange. Containment-tested. */
export const SITE_ARC: Record<PinCategory, { hue: number; light: number }> = {
  biz: { hue: 28, light: 0.12 }, ham: { hue: 20, light: 0.12 }, gmrs: { hue: 12, light: 0.10 },
  air: { hue: 8, light: 0.10 }, publicsafety: { hue: 6, light: 0.06 }, rail: { hue: 6, light: 0.08 },
  marine: { hue: 4, light: 0.08 }, weather: { hue: 0, light: 0 }, unknown: { hue: 0, light: 0 },
};

/** Stable 0..1 per string (FNV-1a). */
function hash01(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0) / 4294967296;
}

export function siteColor(key: string, cat: PinCategory, mode: SiteColorMode): string {
  const family = PIN_COLORS[cat] ?? PIN_COLORS.unknown!;
  if (mode === "service" || cat === "unknown") return family;
  const arc = SITE_ARC[cat];
  if (arc.hue === 0 && arc.light === 0) return family;
  const base = FAMILY_OKLCH[cat];
  const u = hash01(key), v = hash01(key + "#L");
  return oklchHex({ L: base.L + arc.light * (v - 0.5), C: base.C, h: base.h + arc.hue * (2 * u - 1) });
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run test/siteColor.test.ts && npm run typecheck`
Expected: PASS (containment: 0 failures); typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/frontend/lib/siteColor.ts test/siteColor.test.ts
git commit -m "feat(palette): per-site colour within the family arc, containment-tested"
```

---

### Task 4: Knobs + dominant-hue smoke

**Files:**
- Modify: `kiosk/src/backend/config/schema.ts` (`display.glass`, after `smokeScale`)
- Modify: `kiosk/src/frontend/map/glassLayer.ts:20-25` (`GlassKnobs`), `:182` (link list), `:406` (uniform)
- Modify: `kiosk/src/frontend/map/glassShaders.ts` (`SMOKE_FS`)
- Test: `kiosk/test/glassShaders.palette.test.ts` (new), `kiosk/test/api.test.ts`

**Interfaces:**
- Produces: config `display.glass.siteColor: "site" | "service"` (default `"site"`), `display.glass.hueDominance: number` (1–8, default 4); `GlassKnobs.hueDominance: number`; shader uniform `uHueDominance`.

- [ ] **Step 1: Write the failing tests**

`test/glassShaders.palette.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SMOKE_FS } from "../src/frontend/map/glassShaders.js";

describe("smoke hue dominance (spec 2026-10-04 §4)", () => {
  it("declares uHueDominance and weights hue by f^k, brightness by f", () => {
    expect(SMOKE_FS).toContain("uniform float uHueDominance;");
    expect(SMOKE_FS).toMatch(/accP \+= c\.rgb \* pow\(f, uHueDominance\);/);
    expect(SMOKE_FS).toMatch(/acc \+= c\.rgb \* f;/);
  });
  it("k = 1 path is the plain average (accP == acc, so hue = acc / m)", () => {
    // With k = 1, pow(f, 1) = f: accP accumulates exactly what acc does.
    expect(SMOKE_FS).toMatch(/vec3 hue = mp > 1e-9 \? accP \/ mp : acc \/ m;/);
  });
  it("the layer links and sets the uniform from the knob", () => {
    const src = readFileSync(join(__dirname, "..", "src", "frontend", "map", "glassLayer.ts"), "utf8");
    expect(src).toContain('"uHueDominance"');
    expect(src).toMatch(/gl\.uniform1f\(u\.uHueDominance!, k\.hueDominance\)/);
  });
});
```

In `test/api.test.ts`, add near the other config validation tests:

```ts
  it("display.glass palette knobs default and validate", async () => {
    const { server } = makeApp();
    const cfg = (await request(server).get("/api/config")).body;
    expect(cfg.display.glass.siteColor).toBe("site");
    expect(cfg.display.glass.hueDominance).toBe(4);
    cfg.display.glass.hueDominance = 12;
    expect((await request(server).put("/api/config").send(cfg)).status).toBe(400);
    cfg.display.glass.hueDominance = 1;
    cfg.display.glass.siteColor = "rainbow";
    expect((await request(server).put("/api/config").send(cfg)).status).toBe(400);
  });
```

(If `makeApp()`'s default config has no `display` block, set `cfg.display = { weatherLat: 39, weatherLon: -94.5 }` before the PUTs and assert the defaults on the PUT response body instead.)

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/glassShaders.palette.test.ts test/api.test.ts -t "palette|hue dominance"`
Expected: FAIL — no `uHueDominance`; knobs absent.

- [ ] **Step 3: Implement**

`schema.ts`, inside `display.glass` after `smokeScale`:

```ts
      // Site palette (spec 2026-10-04): "site" = each transmitter its own
      // variation of its family colour on the glass and dot markers;
      // "service" = plain family colours. hueDominance = how strongly the
      // strongest overlapping puff keeps its own hue (1 = old even average).
      siteColor: z.enum(["site", "service"]).default("site"),
      hueDominance: z.number().min(1).max(8).default(4),
```

`glassLayer.ts`: add `hueDominance: number;` to `GlassKnobs`; add `"uHueDominance"` to the `link(gl, FX_VS, SMOKE_FS, [...])` name list; after `gl.uniform1f(u.uSparkDensity!, k.sparkDensity);` add `gl.uniform1f(u.uHueDominance!, k.hueDominance);`.

`glassShaders.ts` `SMOKE_FS`: add `uniform float uHueDominance;` after `uniform float uSparkDensity;`; then

```glsl
  vec3 acc = vec3(0.0);
  vec3 accP = vec3(0.0);   // hue weighted by f^k: the strongest puff owns its colour, near-equal puffs blend
  float peak = 0.0;
```

in the loop, after `acc += c.rgb * f;`:

```glsl
    accP += c.rgb * pow(f, uHueDominance);
```

and replace `vec3 hue = acc / m;  // keep service hues; compress brightness only` with

```glsl
    float mp = max(max(accP.r, accP.g), accP.b);
    vec3 hue = mp > 1e-9 ? accP / mp : acc / m;            // dominant puff's hue; brightness still from acc
```

(`f` is ≥ 0 there — `a.w * exp(...) * (0.25 + 1.1 * fbm)` — so `pow(f, k)` is defined.)

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run test/glassShaders.palette.test.ts test/api.test.ts test/glassLayer.test.ts && npm run typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/backend/config/schema.ts src/frontend/map/glassLayer.ts src/frontend/map/glassShaders.ts test/glassShaders.palette.test.ts test/api.test.ts
git commit -m "feat(glass): display.glass.siteColor + hueDominance — strongest puff keeps its colour"
```

---

### Task 5: Wire site colour into the map

**Files:**
- Modify: `kiosk/src/frontend/map/map.ts` — imports; `dotMarker` (~line 45); `glassSite` (~line 349); `siteIcon` + its two calls in `antenna()` (~lines 374–401)

**Interfaces:**
- Consumes: `siteColor`, `SiteColorMode` (Task 3); `display.glass.siteColor` (Task 4).

No unit test: `map.ts` needs the Google Maps runtime (its pure pieces are covered by Tasks 1–4). Verification is typecheck + the wall in Task 6.

- [ ] **Step 1: Implement**

Imports: `import { siteColor } from "../lib/siteColor.js";`

`dotMarker` gains an optional fill:

```ts
function dotMarker(cat: PinCategory, d: number, fill: string = PIN_COLORS[cat] ?? PIN_COLORS.unknown!): any {
```

(and drop the old `const fill = …` line inside it).

`glassSite`:

```ts
    const glassSite = (lat: number, lng: number, freq: number | undefined, kind: "active" | "closecall"): GlassSite => {
      const key = `${lat.toFixed(5)},${lng.toFixed(5)}`;
      // Site palette (spec 2026-10-04): a live site wears its own variation of
      // its family colour; Close Call hits keep their flamingo/service colour.
      const hex = kind === "active"
        ? siteColor(key, categoryFor(freq, tagsFor(freq)), display.glass.siteColor)
        : colorFor(freq, kind, tagsFor(freq));
      return { key, lat, lng, color: hexToGlowRgb(hex) };
    };
```

`siteIcon` takes the site key:

```ts
    const siteIcon = (svg: string, key: string): any => {
      const cat = PIN_CATEGORY.get(svg) ?? "unknown";
      return display.pins.style === "dot"
        ? dotMarker(cat, Math.round(display.pins.sizePx * mk), siteColor(key, cat, display.glass.siteColor))
        : pinMarker(svg, Math.round(display.pins.sizePx * mk));
    };
```

and in `antenna()` change `siteIcon(better)` → `siteIcon(better, key)` and `icon: siteIcon(pin),` → `icon: siteIcon(pin, key),`.

`glassSite` is declared after `const display = cfg.display!;` — confirm it is (it is, in the same `start()` scope); if not, move the `display` const above it.

- [ ] **Step 2: Verify**

Run: `npm run typecheck && npx vitest run`
Expected: typecheck clean; full suite green.

- [ ] **Step 3: Commit**

```bash
git add src/frontend/map/map.ts
git commit -m "feat(map): glass and dot markers wear per-site colour (display.glass.siteColor)"
```

---

### Task 6: Docs, full checks, wall proof, PR

**Files:**
- Modify: `CLAUDE.md` (Weather Glass architecture note, after the `display.pins` sentence)

- [ ] **Step 1: Document**

```markdown
  Colour is family + site (spec 2026-10-04): `lib/serviceColor.ts`
  `FAMILY_OKLCH` is the one palette (pin SVGs are drift-tested against it);
  `display.glass.siteColor` (`site` | `service`) and `hueDominance` (1 = old
  averaged smoke) tune the glass.
```

- [ ] **Step 2: Definition-of-done checks** (from `kiosk/`)

Run: `npm test && npm run test:native && npm run typecheck && npm run build`
Expected: all pass.

- [ ] **Step 3: Deploy** — schema changed (new `display.glass` fields), so restart the backend, then reload the wall:

```bash
sudo systemctl restart kerchunk-kiosk && sleep 12 && curl -s localhost:8080/api/status
curl -s -X POST localhost:8080/api/kiosk/reload
```

- [ ] **Step 4: Prove on the wall** — after ~15 s:
  `XDG_RUNTIME_DIR=/run/user/1000 WAYLAND_DISPLAY=wayland-0 grim /tmp/claude-1000/palette-live.png`, read it, and check: smoke is distinct per family with per-site variation (not a single magenta mass); the live-card head shows the new family colour with the right glyph ink; dots match their plumes. Also check `journalctl -u kerchunk-kiosk --since "-10 min" | grep "glass redraws"` once a pacing report lands — redraw/smoke-render rates unchanged in kind.

- [ ] **Step 5: Commit, PR, merge, clean up**

```bash
git add CLAUDE.md && git commit -m "docs: site palette knobs"
git push -u origin feat/site-palette
gh pr create --title "feat(palette): service families varied per site, CVD-checked; SVG icons recoloured" --body "<summary, spec link, CVD numbers, wall screenshots described, test results, 🤖 footer>"
# after CI green:
gh pr merge <n> --merge --delete-branch && git checkout main && git pull --ff-only && git fetch --prune
git branch -D preview/site-palette   # the throwaway preview branch (never pushed)
```

Out of scope (per spec): colour by age/kind of transmission; marine/business adjacency (revisit if the marine trial is kept).
