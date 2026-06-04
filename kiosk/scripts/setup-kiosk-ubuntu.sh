#!/usr/bin/env bash
#
# Provision the Ubuntu laptop appliance (Intel MacBook Pro, Ubuntu 26.04) with
# the SDR toolchain for the WIDEBAND engine (KERCHUNK_ENGINE=wideband):
#   - rtl-sdr suite + SoapySDR + GNU Radio (apt; gr-soapy ships inside the
#     `gnuradio` package, Python bindings land in system /usr/bin/python3
#     dist-packages — the engine spawns the helper with that interpreter);
#   - blacklists the DVB-TV kernel modules so they never claim the dongle
#     (librtlsdr can detach them, but the appliance shouldn't depend on that).
#
# Display/lid/kiosk-session setup is a SEPARATE follow-up (closed-lid HDMI);
# this script is only the SDR/DSP layer. Run with sudo available. Idempotent.
#
set -euo pipefail

echo "[setup] Installing SDR toolchain packages..."
sudo apt-get update
sudo apt-get install -y \
  rtl-sdr soapysdr-tools soapysdr-module-rtlsdr gnuradio python3-numpy \
  alsa-utils

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

echo "[setup] Verifying the toolchain..."
/usr/bin/python3 -c "import gnuradio, gnuradio.soapy" \
  && echo "[setup]   GNU Radio + gr-soapy: OK ($(gnuradio-config-info --version))"
if rtl_test -t >/dev/null 2>&1 || SoapySDRUtil --find 2>/dev/null | grep -q rtlsdr; then
  echo "[setup]   RTL-SDR device: OK"
else
  echo "[setup]   RTL-SDR device: NOT FOUND (plug in the dongle and re-run rtl_test)"
fi

echo "[setup] Done. Run the kiosk with KERCHUNK_ENGINE=wideband."
