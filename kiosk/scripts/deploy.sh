#!/usr/bin/env bash
#
# Deploy the current origin/main to the Kerchunk Kiosk Pi.
#
# Run from the dev Mac (same LAN as the Pi). SSHes in, resets the Pi's repo
# clone to origin/main, builds, installs to /opt/kerchunk-kiosk, and restarts
# the systemd units. Idempotent: it hard-resets the Pi clone every run.
#
# Override the target with KERCHUNK_PI_HOST (default admin@192.168.1.54), e.g.
#   KERCHUNK_PI_HOST=admin@kerchunk-kiosk.local ./kiosk/scripts/deploy.sh
#
set -euo pipefail

PI_HOST="${KERCHUNK_PI_HOST:-admin@192.168.1.54}"
PI_REPO="${KERCHUNK_PI_REPO:-/home/admin/kerchunk-kiosk}"
INSTALL_DIR=/opt/kerchunk-kiosk

echo "[deploy] target: $PI_HOST  repo: $PI_REPO"

# Preflight: fail fast (and clearly) if the Pi is unreachable, rather than
# hanging on the real SSH session below.
if ! ssh -o BatchMode=yes -o ConnectTimeout=5 "$PI_HOST" true 2>/dev/null; then
  echo "[deploy] ERROR: cannot reach $PI_HOST over SSH. Is the Pi on and on the LAN?" >&2
  exit 1
fi

# All remote work in one session. The remote runs its own strict bash; the
# heredoc is quoted ('REMOTE') so it is sent verbatim, not expanded locally.
ssh "$PI_HOST" "INSTALL_DIR='$INSTALL_DIR' PI_REPO='$PI_REPO' bash -s" <<'REMOTE'
set -euo pipefail

cd "$PI_REPO"

echo "[deploy] fetching origin and resetting to origin/main..."
git fetch --quiet origin
git reset --hard origin/main

cd "$PI_REPO/kiosk"
echo "[deploy] building (npm ci && npm run build)..."
npm ci
npm run build

echo "[deploy] installing to $INSTALL_DIR..."
sudo rsync -a --delete dist/ "$INSTALL_DIR/dist/"
sudo rsync -a --delete node_modules/ "$INSTALL_DIR/node_modules/"
sudo cp package.json "$INSTALL_DIR/package.json"
sudo chown -R kerchunk:kerchunk "$INSTALL_DIR"

echo "[deploy] restarting services..."
sudo systemctl restart kerchunk-kiosk.service kerchunk-display.service

deployed="$(git -C "$PI_REPO" rev-parse --short HEAD)"
echo "[deploy] deployed commit: $deployed"
echo "[deploy] kerchunk-kiosk:   $(systemctl is-active kerchunk-kiosk.service)"
echo "[deploy] kerchunk-display: $(systemctl is-active kerchunk-display.service)"
REMOTE

echo "[deploy] done."
