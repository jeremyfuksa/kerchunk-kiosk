#!/usr/bin/env bash
#
# bench/01-rtl-test.sh
#
# Smoke-test the RTL-SDR dongle. Confirms:
#   * The dongle is enumerated by USB
#   * The DVB-T kernel modules are not claiming it
#   * librtlsdr can open it as the current user
#   * The R820T2 tuner reports a sane gain table
#
# Pass: a tuner gain list prints, no "lost samples" warnings.
# Fail: see bench/README.md "Common failure modes".

set -euo pipefail

echo "[01-rtl-test] lsusb output (looking for 0bda:2838 Realtek RTL2838):"
lsusb | grep -i 'realtek\|0bda' || echo "  (no Realtek device found - is the dongle plugged in?)"

echo
echo "[01-rtl-test] Running rtl_test for 5 seconds..."
echo "             Look for: tuner gains line, no 'lost samples' warnings."
echo
timeout --preserve-status 5 rtl_test -t || true

echo
echo "[01-rtl-test] If you saw a 'Supported gain values' line and no errors,"
echo "             the dongle is healthy and ready for bench/02."
