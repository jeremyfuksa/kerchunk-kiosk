#!/usr/bin/python3
"""Squelch-calibration report from the scanner's txstats.jsonl.

Each line is one carrier episode (kerchunk-dsp `txstat`, logged by
WidebandEngine): a lane's power crossed floor+open_db; `opened` says whether
the quieting check let it open. quiet* fields are the native quieting metric
(dB, lower = more quieted; the lane opens when quiet_db < scan.nativeQuietDb,
default -6). Rejected episodes shorter than 100 ms are never logged.

For each mode (fm/am) x band it prints the opened and rejected quietP50
distributions, then for candidate thresholds -3..-15 dB how many episodes
would FLIP:
  opened->fail   opened episodes whose quietP10 >= T (even their best-quieted
                 10% would not pass: the transmission would be chopped/lost)
  rejected->pass rejected episodes whose quietP50 < T (the carrier would now
                 open: likely noise/data let through)
(The helper's +-1 dB QUIET_HYST_DB is ignored: this is a first-order view.)

Usage (stdlib only, system python):
  /usr/bin/python3 kiosk/bench/squelch_calibrate.py /var/lib/kerchunk-kiosk/txstats.jsonl [more.jsonl ...]
  /usr/bin/python3 kiosk/bench/squelch_calibrate.py --self-test
"""
import json
import os
import sys
import tempfile

THRESHOLDS = list(range(-3, -16, -1))
BANDS = [  # (label, lo MHz, hi MHz) -- inclusive
    ("air 118-137", 118.0, 137.0),
    ("2m 144-148", 144.0, 148.0),
    ("vhf 150-174", 150.0, 174.0),
    ("uhf 420-470", 420.0, 470.0),
]
PCTS = [5, 10, 25, 50, 75, 90, 95]


def band_of(freq_hz):
    if not isinstance(freq_hz, (int, float)):
        return "unknown freq"
    mhz = freq_hz / 1e6
    for label, lo, hi in BANDS:
        if lo <= mhz <= hi:
            return label
    return "other"


def pct(sorted_vals, p):
    """Nearest-rank percentile of a sorted, non-empty list."""
    i = int(round(p / 100.0 * (len(sorted_vals) - 1)))
    return sorted_vals[i]


def load(paths):
    recs, bad = [], 0
    for path in paths:
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    r = json.loads(line)
                except ValueError:
                    bad += 1
                    continue
                if isinstance(r, dict) and isinstance(r.get("opened"), bool):
                    recs.append(r)
                else:
                    bad += 1
    return recs, bad


def summarize(recs):
    """{(mode, band): stats}; band 'ALL' aggregates each mode."""
    groups = {}
    for r in recs:
        mode = r.get("mode") if r.get("mode") in ("fm", "am") else "?"
        for key in ((mode, band_of(r.get("freqHz"))), (mode, "ALL")):
            groups.setdefault(key, []).append(r)
    out = {}
    for key, rs in groups.items():
        opened = [r for r in rs if r["opened"]]
        rejected = [r for r in rs if not r["opened"]]
        op50 = sorted(r["quietP50"] for r in opened if isinstance(r.get("quietP50"), (int, float)))
        rj50 = sorted(r["quietP50"] for r in rejected if isinstance(r.get("quietP50"), (int, float)))
        op10 = [r["quietP10"] for r in opened if isinstance(r.get("quietP10"), (int, float))]
        flips = []
        for t in THRESHOLDS:
            flips.append((t, sum(1 for v in op10 if v >= t), sum(1 for v in rj50 if v < t)))
        out[key] = {
            "opened": len(opened), "rejected": len(rejected),
            "opened_noquiet": len(opened) - len(op50), "rejected_noquiet": len(rejected) - len(rj50),
            "opened_p50": op50, "rejected_p50": rj50, "flips": flips,
        }
    return out


def fmt_dist(vals):
    if not vals:
        return "  (none)"
    return "  " + "  ".join("p%d=%.1f" % (p, pct(vals, p)) for p in PCTS) + "  (n=%d)" % len(vals)


def report(recs, bad=0, stream=sys.stdout):
    w = stream.write
    w("%d episodes (%d opened, %d rejected)%s\n" % (
        len(recs), sum(1 for r in recs if r["opened"]), sum(1 for r in recs if not r["opened"]),
        ", %d unparseable lines skipped" % bad if bad else ""))
    if recs:
        ts = sorted(r["t"] for r in recs if isinstance(r.get("t"), str))
        if ts:
            w("span %s .. %s\n" % (ts[0], ts[-1]))
    stats = summarize(recs)
    order = [b[0] for b in BANDS] + ["other", "unknown freq", "ALL"]
    for mode in ("fm", "am", "?"):
        for band in order:
            s = stats.get((mode, band))
            if not s:
                continue
            w("\n== %s / %s: %d opened, %d rejected\n" % (mode, band, s["opened"], s["rejected"]))
            w(" opened quietP50:%s%s\n" % (fmt_dist(s["opened_p50"]),
              "  [+%d without quiet data]" % s["opened_noquiet"] if s["opened_noquiet"] else ""))
            w(" rejected quietP50:%s%s\n" % (fmt_dist(s["rejected_p50"]),
              "  [+%d without quiet data]" % s["rejected_noquiet"] if s["rejected_noquiet"] else ""))
            w("  thr dB | opened->fail (P10>=T) | rejected->pass (P50<T)\n")
            for t, of, rp in s["flips"]:
                w("  %6d | %21d | %22d\n" % (t, of, rp))
    return stats


