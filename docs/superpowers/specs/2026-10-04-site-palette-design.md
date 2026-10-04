# Site palette — service families, varied per site

Status: picked on the wall 2026-10-04 (hybrid per-site bands, glow-tuned family palette); approved to plan.

## Why

The operator "only ever sees red, blue, pink, purple — the busiest channel
types create a homogeneous colour cloud and sparks." Measured (smoke births
since the visual hold, ~18 h): business violet 52 %, public-safety red 28 %
(2 sites: St Luke's, KU Hospital), ham pink 8 %, air 6 %, GMRS 5 %. Two causes:

1. **Palette:** the three busiest families sit within ~60° of each other
   around magenta.
2. **Shader:** overlapping puffs average their hues (`glassShaders.ts`,
   `hue = acc / m`), so violet + red smoke becomes magenta mush and sparks
   inherit it.

The old palette also fails the roadmap's colour-vision rule: simulated
deuteranopia puts GMRS green and public-safety red at ΔE_ok 0.032 — the
red/green trap.

## Intent (operator's pick)

Colour says **which service family** (base hue) **and which site** (each
site its own variation inside the family). Overlapping smoke keeps each
plume's own colour. Picked on the live wall from three renders (bands,
curated swatches, hybrid) — the **hybrid**: continuous per-site bands with
the bands' saturation, wide arcs and a large lightness spread. Preview code:
branch `preview/site-palette` (`b124117`), throwaway.

## 1. Family palette (replaces `PIN_COLORS`)

OKLCH, searched for the best worst-case separation under normal,
deuteranopic and protanopic vision (Machado 2009 matrices), constrained to a
**glow-friendly band** — every family L 0.62–0.84 and chroma ≥ its floor —
because the strictest CVD optimum (worst case 0.130) got there by pushing
lightness to the extremes: on the wall its business smoke washed out pale
and its ham / public-safety plumes glowed dim. The operator picked the
glow-tuned set on the wall 2026-10-04:

| Family | OKLCH (L C h) | Hex | Glyph ink | Glyph contrast |
|---|---|---|---|---|
| publicsafety | 0.62 0.20 17 | `#e54059` | white | 4.03 |
| rail | 0.70 0.20 60 | `#e58212` | ink | 5.52 |
| weather | 0.81 0.18 82 | `#f5b40e` | ink | 8.36 |
| gmrs | 0.80 0.16 155 | `#56db8f` | ink | 8.73 |
| marine | 0.71 0.14 184 | `#07baaa` | ink | 6.31 |
| biz | 0.80 0.23 212 | `#21d4f0` | ink | 8.60 |
| air | 0.65 0.20 252 | `#0f90fe` | ink | 4.72 |
| ham | 0.64 0.19 327 | `#c55ac7` | ink | 4.15 |
| unknown | unchanged | `#747B8A` | white | — |

