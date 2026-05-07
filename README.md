# Kerchunk

A pocket-sized Bluetooth scanner built around a Raspberry Pi Zero 2 W and an RTL-SDR dongle. Headless, car-optimized, parallel multi-channel monitoring with analog FM/NFM/AM at launch and P25 Phase 1 in a follow-up firmware release — all on the same single SKU.

See [docs/Kerchunk Vision.md](docs/Kerchunk%20Vision.md) for the full product vision, architecture, and roadmap.

## Status

Pre-prototype. Working on **Milestone 1: Feasibility** — proving `rtl_fm + bluez-alsa` on a stock Pi Zero 2 W can stream a local 2 m repeater to Bluetooth earbuds for 60 seconds clean.

## Layout

- [`docs/`](docs/) — vision and design documents
- `software/` (Linux userspace daemons: `kerchunk-rxd`, `kerchunk-btd`, `kerchunk-cfgd`) will be added when M1 starts
- `hardware/` (KiCad carrier PCB) will be added at M4
- `app/` (Flutter companion) will be added at M3
