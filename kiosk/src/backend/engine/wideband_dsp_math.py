"""Pure DSP math for FFT-based power detection — no GNU Radio import, so it is
unit-testable in CI. Shared by wideband_helper.py.

Bin convention matches the helper's Close Call FFT: fft_vcc(..., shift=True) puts
DC at index NFFT//2, and bin index for frequency f (Hz, absolute) at window
center center_hz is round((f - center_hz) / binw) + NFFT//2, with binw = rate/NFFT.
"""
import numpy as np


def channel_bins(freq_hz, center_hz, rate, nfft, half_hz):
    """[lo, hi) FFT bin range (clamped to [0, nfft)) covering a channel of
    half-bandwidth half_hz centered at freq_hz, for a window centered at
    center_hz. Returns (lo, hi) with lo < hi when any part is in-window.

    When the channel is fully outside the window, returns lo >= hi; pass
    straight to bin_power_db, which returns the floor — callers need not
    range-check."""
    binw = rate / nfft
    dc = nfft // 2
    center = int(round((freq_hz - center_hz) / binw)) + dc
    half = max(1, int(round(half_hz / binw)))  # nearest-bin half-width (intentional; distinct from close_call_check's floor+1 guard)
    lo = max(0, center - half)
    hi = min(nfft, center + half + 1)
    return (lo, hi)


def bin_power_db(mag_sq_vec, lo, hi):
    """dB of summed |.|^2 power over bins [lo, hi). -120.0 if empty/zero —
    mirrors the per-lane power_db() floor so downstream logic is unchanged."""
    if hi <= lo:
        return -120.0
    p = float(np.sum(mag_sq_vec[lo:hi]))
    return 10.0 * np.log10(p) if p > 0 else -120.0
