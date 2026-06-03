#!/usr/bin/env bash
# Fake rtl_fm that emits a burst of LOUD S16LE mono PCM (energy well above the
# squelch-open threshold) then stays alive, simulating a held-open channel.
# Optionally record argv for spawn-counting tests.
if [ -n "$FAKE_RTL_ARGS_FILE" ]; then
  echo "$@" >> "$FAKE_RTL_ARGS_FILE"
fi
python3 -c "import sys,struct; sys.stdout.buffer.write(struct.pack('<8192h', *([12000]*8192)))" 2>/dev/null || \
  head -c 16384 /dev/urandom
# Keep writing loud bursts so the detector keeps seeing energy.
while true; do
  python3 -c "import sys,struct; sys.stdout.buffer.write(struct.pack('<4096h', *([12000]*4096)))" 2>/dev/null || \
    head -c 8192 /dev/urandom
  sleep 0.1
done
