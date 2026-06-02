---
title: "Kerchunk Kiosk — Design Spec"
created: 2026-06-02
status: approved
topic: kerchunk-kiosk
---

# Kerchunk Kiosk — Design Spec

## Summary

A stationary, screened sibling to the headless pocket Kerchunk. A Raspberry Pi 4
drives an HD display that shows a fullscreen, output-only scanner **dashboard**;
audio plays out **HDMI**; configuration happens through a **web admin** reachable
from any device on the LAN. A single Node/TypeScript backend serves both UIs,
supervises `rtl_fm` (serial squelch-scan across a channel list) for v1, pipes its
audio straight to the HDMI ALSA sink, and parses `rtl_fm` stderr for live status.

This is **Approach 3** from brainstorming: a single-process monolith with the
radio engine isolated behind a hard `ScannerEngine` interface, so the future
parallel `kerchunk-rxd` engine drops in as a new class without touching the web,
dashboard, or config layers.

## Relationship to Kerchunk

Per the [product vision](../../Kerchunk%20Vision.md), the original Kerchunk is a
deliberately screenless, headless, pocket-sized, Bluetooth-to-car-stereo product
on a Pi Zero 2 W. The Kiosk is a **sibling product** (not a replacement, not a
demo): a desk/wall appliance with a screen, web UI, and HDMI audio. It shares the
SDR + parallel-monitoring *core concept*, but everything around the engine is new.

The shared core is currently **aspirational** — the main project is at Milestone 1
(single-channel `rtl_fm` bench proven; no `kerchunk-rxd` yet). The Kiosk therefore
builds on `rtl_fm` first and treats the parallel engine as a later, clean upgrade
behind a stable interface.

## Decisions locked during brainstorming

- **Kiosk identity:** sibling product, shares the engine concept, own shell.
- **Engine for v1:** off-the-shelf `rtl_fm`, **serial** squelch-scan over a
  frequency list (a real scanner day one). Parallel monitoring deferred.
- **Audio:** HDMI is the one path that *must* work. The audio sink is a config
  value so other sinks can be added later, but only HDMI is wired up in v1.
- **Display:** **output-only** dashboard. No touch, no GPIO input. All control is
  in the web admin from another device. The display is any plain HD monitor/TV.
- **Dashboard layout:** **Now Playing + Activity Log** (active channel prominent,
  scrolling recent-transmissions log). Scales unchanged to parallel monitoring.
- **Rendering:** **browser kiosk mode** — Chromium fullscreen via `cage` pointed
  at `localhost`. The dashboard and admin are the same web app.
- **Backend stack:** **Node + TypeScript**, single language top to bottom.
- **Audio routing:** Path C — `rtl_fm | aplay` straight to HDMI (audio never
  touches Node); Node separately parses `rtl_fm` stderr for telemetry.
- **Backend structure:** Approach 3 — monolith now, radio behind a hard
  `ScannerEngine` interface.
- **Config store path:** `/var/lib/kerchunk-kiosk/` (FHS service state), owned by
  a dedicated `kerchunk` service user.
- **No auth in v1** (LAN appliance, like a Pi-hole admin page).
- **Default HTTP port `8080`** (overridable via a `PORT` env var). `PORT` below
  refers to this value.

## System architecture

```
┌─────────────────────────── Raspberry Pi 4 ───────────────────────────┐
│                                                                       │
│  systemd: kerchunk-kiosk.service        systemd: kerchunk-display.svc │
│  ┌────────────────────────────────┐     ┌──────────────────────────┐  │
│  │   Node / TypeScript backend    │     │  cage (Wayland kiosk) +  │  │
│  │   (single process)             │     │  Chromium --kiosk        │  │
│  │                                │     │  → http://localhost:PORT │  │
│  │  ┌──────────────────────────┐  │     └───────────┬──────────────┘  │
│  │  │ HTTP server (serves SPA) │◄─┼─────────────────┘ (loads dashboard)│
│  │  │ WebSocket (live status)  │  │                                    │
│  │  └──────────────────────────┘  │     Other devices (laptop/phone)   │
│  │  ┌──────────────────────────┐  │         │  http://<pi-ip>:PORT      │
│  │  │ ScannerEngine (interface)│  │◄────────┘ (loads admin)            │
│  │  │  └─ RtlFmEngine (v1)     │  │                                    │
│  │  └────────┬─────────────────┘  │                                    │
│  │  ┌────────┴───────┐ ┌────────┐ │                                    │
│  │  │ ConfigStore    │ │ Logger │ │                                    │
│  │  │ (JSON on disk) │ │(ring)  │ │                                    │
│  │  └────────────────┘ └────────┘ │                                    │
│  └────────────┬───────────────────┘                                    │
│               │ spawns + supervises                                    │
│   ┌───────────▼──────────────────────────────────────┐                 │
│   │  rtl_fm (serial squelch-scan over freq list)      │                 │
│   │     stdout: raw PCM ──┐   stderr: signal/squelch  │                 │
│   └───────────────────────┼──────────▲────────────────┘                 │
│                           │          │ parsed for telemetry            │
│              ┌────────────▼───┐      └──► ScannerEngine events          │
│              │ aplay -D hdmi  │                                         │
│              └────────┬───────┘                                         │
└───────────────────────┼─────────────────────────────────────────────────┘
                        ▼
              HDMI display + audio (one cable)
```