def self_test():
    recs = []
    # 2 m FM: 10 opened, well quieted (P50 -20, P10 -24), except 2 weak ones (P10 -7).
    for i in range(10):
        weak = i < 2
        recs.append({"t": "2026-09-26T00:00:%02dZ" % i, "id": "c%d" % i, "freqHz": 146_790_000,
                     "mode": "fm", "opened": True, "polls": 300,
                     "quietP10": -7.0 if weak else -24.0, "quietP50": -6.5 if weak else -20.0,
                     "quietP90": -6.1 if weak else -15.0, "aboveFloorP50": 15.0})
    # 2 m FM: 4 rejected noise carriers (P50 -4), 1 with no quiet data.
    for i in range(4):
        recs.append({"t": "2026-09-26T00:01:%02dZ" % i, "id": "c%d" % i, "freqHz": 147_330_000,
                     "mode": "fm", "opened": False, "polls": 20,
                     "quietP10": -5.5, "quietP50": -4.0, "quietP90": -1.0, "aboveFloorP50": 10.0})
    recs.append({"t": "2026-09-26T00:02:00Z", "id": "x", "freqHz": 147_330_000, "mode": "fm",
                 "opened": False, "polls": 15, "aboveFloorP50": 9.5})
    # Airband AM, one opened; one UHF; one with an unknown freq.
    recs.append({"t": "2026-09-26T00:03:00Z", "id": "a", "freqHz": 119_100_000, "mode": "am",
                 "opened": True, "polls": 200, "quietP10": -12.0, "quietP50": -10.0, "quietP90": -8.0,
                 "aboveFloorP50": 20.0})
    recs.append({"t": "2026-09-26T00:04:00Z", "id": "u", "freqHz": 464_175_000, "mode": "fm",
                 "opened": True, "polls": 100, "quietP10": -30.0, "quietP50": -28.0, "quietP90": -25.0,
                 "aboveFloorP50": 25.0})
    recs.append({"t": "2026-09-26T00:05:00Z", "id": "zz", "mode": "fm", "opened": False,
                 "polls": 12, "quietP10": -9.0, "quietP50": -8.0, "quietP90": -7.0, "aboveFloorP50": 9.2})

    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "txstats.jsonl")
        with open(path, "w", encoding="utf-8") as f:
            for r in recs:
                f.write(json.dumps(r) + "\n")
            f.write("not json\n")
        loaded, bad = load([path])
    assert len(loaded) == len(recs) and bad == 1, (len(loaded), bad)

    class Sink:
        def __init__(self):
            self.text = ""

        def write(self, s):
            self.text += s

    sink = Sink()
    stats = report(loaded, bad, sink)
    assert band_of(146_790_000) == "2m 144-148" and band_of(119_100_000) == "air 118-137"
    assert band_of(155_000_000) == "vhf 150-174" and band_of(464_175_000) == "uhf 420-470"
    assert band_of(30_000_000) == "other" and band_of(None) == "unknown freq"

    s2m = stats[("fm", "2m 144-148")]
    assert (s2m["opened"], s2m["rejected"], s2m["rejected_noquiet"]) == (10, 5, 1), s2m
    flips = {t: (of, rp) for t, of, rp in s2m["flips"]}
    assert flips[-6] == (0, 0), flips[-6]      # today's default: no flips
    assert flips[-3] == (0, 4), flips[-3]      # permissive: all 4 noise carriers pass (-4 < -3)
    assert flips[-7] == (2, 0), flips[-7]      # stricter: the 2 weak opened fail (P10 -7 >= -7)
    assert flips[-15] == (2, 0)                # -24 < -15: strong ones still pass
    assert stats[("am", "air 118-137")]["opened"] == 1
    assert stats[("fm", "ALL")]["opened"] == 11 and stats[("fm", "ALL")]["rejected"] == 6
    assert stats[("fm", "unknown freq")]["rejected"] == 1
    assert pct([1, 2, 3, 4, 5], 50) == 3 and pct([1, 2, 3, 4, 5], 0) == 1
    assert "fm / 2m 144-148" in sink.text and "1 unparseable" in sink.text
    print("self-test OK")


def main(argv):
    if len(argv) >= 2 and argv[1] == "--self-test":
        self_test()
        return 0
    if len(argv) < 2 or argv[1] in ("-h", "--help"):
        print(__doc__)
        return 0 if len(argv) >= 2 else 2
    recs, bad = load(argv[1:])
    report(recs, bad)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
