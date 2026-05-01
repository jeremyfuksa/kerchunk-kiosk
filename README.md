# Kerchunk

A pocket-sized Bluetooth scanner brain PCB that turns an RTL-SDR dongle into a headless, car-optimized analog (and eventually P25) scanner with parallel channel monitoring.

See [docs/Kerchunk Vision.md](docs/Kerchunk%20Vision.md) for the full product vision, architecture, and roadmap.

## Status

Pre-prototype. Working on **Milestone 1: Feasibility** — proving the ESP32-S3 can host an RTL-SDR, demod one channel, and stream over Bluetooth A2DP simultaneously.

## Layout

- [`docs/`](docs/) — vision and design documents
- [`firmware/m1-feasibility/`](firmware/m1-feasibility/) — ESP-IDF project for the M1 dev-board prototype

`hardware/` (KiCad) and `app/` (Flutter companion) will be added when their milestones start.
