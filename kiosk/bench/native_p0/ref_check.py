"""Compare the P0 bench's lane powers against a straightforward time-domain
reference (mix -> 2001-tap Hamming LPF -> decimate) on the first S seconds of
a capture. Run: /usr/bin/python3 ref_check.py CAP.cu8 DUMP.csv --rate 2400000 --seconds 3 --chan OFF ..."""
import argparse, csv, sys
import numpy as np

ap = argparse.ArgumentParser()
ap.add_argument("capture"); ap.add_argument("dump")
ap.add_argument("--rate", type=float, default=2.4e6)
ap.add_argument("--seconds", type=float, default=3.0)
ap.add_argument("--chan", type=float, action="append", required=True)
a = ap.parse_args()

n = int(a.rate * a.seconds)
raw = np.fromfile(a.capture, dtype=np.uint8, count=2 * n).astype(np.float32)
x = ((raw[0::2] - 127.5) + 1j * (raw[1::2] - 127.5)) / 127.5
NT, fc = 2001, 8000 / a.rate
m = np.arange(NT) - (NT - 1) / 2
h = np.where(m == 0, 2 * fc, np.sin(2 * np.pi * fc * m) / (np.pi * np.where(m == 0, 1, m)))
h *= 0.54 - 0.46 * np.cos(2 * np.pi * np.arange(NT) / (NT - 1))
h /= h.sum()
t = np.arange(len(x)) / a.rate
D = int(round(a.rate / 50_000))
L = 1 << int(np.ceil(np.log2(len(x) + NT)))
Hf = np.fft.fft(h, L)

rows = list(csv.reader(open(a.dump)))
dump_t = np.array([float(r[0]) for r in rows[1:]])
dump = np.array([[float(v) for v in r[1:]] for r in rows[1:]])
if dump.shape[1] != len(a.chan):
    print("REF FAIL dump has %d channel columns, expected %d (--chan count)" % (dump.shape[1], len(a.chan)))
    sys.exit(1)
worst = (0.0, None)
n_compared = 0
for ci, off in enumerate(a.chan):
    y = np.fft.ifft(np.fft.fft(x * np.exp(-2j * np.pi * off * t), L) * Hf)[:len(x)][::D]
    p = np.abs(y) ** 2
    for wi in range(2, len(dump_t)):
        end = int(dump_t[wi] * 50_000)
        start = int(dump_t[wi - 1] * 50_000)
        if end > len(p):
            break
        ref = 10 * np.log10(p[start:end].mean() + 1e-20)
        err = abs(ref - dump[wi, ci])
        n_compared += 1
        if err > worst[0]:
            worst = (err, (off, dump_t[wi], ref, dump[wi, ci]))
if n_compared == 0:
    print("REF FAIL no windows compared")
    sys.exit(1)
if worst[0] > 0.5:
    print("REF FAIL max_err_db=%.3f at off=%s t=%s ref=%.2f bench=%.2f" % (worst[0], *worst[1]))
    sys.exit(1)
print("REF OK max_err_db=%.3f windows=%d" % (worst[0], n_compared))