- **One Node process** is the whole backend: serves the SPA, runs the WebSocket,
  owns config + logging, supervises the radio via the `ScannerEngine` interface.
- **Two systemd services:** the backend (`kerchunk-kiosk.service`) and the local
  display (`kerchunk-display.service` = `cage` + Chromium kiosk → localhost). The
  display is just a local browser client; on a headless Pi it is simply not
  enabled, and the backend + admin still work fully.
- **Audio path** (must work): `rtl_fm` stdout → `aplay -D <hdmi>`, a kernel-side
  pipe Node sets up but never reads.
- **Telemetry path:** Node reads `rtl_fm` stderr, parses signal/squelch lines into
  `ScannerEngine` events (`active`, `idle`, `signal`), driving the WebSocket →
  dashboard.
- The **dashboard** (output-only) and **admin** (config) are the same SPA on
  different routes. Chromium loads the dashboard route; remote browsers load admin.

## The `ScannerEngine` interface

The one boundary that matters. Everything above it talks only to this interface
and never knows `rtl_fm` exists.

```typescript
interface ScannerEngine {
  start(config: ScanConfig): Promise<void>;  // begin scanning the channel list
  stop(): Promise<void>;                       // halt cleanly, kill child procs
  setVolume(percent: number): Promise<void>;   // 0–100, via ALSA amixer
  setMuted(muted: boolean): Promise<void>;
  readonly state: EngineState;                 // current snapshot
  on(event: EngineEvent, cb): void;            // live event stream
}

type EngineEvent =
  | 'active'   // squelch opened → a channel is live   { channel, freq, ts }
  | 'idle'     // squelch closed → back to scanning     { ts }
  | 'signal'   // periodic level update                 { dbfs, ts }
  | 'error'    // rtl_fm/aplay died, no dongle, etc.    { code, message }
  | 'status';  // engine lifecycle: starting/running/stopped

interface ScanConfig {
  channels: Channel[];        // ordered list to scan
  sampleRate: number;         // rtl_fm -s (resampled for aplay)
  squelchLevel: number;       // rtl_fm -l
  gain: number | 'auto';      // rtl_fm -g
  audioSink: string;          // ALSA device id, e.g. "hdmi:CARD=vc4hdmi0"
}

interface Channel {
  id: string;
  freq: number;               // Hz
  alphaTag: string;           // "KC0KW — Gibbs Rd"
  mode: 'fm' | 'nfm' | 'am';  // rtl_fm -M
  enabled: boolean;           // skip if false
}
```

### v1 implementation — `RtlFmEngine`

- `start()` builds the `rtl_fm` argv from `ScanConfig` — passes all enabled
  channel frequencies (`rtl_fm` accepts multiple `-f` args and squelch-scans
  across them), spawns `rtl_fm`, pipes stdout → `aplay -D <audioSink>`.
- A **stderr parser** reads `rtl_fm`'s diagnostic output (tuned-frequency line on
  squelch open, per-block signal-level info) and turns those lines into
  `active` / `idle` / `signal` events. This is the fiddliest, most
  version-dependent part and is isolated as a pure function with fixture tests.
- **Supervision:** if `rtl_fm` or `aplay` exits unexpectedly, emit `error`, then
  auto-restart with backoff. No dongle → `error` event the UI surfaces.
- `setVolume`/`setMuted` shell out to `amixer` on the HDMI control; they do **not**
  restart the radio.

When `kerchunk-rxd` (parallel) eventually exists, it is a new
`class KerchunkRxdEngine implements ScannerEngine`. The web layer, dashboard,
config, and WebSocket protocol do not change. The `active`/`idle`/`signal` model
already accommodates multiple simultaneous active channels (today one at a time;
later many).

**Known v1 limitation (accepted):** `rtl_fm`'s serial squelch-scan has the
first-syllable-clip and dwell behavior common to all serial scanners (as the
vision doc notes). The parallel engine is what fixes this later.

## Web layer (HTTP + WebSocket)

One SPA, two views, served by the Node backend. Same bundle; route determines view.

| Route | View | Audience | Input? |
|---|---|---|---|
| `/` (or `/dashboard`) | **Dashboard** — Now Playing + Activity Log | Chromium kiosk on the Pi; also viewable remotely | No (output-only) |
| `/admin` | **Web Admin** — config forms | Laptop/phone browser | Yes |

