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
# Audio sink: the `kerchunk` ALSA device defined in systemd/asound.conf.pi
# (installed to /etc/asound.conf). On this Pi it routes to the 3.5mm headphone
# jack — the connected HDMI display reported no audio sink (empty EDID/ELD) and
# its speakers sounded bad. Set the headphone level with
# `amixer -c <Headphones-card> sset PCM 65%` then `sudo alsactl store`.
AUDIO_SINK="kerchunk"

echo "[setup] Installing packages..."
sudo apt-get update
# wlrctl: warps cage's compositor cursor into the corner (the display unit's
# ExecStartPost) — cage 0.2.0 has no flag to hide the pointer.
sudo apt-get install -y rtl-sdr alsa-utils cage chromium curl ca-certificates wlrctl

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
  echo "[setup] Seeding default config (audio sink $AUDIO_SINK, NOAA test channel)..."
  sudo tee "$STATE_DIR/config.json" >/dev/null <<JSON
{
  "version": 1,
  "scan": { "sampleRate": 12000, "squelchLevel": 1800, "gain": "auto", "dwellMs": 1500 },
  "audio": { "sink": "$AUDIO_SINK", "volume": 70, "muted": false },
  "channels": [
    { "id": "noaa", "freq": 162550000, "alphaTag": "NOAA WX", "mode": "nfm", "enabled": true }
  ]
}
JSON
fi
sudo chown -R kerchunk:kerchunk "$STATE_DIR"

echo "[setup] Installing ALSA config (defines the '$AUDIO_SINK' sink)..."
sudo cp "$REPO_DIR/systemd/asound.conf.pi" /etc/asound.conf

echo "[setup] Tuning VM for zram swap on this low-RAM Pi..."
sudo cp "$REPO_DIR/systemd/99-kerchunk-zram.conf" /etc/sysctl.d/99-kerchunk-zram.conf
sudo sysctl --system >/dev/null 2>&1 || true

echo "[setup] Disabling appliance-useless services (kiosk needs no Bluetooth / removable-media mgmt)..."
sudo systemctl disable --now bluetooth.service 2>/dev/null || true
sudo systemctl disable --now udisks2.service 2>/dev/null || true

echo "[setup] Installing the blank cursor theme (best-effort) + corner-park script..."
# The display unit sets XCURSOR_THEME=blank / XCURSOR_PATH=/usr/share/icons as a
# best-effort hide. On cage 0.2.0 this did not actually hide the pointer, so the
# active mitigation is park-cursor.sh (ExecStartPost) shoving the cursor into the
# corner via wlrctl. -a preserves the theme's cursor-name symlinks.
sudo rm -rf /usr/share/icons/blank
sudo cp -a "$REPO_DIR/kiosk-assets/blank-cursor" /usr/share/icons/blank
# park-cursor.sh lives under the /opt install at the path the cursor-park unit's
# ExecStart expects (deploy.sh only syncs dist/node_modules, so install the
# script here explicitly).
sudo mkdir -p "$INSTALL_DIR/scripts"
sudo cp "$REPO_DIR/scripts/park-cursor.sh" "$INSTALL_DIR/scripts/park-cursor.sh"
sudo chmod +x "$INSTALL_DIR/scripts/park-cursor.sh"

echo "[setup] Installing systemd units (Pi-hardened display: seatd, memory caps, no cursor)..."
sudo cp "$REPO_DIR/systemd/kerchunk-kiosk.service" /etc/systemd/system/kerchunk-kiosk.service
sudo cp "$REPO_DIR/systemd/kerchunk-display-pi.service" /etc/systemd/system/kerchunk-display.service
sudo cp "$REPO_DIR/systemd/kerchunk-cursor-park.service" /etc/systemd/system/kerchunk-cursor-park.service
sudo systemctl daemon-reload
sudo systemctl enable --now kerchunk-kiosk.service
# Enable the local display only if a screen is attached; safe to enable anyway.
sudo systemctl enable --now kerchunk-display.service || true
# Park the cursor off-screen after the display is up (oneshot; non-fatal).
sudo systemctl enable --now kerchunk-cursor-park.service || true

echo "[setup] Done. Admin: http://$(hostname -I | awk '{print $1}'):8080/admin"
echo "[setup] If the dongle was plugged in before blacklisting, reboot once."