Worst-case pairwise ΔE_ok: **0.101** across normal / deutan / protan (hexes
are exactly the two-decimal OKLCH values above; air L 0.66 → 0.65 during
implementation to clear the 0.10 floor after rounding), vs the
old palette's 0.098 / **0.032** / 0.042 (old deutan worst: GMRS vs public
safety). "Ink" = `#1f2530` (the pins' dark). Glyph ink is whichever of white /
ink has the higher WCAG contrast on the head (all ≥ 4.03 : 1, icon floor
3 : 1); every head ≥ 4.71 : 1 on the LCD well (`#0c1113`).

`PIN_COLORS` stays the single source of truth (`lib/serviceColor.ts`); a new
`PIN_GLYPH_INK` beside it holds the per-family glyph colour.

## 2. SVG icons recoloured (operator requirement)

The nine service pins in `src/frontend/map/pins/pin-*.svg` bake the head
colour (and white glyph stroke) in as literals; `faceplate/serviceHead.ts`
reuses their glyphs for the live card's disc.

- Edit each `pin-<family>.svg`: head fill → the new hex; glyph stroke →
  that family's glyph ink. `pin-home.svg` is not a service and is unchanged.
- **Drift test:** for every family, its pin SVG contains `PIN_COLORS[f]` as
  the head fill and `PIN_GLYPH_INK[f]` as the glyph stroke — a palette edit
  that forgets the SVGs fails CI.
- The live card's head: disc = `PIN_COLORS[f]`; glyph drawn in
  `PIN_GLYPH_INK[f]` (today `currentColor` / `--kc-pin-glyph` white).
  `ringed` (the cream ring under 3 : 1 on the well) is re-evaluated by its
  existing test; with this palette no head needs it.

## 3. Per-site colour (glass + map dots)

`lib/siteColor.ts`: `siteColor(siteKey, family): string` — OKLCH around the
family base, both offsets seeded from the site key (FNV-1a), so a site keeps
its colour across reloads and restarts:

- hue = base h + arc · (2u − 1), u = hash(key)
- L = base L + spread · (v − 0.5), v = hash(key + "#L"); chroma = base C,
  pulled in until in sRGB gamut.

| Family | arc (±°) | L spread |
|---|---|---|
| biz | 28 | 0.12 |
| ham | 20 | 0.12 |
| gmrs | 12 | 0.10 |
| air | 8 | 0.10 |
| publicsafety | 6 | 0.06 |
| rail | 6 | 0.08 |
| marine | 4 | 0.08 |
| weather, unknown | 0 | 0 |

**Containment test:** for a sweep of site keys (1 500 per family), every
variant's nearest family base (ΔE_ok, normal vision) is its own family —
with one exception: business variants may sit nearer **marine**. Marine has
no located sites (its channels are unlocated; hits only edge-glow), so no
marine plume exists to be confused with; without the exception business is
squeezed to ±16° / 0.08. Verified while writing this spec: zero leaks under
these arcs.

**Where site colour applies:** glass rings, smoke and sparks (via
`glassSite().color` in `map.ts`, incl. the history backfill), and the map
site dots (`display.pins.style: "dot"`). Close Call hits keep their existing
colour. **Family colour everywhere else:** the live-card head, legend, admin
(`libraryChannels`), wall, art/sediment, and `pin`-style markers.

## 4. Overlap: the strongest puff owns its colour

Smoke shader: brightness still from Σ c·f; hue from Σ c·f^k normalised
(k = `display.glass.hueDominance`). Where one puff dominates it keeps its
own colour; where puffs are near-equal they blend softly. Sparks take that
hue. k = 1 reproduces today's average exactly.

## Knobs

- `display.glass.siteColor`: `"site"` (default) | `"service"` — `service`
  = family colour on the glass and dots too (escape hatch).
- `display.glass.hueDominance`: number 1–8, default 4.

Both apply on kiosk/reload.

## Cost

Shader: one extra `pow` + accumulate per puff per half-res pixel, only on
event-paced smoke renders (cached texture) — no new standing animation.
Check `[kiosk] glass redraws/smoke renders` and temperature are unchanged
after deploy.

## Testing

- `serviceColor.test.ts`: new hexes; CVD worst-case ΔE_ok ≥ 0.10 across
  normal/deutan/protan (pins the property, not just the values).
- `siteColor.test.ts`: deterministic per key; in gamut; containment.
- Pin SVG drift test (§2); `serviceHead` glyph-ink and ring tests.
- Update tests pinning old hexes: `dashboard.cornerView`, `faceplate.lcd`,
  `glassMath`, `sediment` (fixtures only).
- Shader: `hueDominance` uniform wired (glassLayer test), k = 1 path.
- Visual: wall screenshots (glass + card + dots) after deploy; operator
  stare test.

## Out of scope

- Marine sitting next to business (ΔE fine, but marine is unlocated edge
  glow only — revisit if the marine trial is kept).
- Colour by age/kind of transmission (option C, not picked).
