#!/usr/bin/env python3
"""Kerchunk Pi DSP-budget benchmark. Measures how many CPU cores the wideband
channelizer flowgraph burns on THIS machine, at a few lane-count / sample-rate
points — throttled noise source, NO SDR needed. Run on the Pi:  python3 pi_dsp_bench.py
Needs gnuradio + numpy (if absent it says so -> the Pi needs the SDR toolchain first)."""
import os, time
try:
    from gnuradio import analog, blocks, filter as grfilter, gr
    from gnuradio.filter import firdes
except Exception as e:
    print("NO GNURADIO on this box:", e)
    print("-> provision first (the repo's kiosk/scripts/setup-kiosk-pi.sh installs the SDR toolchain).")
    raise SystemExit(1)

HZ = os.sysconf("SC_CLK_TCK")
def cpu():
    f = open("/proc/self/stat").read().split(); return int(f[13]) + int(f[14])
def temp():
    try: return round(int(open("/sys/class/thermal/thermal_zone0/temp").read()) / 1000, 1)
    except Exception: return None

def build(lanes, rate, quad=48000):
    tb = gr.top_block(); src = analog.noise_source_c(analog.GR_GAUSSIAN, 0.3, 0)
    thr = blocks.throttle(gr.sizeof_gr_complex, rate); tb.connect(src, thr)
    taps = firdes.low_pass(1.0, rate, 8000, 4000); decim = rate // quad
    adder = blocks.add_ff(1)
    for i in range(lanes):
        x = grfilter.freq_xlating_fir_filter_ccf(decim, taps, 0, rate)
        m = blocks.complex_to_mag_squared(1); a = blocks.moving_average_ff(quad//10, 10.0/quad); p = blocks.probe_signal_f()
        af = blocks.moving_average_ff(quad//100, 100.0/quad); pf = blocks.probe_signal_f()
        d = analog.nbfm_rx(audio_rate=quad, quad_rate=quad, tau=75e-6, max_dev=5000); g = blocks.multiply_const_ff(0.0)
        hp = grfilter.fir_filter_fff(1, firdes.high_pass(1.0, quad, 8000, 2000)); ns = blocks.multiply_ff(1)
        nv = blocks.moving_average_ff(quad//100, 100.0/quad); npb = blocks.probe_signal_f()
        mg = blocks.complex_to_mag(1); cr = grfilter.single_pole_iir_filter_ff(0.0005, 1); dv = blocks.divide_ff(1)
        dc = blocks.add_const_ff(-1.0); mp = blocks.multiply_const_ff(1.0); ga = blocks.multiply_const_ff(0.0)
        tb.connect(thr, x, m, a, p); tb.connect(m, af, pf)
        tb.connect(x, d, g, (adder, i)); tb.connect(d, hp, (ns, 0)); tb.connect(hp, (ns, 1)); tb.connect(ns, nv, npb)
        tb.connect(x, mg, (dv, 0)); tb.connect(mg, cr, (dv, 1)); tb.connect(dv, dc, mp, ga, (adder, lanes + i))
    tb.connect(adder, blocks.null_sink(gr.sizeof_float)); return tb

def measure(lanes, rate):
    tb = build(lanes, rate); tb.start(); time.sleep(4)
    t0, j0 = time.time(), cpu(); time.sleep(8); cores = ((cpu() - j0) / HZ) / (time.time() - t0)
    tb.stop(); tb.wait(); return cores

ncpu = os.cpu_count()
print("gnuradio", gr.version(), "| cores", ncpu)
try: print("model:", open("/proc/device-tree/model").read().strip("\x00"))
except Exception: pass
print("--- wideband channelizer cost (cores) at lane-count x sample-rate ---")
for lanes, rate in [(12, 2_400_000), (12, 1_200_000), (8, 2_400_000), (6, 1_200_000), (4, 1_200_000)]:
    t1 = temp(); c = measure(lanes, rate); t2 = temp()
    fit = "FITS" if c < ncpu * 0.6 else ("TIGHT" if c < ncpu * 0.85 else "OVER")
    print(f"  {lanes:2d} lanes @ {rate/1e6:.1f} MS/s -> {c:5.2f} cores  [{fit} vs {ncpu}]  temp {t1}->{t2}C")
print(f"\nA viable config must sit well under {ncpu} cores AND leave room for Node + Chromium + OS.")
print("Reference: this flowgraph is ~2.8 cores on a desktop i7-4770HQ at 12 lanes @ 2.4 MS/s.")
