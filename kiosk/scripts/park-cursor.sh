#!/usr/bin/env bash
#
# Park the kiosk cursor in the bottom-right corner.
#
# cage (Wayland) draws a compositor pointer that CSS `cursor: none` can't hide
# and that cage 0.2.0 has no flag to suppress. As a pragmatic kiosk mitigation
# we shove the pointer into the far corner with wlrctl (wlroots virtual-pointer
# protocol) so it's out of view. A large relative move is clamped to the screen
# edge, so the magnitude only needs to exceed the display size.
#
# Run by kerchunk-cursor-park.service (a SEPARATE oneshot unit, After= the
# display) — NOT as an ExecStartPost of the display unit, which blocks cage's
# activation and stopped chromium from launching. Because it's separate, this
# script can wait for cage to be fully up without holding back the display.
#
# Needs XDG_RUNTIME_DIR + WAYLAND_DISPLAY pointing at cage's socket, and to run
# as the user that owns it (the display unit's User=kerchunk).
set -euo pipefail

WAYLAND_DISPLAY="${WAYLAND_DISPLAY:-wayland-0}"
RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
export WAYLAND_DISPLAY XDG_RUNTIME_DIR="$RUNTIME_DIR"
SOCK="$RUNTIME_DIR/$WAYLAND_DISPLAY"

# Wait for cage to actually accept Wayland clients. The socket file appearing is
# necessary but not sufficient (wlrctl crashes if it connects too early), so we
# poll wlrctl itself until a no-op succeeds, up to ~20s.
ok=
for _ in $(seq 1 100); do
  if [ -S "$SOCK" ] && wlrctl pointer move 0 0 >/dev/null 2>&1; then
    ok=1
    break
  fi
  sleep 0.2
done
if [ -z "$ok" ]; then
  echo "[park-cursor] cage not ready on $SOCK after ~20s; skipping" >&2
  exit 0   # cosmetic — never fail the unit over it
fi

# 5000px exceeds either dimension (1920x1080); wlroots clamps to the corner.
wlrctl pointer move 5000 5000
echo "[park-cursor] parked cursor in bottom-right corner"