### HTTP API (admin → backend)

```
GET    /api/config            → full config (channels, scan params, audio sink)
PUT    /api/config            → replace config; triggers engine restart
GET    /api/channels          → channel list
POST   /api/channels          → add channel
PUT    /api/channels/:id      → edit channel
DELETE /api/channels/:id      → remove channel
POST   /api/scan/start|stop   → control the engine
POST   /api/audio/volume      → { percent }
POST   /api/audio/mute        → { muted }
GET    /api/audio/sinks       → enumerate available ALSA sinks (for the dropdown)
GET    /api/status            → current snapshot (one-shot; WS is the live feed)
GET    /api/logs              → recent activity log entries
```

### WebSocket (backend → all clients)

A single `/ws` endpoint broadcasts engine events live. Dashboard and any open
admin tab subscribe. Message shapes mirror the engine events:

```jsonc
{ "type": "active", "channel": {...}, "freq": 145130000, "ts": 1780434262 }
{ "type": "idle",   "ts": 1780434270 }
{ "type": "signal", "dbfs": -32, "ts": 1780434262 }
{ "type": "status", "state": "running", "ts": 1780434200 }
{ "type": "error",  "code": "NO_DONGLE", "message": "No RTL-SDR detected" }
```

### Web layer design choices

- **No auth in v1.** LAN appliance, like a Pi-hole admin or a printer page.
  Documented as a v2 item — a conscious decision, not an omission.
- **The dashboard is a pure WebSocket consumer.** It issues no commands, only
  renders the event stream + an initial `GET /api/status`. This enforces
  "output-only" at the protocol level.
- **Config changes restart the engine.** `PUT /api/config` (and channel/scan
  edits) does `engine.stop()` → `engine.start(newConfig)`. Volume/mute do **not**
  restart — they are live `amixer` calls.

## Config & persistence

A single JSON file is the source of truth. No database.

```
/var/lib/kerchunk-kiosk/config.json     ← live config (channels, scan, audio)
/var/lib/kerchunk-kiosk/config.json.bak ← last-known-good, written before each save
```

```jsonc
{
  "version": 1,
  "scan": { "sampleRate": 12000, "squelchLevel": 150, "gain": "auto", "dwellMs": 2000 },
  "audio": { "sink": "hdmi:CARD=vc4hdmi0", "volume": 70, "muted": false },
  "channels": [
    { "id": "ch_001", "freq": 145130000, "alphaTag": "KC0KW — Gibbs Rd", "mode": "nfm", "enabled": true },
    { "id": "ch_002", "freq": 146940000, "alphaTag": "WØERH",            "mode": "nfm", "enabled": true }
  ]
}
```

### `ConfigStore` behavior

- **Load on startup.** Missing file → write default config (empty channels,
  sensible scan defaults, auto-detected HDMI sink). Corrupt file (bad JSON / fails
  schema) → fall back to `.bak`; if that is also bad → defaults, and surface a
  `warning` so the admin shows "config was reset."
- **Schema validation on every load and write** via `zod` (TS-native; gives typed
  config for free). A bad `PUT /api/config` is rejected `400`; live config
  untouched.
- **Atomic writes:** write temp file → `fsync` → copy current to `.bak` → rename
  temp over `config.json`. Survives a power cut mid-write (the half-written file is
  always the temp, never the live one). This is the kiosk's SD-corruption
  mitigation.

### Activity log

- **In-memory ring buffer** (last ~500 transmissions) feeds the dashboard log
  panel and `GET /api/logs`. Cheap, no disk wear, resets on reboot — fine for a
  glanceable "what just happened" view.
- **Persistent disk logging is deferred to v2** (this is where the vision doc's
  RTC-timestamped scan log would live).

## Deployment, services & boot

### `kerchunk-kiosk.service` (Node backend)

- Runs as a dedicated unprivileged `kerchunk` user (in `audio` group for
  ALSA/HDMI, `plugdev` for the RTL-SDR USB device).
- `WorkingDirectory=/opt/kerchunk-kiosk`; state in `/var/lib/kerchunk-kiosk`.
- `Restart=on-failure` with backoff. Starts after network is up.

### `kerchunk-display.service` (local fullscreen browser)

- Launches `cage` running `chromium --kiosk --app=http://localhost:PORT/dashboard`.
- `Restart=always`. `After=kerchunk-kiosk.service`, but resilient if the backend
  is briefly down (SPA retries the WebSocket / shows a reconnecting state).
- **Optional/independent:** on a headless Pi, leave this unit disabled; backend +
  admin still work fully.

### `scripts/setup-kiosk.sh`

- Installs deps: `rtl-sdr`, `alsa-utils`, `cage`, `chromium`, `nodejs` (current
  LTS from NodeSource).
