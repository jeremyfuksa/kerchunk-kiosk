# Native DSP P1b — results — 2026-09-25

## Quieting calibration (QUIET_DB_DEFAULT)

Capture: KIOSK01 2 m group, 146.03375 MHz, 2.4 Msps, 30 s. Tool: kc-quiet-survey, 11 lanes, 100 ms rows.
Script output:
```
windows: keyed=25 dead=3204
dead quiet_db  p5=-2.89 p50=-1.86
keyed quiet_db p50=-31.73 p95=-5.15
RECOMMEND QUIET_DB_DEFAULT=-4.0 (keyed p95 -5.15 < dead p5 -2.89)
```

Synthetic anchor (test_hardening): carrier -45.78 dB, noise -0.92 dB, hot-deviation -18.93 dB.

Chosen: QUIET_DB_DEFAULT = -4.0 — from real RF separation (keyed p95 -5.15 dB < dead p5 -2.89 dB, midpoint rounded to 0.5 dB).
Sanity check against the synthetic hot-deviation anchor: -18.93 dB is well below -4.0, so a hot ±5 kHz-deviation carrier still
reads as quieted (correctly passes) under this threshold — no conflict with the fallback-path concern.
The GR-era `noiseQuietDb` (-86 default, per-bank overrides) does not apply to the native engine (decision C).
