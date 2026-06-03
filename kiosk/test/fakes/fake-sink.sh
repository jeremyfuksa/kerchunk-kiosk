#!/usr/bin/env bash
# Fake audio sink used to detect orphaned sink processes across rtl_fm restarts.
# Records its PID on launch then drains stdin forever. Tests check, after the
# engine stops, that none of these PIDs are still alive: a leaked/orphaned sink
# (one the engine forgot to kill) would still be running.
[ -n "${FAKE_SINK_FILE:-}" ] && echo "start $$" >> "$FAKE_SINK_FILE"
cat >/dev/null
