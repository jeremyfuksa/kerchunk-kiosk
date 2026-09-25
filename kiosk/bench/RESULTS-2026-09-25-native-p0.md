# Native DSP P0 bench — 2026-09-25

Capture: KIOSK01, 2 m group center 146.03375 MHz, 2.4 Msps, 30 s, gain auto.
Bench: kiosk/bench/native_p0 (throwaway), -O3 -march=native, FFTW MEASURE, single thread.

Package temp (`x86_pkg_temp`) was 78 °C before the capture/correctness step, 82 °C
before the cost runs, and 86 °C after all nine cost runs — the live GNU Radio
helper (scanner + weather monitor) kept running throughout, so the bench
competed with it for a core the whole time. These numbers are therefore
measured under load, i.e. conservative (an idle box would likely show lower
core_pct).

| Config | core_pct (median of 3) |
|---|---|
| 12 lanes power only (--no-cc) | 3.7 |
| 12 lanes + 1 FM demod (--no-cc) | 4.8 |
| 12 lanes + 1 demod + CC 20 fps | 5.5 |

Raw runs (12 lanes = 11 real 2 m channels + 1 DC stand-in, 30 s IQ each):

```
12 lanes + 1 demod + CC 20 fps:
P0 iq_s=30.00 cpu_s=1.655 core_pct=5.5 lanes=12 demod=1 cc=1
P0 iq_s=30.00 cpu_s=1.612 core_pct=5.4 lanes=12 demod=1 cc=1
P0 iq_s=30.00 cpu_s=1.645 core_pct=5.5 lanes=12 demod=1 cc=1

12 lanes + 1 demod, --no-cc:
P0 iq_s=30.00 cpu_s=1.449 core_pct=4.8 lanes=12 demod=1 cc=0
P0 iq_s=30.00 cpu_s=1.462 core_pct=4.9 lanes=12 demod=1 cc=0
P0 iq_s=30.00 cpu_s=1.422 core_pct=4.7 lanes=12 demod=1 cc=0

12 lanes power only, --no-cc, no --demod:
P0 iq_s=30.00 cpu_s=1.111 core_pct=3.7 lanes=12 demod=0 cc=0
P0 iq_s=30.00 cpu_s=1.106 core_pct=3.7 lanes=12 demod=0 cc=0
P0 iq_s=30.00 cpu_s=1.103 core_pct=3.7 lanes=12 demod=0 cc=0
```

Reference check (3 s, 11 real lanes): `REF OK max_err_db=0.014 windows=297`.
GNU Radio helper baseline on the same box: ~223–234% (2026-09-25, meas.sh 60 s ×3).

Verdict: **GO** — 5.5% core_pct for the full config (12 lanes + 1 demod + CC)
vs. the 60% go line, roughly 40x headroom under load and likely more headroom
idle. The channelizer (power-only stage) is the largest single contributor at
3.7 of the 5.5 points (~67%), with FM demod adding ~1.1 points and Close Call
FFT adding the remaining ~0.7 — the 12-lane overlap-save channelizer, not
demod or CC, dominates the cost.
