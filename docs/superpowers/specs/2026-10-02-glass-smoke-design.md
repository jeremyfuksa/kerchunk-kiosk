# Glass smoke: afterglows become wind-carried smoke & sparks

Date: 2026-10-02 · Status: design approved in brainstorm, awaiting spec review
Builds on: [`2026-10-02-fixed-stage-event-pacing-design.md`](2026-10-02-fixed-stage-event-pacing-design.md)
(PR B, `feat/glass-transmissions`). It replaces that spec's **afterglow**
(a per-site Gaussian fading over 60 s in `fadeSteps` steps). Fronts, the still
hold, the release dissolve, the pacing contract and the fixed stage all stand.

## Why

The operator's read of the shipped afterglow: the rings are right and the
same-service haze is a good start, but it fades far too fast and *does nothing*
while it lasts. The map should feel alive between transmissions: in the
operator's words, a lava lamp for radio, **something you can just stare at**.
The
constraint is still the box's thermals: every glass redraw re-composites the
whole Google map, and continuous haze drove it to its 90 °C trip on
2026-10-01. So anything that happens between transmissions has to be **coarse
steps on a shared tick**, never standing animation.

## Decisions (from the brainstorm)

| Question | Decision |
|---|---|
| What the in-between conveys | Nothing specific: the haze itself should evolve so the map never looks static. |
| Lifespan after a hit | **~10 minutes** (was 60 s). |
| Look | **Smoke & sparks** (mockup "B+D 1"): a soft plume carried downwind by the real surface wind, with ember grain riding inside it. Picked over ink diffusion, isobars, pure embers, plain plume, and streaky "blown embers". |
| Motion between transmissions | Stepped on one shared tick (`smokeStepMs`, 6 s). |
| Busy sites | Each transmission adds a puff, so a hot site streams a **trail** downwind; hits within `puffMergeMs` thicken the newest puff instead. |

Mockups: `.superpowers/brainstorm/371816-1790988283/content/haze-bd-mix.html`
(local only, gitignored).

## Behaviour

**Puff lifecycle.**

- **Birth.** When a front releases, its rim still dissolves over `RELEASE_MS`
  (unchanged), and a **puff** is born at the site in the service colour. The
  puff carries: site position, service colour, birth time, strength, and the
  **wind at birth** (direction + speed), plus a stable per-puff seed.
- **Re-feed.** If the site's newest puff was born less than `puffMergeMs` ago
  (60 s), a new release does not add a puff. It bumps that puff's strength
  (the 1–6 hit ramp, `rampStrength`) and **keeps its birth time**. Restarting
  the age would let a site hit every 30 s hold one puff at the source forever,
  with no trail. A busy site therefore holds at most
  `smokeLifeMs / puffMergeMs` ≈ 10 puffs.
- **Ageing.** Over `smokeLifeMs` (10 min), with `k = age / smokeLifeMs`:
  - **drift:** the centre moves downwind by `k × smokePxPerMph × mph`
    (screen px, scaled to a 1080-px-tall viewport so a resize keeps the look);
  - **stretch:** the along-wind radius grows by `1 + 1.6 k`, the cross-wind by
    `1 + 0.8 √k`, starting from the site's latched radius (`siteRadius`);
  - **dim:** strength × `(1 − k)²`;
  - **outline:** an irregular edge from noise keyed on the seed. The noise
    offset advances with the step index, so the outline shifts slightly on
    each tick.
- **Death.** At `k ≥ 1` the puff is removed. If more than `MAX_PUFFS` (48) are
  alive, the weakest current puff is dropped first.
- **History seed.** `seedGlow` becomes `seedPuff`: a backfilled transmission
  makes a puff whose birth time is the row's `ts`, so on reload the wall
  shows smoke already part-way through its life. The backfill fetch asks for
  the last `smokeLifeMs`, not the last hour, and uses the rows' real
  timestamps (the old 1 h → 60 s rescale goes). Seeds use the wind known at
  reload (or none).

**Rendering: smoke & sparks.**

- **Body:** each puff is a stretched Gaussian along its wind axis, with its
  noise-warped edge, times `smokeBody` (0.55).
- **Sparks:** inside the body, a per-pixel grain from a hash of
  (screen cell, seed, generation). A grain is lit when its hash is below the
  local smoke density × `sparkDensity`. Each grain's generation advances every
  7 steps with a per-grain stagger, so about 1/7 of the sparks reshuffle on
  each tick. The grain is densest at the source and thins downwind, because it
  follows the density.
- **Colour:** puffs add per channel, with a hue-preserving tone map (compress
  brightness by the max channel, keep the ratios). Same-service plumes merge;
  different services keep their hues where they overlap instead of washing
  to white.
- **Calm or unknown wind:** zero drift. A puff spreads isotropically and
  pools at the site.

**Wind source.**

- New pure module `src/frontend/lib/wind.ts`:
  - `parseWind("NE 7 mph") → { towardDeg: 225, mph: 7 } | null`. NWS gives the
    direction the wind comes **from**; the plume heads the other way. Ranges
    ("5 to 10 mph") use the upper bound. "Calm", unknown compass words or no
    number → `null`.
  - The compass table moves here from `dashboard.ts`, whose `windBlock` arrow
    uses `parseWind`.
  - A tiny module-level store: `setWind(raw)` and `onWind(cb)`.
