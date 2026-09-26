"""Pick the native quieting threshold from a quiet_survey CSV.
Per lane: floor = 10th percentile of slow power. Keyed windows: slow > floor + 9 dB.
Dead windows: slow < floor + 3 dB. Threshold = midpoint between keyed p95 and dead p5 of
quiet_db (lower quiet_db = quieter), if they separate. Run: /usr/bin/python3 quiet_calibrate.py survey.csv"""
import csv, sys
import numpy as np

rows = list(csv.reader(open(sys.argv[1])))
hdr, data = rows[0], np.array([[float(v) for v in r] for r in rows[1:]])
data = data[5:]                     # skip warm-up rows (first 0.5 s)
keyed, dead = [], []
for c in range(1, len(hdr), 2):
    p, q = data[:, c], data[:, c + 1]
    floor = np.percentile(p, 10)
    keyed += list(q[p > floor + 9])
    dead += list(q[p < floor + 3])
print(f"windows: keyed={len(keyed)} dead={len(dead)}")
if dead:
    print(f"dead quiet_db  p5={np.percentile(dead, 5):.2f} p50={np.percentile(dead, 50):.2f}")
if keyed:
    print(f"keyed quiet_db p50={np.percentile(keyed, 50):.2f} p95={np.percentile(keyed, 95):.2f}")
if len(keyed) >= 20 and dead:
    hi, lo = np.percentile(keyed, 95), np.percentile(dead, 5)
    if hi < lo:
        print(f"RECOMMEND QUIET_DB_DEFAULT={round((hi + lo) / 2 * 2) / 2:.1f} (keyed p95 {hi:.2f} < dead p5 {lo:.2f})")
    else:
        print(f"NO SEPARATION keyed p95 {hi:.2f} >= dead p5 {lo:.2f}")
else:
    print("INSUFFICIENT KEYED WINDOWS")
