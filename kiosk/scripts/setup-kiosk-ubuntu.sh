#!/usr/bin/env bash
#
# Provision the Ubuntu laptop appliance (Intel MacBook Pro, Ubuntu 26.04):
#
# SDR/DSP layer (wideband engine):
#   - rtl-sdr suite + SoapySDR + GNU Radio (apt; gr-soapy ships inside the
#     `gnuradio` package, Python bindings land in system /usr/bin/python3
#     dist-packages — the engine spawns the helper with that interpreter);
#   - blacklists the DVB-TV kernel modules so they never claim the dongle
#     (librtlsdr can detach them, but the appliance shouldn't depend on that).
#
# Kiosk session layer (closed-lid HDMI, never sleeps):
#   - cage + snap Chromium fullscreen dashboard on tty1 (systemd units run as
#     the `kiosk` user straight from this repo checkout);
#   - lid switch ignored (logind drop-in) — closed lid is the normal posture;
#   - system sleep/suspend masked and idle ignored — the appliance never sleeps;
#   - internal panel disabled at boot (video=eDP-1:d) — HDMI is the only output;
#   - console blanking off (consoleblank=0).
#
# Run from the repo as the `kiosk` user with sudo available. Idempotent.
# Finish with a REBOOT (kernel cmdline + tty1 takeover apply at boot).
#
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # the kiosk/ dir
STATE_DIR=/var/lib/kerchunk-kiosk
AUDIO_SINK="plughw:1,0"   # CS4208 built-in analog out (operator-verified)

echo "[setup] Installing SDR toolchain packages..."
sudo apt-get update
sudo apt-get install -y \
  rtl-sdr soapysdr-tools soapysdr-module-rtlsdr gnuradio python3-numpy \
  alsa-utils \
  cage wlrctl nodejs

echo "[setup] Installing Chromium (snap — the only Chromium on Ubuntu)..."
snap list chromium >/dev/null 2>&1 || sudo snap install chromium

echo "[setup] Blacklisting DVB-TV kernel modules (they grab the RTL dongle)..."
sudo tee /etc/modprobe.d/rtl-sdr-blacklist.conf >/dev/null <<'EOF'
# RTL2832U is an SDR here, not a TV tuner. Keep the DVB stack off it.
blacklist dvb_usb_rtl28xxu
blacklist rtl2832
blacklist rtl2832_sdr
EOF

# Best-effort unload for the current boot; a replug/reboot makes it permanent.
for mod in rtl2832_sdr dvb_usb_rtl28xxu rtl2832; do
  if lsmod | grep -q "^${mod}\b"; then
    sudo rmmod "$mod" 2>/dev/null || echo "[setup]   $mod busy (replug the dongle or reboot)"
  fi
done

echo "[setup] Lid + sleep policy: ignore the lid, never sleep..."
sudo mkdir -p /etc/systemd/logind.conf.d
sudo tee /etc/systemd/logind.conf.d/kerchunk-kiosk.conf >/dev/null <<'EOF'
# Kerchunk appliance: the laptop runs closed-lid with HDMI out, 24/7.
[Login]
HandleLidSwitch=ignore
HandleLidSwitchExternalPower=ignore
HandleLidSwitchDocked=ignore
IdleAction=ignore
EOF
# The dashboard must never go away: no suspend/hibernate, ever.
sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target >/dev/null

echo "[setup] Kernel cmdline: disable the internal panel, no console blanking..."
# video=eDP-1:d turns the built-in panel off at boot so cage only ever sees
# the HDMI output (remove this file + update-grub to get the panel back).
sudo mkdir -p /etc/default/grub.d
sudo tee /etc/default/grub.d/kerchunk-kiosk.cfg >/dev/null <<'EOF'
GRUB_CMDLINE_LINUX_DEFAULT="$GRUB_CMDLINE_LINUX_DEFAULT video=eDP-1:d consoleblank=0"
EOF
sudo update-grub 2>&1 | tail -1

echo "[setup] Building the kiosk app..."
(cd "$REPO_DIR" && npm install --silent && npm run build >/dev/null)

if ! sudo test -f "$STATE_DIR/config.json"; then
  echo "[setup] Seeding default config (audio sink $AUDIO_SINK, NOAA test channel)..."
  sudo mkdir -p "$STATE_DIR"
  sudo tee "$STATE_DIR/config.json" >/dev/null <<JSON
{
  "version": 1,
  "scan": { "sampleRate": 12000, "squelchLevel": 1800, "gain": "auto", "dwellMs": 2000 },
  "audio": { "sink": "$AUDIO_SINK", "volume": 70, "muted": false, "mixerCard": 1, "mixerControl": "Master" },
  "channels": [
    { "id": "noaa", "freq": 162550000, "alphaTag": "NOAA WX", "mode": "nfm", "enabled": true }
  ]
}
JSON
  sudo chown -R kiosk:kiosk "$STATE_DIR"
fi

echo "[setup] Installing systemd units (repo-local paths, user kiosk)..."
sudo cp "$REPO_DIR/systemd/kerchunk-kiosk-ubuntu.service" /etc/systemd/system/kerchunk-kiosk.service
sudo cp "$REPO_DIR/systemd/kerchunk-display-ubuntu.service" /etc/systemd/system/kerchunk-display.service
sudo cp "$REPO_DIR/systemd/kerchunk-cursor-park-ubuntu.service" /etc/systemd/system/kerchunk-cursor-park.service
sudo systemctl daemon-reload
sudo systemctl enable --now kerchunk-kiosk.service
# Display units are enabled but NOT started: cage takes over tty1, and the
# kernel-cmdline change needs a boot anyway. The kiosk owns the screen from
# the next reboot on.
sudo systemctl enable kerchunk-display.service kerchunk-cursor-park.service

echo "[setup] Verifying the toolchain..."
/usr/bin/python3 -c "import gnuradio, gnuradio.soapy" \
  && echo "[setup]   GNU Radio + gr-soapy: OK ($(gnuradio-config-info --version))"
if rtl_test -t >/dev/null 2>&1 || SoapySDRUtil --find 2>/dev/null | grep -q rtlsdr; then
  echo "[setup]   RTL-SDR device: OK"
else
  echo "[setup]   RTL-SDR device: NOT FOUND (plug in the dongle and re-run rtl_test)"
fi

echo "[setup] Done. REBOOT to bring the kiosk up on the HDMI display"
echo "[setup] (internal panel off, lid ignored, never sleeps; backend is"
echo "[setup]  already running on :8080 with the wideband engine)."
