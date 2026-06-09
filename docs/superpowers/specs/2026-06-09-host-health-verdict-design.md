# Host status → mission-health verdict (design)

> Status: design, approved 2026-06-09. Improves the shipped System health panel
> (ROADMAP Idea 16). Motivated by the operator's note that the panel's numbers —
> the DSP helper `%` especially — aren't intuitive: the panel shows raw gauges
> that demand interpretation instead of answering the only question that matters,
> "is the radio working?"

## Intent

The System health panel today is six raw gauges. Two of them say `%` but mean
different things: **CPU** is whole-machine (100% = all cores), while **DSP
helper** uses the `top` convention (100% = one core), so on a 4-core box the
helper reads `287%` — accurate, but it looks broken to anyone not steeped in
`top`, and "is 287% bad?" requires holding the core count in your head. The
panel is already aware its numbers mislead: the **Load** cell literally
apologizes (`"GR threads inflate this — trust temp"`) and **Temp** is hinted as
the metric to actually trust.

This appliance runs **hot by design** (steady-state 82–83°C). A box that is hot
and busy but still scanning is *fine*, yet the current panel reddens cells and
shows alarming numbers for exactly that normal state.

**The fix: lead with a mission-capability verdict.** Health means "is the radio
doing its job?", not "how much CPU is free." Resource numbers become *evidence*
you consult only when the verdict says something is wrong.

## The verdict model (backend)

A new **pure** function in `kiosk/src/backend/systemStats.ts`, beside the
existing `classifySystemAlerts` (it does **not** replace it — the alert
classifier keeps driving the existing `healthBanner`):

```
classifyHealth(input) -> { verdict: "healthy" | "stressed" | "trouble", reason: string }
```

Three states, mission-first:

