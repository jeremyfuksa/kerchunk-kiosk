#!/usr/bin/env bash
# Fake wideband_helper.py for WidebandEngine tests. Speaks the line-JSON
# protocol on stdin/stdout. Scenarios via env:
#   FAKE_WB_ARGS_FILE   - append "$@" on launch (spawn counting)
#   FAKE_WB_PID_FILE    - append $$ on launch (orphan detection, fake-sink.sh pattern)
#   FAKE_WB_TUNES_FILE  - append every received tune command (hop assertions)
#   FAKE_WB_CMDS_FILE   - append EVERY received command line (skip etc.)
#   FAKE_WB_SCRIPT      - newline-separated events to emit after the FIRST tune;
#                         lines of the form "sleep:<ms>" pause between events
#   FAKE_WB_MODE        - "nodevice" -> print device error to stderr, exit 1
#                         "crash"    -> emit ready, then exit 2 after 100ms
[ -n "${FAKE_WB_ARGS_FILE:-}" ] && echo "$@" >> "$FAKE_WB_ARGS_FILE"
[ -n "${FAKE_WB_PID_FILE:-}" ] && echo "$$" >> "$FAKE_WB_PID_FILE"
if [ "${FAKE_WB_MODE:-}" = "nodevice" ]; then
  echo "RuntimeError: failed to open SoapySDR device" >&2
  exit 1
fi
echo '{"ev":"ready"}'
if [ "${FAKE_WB_MODE:-}" = "crash" ]; then sleep 0.1; exit 2; fi
emitted=0
while IFS= read -r line; do
  [ -n "${FAKE_WB_CMDS_FILE:-}" ] && echo "$line" >> "$FAKE_WB_CMDS_FILE"
  case "$line" in
    *'"cmd":"quit"'*) exit 0 ;;
    *'"cmd":"tune"'*)
      [ -n "${FAKE_WB_TUNES_FILE:-}" ] && echo "$line" >> "$FAKE_WB_TUNES_FILE"
      # Ack every tune; the engine asserts hop ORDER via FAKE_WB_TUNES_FILE,
      # the ack payload is opaque to it.
      echo '{"ev":"tuned"}'
      if [ "$emitted" = 0 ] && [ -n "${FAKE_WB_SCRIPT:-}" ]; then
        emitted=1
        (
          while IFS= read -r ev; do
            case "$ev" in
              sleep:*) sleep "$(awk "BEGIN{print ${ev#sleep:}/1000}")" ;;
              *) echo "$ev" ;;
            esac
          done <<< "$FAKE_WB_SCRIPT"
        ) &
      fi
      ;;
  esac
done
exit 0
