#!/usr/bin/env python3
"""Wideband spike: prove GNU Radio multi-channel demod per the wideband spec.

One Soapy RTL-SDR source samples a 2.4 MS/s I/Q window; N channels in the
window are channelized (freq-xlating FIR), each gets a power probe (detection),
and ONE selected channel is NBFM-demodulated to the ALSA sink (live audio).

Default window: the 7 NOAA WX channels (162.400-162.550 MHz, 150 kHz span,
all in one window, always transmitting) -- ideal for proving simultaneous
per-channel detection with a known-live signal.

Run with the SYSTEM python (gnuradio lives in dist-packages):
    /usr/bin/python3 bench/wideband-spike.py [--audio-channel 162.550] \
        [--sink plughw:1,0] [--seconds 30]

Emits line-delimited JSON on stdout (the protocol shape the spec calls for):
    {"t": 12.0, "power_db": {"162.400": -42.1, ...}, "audible": "162.550"}
"""

import argparse
import json
import math
import sys
import time

from gnuradio import analog, audio, blocks, filter as grfilter, gr, soapy
from gnuradio.filter import firdes

WX_FREQS_HZ = [162_400_000, 162_425_000, 162_450_000,
               162_475_000, 162_500_000, 162_525_000, 162_550_000]

SAMP_RATE = 2_400_000
CHAN_DECIM = 50              # 2.4 MS/s -> 48 kHz quad rate
QUAD_RATE = SAMP_RATE // CHAN_DECIM
AUDIO_RATE = 48_000


class WidebandSpike(gr.top_block):
    def __init__(self, freqs_hz, audio_freq_hz, sink_dev, gain):
        gr.top_block.__init__(self, "wideband-spike")

        center = (min(freqs_hz) + max(freqs_hz)) // 2
        self.center = center

        src = soapy.source("driver=rtlsdr", "fc32", 1, "", "", [""], [""])
        src.set_sample_rate(0, SAMP_RATE)
        src.set_frequency(0, center)
        src.set_gain_mode(0, gain is None)  # True = AGC when no manual gain
        if gain is not None:
            src.set_gain(0, gain)

        chan_taps = firdes.low_pass(1.0, SAMP_RATE, 8_000, 4_000)

        self.probes = {}
        for f in freqs_hz:
            offset = f - center
            xlate = grfilter.freq_xlating_fir_filter_ccf(
                CHAN_DECIM, chan_taps, offset, SAMP_RATE)
            mag2 = blocks.complex_to_mag_squared(1)
            avg = blocks.moving_average_ff(QUAD_RATE // 10, 10.0 / QUAD_RATE)
            probe = blocks.probe_signal_f()
            self.connect(src, xlate, mag2, avg, probe)
            self.probes[f] = probe

            if f == audio_freq_hz:
                demod = analog.nbfm_rx(
                    audio_rate=AUDIO_RATE, quad_rate=QUAD_RATE,
                    tau=75e-6, max_dev=5_000)
                vol = blocks.multiply_const_ff(0.6)
                snd = audio.sink(AUDIO_RATE, sink_dev, True)
                self.connect(xlate, demod, vol, snd)

    def power_db(self, f):
        p = self.probes[f].level()
        return round(10 * math.log10(p), 1) if p > 0 else -120.0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--audio-channel", default="162.550",
                    help="MHz of the channel routed to audio")
    ap.add_argument("--sink", default="plughw:1,0", help="ALSA device")
    ap.add_argument("--seconds", type=float, default=30.0)
    ap.add_argument("--gain", type=float, default=None,
                    help="manual tuner gain dB (default: AGC)")
    args = ap.parse_args()

    audio_hz = round(float(args.audio_channel) * 1e6)
    if audio_hz not in WX_FREQS_HZ:
        sys.exit(f"--audio-channel must be one of "
                 f"{[f/1e6 for f in WX_FREQS_HZ]}")

    tb = WidebandSpike(WX_FREQS_HZ, audio_hz, args.sink, args.gain)
    tb.start()
    t0 = time.monotonic()
    try:
        while (t := time.monotonic() - t0) < args.seconds:
            time.sleep(1.0)
            print(json.dumps({
                "t": round(t, 1),
                "power_db": {f"{f/1e6:.3f}": tb.power_db(f)
                             for f in WX_FREQS_HZ},
                "audible": f"{audio_hz/1e6:.3f}",
            }), flush=True)
    finally:
        tb.stop()
        tb.wait()


if __name__ == "__main__":
    main()
