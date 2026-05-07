# Kerchunk M1 — Feasibility bench

Goal: stream a local 2 m repeater to Bluetooth earbuds for **60 seconds, no glitches**, on a stock Pi Zero 2 W. Until this passes, no carrier PCB, no companion app, no custom OS image work — every downstream milestone is built on this one.

## Hardware

- Raspberry Pi Zero 2 W with a fresh Raspberry Pi OS Lite SD, on Wi-Fi
- RTL-SDR Blog V3 (or any R820T2 dongle)
- Right-angle micro-USB OTG adapter from the Pi's data port to the dongle's USB-A
- USB-C-to-micro-USB power on the Pi's *power* port (the port nearest the corner of the board)
- A pair of Bluetooth earbuds you can pair fresh

## One-time setup

From the cloned repo on the Pi:

```sh
./scripts/setup-pi.sh
sudo reboot
```

The reboot is needed for `plugdev` and `bluetooth` group membership to take effect.

## Protocol, in order

```sh
./bench/01-rtl-test.sh                                # smoke-test the dongle
./bench/02-pair-bluetooth.sh                          # pair earbuds, copy the MAC
./bench/03-stream-fm.sh 145130000 AA:BB:CC:DD:EE:FF   # 60-second stream test
```

Replace `145130000` with a Hz value of an active local 2 m repeater (look it up on RepeaterBook). Replace the MAC with whatever `02-pair-bluetooth.sh` paired.

## Pass criterion

Sixty seconds of clean repeater audio in the earbuds. AVRCP metadata isn't expected at this milestone — that's M2.

## Common failure modes

| Symptom | Cause | Fix |
|---|---|---|
| `usb_claim_interface error -6` | DVB-T kernel driver still attached | Re-run `setup-pi.sh`, then reboot |
| `rtl_test` reports `lost samples` continuously | Underpowered USB supply, bad cable, or the Pi's USB host is overloaded | Use a 2 A+ supply on the Pi's power port, swap the OTG adapter, or try a powered hub |
| `bluealsa-aplay` connects but you hear nothing | Earbuds in the wrong A2DP role, or wrong codec negotiated | `bluetoothctl info <MAC>` to confirm A2DP profile is connected |
| Audio plays for ~30 s then drops | Wi-Fi 2.4 GHz interfering with BT | Move closer / disable Wi-Fi for the test (`sudo ifconfig wlan0 down`) |
| Audio is constantly choppy from the start | rtl_fm sample rate too high for the Pi or BT bandwidth | Lower the resample rate (`-r 24000`) and re-test |

If pass: file the result, then move to M1.5 (suspend-resume validation).
If fail: investigate the specific symptom before any further work — the entire roadmap is gated on this.