- `dashboard.ts`'s existing `/api/weather` poll (`POLL_MS.weather`, 10 min)
  calls `setWind`. **No new poll**: the appliance can deadlock on concurrent
  requests. The map subscribes with `onWind` and hands the latest value to
  `glassState.setWind()`. A new wind only affects puffs born after it.
- `/map` (interactive) has no weather poll, so its smoke pools. That's
  acceptable.

## Pacing and cost

- **One shared tick.** Every puff's visible state (drift, stretch, dim,
  outline, spark generation) is sampled at `gridTick(now, smokeStepMs)`, an
  absolute grid like today's `gridTick`. N puffs cost **one** redraw per tick.
- **`frame()` contract:** while any puff is alive, `nextChangeAt` includes the
  next tick; with none alive it contributes nothing, so a quiet band still
  does **zero** glass redraws. `continuous` is unchanged (grows and dissolves
  only).
- **Budget:** about 10 redraws/min while smoke is alive (the 60 s afterglow
  ran about 24/min). Events (key-up, release, a changed signal level, a seed)
  still redraw immediately.
- **Shader:**
  - `uGlowA/uGlowC` (32) become `uPuffA/uPuffB/uPuffC` (`MAX_PUFFS` = 48):
    - A: centre px, along-wind radius px, strength;
    - B: wind unit vector, cross-wind radius px, seed;
    - C: colour.
  - New uniforms `uStep` (the step index, for outline and spark generations),
    `uSmokeBody` and `uSparkDensity`.
  - The grain and noise are evaluated only where the summed density > ε, so
    empty pixels pay only the puff loop.
- **CPU side:** drift and stretch are computed in `glassState` (pure TS) and
  projected once per redraw in `glassLayer`; no per-frame work between ticks.

## Knobs (`display.glass.*`, apply on `kiosk/reload`)

| Key | Default | Range | Notes |
|---|---|---|---|
| `smokeLifeMs` | 600 000 | 60 000–3 600 000 | A puff's life. Replaces `BLIP_LIFETIME_MS`. |
| `smokeStepMs` | 6 000 | 1 000–60 000 | The shared tick: redraws/min ≈ 60 000 / this. |
| `smokePxPerMph` | 60 | 0–200 | Drift over a full life per mph, in px at 1080 tall. 7 mph → about 420 px, roughly the mockup's third of the screen. 0 = never drift. |
| `smokeBody` | 0.55 | 0–1 | Body brightness vs the old afterglow. |
| `sparkDensity` | 1 | 0–3 | 0 = no sparks (body only). |
| `puffMergeMs` | 60 000 | 0–600 000 | A hit within this of the site's newest puff re-feeds it. |
| ~~`fadeSteps`~~ | | | Removed; zod strips the unknown key from old configs. |

`MAX_PUFFS` is a code constant (`glassMath.ts`), because it sizes the shader
arrays.

## Testing and proof

**Unit (vitest, headless).**

- `wind.test.ts`: from→toward inversion for all 16 points; ranges; "Calm",
  "", "Variable 3 mph" and missing numbers → `null`; the store notifies its
  subscribers.
- `glassState.test.ts` (puffs):
  - a release births a puff with the current wind;
  - a release within `puffMergeMs` re-feeds instead of adding one;
  - a release after it adds a second puff (a trail);
  - drift/stretch/dim at k = 0, 0.5 and 1;
  - the puff is gone at the end of its life;
  - the `MAX_PUFFS` cap drops the weakest;
  - a puff's state only changes across a `smokeStepMs` boundary;
  - `nextChangeAt` lands on the next tick while puffs live and is `null` for
    an empty scene;
  - `seedPuff` pre-ages a puff and skips rows that are too old;
  - a wind change leaves existing puffs alone.
- Schema: the defaults and ranges; an old config containing `fadeSteps`
  still loads.

**On the wall** (`grim` captures, per CLAUDE.md "Verifying changes").

- Drive `/api/test/tx` sequences: one site firing repeatedly (a trail), two
  services overlapping, a single kerchunk. Capture at the source, mid-drift
  and while dying out. With a key in `test/tx` there's no wind override, so
  also verify on the live band with the real wind.
- **Stare test (the goal).** Run the live band at `smokeStepMs` 6000, 3000
  and 1500, about 10 minutes each, with temperature and chromium CPU noted for
  each. The operator picks the default by eye within the thermal budget, and
  the spec's 6000 changes if they pick another.
- The pacing diag (`glassRedraws/min`) reads ≈ 60 000 / `smokeStepMs` while
  smoke lives, and 0 on a quiet band.
- **Thermal:** a 10-minute live-band run (temperature, CPU, chromium) against
  PR B's numbers. Budget: +2 °C and +10 % chromium.

## Rollout

1. `feat/glass-transmissions` (PR B) is pushed, proven and merged first.
2. This work is rebased onto `main` and shipped as **one PR**:
   - `lib/wind.ts`;
   - the `glassState` puffs;
   - shader and layer changes;
   - schema knobs;
   - the dashboard `setWind` hook;
   - docs: CLAUDE.md "Weather Glass layer" note, `docs/ROADMAP.md`.

   A backend restart is needed for the schema, then a `kiosk/reload`.
3. Not stacked on PR B on GitHub: merging a base PR with `--delete-branch`
   closes stacked PRs.

## Out of scope

- Any continuous animation (the smoke is still between ticks).
- Wind on `/map`, wind in the art or wall skins.
- Using the radar or other weather fields to shape the smoke.
- Changing fronts, the hold, the release dissolve or the camera.
