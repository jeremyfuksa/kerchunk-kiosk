# FFT-Detect Power — Bench A/B GO/NO-GO Procedure

**Date:** 2026-06-08
**Status:** Ready to run (flip the default only after ALL criteria PASS)

## Purpose

Gate flipping `scan.detectVia` from `"lane"` (current default) to `"fft"` (the
new path). Run this procedure on the cool, thermally-stable appliance after a
clean build is deployed. Keep `"lane"` as the documented fallback flag throughout.

---

## Prerequisites

- Appliance has been idle ≥30 min since last sustained DSP load (thermally stable).
- Build from `feat/fft-detect-power` is deployed to `/home/kiosk/kerchunk-kiosk`.
- Work from a **copy** of the live config:
  ```
  cp ~/.config/kerchunk/config.json /tmp/bench-config.json
  ```
  The helper is spawned by `WidebandEngine`; set `scan.detectVia` only in the
  copy — do NOT edit the live config during the run.
- A recording or live RF that spans at least one busy 12-channel group
  (use the active VHF/UHF group; 146–147 MHz + 464 MHz UHF cluster is ideal).
- Both run windows are over the **same RF** and comparable time of day.

---

## How to run both arms

`WidebandEngine` passes `--detect-via fft` to the helper when `scan.detectVia`
is `"fft"` (see `WidebandEngine.ts`). With `"lane"` unset or explicit the flag
is absent and the per-lane probes run — today's behavior unchanged.

**Arm A (baseline — lane power):**  
In the bench config, leave `scan.detectVia` unset (or `"lane"`). Run the kiosk
against live RF for ≥30 min spanning the busy 12-channel window. Capture the
`open`, `close`, `audible`, and `power` events from stdout (helper JSON lines)
to a timestamped log:

```
# From the deployed kiosk directory, with the bench config:
node dist/backend/index.js --config /tmp/bench-config-lane.json 2>&1 \
  | tee /tmp/bench-lane-$(date +%H%M).log
```

**Arm B (candidate — fft power):**  
In the bench config set `"scan": { "detectVia": "fft" }`. Run over the same RF
for the same ≥30 min window, same channel group. Log identically:

```
node dist/backend/index.js --config /tmp/bench-config-fft.json 2>&1 \
  | tee /tmp/bench-fft-$(date +%H%M).log
```

Compare the two logs side-by-side on the four criteria below.

---

## Metrics and PASS criteria

### 1. False-open rate (adjacent-bin bleed)
Count `{"ev":"open"}` events that appear in Arm B but have no corresponding open
in Arm A within ±2 polls (±40 ms) on the same channel.

**PASS:** FFT false-open count ≤ lane false-open count over the same window.

*If this fails:* reduce `DETECT_HALF_HZ` (fewer bins summed per channel) or
switch the bin sum to a center-weighted (Hann) weighting in `bin_power_db`.

### 2. No missed real transmissions
Count `{"ev":"open"}` events in Arm A (ground truth). Verify each has a
matching open in Arm B within the open-latency budget (see criterion 3).

**PASS:** zero misses — every lane open has a corresponding FFT open.

*If this fails:* increase `FFT_SLOW_FRAMES` (more averaging = lower noise floor
estimate) or check `DETECT_HALF_HZ` is wide enough for the channel's offset.

### 3. Open-latency within the existing budget
For matched open pairs (Arm A vs Arm B), measure the timestamp delta
(Arm B open minus Arm A open). The `FFT_SLOW_FRAMES = 176` (~150 ms) long
integration introduces latency relative to the ~100 ms per-lane average.

**PASS:** median open-latency delta ≤ 200 ms; no individual delta > 500 ms.

*If this fails:* reduce `FFT_SLOW_FRAMES` toward 100 frames (~85 ms), accepting
slightly noisier floor estimates.

### 4. Fast mute hold ≤ ~30 ms, no added gate chatter (TOP RISK)
The short integration (`FFT_FAST_FRAMES = 35`, ~30 ms) drives the audio gate.
FFT-bin power at ~30 ms is ~1.2 dB noisier than the dedicated 10 ms per-lane
probe; the ±0.5 dB `GATE_HYST_DB` must absorb it.

Listen to Arm B audio on the bench speaker. Check the log for rapid `audible`
on/off pairs with no corresponding open/close (gate flutter).

**PASS:** no audible click/chatter on carrier hold or drop; `audible` event
chatter count (rapid on/off within a single `open` hold) ≤ Arm A count.

*If this fails (the highest-risk criterion):* increase `FFT_FAST_FRAMES` toward
50–70 frames (~43–60 ms) — longer window trades a slightly later mute for
stability. If chatter persists above ~60 ms, FFT-detect does NOT become the
default; keep `"lane"` and revisit `GATE_HYST_DB`.

---

## Tuning knobs (in `wideband_helper.py`)

| Knob | Line | What it controls | Direction if criterion fails |
|---|---|---|---|
| `FFT_SLOW_FRAMES` | ~140 | Long integration window (~150 ms) — floor + open | Down if latency fails; up if misses |
| `FFT_FAST_FRAMES` | ~145 | Short integration window (~30 ms) — audio gate | Up if chatter (crit 4) |
| `DETECT_HALF_HZ` | ~146 | Half-bandwidth summed per channel (±8 kHz) | Down if adjacent bleed (crit 1) |

After any knob change, rebuild (`npm run build` in `kiosk/`) and re-deploy
before re-running the A/B.

---

## Decision

| Outcome | Action |
|---|---|
| ALL four criteria PASS | Set `scan.detectVia: "fft"` in the live config; deploy. Keep `"lane"` documented as fallback. |
| Any criterion FAILS | Keep `scan.detectVia` unset (`"lane"`); apply the tuning adjustment and schedule a repeat bench session. |

Do NOT flip the default speculatively. The thermal benefit is worth having; it
is not worth risking the operator-tuned squelch behavior.
