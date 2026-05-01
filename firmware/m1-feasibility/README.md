# Kerchunk M1 — Feasibility

ESP-IDF project for Milestone 1 of the [Kerchunk vision](../../docs/Kerchunk%20Vision.md).

## Goal

Prove the ESP32-S3 can host an RTL-SDR, pull I/Q samples, demod one channel, and simultaneously stream audio over Bluetooth A2DP.

## Success criterion

Stream a local 2m repeater to Bluetooth earbuds for 60 seconds without glitches.

## Failure decision

If the S3 cannot sustain this, pivot Base to the STM32H7 + ESP32-S3 architecture (per vision §Firmware architecture → Critical risk).

## Hardware

- ESP32-S3-DevKitC-1 (N8R2)
- Nooelec Nano 3 RTL-SDR
- USB OTG adapter cable

## Build

Requires ESP-IDF v5.x on `PATH`.

```sh
idf.py set-target esp32s3
idf.py build
idf.py -p <PORT> flash monitor
```

## Status

Skeleton only. `app_main` logs and exits. Subsystems (USB host, RTL2832U driver, FM demod, A2DP source) are not yet implemented — see the vision doc's M1 task list.
