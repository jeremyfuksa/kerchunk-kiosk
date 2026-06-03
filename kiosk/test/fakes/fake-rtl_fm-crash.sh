#!/usr/bin/env bash
# Fake rtl_fm that writes a short LOUD burst of S16LE mono PCM then EXITS
# non-zero, simulating an rtl_fm crash. Records argv if requested so tests can
# count how many times it was (re)spawned.
[ -n "${FAKE_RTL_ARGS_FILE:-}" ] && echo "$@" >> "$FAKE_RTL_ARGS_FILE"
python3 -c "import sys,struct; sys.stdout.buffer.write(struct.pack('<2048h', *([12000]*2048)))" 2>/dev/null || head -c 4096 /dev/urandom
exit 1
