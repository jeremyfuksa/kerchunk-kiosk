#!/usr/bin/env bash
#
# bench/02-pair-bluetooth.sh
#
# Guided Bluetooth pairing. Prints the bluetoothctl command sequence, then
# launches bluetoothctl in interactive mode for you to follow it.

set -euo pipefail

cat <<'EOF'
[02-pair-bluetooth] Put your earbuds in pairing mode now, then follow these
                    commands inside bluetoothctl:

    power on
    agent on
    default-agent
    scan on
    # ...wait until your earbuds appear with a MAC like XX:XX:XX:XX:XX:XX
    scan off
    pair XX:XX:XX:XX:XX:XX
    trust XX:XX:XX:XX:XX:XX
    connect XX:XX:XX:XX:XX:XX
    info XX:XX:XX:XX:XX:XX
    # ...confirm 'Connected: yes' and 'UUID: Audio Sink' appears
    quit

Save the MAC. You will pass it to bench/03-stream-fm.sh.

Press Enter to launch bluetoothctl, or Ctrl-C to quit.
EOF

read -r
exec bluetoothctl
