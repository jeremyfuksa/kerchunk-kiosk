"""Synthetic-IQ correctness test for the P0 channelizer. Run: /usr/bin/python3 test_p0.py"""
import csv, os, subprocess, sys, tempfile
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
BIN = os.path.join(HERE, "p0")
RATE = 2_400_000

def write_cu8(path, x):
    iq = np.empty(2 * len(x), dtype=np.float64)
    iq[0::2], iq[1::2] = x.real, x.imag
    np.clip(np.round(iq * 127.5 + 127.5), 0, 255).astype(np.uint8).tofile(path)

def run(path, chans, extra=()):
    dump = path + ".csv"
    args = [BIN, "--file", path, "--rate", str(RATE), "--no-cc", "--dump", dump, *extra]
    for c in chans:
        args += ["--chan", str(c)]
    out = subprocess.run(args, check=True, capture_output=True, text=True).stdout
    rows = list(csv.reader(open(dump)))
    data = np.array([[float(v) for v in r[1:]] for r in rows[1:]])
    return out, data[2:].mean(axis=0)   # skip filter warm-up windows

rng = np.random.default_rng(1)
n = RATE  # 1 s
t = np.arange(n) / RATE
A_HZ, B_HZ = 250_000, -412_600               # B deliberately off the 390.625 Hz bin grid
x = (0.3 * np.exp(2j * np.pi * A_HZ * t)
     + 0.03 * np.exp(2j * np.pi * B_HZ * t)
     + 0.004 * (rng.standard_normal(n) + 1j * rng.standard_normal(n)))
chans = [A_HZ, A_HZ + 12_500, B_HZ, 600_000]  # A, A's neighbor, B, empty

with tempfile.TemporaryDirectory() as d:
    p = os.path.join(d, "syn.cu8")
    write_cu8(p, x)
    out, db = run(p, chans)
    pA, pN, pB, pE = db
    print("dB:", np.round(db, 2))
    assert abs(pA - 10 * np.log10(0.09)) < 0.5, pA          # 0.3^2 through unity-gain filter
    assert abs((pA - pB) - 20.0) < 1.0, (pA, pB)            # off-grid tone measured right
    assert pA - pN > 35, (pA, pN)                           # adjacent 12.5 kHz rejection
    assert pA - pE > 35, (pA, pE)                           # empty channel stays at floor
    last = out.strip().splitlines()[-1]
    assert last.startswith("P0 ") and "lanes=4" in last, last
    # Demod + CC paths run without disturbing lane powers.
    out2, db2 = run(p, chans, ("--demod", "0"))
    assert np.allclose(db, db2, atol=0.01), (db, db2)
    assert "demod=1" in out2.strip().splitlines()[-1]
    # FM demod lane on a tone FM-modulated at 1 kHz, 3 kHz deviation: audio rms
    # must be clearly non-zero and the quieting noise (8-25 kHz) low vs pure noise.
    fm = 0.3 * np.exp(1j * (2 * np.pi * A_HZ * t + (3000 / 1000) * np.sin(2 * np.pi * 1000 * t)))
    pf = os.path.join(d, "fm.cu8")
    write_cu8(pf, fm + 0.004 * (rng.standard_normal(n) + 1j * rng.standard_normal(n)))
    out3, _ = run(pf, [A_HZ], ("--demod", "0"))
    dl = [l for l in out3.splitlines() if l.startswith("DEMOD ")][0]
    kv = dict(p.split("=") for p in dl.split()[1:])
    assert float(kv["audio_rms"]) > 0.05, dl
    assert int(kv["out48k"]) > 0.9 * 48_000, dl        # ~1 s of 48 kHz audio
    pn = os.path.join(d, "noise.cu8")
    write_cu8(pn, 0.05 * (rng.standard_normal(n) + 1j * rng.standard_normal(n)))
    out4, _ = run(pn, [A_HZ], ("--demod", "0"))
    dl4 = [l for l in out4.splitlines() if l.startswith("DEMOD ")][0]
    kv4 = dict(p.split("=") for p in dl4.split()[1:])
    assert float(kv4["noise_db"]) - float(kv["noise_db"]) > 10, (dl, dl4)   # quieting
print("test_p0: OK")