- **TROUBLE** (red) — the radio is not doing its job:
  - `engineState === "error"` or `engineState === "stopped"`, OR
  - the DSP helper is crash-looping (see "recent helper restarts" below), OR
  - not `warmed` after a grace period from start (detection isn't trustworthy yet).
  - `reason` names the cause: "Scanner engine stopped" / "DSP helper keeps
    crashing" / "Still warming up."
- **STRESSED** (amber) — working, but under duress (still scanning, just coping):
  - `safetyMode` active (engine is shedding Close Call / sweep load to survive
    heat), OR sustained thermal throttling, OR a recent helper restart that has
    since recovered.
  - `reason`: e.g. "Running hot — Close Call paused to cool down."
- **HEALTHY** (green) — `engineState === "running"` AND `warmed` AND not shedding
  AND helper alive. `reason`: "Scanning normally." **A box at 83°C with the
  helper on three cores lands here** — which is the correct, honest reading.

Precedence: TROUBLE > STRESSED > HEALTHY (evaluate worst-first; first match wins).

### Inputs — all already available, no engine changes

`classifyHealth` is pure; the server passes it values it already holds:

- `engineState: EngineState` — `engine.state` (`stopped|starting|running|error`).
- `warmed: boolean` — the server already tracks this from the engine's `warmup`
  phase events (`booting`→…→`ready`).
- `safetyMode: boolean` — already tracked in `server.ts` and already on the
  `/api/system` payload.
- `recentSample: SystemSample` — for `throttled` / liveness (`helperCpuPct`).
- `helperRestartsRecent: number` — count of engine `error` events in a trailing
  window. **The engine already emits `{ type: "error", code, message, ts }`**
  when helper-spawn escalation trips (`WidebandEngine` `exitFailures`); the
  engine's private `exitFailures` counter is not exposed, but the server already
  receives these `error` events on its `EngineEvent` stream, so the server keeps
  a small trailing tally. No new engine API. A crash-loop (≥2 in the window) →
  TROUBLE; a single recent-but-recovered restart → STRESSED.
- `startedAt` / grace: "not warmed" only counts as TROUBLE after a grace period
  (e.g. 60 s) from engine start, so a normal cold boot reads STRESSED ("warming
  up"), not TROUBLE.

### Honest limitation (on the record)

There is **no direct "audio underrun / DSP fell behind" metric** on the wideband
engine. "Keeping up" is therefore inferred from *liveness* — helper alive, not
crash-looping, engine not in safetyMode — **not** from measured audio glitches.
The verdict answers "is the radio running and coping?" It does **not** claim "the
audio sounds perfect right now." This scope is deliberate; do not imply a
keeping-up signal that doesn't exist.

### Testing

`classifyHealth` is pure and unit-tested with fixture inputs (same pattern as the
existing `classifySystemAlerts` tests): each state's trigger conditions, the
worst-first precedence, the warm-up grace window, and the single-restart
(STRESSED) vs crash-loop (TROUBLE) distinction.

## The panel (frontend — verdict replaces gauges)

The admin "System health" section becomes verdict-first.

- **Headline = the verdict.** A prominent band: a colored indicator + the state
  word (**HEALTHY** / **STRESSED** / **TROUBLE**) + the plain-language `reason`.
  Colors via existing Campfire tokens — `--sage`/green, `--golden-amber`/amber,
  `--red` — consistent with `.healthBanner` and the channel-duplicates panel.
  This row is the whole panel at a glance.
- **Gauges collapse into a "Details" disclosure** below the verdict:
  - **HEALTHY** → details collapsed by default (you never see `287%` unless you
    expand).
  - **STRESSED / TROUBLE** → details auto-expanded, so the supporting numbers are
    right there the moment the verdict flags something. The verdict says *what*;
    the gauges show *how bad*.
- **Legibility fixes inside Details:**
  - **DSP helper** no longer shows a bare `287%`. It renders as
    **"2.9 / 4 cores"** — `helperCpuPct / 100` core-equivalents over
    `os.cpus().length` machine cores. Same underlying number, now self-explanatory
    and comparable to the box's real capacity. Spark retained (its existing
    400-scale / 320-"hot" line is unchanged under the hood).
  - **Load cell removed entirely.** On a GNU Radio box, load average is inflated
    by DSP threads enough that it needs a disclaimer to be read correctly; the
    verdict + CPU/temp/helper cover the real story. Delete the apology, not reword
    it.
  - **Temp / CPU / RAM / Open channels / Disk free** remain as plain evidence
    cells; Temp stops implying it is the one metric to trust (the verdict carries
    that now).

### Data path (unchanged shape)

`/api/system` already returns `{ now, ring, alerts, safetyMode }` and the panel
polls it every 3 s (plus the WS push). Add a `health: { verdict, reason }` field
to that payload, computed **server-side** so the polled and WS-driven views
always agree. The frontend renders the verdict from `health` and the details from
the existing `now`/`ring`. Core count for the "/N cores" denominator comes from
`os.cpus().length` (already imported in `systemStats.ts`).

## Architecture / isolation

- **`systemStats.ts`** — gains `classifyHealth` (pure) + a small trailing tally of
  engine `error` events feeding `helperRestartsRecent`. One responsibility each;
  unit-tested in isolation.
- **`server.ts`** — passes the values it already holds into `classifyHealth` and
  adds `health` to the `/api/system` payload. Thin; no health logic inline.
- **`admin.ts` / `admin.css`** — the verdict headline + Details disclosure +
  the "/N cores" formatting + Load-cell removal. Presentation only.

## Out of scope

- Any new engine instrumentation or a real audio-underrun metric (the honest
  limitation above stands; a measured keeping-up signal is a separate, larger
  project that touches the DSP helper).
- Changes to `classifySystemAlerts` or the existing `healthBanner` — they stay;
  the verdict is additive.
- Changes to what telemetry is collected — uses only signals that already exist.
- The kiosk dashboard (HDMI) — this is the **admin** System health panel only.

## Success criteria

- At a glance, the panel answers "is the radio working?" with one word + a plain
  reason, before any number is read.
- A normally hot, busy, scanning appliance reads **HEALTHY** (green), not a wall
  of reddened gauges.
- When the engine errors/stops, the helper crash-loops, or the box is shedding
  load, the verdict says so in plain language and the supporting gauges
  auto-expand.
- The DSP helper figure is legible without `top` knowledge ("2.9 / 4 cores").
- The Load cell and its apology are gone.
- `classifyHealth` is covered by off-server unit tests; the panel builds and the
  existing suite stays green. No engine changes.
