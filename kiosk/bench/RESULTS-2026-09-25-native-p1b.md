# Native DSP P1b — results — 2026-09-25

## Quieting calibration (QUIET_DB_DEFAULT)

Capture: KIOSK01 2 m group, 146.03375 MHz, 2.4 Msps, 30 s. Tool: kc-quiet-survey, 11 lanes, 100 ms rows.

### Original script output (round 1 — since revised, kept here for the record)

```
windows: keyed=25 dead=3204
dead quiet_db  p5=-2.89 p50=-1.86
keyed quiet_db p50=-31.73 p95=-5.15
RECOMMEND QUIET_DB_DEFAULT=-4.0 (keyed p95 -5.15 < dead p5 -2.89)
```

This first pass treated `keyed p95=-5.15` as a real separation point and recommended -4.0.
Review found that reading was an artifact: all 25 "keyed" windows came from a single lane
(+591250 Hz = 146.625 MHz), the trailing-edge rows of five periodic ~500 ms bursts (t≈3.2,
10.2, 16.2, 22.2, 28.2 s). The 100 ms slow-power window that gates "keyed" still reads hot for
a row or two after the 10 ms quiet-power window has already seen the carrier unkey, so those
edge rows' *quiet_db* values are really post-unkey noise, not signal — they pulled the keyed
pool's p95 all the way up to -5.15 and produced a false separation from the dead pool.

### Revised script (round 2) — edge-row artifact removed

`quiet_calibrate.py` now only pools a row into the keyed (or dead) set if it *and* its
previous *and* next row (same lane) all satisfy the raw threshold — this drops exactly the
trailing-edge rows described above. It also prints per-lane keyed/dead counts and the number
of distinct raw-keyed runs (bursts) per lane, so a sample dominated by one lane/one repeating
source is visible instead of hidden inside a pooled percentile.

Re-run of the script only (survey NOT re-run; same `2m-quiet-survey.csv` from the original
30 s capture), output:

```
lane -903750: keyed=0 dead=292 bursts=0
lane -883750: keyed=0 dead=292 bursts=0
lane -723750: keyed=0 dead=292 bursts=0
lane -563750: keyed=0 dead=292 bursts=0
lane 486250: keyed=0 dead=292 bursts=0
lane 591250: keyed=15 dead=252 bursts=5
lane 603750: keyed=0 dead=292 bursts=0
lane 666250: keyed=0 dead=292 bursts=0
lane 728750: keyed=0 dead=292 bursts=0
lane 756250: keyed=0 dead=292 bursts=0
lane 903750: keyed=0 dead=292 bursts=0
windows: keyed=15 dead=3172
dead quiet_db  mean=-1.87 p5=-2.89 p50=-1.86 min=-4.68
dead below -3.0: 111/3172  below -5.0: 0/3172
keyed quiet_db p50=-31.81 p95=-30.36 worst(max)=-29.69
INSUFFICIENT KEYED WINDOWS
```

With edge rows excluded, every keyed window still comes from the same single lane
(+591250 Hz) and the same 5 bursts — there is no weak, fluttering, or voice-like carrier
anywhere in this 30 s capture, only one periodic, strongly-hot (~+15 dB over floor), likely
non-voice source. Its steady (non-edge) quiet_db is deeply quieted (worst -29.69 dB, p50
-31.81 dB) — nowhere near the dead-noise floor. That leaves only 15 keyed core windows, below
the script's own 20-window confidence floor, so it correctly reports `INSUFFICIENT KEYED
WINDOWS` and does not emit a `RECOMMEND` this round; the recommend logic is advisory only and
was not usable here.

Dead-window stats (3172 core-dead rows, pooled across all 11 lanes) are the only trustworthy
statistic from this capture: mean -1.87 dB, p5 -2.89 dB, min -4.68 dB, 111/3172 rows below
-3.0 dB, 0/3172 below -5.0 dB.

### Synthetic anchor (test_hardening, unchanged)

carrier -45.78 dB, noise -0.92 dB, hot-deviation carrier -18.93 dB.

### Chosen: QUIET_DB_DEFAULT = -6.0

This is a **chosen** value, not a computed midpoint — the real-RF sample here has no usable
weak/voice-carrier data to midpoint against (only one strong periodic non-voice source, one
lane, five bursts). Reasoning:

- No dead-window reading in the whole 30 s / 11-lane capture falls below -5.0 dB (0/3172;
  worst dead reading is -4.68 dB) — so -6.0 keeps every observed dead (silence/noise) window
  correctly out of "quieted".
- The one steady keyed source observed (worst -29.7 dB) and the synthetic hot ±5 kHz-deviation
  carrier anchor (-18.9 dB, `test_hardening`) both sit well inside (well below) -6.0, so real
  and synthetic legitimate carriers are still read as quieted.
- -6.0 is deliberately biased permissive relative to a tighter cut like -7 (both would still
  pass every check above) — the appliance's failure mode of interest is chopping a weak or
  fluttering carrier mid-transmission, not slightly over-admitting noise, so the looser of the
  two safe values was chosen.
- **The real validation for this threshold is not this survey** — the available real-RF sample
  is too data-starved (one lane, one repeating non-voice source, no voice traffic) to certify a
  threshold on its own. The by-ear A/B at P3, once the native engine is wired up to actually
  gate audio on quieting, is the check that matters; this calibration only rules out the range
  that the dead-noise data clearly forbids (below roughly -5 dB) and leaves the rest to that
  live listening pass.

The GR-era `noiseQuietDb` (-86 default, per-bank overrides) does not apply to the native engine
(decision C).

The threshold is tunable live via `--quiet-db` (see `native/src/constants.hpp`) so the P3 by-ear
pass can move it without a rebuild.

## Engine replay on real RF

Binary: kerchunk-dsp (P1b replay), 11 channels (the 2 m group), Close Call on, default squelch (open 9 dB, hang 2000 ms, QUIET_DB_DEFAULT).
- Batch: `REPLAY iq_s=30.00 cpu_s=3.500 core_pct=11.7 realtime=0`
- Real-time (--realtime): `REPLAY iq_s=30.00 cpu_s=4.522 core_pct=15.1 realtime=1`  ← the acceptance number; GNU Radio helper baseline 223–234%
- Events: `Counter({'power': 149, 'audible': 9, 'open': 5, 'level': 5, 'rf': 4, 'close': 4, 'ready': 1, 'tuned': 1})`
- Opens/closes/audible/closecall/log/rf (no closecall, no log):
  - open c146625000 db -18.1 @3.200 → rf -33.9 n=248, close @5.681
  - open c146625000 db -17.9 @10.200 → rf -33.9 n=247, close @12.671
  - open c146625000 db -18.1 @16.201 → rf -34.0 n=248, close @18.680
  - open c146625000 db -18.3 @22.200 → rf -33.9 n=248, close @24.681
  - open c146625000 db -18.2 @28.201 (still open at end of capture)
  - each open/close paired with `audible` c146625000 / null (9 audible events)
  - Same single periodic source (6 s period, ~0.5 s keyed + 2 s hang) the quieting survey found on this lane; no other lane opened.
- Note on the `rf` values (-33.9 dB): `rf` is the GR-parity median of the lane's open-period power samples, and the open period includes the 2 s hang after each ~0.5 s burst. Most samples are therefore floor, so the median reports the floor rather than the burst power (bursts open at about -18 dB). This behaviour comes from GR, not from an engine defect.
- Audio for listening: /home/kiosk/kiosk-iq/2m-native.wav (48 kHz mono, 30.00 s, not in the repo)

Not included: USB reader thread, ALSA write, fd-3 tee (P1c).
