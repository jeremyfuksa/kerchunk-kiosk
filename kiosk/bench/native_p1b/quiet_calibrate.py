"""Pick the native quieting threshold from a quiet_survey CSV.
Per lane: floor = 10th percentile of slow power. Raw keyed rows: slow > floor + 9 dB; raw dead
rows: slow < floor + 3 dB. A row only counts toward the pooled keyed/dead sets if it AND its
previous AND next row (same lane) are all raw-keyed (resp. raw-dead) -- this drops the trailing
edge row of a keyup, where the 100 ms slow-power window still reads hot for a few rows after the
10 ms quiet window has already seen the unkey, which otherwise contaminates the keyed pool with
post-unkey noise read as "keyed". Per-lane keyed/dead counts and the count of distinct raw-keyed
runs (bursts, i.e. separate keyups) are printed for inspection -- a single lane with all the keyed
mass and few bursts means the sample is not representative of general voice traffic.
Threshold recommendation (advisory only -- see RESULTS-*.md for why the chosen value may differ):
midpoint between keyed p95 and dead p5 of quiet_db (lower quiet_db = quieter), if they separate.
Run: /usr/bin/python3 quiet_calibrate.py survey.csv"""
import csv, sys
import numpy as np

rows = list(csv.reader(open(sys.argv[1])))
hdr, data = rows[0], np.array([[float(v) for v in r] for r in rows[1:]])
data = data[5:]                     # skip warm-up rows (first 0.5 s)
keyed, dead = [], []
for c in range(1, len(hdr), 2):
    lane = hdr[c][1:]
    p, q = data[:, c], data[:, c + 1]
    floor = np.percentile(p, 10)
    raw_keyed = p > floor + 9
    raw_dead = p < floor + 3
    # core = row and both neighbours agree; edge rows (first/last sample) can't have both
    # neighbours so they're never core.
    core_keyed = np.zeros_like(raw_keyed)
    core_dead = np.zeros_like(raw_dead)
    core_keyed[1:-1] = raw_keyed[:-2] & raw_keyed[1:-1] & raw_keyed[2:]
    core_dead[1:-1] = raw_dead[:-2] & raw_dead[1:-1] & raw_dead[2:]
    lane_keyed = list(q[core_keyed])
    lane_dead = list(q[core_dead])
    keyed += lane_keyed
    dead += lane_dead
    # bursts = distinct contiguous runs of raw_keyed (separate keyups, before edge-trimming)
    bursts = int(np.sum(raw_keyed & ~np.concatenate(([False], raw_keyed[:-1]))))
    print(f"lane {lane}: keyed={len(lane_keyed)} dead={len(lane_dead)} bursts={bursts}")
print(f"windows: keyed={len(keyed)} dead={len(dead)}")
if dead:
    dead_arr = np.array(dead)
    print(f"dead quiet_db  mean={dead_arr.mean():.2f} p5={np.percentile(dead, 5):.2f} "
          f"p50={np.percentile(dead, 50):.2f} min={dead_arr.min():.2f}")
    print(f"dead below -3.0: {int(np.sum(dead_arr < -3.0))}/{len(dead_arr)}  "
          f"below -5.0: {int(np.sum(dead_arr < -5.0))}/{len(dead_arr)}")
if keyed:
    keyed_arr = np.array(keyed)
    print(f"keyed quiet_db p50={np.percentile(keyed, 50):.2f} p95={np.percentile(keyed, 95):.2f} "
          f"worst(max)={keyed_arr.max():.2f}")
if len(keyed) >= 20 and dead:
    hi, lo = np.percentile(keyed, 95), np.percentile(dead, 5)
    if hi < lo:
        print(f"RECOMMEND (advisory) QUIET_DB_DEFAULT={round((hi + lo) / 2 * 2) / 2:.1f} "
              f"(keyed p95 {hi:.2f} < dead p5 {lo:.2f})")
    else:
        print(f"NO SEPARATION keyed p95 {hi:.2f} >= dead p5 {lo:.2f}")
else:
    print("INSUFFICIENT KEYED WINDOWS")
