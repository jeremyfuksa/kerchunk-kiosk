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
# Built-in analog out (CS4208), addressed by card NAME: indices swap across
# boots when the PCH and HDMI controllers race (bit us on first appliance boot).
# AUDIO_CARD is the single knob: it names the sink, the amixer target, and the
# card WirePlumber is told to keep its hands off (see the audio-ownership step).
AUDIO_CARD="${AUDIO_CARD:-PCH}"
AUDIO_SINK="plughw:CARD=${AUDIO_CARD},DEV=0"

echo "[setup] Installing SDR toolchain packages..."
sudo apt-get update
sudo apt-get install -y \
  rtl-sdr soapysdr-tools soapysdr-module-rtlsdr gnuradio python3-numpy \
  alsa-utils \
  cage wlrctl curl ca-certificates

echo "[setup] Ensuring a SYSTEM Node >=24 at /usr/bin/node (NodeSource)..."
# The systemd unit runs ExecStart=/usr/bin/node, and the history store imports
# node:sqlite — built in, but only on Node >=22.5, and unflagged on Node 24. So
# Ubuntu's apt `nodejs` (often older) isn't enough; pin Node 24 from NodeSource.
# Install only if /usr/bin/node is missing or too old (check the path, not PATH —
# a per-user mise/nvm node must not satisfy the systemd unit's /usr/bin/node).
need_node=1
if [ -x /usr/bin/node ] && [ "$(/usr/bin/node -p 'process.versions.node.split(".")[0]')" -ge 24 ]; then
  need_node=0
fi
if [ "$need_node" -eq 1 ]; then
  # Avoid piping a remote script straight into a root shell. Fetch it, verify a
  # pinned SHA-256 if provided, then run it without -E. Update NODESOURCE_SHA256
  # when bumping the Node major: `curl -fsSL https://deb.nodesource.com/setup_24.x | sha256sum`.
  NODESOURCE_SHA256="${NODESOURCE_SHA256:-}"
  tmp_ns="$(mktemp)"
  curl -fsSL https://deb.nodesource.com/setup_24.x -o "$tmp_ns"
  if [ -n "$NODESOURCE_SHA256" ]; then
    echo "${NODESOURCE_SHA256}  ${tmp_ns}" | sha256sum -c - || { echo "[setup] NodeSource setup script failed checksum verification" >&2; exit 1; }
  else
    echo "[setup] WARNING: NODESOURCE_SHA256 not pinned; running the NodeSource setup script unverified." >&2
  fi
  sudo bash "$tmp_ns"
  rm -f "$tmp_ns"
  sudo apt-get install -y nodejs
fi
echo "[setup] system node: $(/usr/bin/node --version)"

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

echo "[setup] Audio ownership: keeping WirePlumber off the scanner card ($AUDIO_CARD)..."
# Exactly one process owns the scanner's audio card. WirePlumber otherwise
# claims it at login and writes its own route volume onto the ALSA Master
# control the backend owns — desyncing the admin volume slider from the
# hardware on every boot. See the drop-in's header for the full mechanism.
sudo mkdir -p /etc/wireplumber/wireplumber.conf.d
sed 's#\\\\bPCH\$#\\\\b'"${AUDIO_CARD}"'$#' \
  "$REPO_DIR/systemd/wireplumber-kerchunk-scanner-card.conf" \
  | sudo tee /etc/wireplumber/wireplumber.conf.d/50-kerchunk-scanner-card.conf >/dev/null
systemctl --user restart wireplumber 2>/dev/null || true

echo "[setup] Pinning OS maintenance to an overnight window (off the air during the day)..."
# apt + snap default to daytime/boot-relative schedules. On this old, thermally
# saturated box an apt-get dist-upgrade or snap refresh mid-afternoon spikes CPU
# and competes with the DSP helper for the few cores it has. Pin all of it to
# ~03:00-05:00 local. OnCalendar is additive in drop-ins, so reset it to empty
# before setting the new time, or the default schedule stays active alongside.
for unit in apt-daily:03:30:00 apt-daily-upgrade:03:50:00; do
  name="${unit%%:*}"; when="${unit#*:}"
  sudo mkdir -p "/etc/systemd/system/${name}.timer.d"
  # No Persistent=true on purpose: a missed overnight run must NOT catch up on
  # next boot — a daytime reboot would otherwise fire apt immediately, the very
  # daytime spike we're moving away from. Always-on box runs it at the window.
  sudo tee "/etc/systemd/system/${name}.timer.d/override.conf" >/dev/null <<EOF
