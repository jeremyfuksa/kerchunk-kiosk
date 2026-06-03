#!/usr/bin/env bash
# Fake rtl_fm that streams near-silent PCM (zeros) continuously, so the engine
# sees low energy and should hop / declare idle. Records argv if requested.
if [ -n "$FAKE_RTL_ARGS_FILE" ]; then
  echo "$@" >> "$FAKE_RTL_ARGS_FILE"
fi
for i in $(seq 1 200); do
  head -c 256 /dev/zero
  sleep 0.03
done