- Creates the `kerchunk` user and the `/opt/kerchunk-kiosk` +
  `/var/lib/kerchunk-kiosk` dirs with correct ownership.
- Installs the RTL-SDR udev rule (reuse the existing repo's rtl-sdr handling).
- Installs + enables both systemd units.
- Blacklists `dvb_usb_rtl28xxu` (the classic "RTL-SDR not detected" gotcha the
  repo history already addresses).

### Build/deploy model

- Dev on Mac: TS + Vite (frontend), `tsx`/`tsc` (backend).
- `npm run build` → static frontend bundle + compiled backend.
- Deploy = copy the built artifact to `/opt/kerchunk-kiosk` (rsync/scp) **or**
  `git pull` + `npm ci && npm run build` on the Pi. Both documented. No CI/OTA in
  v1 (vision-doc v2 territory).

### Boot story (what the user sees)

Power on Pi → systemd starts backend → `cage`+Chromium launches fullscreen →
dashboard shows "Starting…" → engine spawns `rtl_fm` → scanning begins, dashboard
goes live. Configure from any browser at `http://<pi-ip>:PORT/admin`.

## Project structure

Added to the existing repo alongside `docs/`, `scripts/`, `bench/`:

```
kiosk/
├── package.json
├── tsconfig.json
├── src/
│   ├── backend/
│   │   ├── index.ts              # entrypoint: wires everything, starts HTTP/WS
│   │   ├── server.ts             # HTTP routes + static SPA serving
│   │   ├── ws.ts                 # WebSocket broadcast hub
│   │   ├── engine/
│   │   │   ├── ScannerEngine.ts   # the interface + types
│   │   │   ├── RtlFmEngine.ts     # v1 implementation
│   │   │   └── stderrParser.ts    # rtl_fm stderr → events (heavily tested)
│   │   ├── audio.ts              # amixer sink/volume/mute + sink enumeration
│   │   ├── config/
│   │   │   ├── ConfigStore.ts     # load/validate/atomic-write
│   │   │   └── schema.ts          # zod schema = source of truth for types
│   │   └── activityLog.ts        # in-memory ring buffer
│   └── frontend/
│       ├── main.ts               # SPA bootstrap + router (dashboard vs admin)
│       ├── dashboard/            # Now Playing + Activity Log (output-only)
│       ├── admin/                # config forms
│       └── lib/wsClient.ts       # reconnecting WebSocket consumer
├── systemd/
│   ├── kerchunk-kiosk.service
│   └── kerchunk-display.service
└── scripts/setup-kiosk.sh
```

## Testing strategy

TDD where it counts (minimum code, verify by looping):

- **`stderrParser`** — fiddliest, highest-risk unit. Unit tests against captured
  real `rtl_fm` stderr samples (fixtures). Pure function: bytes in → events out.
  No dongle needed.
- **`ConfigStore`** — load/validate/corrupt-fallback/atomic-write tests against a
  temp dir. No hardware.
- **`RtlFmEngine`** — tested against a **fake `rtl_fm`** (tiny script emitting
  canned stderr + silence on stdout) to verify spawn/supervise/restart without an
  SDR. The real-dongle path is a manual bench step.
- **Web API** — supertest-style integration tests against the HTTP layer with a
  mock engine.
- **Frontend** — light; dashboard is mostly render-from-events. Manual
  verification on the Pi + display is the real acceptance test.
- **Whole stack on real hardware** — a documented bench protocol (like the
  existing `bench/README.md`); the true success gate.

## v1 success criteria

1. Fresh Pi 4 + HD display → run `setup-kiosk.sh` → reboot → dashboard appears
   fullscreen automatically.
2. From a laptop, open `/admin`, add 3+ real local repeater frequencies, save.
3. Scanner serially scans them; when one is active, **audio plays through the HDMI
   display** and the dashboard's "Now Playing" updates to that frequency + alpha
   tag within ~1 s.
4. The activity log fills with timestamped entries as transmissions come and go.
5. Volume/mute from the admin work live without interrupting scanning.
6. Unplug the dongle → dashboard shows a clear error; replug → it recovers.
7. Reboot → comes back up scanning the saved config, no manual steps.

## Explicitly deferred to v2

Conscious cuts, all traceable to the vision doc:

- Parallel multi-channel monitoring (`kerchunk-rxd`) — the headline feature, the
  big DSP lift. The `ScannerEngine` interface is the seam it plugs into.
- Spectrum / waterfall display.
- P25 / digital decode.
- RepeaterBook CSV import & curated presets.
- Web admin authentication.
- Persistent / RTC-timestamped disk logging.
- OTA / image-based updates.
- Multi-audio-sink switching beyond HDMI (the sink is already a config value; only
  HDMI is wired up in v1).
