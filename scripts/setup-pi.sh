#!/usr/bin/env bash
#
# scripts/setup-pi.sh
#
# Foundation setup for a fresh Raspberry Pi Zero 2 W running Raspberry Pi OS Lite.
# Prepares the Pi for Milestone 1 (feasibility) bench work.
#
# What this does:
#   * Installs rtl-sdr, bluez-alsa-utils, alsa-utils, usbutils
#   * Blacklists kernel DVB-T modules so rtl_sdr can claim the dongle
#   * Adds the current user to the plugdev and bluetooth groups
#   * Enables and starts the bluez-alsa daemon
#   * Marks bench/ helper scripts executable
#
# Idempotent. Safe to re-run.
#
# Usage, from the repo root:
#   ./scripts/setup-pi.sh
#
# Group changes don't take effect until you log out and back in (or reboot).

set -euo pipefail

readonly BLACKLIST_FILE="/etc/modprobe.d/kerchunk-blacklist-rtl-sdr.conf"
readonly REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

say()  { printf '\n[setup-pi] %s\n' "$*"; }
warn() { printf '\n[setup-pi] WARNING: %s\n' "$*" >&2; }
die()  { printf '\n[setup-pi] ERROR: %s\n' "$*" >&2; exit 1; }

# ---- environment checks -----------------------------------------------------

if [[ $EUID -eq 0 ]]; then
    die "Run as a regular user, not root. The script invokes sudo where it needs to."
fi

if ! command -v sudo >/dev/null; then
    die "sudo is required and not available."
fi

if [[ -r /proc/device-tree/model ]]; then
    model=$(tr -d '\0' < /proc/device-tree/model)
    say "Detected: ${model}"
    if [[ "${model}" != *"Raspberry Pi"* ]]; then
        warn "This script is intended for a Raspberry Pi. Continuing anyway."
    fi
else
    warn "Cannot read /proc/device-tree/model. Continuing anyway."
fi

say "Caching sudo credentials..."
sudo -v

# ---- apt update + install ---------------------------------------------------

say "Updating apt indices..."
sudo apt-get update -qq

say "Installing M1 dependencies..."
sudo apt-get install -y --no-install-recommends \
    rtl-sdr \
    bluez \
    bluez-alsa-utils \
    alsa-utils \
    usbutils

# ---- blacklist DVB-T kernel modules ----------------------------------------
#
# Without this, the kernel's DVB-T driver (dvb_usb_rtl28xxu) claims the dongle
# at plug-in and rtl_sdr fails with "usb_claim_interface error -6".

say "Blacklisting DVB-T kernel modules..."
if [[ ! -f "${BLACKLIST_FILE}" ]]; then
    sudo tee "${BLACKLIST_FILE}" >/dev/null <<'EOF'
# Kerchunk: prevent the kernel DVB-T driver from claiming RTL2832U-based
# RTL-SDR dongles. Without this, rtl_test / rtl_fm fail with
# "usb_claim_interface error -6".
blacklist dvb_usb_rtl28xxu
blacklist rtl2832
blacklist rtl2830
EOF
    say "Wrote ${BLACKLIST_FILE}"
else
    say "${BLACKLIST_FILE} already present, leaving as-is"
fi

# Best-effort unload now (so the user doesn't have to reboot to use the dongle).
for mod in dvb_usb_rtl28xxu rtl2832 rtl2830; do
    if lsmod | awk '{print $1}' | grep -qx "${mod}"; then
        sudo modprobe -r "${mod}" 2>/dev/null || \
            warn "Could not unload ${mod} now (in use?). A reboot will fix it."
    fi
done

# ---- group membership -------------------------------------------------------
#
# plugdev: the rtl-sdr Debian package's udev rules grant device access to this
# group. bluetooth: needed for bluetoothctl pairing operations.

current_user="${SUDO_USER:-$USER}"
for group in plugdev bluetooth; do
    if id -nG "${current_user}" | tr ' ' '\n' | grep -qx "${group}"; then
        say "User ${current_user} already in ${group}"
    else
        say "Adding ${current_user} to ${group}..."
        sudo usermod -aG "${group}" "${current_user}"
    fi
done

# ---- bluez-alsa service -----------------------------------------------------

say "Enabling bluez-alsa..."
if sudo systemctl enable --now bluealsa.service 2>/dev/null; then
    say "bluez-alsa is running"
else
    warn "Could not enable/start bluealsa.service. Check 'systemctl status bluealsa'."
fi

# ---- bench scripts ----------------------------------------------------------

if [[ -d "${REPO_ROOT}/bench" ]]; then
    say "Marking bench/ scripts executable..."
    find "${REPO_ROOT}/bench" -maxdepth 1 -name '*.sh' -exec chmod +x {} +
else
    warn "No bench/ directory in ${REPO_ROOT}. Run from the repo root."
fi

# ---- summary ----------------------------------------------------------------

cat <<EOF

[setup-pi] Done.

Next steps:
  1. Log out and back in (or reboot) so group membership takes effect:
       sudo reboot
  2. Plug the RTL-SDR dongle into the Pi's USB-OTG port (the data port,
     via a right-angle micro-USB OTG adapter). Power the Pi from the
     other micro-USB port.
  3. Run the bench protocol from bench/README.md, in order:
       ./bench/01-rtl-test.sh
       ./bench/02-pair-bluetooth.sh
       ./bench/03-stream-fm.sh <FREQ_HZ> <BT_MAC>

EOF
