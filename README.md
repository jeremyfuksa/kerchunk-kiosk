# Kerchunk

A pocket-sized Bluetooth scanner built around a Raspberry Pi Zero 2 W and an RTL-SDR dongle. Headless, car-optimized, parallel multi-channel monitoring with analog FM/NFM/AM at launch and P25 Phase 1 in a follow-up firmware release — all on the same single SKU.

See [docs/Kerchunk Vision.md](docs/Kerchunk%20Vision.md) for the full product vision, architecture, and roadmap.

## Status

Pre-prototype. **Pivoted in May 2026** from an ESP32-S3 host to a Raspberry Pi Zero 2 W after discovering the S3's USB peripheral is Full-Speed only (12 Mbps) and cannot carry the RTL2832U's 2.4 MSPS / ~4.8 MB/s I/Q stream. The Zero 2 W has High-Speed USB host, on-chip Bluetooth Classic + BLE, and the DSP headroom to run analog and P25 on the same chip — collapsing the previous two-tier (Classic/Delta) plan into one product.

Now working on **Milestone 1: Feasibility** — proving `rtl_fm + bluez-alsa` on a stock Pi Zero 2 W can stream a local 2m repeater to Bluetooth earbuds for 60 seconds clean.

## Layout

- [`docs/`](docs/) — vision and design documents
- `software/` (Linux userspace daemons: `kerchunk-rxd`, `kerchunk-btd`, `kerchunk-cfgd`) will be added when M1 starts
- `hardware/` (KiCad carrier PCB) will be added at M4
- `app/` (Flutter companion) will be added at M3
