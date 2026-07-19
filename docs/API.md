# HTTP/WS API

The backend (`kiosk/src/backend/server.ts`) serves everything on one port
(`PORT`, default 8080): the static frontends, a JSON API under `/api/`, and a
WebSocket event stream at `/ws`. This file is the reference for that surface.

## ⚠️ External consumer — read before changing responses

**jeremyfuksa.com polls this appliance over the Tailscale tailnet**
(`http://kiosk:8080`) for three endpoints: **`/api/status`**, **`/api/logs`**,
and **`/api/weather`**. It polls them **sequentially, never in parallel**,
because the appliance has been observed to deadlock when handling 2+
concurrent requests. Two consequences:

- **Changing the response shape of those three endpoints breaks a live
  external site.** Treat their fields as a compatibility contract — add
  fields freely, but don't rename, remove, or re-type existing ones without
  coordinating the jeremyfuksa.com side.
- **Don't "fix" the consumer into parallel polling.** The sequential polling
  on the website side is deliberate, working around the observed
  concurrent-request deadlock. (Server-side, non-GET `/api/` requests are
  serialized through a mutation chain in `server.ts`; GETs run concurrently —
  but the deadlock was observed in practice regardless, so the consumer
  stays sequential.)

## The three externally-consumed endpoints

### `GET /api/status`

What the scanner is doing right now.

```jsonc
{
  "state": "running",        // EngineState: "stopped" | "starting" | "running" | "error"
  "mode": "scan",            // "scan" | "weather" | "monitor"
  "monitor": null,           // Channel object when mode is "monitor", else null
  "scanCount": 42,           // channels the current mode actually scans (0 = standby)
  "muted": false,            // speaker mute (doesn't restart the engine, so it's polled)
  "warmed": true             // false until the engine's first warm sweep completes
}
```

### `GET /api/logs`

Recent channel activity — an array of the last ≤500 hits, **newest first**
(`ActivityLog`, `kiosk/src/backend/activityLog.ts`):

```jsonc
[
  { "freq": 462550000,       // Hz
    "alphaTag": "MURC 1",    // channel name at hit time
    "ts": 1752854400000 }    // epoch ms
]
```

### `GET /api/weather`

Current conditions from the NWS API (`kiosk/src/backend/weather.ts`), cached
~10 min. Returns `404 { "error": "no weather configured" }` when
`config.display` has no lat/lon, and `200 null` when the feed is failing and
the cache has gone stale (>2 h):

```jsonc
{
  "tempF": 91,
  "condition": "Partly Cloudy",
  "wind": "S 10 mph",
  "isDaytime": true
}
```

## Full endpoint list

Verified against the route registrations in `server.ts`. Errors are JSON
(`{ "error": "..." }`); unknown `/api/` paths 404. Non-GET requests run one
at a time (mutation chain); GETs — including the long-lived `/api/stream.wav`
— run concurrently.

### Config & channels

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/config` | Full zod-validated config object. |
| PUT | `/api/config` | Replace config. Engine restarts only if scan-relevant fields changed; lockout/discovery-only edits push `knownHz` live instead. |
| GET | `/api/channels` | Channel list. |
| POST | `/api/channels` | Add a channel (`201` + channel; `409` on frequency collision). |
| PUT | `/api/channels/:id` | Update a channel (`409` on collision, `404` unknown id). |
| DELETE | `/api/channels/:id` | Remove a channel (`204`; `404` unknown id). |
| GET | `/api/channels/duplicates` | Duplicate-frequency sets, richest entry first. |
| POST | `/api/channels/duplicates/resolve` | Delete every duplicate except each set's richest. |
| GET | `/api/weather-channel` | `{ weatherChannel: Channel \| null }`. |
| PUT | `/api/weather-channel` | Set the NWR channel; re-points the engine so SAME decode starts now. |

### Scan control & audio

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/scan/start` / `/api/scan/stop` | Start/stop the engine → `{ state }`. |
| POST | `/api/scan/skip` | Hop off the current channel (optional `{ holdoffSeconds }`). |
| POST | `/api/mode` | `{ mode: "scan" \| "weather" }` (weather requires a configured weather channel). |
| POST | `/api/monitor` | Park on one frequency: `{ freq, mode?, alphaTag? }` → monitor mode. |
| POST | `/api/monitor/stop` | Back to scanning. |
| POST | `/api/audio/volume` | `{ percent: 0–100 }` → amixer + persisted config. |
| POST | `/api/audio/mute` | `{ muted: boolean }`. |
| GET | `/api/stream.wav` | Endless 48 kHz mono s16 WAV of the live speaker feed. **Gated:** `404` unless `config.audio.remoteListening` is true (the helper only builds its audio tee when it's on). Slow clients get chunks dropped, not buffered. |

### Telemetry, history & lookups

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/system` | System stats snapshot + `safetyMode` + health verdict (`healthy`/`stressed`/`trouble`) + `coreCount`. |
| GET | `/api/status` | See above (external consumer). |
| GET | `/api/logs` | See above (external consumer). |
| GET | `/api/weather` | See above (external consumer). |
| GET | `/api/history` | Hit history; query params `since`, `until`, `freq`, `tag`, `kind`, `limit`. Labels resolved to current channel names. |
| GET | `/api/history/sites` | Transmitter sites (lat/lon/hits) with current channel names. |
| DELETE | `/api/history/alerts` | Clear all alert rows → `{ removed }` (hits/stats survive). |
| DELETE | `/api/history/alerts/:id` | Delete one alert row (`204`; `404` unknown). |
| GET | `/api/stats` | Aggregated stats since `?since` (default 24 h). |
| GET | `/api/recommendations/archive` | Channels heard once upon a time but silent for 30 days — archive candidates. |
| POST | `/api/power/estimate` | Run the CPU-budget estimator. |

### Appliance plumbing

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/kiosk/reload` | Broadcast `{ type: "reload" }` over WS — the wall page reloads itself (fresh bundle, no systemd). |
| POST | `/api/backend/restart` | `202`, then the backend exits for systemd to respawn (`503` when unavailable, e.g. tests). |
| POST | `/api/test/alert` | Fire a canned SAME alert banner for design/verification (`{ alphaTag }`; `{ "clear": true }` dismisses). |

### WebSocket `/ws`

One JSON message per event, `EngineEvent` union
(`kiosk/src/backend/engine/ScannerEngine.ts`): `active`, `audible`,
`release`, `idle`, `closecall`, `level`, `rf`, `same`, `signal`, `tuned`,
`alert`, `aircraft`, `status`, `warmup`, `reload`, `error`. Late joiners get
the last now-playing event and last non-empty aircraft snapshot replayed;
stuck clients (>512 KB buffered) get events dropped, not queued.

### Static routes

`/`, `/map`, `/wall`, and `/art` all serve `index.html` (the frontend routes
on `location.pathname`); hashed assets are immutable, HTML always
revalidates.
