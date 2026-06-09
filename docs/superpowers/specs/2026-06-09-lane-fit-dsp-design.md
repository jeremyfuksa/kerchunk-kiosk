# Lane-fit DSP — build only the lanes/types the config needs (design)

> Status: design, approved 2026-06-09. Realizes item #1 of the DSP-efficiency
> hardening backlog (`docs/PROCESSOR-EFFICIENCY-REVIEW-2026-06-06.md`,
> ROADMAP). **Off-server caveat:** the lane-plan LOGIC is pure and
> off-server-buildable/testable; the DSP/flowgraph change touches the
> field-calibrated `wideband_helper.py` and its correctness (clean demod, no
> glitches) can only be PROVEN on the kiosk against real signals. Design + plan
> off-server; build + verify on hardware.

## Intent

The wideband helper runs a **fixed 12 channelizer lanes**, built once and
retuned per group-hop. The efficiency review found this is the dominant cost
(~2.4–2.5 cores for 12 lanes) and that it is wasteful in two ways:

1. **All 12 lanes run continuously**, including parked ones, even when no
   configured group is anywhere near 12 channels.
2. **Every lane builds and connects BOTH a NBFM demod path AND an AM envelope
   path** (`wideband_helper.py` `Lane.__init__`), so a plain FM channel pays
   for an AM detector it never uses, and vice versa.

This is also the heat/CPU the just-shipped host-health verdict was built to make
visible — so cutting it is directly continuous with that work.

**Goal:** build only the lanes, and only the demod paths, the *config* actually
needs — **without** changing the load-bearing "build once, retune per hop"
architecture (no per-hop flowgraph rebuild, which is the exact `rtl_fm`-style
thrash this engine was designed to avoid).

## Architecture

### The lane plan (pure, startup-time, the off-server-testable seam)

Before the flowgraph is built, a **pure function** inspects the grouping the
engine already computes (`groupChannels` in `WidebandEngine`) and derives a
**lane plan**. It lives in TypeScript (`WidebandEngine`, or a small extracted
`lanePlan.ts`) and is passed to the helper at spawn via args / the tune
protocol. It is computed ONCE at startup (and on a config-changing restart),
never per hop.

**Lane count:**
```
N = min(MAX_CHANS, max over all groups of group.length)
```
The flowgraph builds `N` lanes instead of a fixed 12. Group-hop still just
retunes; parked lanes within `N` still park exactly as today. We simply never
build slots that no group can fill. Any config whose busiest group is < 12 wins,
permanently.

**Per-slot mode set (positional):** channel→lane assignment is **positional** —
the helper packs each group's channels into lane slots `0..n` in order
(`wideband_helper.py`: `for i, chain in enumerate(self.chains): c = regs[i]`).
Slots therefore have **positional**, not semantic, identity: slot 0 may be a VHF
FM channel in one group and an airband AM channel in another. So for each slot
`i`:
```
modes[i] = { channel.mode of the channel each group places at position i, over all groups }
```
Lane `i` builds the **FM path** iff `modes[i]` contains an FM-family mode
(`fm`/`nfm`), the **AM path** iff `modes[i]` contains `am`. Always-FM slot →
FM-only; always-AM → AM-only; genuinely mixed slot → both (today's behavior, for
that slot only).

### The SAME/weather lane is excluded from type-pruning (risk reduction)

The last built lane carries the SAME decoder tap (today `MAX_CHANS - 1`; with
lane-fit, the last of the `N` built lanes). It is the most entangled part of the
flowgraph (decode-only weather, visiting-slot SAME). **This lane keeps BOTH
demod paths and its decoder tap regardless of its per-slot mode union.**
Type-pruning applies only to slots `0..N-2`. Rationale: the SAME/weather path is
field-calibrated and can't be fully verified off-server, so excluding it bounds
the blast radius — a hardware regression cannot originate in the weather/SAME
path. The savings cost is at most one lane's worth of an unused path; the risk
reduction is large.

### Helper changes

- `Lane.__init__` gains `build_fm: bool` and `build_am: bool`; it constructs and
  connects only the requested path(s). The unrequested path's blocks are not
  created and not connected to the adder. (The `build_power` flag is an existing
  precedent for conditional construction.)
- `WidebandEngine`'s chain list builds `range(N)` lanes, the last one always
  `build_fm=True, build_am=True` (the SAME lane), the rest per `modes[i]`.
- The spawn protocol carries `N` and the per-lane `(build_fm, build_am)` mask.

## What is off-server vs. hardware

- **Off-server (build + unit-test now):** the lane-plan computation — `N` from
  grouping, the positional `modes[i]` union, the SAME-lane-always-both rule.
  Pure function over a grouping; fully unit-testable with fixture configs.
- **Hardware (build + prove on the kiosk):** the `wideband_helper.py` changes
  (Lane building one path; `N` lanes). Correctness is a DSP property — every
  active channel still demodulates cleanly, FM and AM both sound right, no
  glitches, CPU actually drops — provable only against real signals.

The plan should put the pure lane-plan logic in its own task(s) (buildable now)
and the helper change in clearly hardware-gated task(s).

## Out of scope

- The polyphase-channelizer rewrite (parked; a different, larger DSP
  re-architecture).
- Per-group rebuild (explicitly rejected: reintroduces per-hop thrash).
- Efficiency items #2–#4 (one-lane weather flowgraph; skipping disabled-feature
  work; idle-render the dashboard) — separate, independent improvements.
- Changing `MAX_CHANS` itself, the group-floor detection math, or the SAME
  decoder behavior.

## Success criteria

- A config whose busiest group has `< 12` channels builds fewer than 12 lanes
  and the helper's steady-state CPU drops measurably (verified on the kiosk via
  the host-health "N / M cores" reading).
- Pure-FM configs build no AM paths on the pruned slots; AM/airband channels
  still demodulate correctly where present.
- The SAME/weather lane is unchanged and still decodes (visiting-slot SAME
  proof-of-life still fires).
- Group-hop remains a retune (no per-hop rebuild); boot still opens the SDR
  once.
- Every active channel in every group still demodulates cleanly with no audible
  regression (the hardware gate).
- The lane-plan logic is covered by off-server unit tests; the helper change is
  proven on hardware before its PR.