[Timer]
OnCalendar=
OnCalendar=*-*-* ${when}
RandomizedDelaySec=20m
EOF
done
sudo systemctl daemon-reload
sudo systemctl restart apt-daily.timer apt-daily-upgrade.timer 2>/dev/null || true
# snap has its own scheduler (not a systemd timer): hold refreshes to the same window.
sudo snap set system refresh.timer=03:00-05:00 2>/dev/null || true

echo "[setup] Kernel cmdline: disable the internal panel, no console blanking..."
# video=eDP-1:d turns the built-in panel off at boot so cage only ever sees
# the HDMI output (remove this file + update-grub to get the panel back).
sudo mkdir -p /etc/default/grub.d
sudo tee /etc/default/grub.d/kerchunk-kiosk.cfg >/dev/null <<'EOF'
GRUB_CMDLINE_LINUX_DEFAULT="$GRUB_CMDLINE_LINUX_DEFAULT video=eDP-1:d consoleblank=0"
EOF
sudo update-grub 2>&1 | tail -1

echo "[setup] Building the kiosk app..."
# Build as the repo owner, not root (this script is usually `sudo bash`-ed):
# root-owned node_modules/dist would break later user-run builds. Plain
# `bash -c` (no login shell) keeps mise out of it — system node/npm, same
# interpreter the systemd unit uses.
REPO_OWNER="$(stat -c %U "$REPO_DIR")"
sudo -u "$REPO_OWNER" -H bash -c "cd '$REPO_DIR' && /usr/bin/npm install --silent && /usr/bin/npm run build" >/dev/null

if ! sudo test -f "$STATE_DIR/config.json"; then
  echo "[setup] Seeding default config (audio sink $AUDIO_SINK, all 7 NOAA WX channels)..."
  # ALL SEVEN WX channels, not just one: they fit a single wideband group, and
  # the wideband squelch needs quiet neighbors to learn the noise floor — a
  # single continuously-keyed NOAA channel alone can never open (documented
  # limitation in wideband_helper.py). Seven also makes a great first-boot
  # demo: the live stations open, the rest hold the floor.
  sudo mkdir -p "$STATE_DIR"
  sudo tee "$STATE_DIR/config.json" >/dev/null <<JSON
{
  "version": 1,
  "scan": { "sampleRate": 12000, "squelchLevel": 1800, "gain": "auto", "dwellMs": 2000 },
  "audio": { "sink": "$AUDIO_SINK", "volume": 70, "muted": false, "mixerCard": "$AUDIO_CARD", "mixerControl": "Master" },
  "channels": [
    { "id": "wx2", "freq": 162400000, "alphaTag": "WX2", "mode": "nfm", "enabled": true },
    { "id": "wx4", "freq": 162425000, "alphaTag": "WX4", "mode": "nfm", "enabled": true },
    { "id": "wx5", "freq": 162450000, "alphaTag": "WX5", "mode": "nfm", "enabled": true },
    { "id": "wx3", "freq": 162475000, "alphaTag": "WX3", "mode": "nfm", "enabled": true },
    { "id": "wx6", "freq": 162500000, "alphaTag": "WX6", "mode": "nfm", "enabled": true },
    { "id": "wx7", "freq": 162525000, "alphaTag": "WX7", "mode": "nfm", "enabled": true },
    { "id": "wx1", "freq": 162550000, "alphaTag": "WX1 KID77", "mode": "nfm", "enabled": true }
  ]
}
JSON
  sudo chown -R kiosk:kiosk "$STATE_DIR"
fi

echo "[setup] Disabling the display manager (kiosk owns seat0/tty1)..."
# A desktop install boots into GDM, which owns seat0/tty1 and blocks cage's
# PAM/logind session forever (the unit sits "active" with cage stuck pre-exec).
# Same move as lightdm on the Pi: the kiosk IS the display manager here.
if systemctl list-unit-files display-manager.service >/dev/null 2>&1 \
   && [ -e /etc/systemd/system/display-manager.service ]; then
  sudo systemctl disable --now "$(basename "$(readlink -f /etc/systemd/system/display-manager.service)")"
fi

echo "[setup] Neutralizing gnome-keyring for the kiosk session..."
# A password-locked login keyring (left over from any prior desktop login)
# makes gnome-keyring throw an unlock dialog over the dashboard — Chromium
# runs with --password-store=basic and never needs it. Move it aside (backup,
# not delete: it may hold secrets from that desktop session).
KIOSK_HOME="$(getent passwd kiosk | cut -d: -f6)"
if [ -f "$KIOSK_HOME/.local/share/keyrings/login.keyring" ]; then
  sudo -u kiosk mkdir -p "$KIOSK_HOME/keyrings-pre-kiosk-backup"
  sudo -u kiosk mv "$KIOSK_HOME/.local/share/keyrings/login.keyring" \
    "$KIOSK_HOME/keyrings-pre-kiosk-backup/login.keyring.$(date +%s)"
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
