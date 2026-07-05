#!/usr/bin/env python3
"""Kerchunk Go DSP-budget model. Paper model, runs anywhere, no SDR and no
GNU Radio needed: estimates the arithmetic cost (MAC/s) of the wideband
channelizer at candidate lane-count x sample-rate points and compares it to
the realistic sustained DSP throughput of each candidate compute platform.

This is the sizing companion to kiosk/bench/pi_dsp_bench.py (which MEASURES
the GNU Radio flowgraph on real hardware). Use this one to rule platforms
in/out before buying them; use pi_dsp_bench.py to verify on the survivors.

Model
-----
Per lane, the dominant cost is the frequency-translating decimating FIR:
  * oscillator mix: 1 complex multiply per input sample (6 MAC-equivalents)
  * polyphase decimating FIR: taps/decim complex MACs per INPUT sample when
    implemented polyphase (each input sample touches taps/decim coefficients)
  * NBFM demod + squelch + audio filters at the 48 kHz quad rate: small,
    modeled as a flat 2 MMAC/s per open lane.
A shared-FFT detector (Close Call / energy scan) is modeled as radix-2
N*log2(N) butterflies per FFT frame at 10 Hz.

Platform numbers are SUSTAINED single-precision-or-int16 MAC/s estimates for
hand-written SIMD code (NEON / PIE / scalar DSP), derated hard from peak
because filter kernels are memory-bound and the box also runs USB + BT +
control code. They are order-of-magnitude sizing numbers, not benchmarks.
"""

# taps for a ~12.5 kHz-channel FIR at the given input rate scale roughly
# linearly with rate/transition-width; anchor: ~400 taps at 2.4 MS/s for the
# tight 4 kHz transition the kiosk uses, relaxed to ~200 for a car build.
TAPS_AT_2M4 = 200
AUDIO_RATE = 48_000
DEMOD_MMACS = 2.0e6          # per OPEN lane: NBFM + squelch + level chain
FFT_HZ = 10                   # detector frames per second

def lane_macs(rate: float) -> float:
    taps = TAPS_AT_2M4 * (rate / 2.4e6)
    decim = max(1, int(rate // AUDIO_RATE))
    mix = 6 * rate                       # complex mult per input sample
    fir = 4 * (taps / decim) * rate      # complex MAC = 4 real MACs, polyphase
    return mix + fir

def fft_macs(rate: float) -> float:
    import math
    n = 1
    while n < rate / 500:                # ~500 Hz bins, kiosk-like
        n *= 2
    return FFT_HZ * n * math.log2(n) * 4

# (name, sustained MAC/s, note) — derated sustained estimates
PLATFORMS = [
    ("ESP32 (2x LX6 @240MHz)",        0.15e9, "no USB-HS host: audio/control only"),
    ("ESP32-S3 (2x LX7+SIMD)",        0.4e9,  "no USB-HS host: ruled out for SDR"),
    ("ESP32-P4 (2x RV32+PIE @400MHz)",1.2e9,  "USB-HS host YES, BT Classic NO"),
    ("1x Cortex-A7 @1.2GHz (RV1106)", 1.5e9,  "NEON, single core, Linux overhead"),
    ("Pi Zero 2 W (4x A53 @1GHz)",    6.0e9,  "NEON across 3 usable cores"),
    ("Radxa Zero 3W (4x A55 @1.6GHz)",12.0e9, "same footprint as Pi Zero 2 W"),
    ("i7-4770HQ kiosk laptop",        60.0e9, "reference: today's appliance"),
]

CONFIGS = [
    # (lanes, open_lanes, sample rate) — car-realistic points
    (4,  1, 1.024e6),
    (6,  2, 1.024e6),
    (8,  2, 2.4e6),
    (12, 3, 2.4e6),
    (1,  1, 0.25e6),   # single-lane narrow window: the USB-FS fallback case
]

if __name__ == "__main__":
    print(f"{'config':<28}{'need MMAC/s':>12}   headroom vs platform (need/have, <60% = FITS)")
    for lanes, open_lanes, rate in CONFIGS:
        need = lanes * lane_macs(rate) + open_lanes * DEMOD_MMACS + fft_macs(rate)
        row = f"{lanes:>2d} lanes @ {rate/1e6:4.2f} MS/s"
        print(f"{row:<28}{need/1e6:>12.0f}")
        for name, have, note in PLATFORMS:
            frac = need / have
            tag = "FITS " if frac < 0.6 else ("TIGHT" if frac < 0.85 else "OVER ")
            print(f"    {tag} {frac*100:5.1f}%  {name}  ({note})")
        print()
    print("Model caveats: MAC/s only — ignores USB interrupt load, cache misses,")
    print("and BT stack cost. Anything TIGHT here should be assumed OVER in real")
    print("life; anything FITS still needs pi_dsp_bench.py-style proof on hardware.")
