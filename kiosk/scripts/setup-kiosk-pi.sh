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
# Use the `plughw:` plugin, NOT raw `hdmi:`/`hw:` — HDMI audio requires stereo,
# but rtl_fm produces mono; `plughw` auto-upmixes mono->stereo (and converts
# rate). Raw hdmi: fails with "Channels count non available" and aplay dies.
HDMI_SINK="plughw:CARD=vc4hdmi1,DEV=0"

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
  # Avoid piping a remote script straight into a root shell. Fetch it, verify a
  # pinned SHA-256, then run it without -E (don't leak this shell's env into root).
  # Update NODESOURCE_SHA256 when bumping the Node major; get it from the file you
  # intend to trust: `curl -fsSL https://deb.nodesource.com/setup_20.x | sha256sum`.
  NODESOURCE_SHA256="${NODESOURCE_SHA256:-}"
  tmp_ns="$(mktemp)"
  curl -fsSL https://deb.nodesource.com/setup_20.x -o "$tmp_ns"
  if [ -n "$NODESOURCE_SHA256" ]; then
    echo "${NODESOURCE_SHA256}  ${tmp_ns}" | sha256sum -c - || { echo "[setup] NodeSource setup script failed checksum verification" >&2; exit 1; }
  else
    echo "[setup] WARNING: NODESOURCE_SHA256 not pinned; running the NodeSource setup script unverified." >&2
    echo "[setup] Set NODESOURCE_SHA256=<sha> to enforce, or install Debian's own nodejs (>=20) instead." >&2
  fi
  sudo bash "$tmp_ns"
  rm -f "$tmp_ns"
  sudo apt-get install -y nodejs
fi
echo "[setup] system node: $(/usr/bin/node --version)"

echo "[setup] Blacklisting the DVB kernel module (frees the dongle for rtl_fm)..."
echo 'blacklist dvb_usb_rtl28xxu' | sudo tee /etc/modprobe.d/blacklist-rtl.conf >/dev/null

echo "[setup] Installing RTL-SDR udev rule (plugdev access, no root needed)..."
sudo tee /etc/udev/rules.d/20-rtlsdr.rules >/dev/null <<'RULE'
SUBSYSTEM=="usb", ATTRS{idVendor}=="0bda", ATTRS{idProduct}=="2838", GROUP="plugdev", MODE="0660"
SUBSYSTEM=="usb", ATTRS{idVendor}=="0bda", ATTRS{idProduct}=="2832", GROUP="plugdev", MODE="0660"
RULE
sudo udevadm control --reload-rules

echo "[setup] Creating the kerchunk service user..."
if ! id kerchunk >/dev/null 2>&1; then
  sudo useradd --system --create-home --shell /usr/sbin/nologin kerchunk
fi
# No `input` group: it grants read of ALL /dev/input/* (keyboards/mice) — a
# keyboard-sniffing risk for a service user. cage gets input via seatd/logind,
# and the dashboard is output-only, so the kiosk does not need it.
sudo usermod -aG audio,plugdev,video,render kerchunk

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
