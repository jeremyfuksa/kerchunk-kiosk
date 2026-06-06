# kiosk/scripts/setup-kiosk.sh
#!/usr/bin/env bash
#
# Provision a Raspberry Pi 4 (Raspberry Pi OS) as a Kerchunk Kiosk.
# Run on the Pi as a user with sudo. Idempotent where practical.
#
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # the kiosk/ dir
INSTALL_DIR=/opt/kerchunk-kiosk
STATE_DIR=/var/lib/kerchunk-kiosk

echo "[setup] Installing packages..."
sudo apt-get update
sudo apt-get install -y rtl-sdr alsa-utils cage chromium-browser curl ca-certificates

echo "[setup] Installing Node.js 24 (NodeSource) if node is missing or <24..."
# Node >=24: the history store imports node:sqlite (built in, but only Node
# >=22.5, unflagged on 24).
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 24 ]; then
  curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi

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

echo "[setup] Building the app..."
( cd "$REPO_DIR" && npm ci && npm run build )

echo "[setup] Installing to $INSTALL_DIR..."
sudo mkdir -p "$INSTALL_DIR"
sudo cp -r "$REPO_DIR/dist" "$REPO_DIR/package.json" "$REPO_DIR/node_modules" "$INSTALL_DIR/"
sudo chown -R kerchunk:kerchunk "$INSTALL_DIR"

echo "[setup] Preparing state dir $STATE_DIR..."
sudo mkdir -p "$STATE_DIR"
sudo chown kerchunk:kerchunk "$STATE_DIR"

echo "[setup] Installing systemd units..."
sudo cp "$REPO_DIR/systemd/kerchunk-kiosk.service" /etc/systemd/system/
sudo cp "$REPO_DIR/systemd/kerchunk-display.service" /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now kerchunk-kiosk.service
# Enable the local display only if a screen is attached; safe to enable anyway.
sudo systemctl enable --now kerchunk-display.service || true

echo "[setup] Done. Admin: http://$(hostname -I | awk '{print $1}'):8080/admin"
echo "[setup] If the dongle was plugged in before blacklisting, reboot once."
