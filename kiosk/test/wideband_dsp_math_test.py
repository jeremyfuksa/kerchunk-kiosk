"""Dependency-free asserts for the wideband DSP math. Run: python3 this_file.py"""
import os
import sys
import numpy as np
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src", "backend", "engine"))
from wideband_dsp_math import channel_bins, bin_power_db

RATE, NFFT = 2_400_000, 2048
BINW = RATE / NFFT            # ~1171.875 Hz
DC = NFFT // 2                # fft_vcc(shift=True) puts DC at the center bin

def approx(a, b, eps=2): return abs(a - b) <= eps

# A channel exactly at window center maps around the DC bin.
lo, hi = channel_bins(462_000_000, 462_000_000, RATE, NFFT, 8_000)
assert lo < DC < hi, (lo, DC, hi)
assert approx(hi - lo, 2 * round(8_000 / BINW) + 1), (lo, hi)

# A channel +250 kHz above center exercises the round() path (250000/BINW is non-integer).
off = 250_000
lo2, hi2 = channel_bins(462_000_000 + off, 462_000_000, RATE, NFFT, 8_000)
center2 = (lo2 + hi2 - 1) / 2
assert center2 == DC + round(off / BINW), (center2, DC + round(off / BINW))

# Clamped at the window edges (no negative / out-of-range bins).
loE, hiE = channel_bins(462_000_000 - RATE / 2, 462_000_000, RATE, NFFT, 8_000)
assert loE >= 0 and hiE <= NFFT and loE < hiE, (loE, hiE)

# bin_power_db: sum of |.|^2 bins -> dB; empty/zero -> floor.
vec = np.zeros(NFFT); vec[DC - 2:DC + 3] = 1.0     # 5 bins of unit power
assert approx(bin_power_db(vec, DC - 2, DC + 3), 10 * np.log10(5.0), 0.01)
assert bin_power_db(np.zeros(NFFT), 0, 4) == -120.0

# A channel fully outside the window yields an inverted/empty range and floored power.
loO, hiO = channel_bins(462_000_000 + RATE * 2, 462_000_000, RATE, NFFT, 8_000)
assert hiO <= loO, (loO, hiO)                           # inverted/empty range
assert bin_power_db(np.ones(NFFT), loO, hiO) == -120.0  # floor even with power everywhere

# Two adjacent channels ~12 bins apart: a strong signal in one must not dominate
# the other's bin sum (adjacent-bleed sanity for DETECT_HALF_HZ).
a_lo, a_hi = channel_bins(462_000_000, 462_000_000, RATE, NFFT, 8_000)
b_lo, b_hi = channel_bins(462_012_500, 462_000_000, RATE, NFFT, 8_000)  # +12.5 kHz
spectrum = np.zeros(NFFT)
spectrum[(a_lo + a_hi)//2] = 100.0   # strong carrier in channel A's center bin
pa = bin_power_db(spectrum, a_lo, a_hi)
pb = bin_power_db(spectrum, b_lo, b_hi)
assert pa > pb + 10, (pa, pb)  # A reads far hotter than B despite some range overlap
print("adjacent-bleed sanity passed")

print("wideband_dsp_math: all asserts passed")
