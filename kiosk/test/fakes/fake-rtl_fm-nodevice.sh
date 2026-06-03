#!/usr/bin/env bash
# Fake rtl_fm that simulates a missing/wedged dongle: prints the real
# "No supported devices found." line to STDERR and exits non-zero with NO
# stdout (no PCM). Records argv if requested so tests can count (re)spawns.
[ -n "${FAKE_RTL_ARGS_FILE:-}" ] && echo "$@" >> "$FAKE_RTL_ARGS_FILE"
echo "No supported devices found." 1>&2
exit 1
