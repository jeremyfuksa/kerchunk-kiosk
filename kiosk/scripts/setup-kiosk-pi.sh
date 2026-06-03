#!/usr/bin/env bash
#
# Provision THIS Raspberry Pi (Debian 13 / RPi OS, Pi 4) as a Kerchunk Kiosk.
# Adapted from setup-kiosk.sh for this specific host:
#   - installs a SYSTEM Node at /usr/bin/node (NodeSource v20) so the systemd
#     service does not depend on a per-user mise/nvm install;
#   - uses the `chromium` package (not `chromium-browser`);
#   - seeds config pointing at the connected HDMI (ALSA card 1, vc4hdmi1).
#
# Run as a user with sudo, from the repo. Idempotent where practical.
#
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # the kiosk/ dir
INSTALL_DIR=/opt/kerchunk-kiosk
STATE_DIR=/var/lib/kerchunk-kiosk
# Connected display's ALSA sink on this Pi (verified: card 1 = vc4hdmi1).
HDMI_SINK="hdmi:CARD=vc4hdmi1,DEV=0"

echo "[setup] Installing packages..."
sudo apt-get update
sudo apt-get install -y rtl-sdr alsa-utils cage chromium curl ca-certificates

echo "[setup] Ensuring a SYSTEM Node >=20 at /usr/bin/node (NodeSource)..."
# The systemd unit runs ExecStart=/usr/bin/node, which must exist independent of
# any per-user node manager (mise/nvm). Install only if /usr/bin/node is missing
# or too old — note we check /usr/bin/node specifically, not `command -v node`.
need_node=1
if [ -x /usr/bin/node ] && [ "$(/usr/bin/node -p 'process.versions.node.split(".")[0]')" -ge 20 ]; then
  need_node=0
fi
if [ "$need_node" -eq 1 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
echo "[setup] system node: $(/usr/bin/node --version)"

echo "[setup] Blacklisting the DVB kernel module (frees the dongle for rtl_fm)..."
echo 'blacklist dvb_usb_rtl28xxu' | sudo tee /etc/modprobe.d/blacklist-rtl.conf >/dev/null

echo "[setup] Installing RTL-SDR udev rule (plugdev access, no root needed)..."
sudo tee /etc/udev/rules.d/20-rtlsdr.rules >/dev/null <<'RULE'
SUBSYSTEM=="usb", ATTRS{idVendor}=="0bda", ATTRS{idProduct}=="2838", GROUP="plugdev", MODE="0666"
SUBSYSTEM=="usb", ATTRS{idVendor}=="0bda", ATTRS{idProduct}=="2832", GROUP="plugdev", MODE="0666"
RULE
sudo udevadm control --reload-rules

echo "[setup] Creating the kerchunk service user..."
if ! id kerchunk >/dev/null 2>&1; then
  sudo useradd --system --create-home --shell /usr/sbin/nologin kerchunk
fi
sudo usermod -aG audio,plugdev,video,render,input kerchunk

echo "[setup] Building the app (using whatever node is on PATH for the build)..."
( cd "$REPO_DIR" && npm ci && npm run build )

echo "[setup] Installing to $INSTALL_DIR..."
sudo mkdir -p "$INSTALL_DIR"
sudo cp -r "$REPO_DIR/dist" "$REPO_DIR/package.json" "$REPO_DIR/node_modules" "$INSTALL_DIR/"
sudo chown -R kerchunk:kerchunk "$INSTALL_DIR"

echo "[setup] Preparing state dir $STATE_DIR..."
sudo mkdir -p "$STATE_DIR"
# Seed config only if absent, so reboots/re-runs keep the operator's channels.
if [ ! -f "$STATE_DIR/config.json" ]; then
  echo "[setup] Seeding default config (HDMI sink $HDMI_SINK, NOAA test channel)..."
  sudo tee "$STATE_DIR/config.json" >/dev/null <<JSON
{
  "version": 1,
  "scan": { "sampleRate": 12000, "squelchLevel": 1800, "gain": "auto", "dwellMs": 1500 },
  "audio": { "sink": "$HDMI_SINK", "volume": 70, "muted": false },
  "channels": [
    { "id": "noaa", "freq": 162550000, "alphaTag": "NOAA WX", "mode": "nfm", "enabled": true }
  ]
}
JSON
fi
sudo chown -R kerchunk:kerchunk "$STATE_DIR"

echo "[setup] Installing systemd units..."
sudo cp "$REPO_DIR/systemd/kerchunk-kiosk.service" /etc/systemd/system/
sudo cp "$REPO_DIR/systemd/kerchunk-display.service" /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now kerchunk-kiosk.service
# Enable the local display only if a screen is attached; safe to enable anyway.
sudo systemctl enable --now kerchunk-display.service || true

echo "[setup] Done. Admin: http://$(hostname -I | awk '{print $1}'):8080/admin"
echo "[setup] If the dongle was plugged in before blacklisting, reboot once."
