#!/usr/bin/env bash
#
# bench/03-stream-fm.sh
#
# M1 success test: stream a 2 m repeater to paired Bluetooth earbuds.
#
# Usage:
#   ./bench/03-stream-fm.sh <FREQ_HZ> <BLUETOOTH_MAC>
#
# Example:
#   ./bench/03-stream-fm.sh 145130000 AA:BB:CC:DD:EE:FF
#
# Pass criterion: 60 seconds of clean repeater audio with no glitches.
# Ctrl-C to stop.

set -euo pipefail

FREQ="${1:-}"
MAC="${2:-}"

if [[ -z "${FREQ}" || -z "${MAC}" ]]; then
    cat >&2 <<EOF
Usage: $0 <FREQ_HZ> <BLUETOOTH_MAC>

  FREQ_HZ         Repeater output frequency in Hz (e.g. 145130000 for 145.130 MHz)
  BLUETOOTH_MAC   Earbud MAC paired in bench/02-pair-bluetooth.sh

Example:
  $0 145130000 AA:BB:CC:DD:EE:FF
EOF
    exit 64
fi

if ! command -v rtl_fm >/dev/null; then
    echo "ERROR: rtl_fm not found. Did you run scripts/setup-pi.sh?" >&2
    exit 1
fi
if ! command -v bluealsa-aplay >/dev/null; then
    echo "ERROR: bluealsa-aplay not found. Did you run scripts/setup-pi.sh?" >&2
    exit 1
fi

echo "[03-stream-fm] Tuning rtl_fm to ${FREQ} Hz, streaming to ${MAC}..."
echo "               Listen for at least 60 seconds. Ctrl-C to stop."
echo

# Pipeline:
#   rtl_fm: NFM demod, 200 kHz IF sampling, resample to 48 kHz mono PCM.
#   bluealsa-aplay: A2DP playback to the paired sink.
exec rtl_fm \
        -f "${FREQ}" \
        -M fm \
        -s 200000 \
        -r 48000 \
        -g 30 \
        - \
    | bluealsa-aplay --pcm-buffer-time=400000 "${MAC}"
