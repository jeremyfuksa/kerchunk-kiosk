#!/usr/bin/env bash
# Capture ~60s of real rtl_fm stderr while serial-scanning a few frequencies.
# Run ON THE PI with a dongle attached and at least one active local repeater.
# Usage: ./capture-stderr.sh 145130000 146940000 442150000
set -euo pipefail
FREQS=("$@")
[[ ${#FREQS[@]} -ge 1 ]] || { echo "give 1+ frequencies in Hz" >&2; exit 64; }
ARGS=(); for f in "${FREQS[@]}"; do ARGS+=(-f "$f"); done
echo "Capturing 60s of stderr to /tmp/rtl_fm-stderr.txt ... key up a repeater now." >&2
timeout 60 rtl_fm "${ARGS[@]}" -M fm -s 12000 -l 150 -t 5 - \
  >/dev/null 2>/tmp/rtl_fm-stderr.txt || true
echo "Done. Lines captured: $(wc -l < /tmp/rtl_fm-stderr.txt)" >&2
echo "Copy /tmp/rtl_fm-stderr.txt into kiosk/test/fixtures/rtl_fm-stderr.captured.txt" >&2
