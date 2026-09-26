# Native DSP P1a — always-on demod cost — 2026-09-25

Library: kiosk/native (kcdsp), -O3 -march=native, no -ffast-math. Tool: kc-cost-bench, batch replay
fed in 10 ms slices, single thread. Capture: 2 m group, 146.03375 MHz, 2.4 Msps, 30 s (same as P0).
12 lanes = 11 real channels + DC stand-in. Package temp 80.0 -> 81.0 °C (live helper running).

| demod | what runs | core_pct (median of 3) |
|---|---|---|
| none | channelizer + lane power (12) | 4.1 |
| one | + discriminator/quieting/speech on lane 0 + speaker path | 5.4 |
| all | + discriminator/quieting/speech on all 12 lanes | 11.7 |

Raw lines:
```
COST iq_s=30.00 cpu_s=1.237 core_pct=4.1 lanes=12 demod=none
COST iq_s=30.00 cpu_s=1.240 core_pct=4.1 lanes=12 demod=none
COST iq_s=30.00 cpu_s=1.247 core_pct=4.2 lanes=12 demod=none
COST iq_s=30.00 cpu_s=1.624 core_pct=5.4 lanes=12 demod=one
COST iq_s=30.00 cpu_s=1.635 core_pct=5.4 lanes=12 demod=one
COST iq_s=30.00 cpu_s=1.630 core_pct=5.4 lanes=12 demod=one
COST iq_s=30.00 cpu_s=3.497 core_pct=11.7 lanes=12 demod=all
COST iq_s=30.00 cpu_s=3.519 core_pct=11.7 lanes=12 demod=all
COST iq_s=30.00 cpu_s=3.521 core_pct=11.7 lanes=12 demod=all
```

Always-on delta (all - one): 6.3 points.
Caveat (from P0): batch replay is turbo/cache-optimistic; real-time may cost 1.5-3x.

Recommendation for P1b: drop demod-on-demand (always-on discriminator + quieting on every lane,
speaker path only on the audible lane) — the `all` median of 11.7% is well under the 25% batch
threshold.
