# Aircraft Overlay — Design

**Date:** 2026-06-18
**Status:** Approved (design); ready for implementation plan
**Branch:** `feat/aircraft-overlay`

## Summary

Add a live aircraft overlay to the kiosk map, fed from the public
[airplanes.live](https://airplanes.live) ADS-B HTTP API. A backend poller
fetches airborne targets within a radius of the QTH every few seconds, the
server broadcasts each snapshot over the existing `/ws`, and a frontend layer
reconciles Google Maps markers imperatively on each update.

No local SDR and no DSP are involved — the data arrives over HTTP, so the
feature adds no scanner load. It is **disabled by default** behind a config
flag and costs nothing until turned on.

### Motivation and the thermal note

The original ask framed this as a way to "reduce machine strain." To be
accurate: it does **not** reduce the appliance's dominant load — the 12-lane
wideband DSP scanner is at the software ceiling and is unaffected by a network
overlay. What this feature does is add a useful map layer *cheaply*, by pulling
positions from a network feed rather than standing up a local 1090 MHz decoder
(which would cost real CPU/SDR resources). "Use the public feed instead of
decoding locally" is the genuine efficiency win.

The map's render path is deliberately thermal-conscious: it idle-suspends its
animation loop on quiet bands. Aircraft are continuously present and moving, so
a *smoothly animated* overlay would defeat idle-suspend and run rAF 24/7. We
avoid that by **snapping** markers to new positions on each poll tick instead of
interpolating. Markers update imperatively via the Google Maps marker API — they
do **not** ride the blip rAF loop — so added cost is bounded to one reconcile per
poll interval (~5s), regardless of how busy the sky is.

## Decisions (from brainstorming)

| Decision | Choice |
|----------|--------|
| Scope | All aircraft within radius (full ambient situational map) |
| Per-plane detail | Heading-rotated icon + callsign label |
| Refresh behavior | Snap on poll, then re-suspend (no smooth interpolation) |
| Coverage radius | ~75 km (40 nm), config-overridable |
| Ground traffic | Airborne only (drop on-ground targets) |
| Data source | airplanes.live network feed (no local SDR) |

## Architecture

```
airplanes.live  /v2/point/{lat}/{lon}/{40nm}
        │  HTTP poll, every pollIntervalMs (default 5s)
        ▼
   AircraftFeed            (backend, src/backend/aircraft.ts)
        │  onUpdate(targets)        ← subscribed in server.ts (DI)
        ▼
   WsHub.broadcast({ type:"aircraft", targets, ts })
        │  /ws
        ▼
   AircraftLayer           (frontend, src/frontend/map/aircraft.ts)
        │  upsert / move / remove markers keyed by hex
        ▼
   Google Maps markers on the kiosk map (display-only)
```

The feed is constructed in `index.ts` only when `config.aircraft.enabled` is
true, then passed to `createServer` via `ServerDeps`. The server owns its
lifecycle (start on boot, stop on close) and wires its updates to the WS hub —
keeping the broadcast path inside the unit covered by server tests.

## Components

### Backend — `AircraftFeed` (`src/backend/aircraft.ts`)

Follows the `BusinessGuess` provider precedent: an options object with an
injectable `fetcher` for tests, defaulting to global `fetch`.

```ts
export interface AircraftTarget {
  hex: string;           // ICAO 24-bit address — stable identity for reconcile
  callsign: string;      // flight or registration, trimmed
  lat: number;
  lon: number;
  heading: number | null; // degrees true (from `track`); null if absent
}

export interface AircraftFeedOpts {
  home: { lat: number; lon: number };
  radiusKm?: number;        // default 75
  pollIntervalMs?: number;  // default 5000
  maxTargets?: number;      // default 60
  url?: string;             // default http://api.airplanes.live/v2/point
  fetcher?: typeof fetch;   // injected in tests
}

export class AircraftFeed {
  constructor(opts: AircraftFeedOpts);
  onUpdate(cb: (targets: AircraftTarget[]) => void): void;
  start(): void;
  stop(): void;
}
```

Behavior:

- **Endpoint:** `GET {url}/{lat}/{lon}/{radiusNm}` where `radiusNm =
  round(radiusKm / 1.852)`. Parse the `ac[]` array from the JSON body.
- **Airborne filter:** drop any target whose `alt_baro === "ground"`.
- **Distance cap:** compute Haversine distance from QTH (reuse the formula
  already present in `businessGuess.ts`), sort ascending, keep nearest
  `maxTargets`.
- **Mapping:** `hex` ← `hex`; `callsign` ← `flight` (fallback `r`), trimmed;
  `lat`/`lon` direct; `heading` ← `track` (null if missing).
- **Failure handling:** on fetch/parse error, log **once** per error streak and
  retain the last good snapshot for a staleness window (2× `pollIntervalMs`,
  ~10s). After the window with no success, emit an empty snapshot so stale
  planes clear from the map. Consecutive errors widen the effective interval
  (simple backoff) rather than permanently disabling the feed — unlike
  `BusinessGuess`, this is a transient public feed with no auth latch.
- **Rate limit:** the 5s default poll is well under airplanes.live's documented
  1 request/second ceiling.
- **No persistent cache:** the data is live; nothing is written to disk.

### Server wiring (`server.ts`, `index.ts`)

- `ServerDeps` gains `aircraftFeed?: AircraftFeed`.
- In `createServer`, if `deps.aircraftFeed` is present:
  `deps.aircraftFeed.onUpdate(targets => deps.wsHub.broadcast({ type:
  "aircraft", targets, ts }))`, then `start()` it; `stop()` on server close.
- `index.ts` constructs the feed from config when `config.aircraft?.enabled`,
  drawing `home` from `config.display.weatherLat/weatherLon` (the same QTH
  source `BusinessGuess` uses — no new lat/lon field), else passes nothing.

### WebSocket contract (`ScannerEngine.ts`, `ws.ts`)

- Extend the `EngineEvent` union:
  ```ts
  | { type: "aircraft"; targets: AircraftTarget[]; ts: number }
  ```
- **Reconnect replay:** `WsHub` already replays the last `active`/`audible`
  events to a reconnecting client. Add the last `aircraft` event to that replay
  set so a reconnecting kiosk renders planes immediately instead of waiting up
  to one poll interval.

### Config schema (`src/backend/config/schema.ts`)

A new optional, off-by-default block (matches the per-domain optional-block
style of `display`, `lookup`, `alerts`):

```ts
aircraft: z.object({
  enabled: z.boolean().default(false),
  radiusKm: z.number().positive().default(75),
  pollIntervalMs: z.number().int().positive().default(5000),
  maxTargets: z.number().int().positive().default(60),
  url: z.string().url().default("http://api.airplanes.live/v2/point"),
}).optional()
```

The existing `radios` role `"adsb"` (for a *local* SDR) is intentionally not
used by this feature; the network feed keeps it off-SDR.

### Frontend — `AircraftLayer` (`src/frontend/map/aircraft.ts`)

- Holds a `Map<hex, marker>` of live aircraft markers.
- On each `aircraft` WS event (full-snapshot reconcile): move existing markers
  by `hex`, add markers for new `hex`es, remove markers whose `hex` is absent
  from the snapshot. An empty/stale snapshot clears the layer.
- **Icon:** a heading-rotated plane glyph (SVG), rendered in a color distinct
  from the service-colored site pins and Close-Call blips so radio activity
  stays visually dominant. The callsign is shown as the marker label.
- **Display-only:** the kiosk map mounts with `interactive: false`; markers
  carry no click/gesture handlers.
- Markers have **no expiry timer** (unlike the 60s blip decay) — each poll is
  authoritative, so presence is driven entirely by the feed.
- Hooks into the existing WS event dispatch in `map.ts` / `dashboard.ts`. Marker
  updates are imperative and independent of the blip `idleLoop`, so they add no
  sustained per-frame work.

## Data flow

1. `AircraftFeed.start()` schedules a poll every `pollIntervalMs`.
2. Each poll fetches `/v2/point/...`, filters to airborne, caps to nearest
   `maxTargets`, maps to `AircraftTarget[]`, and invokes `onUpdate`.
3. The server broadcasts `{ type:"aircraft", targets, ts }` to all WS clients
   and stashes it for reconnect replay.
4. Each frontend `AircraftLayer` reconciles its marker set against the snapshot
   and repaints once.

## Error handling

| Failure | Behavior |
|---------|----------|
| Network/timeout error | Log once per streak; retain last snapshot ≤10s, then emit empty; back off poll interval |
| Malformed JSON | Skip the tick; treat as a transient error |
| Feature disabled | No feed constructed; no WS events; zero cost |
| Frontend receives empty snapshot | Clear all aircraft markers |
| WS reconnect | Last `aircraft` event replayed so the map isn't blank |

## Testing

- `test/aircraft.test.ts` with an injected fake `fetcher` returning canned
  airplanes.live JSON:
  - callsign trimming and `flight`→`r` fallback
  - heading mapping (`track`, null when absent)
  - **airborne filter drops `alt_baro:"ground"`**
  - distance cap keeps the nearest `maxTargets`
  - `onUpdate` fires with the parsed targets
  - error path: retain-then-clear after the staleness window
- Server-level (in the `api.test.ts` style): inject a fake feed via
  `ServerDeps`, fire an update, assert `WsHub` broadcasts the `aircraft` event.
- All tests run under the existing `FakeEngine` setup — no hardware or live
  network needed.

## Files

**New**
- `src/backend/aircraft.ts` — `AircraftFeed` poller + `AircraftTarget`
- `src/frontend/map/aircraft.ts` — `AircraftLayer` marker reconciler
- `test/aircraft.test.ts` — poller/parser/filter tests

**Edited**
- `src/backend/engine/ScannerEngine.ts` — `EngineEvent` union + `AircraftTarget` export
- `src/backend/server.ts` — `ServerDeps.aircraftFeed` + subscribe/lifecycle
- `src/backend/index.ts` — construct feed from config
- `src/backend/config/schema.ts` — `aircraft` config block
- `src/backend/ws.ts` — replay last `aircraft` event on reconnect
- `src/frontend/map/map.ts` / `dashboard.ts` — dispatch `aircraft` events to the layer
- map CSS — minor styling for the aircraft icon/label

## Out of scope (YAGNI)

- Local ADS-B decode via the `"adsb"` SDR role.
- Per-aircraft altitude/type labels, trails, or tap-for-detail (kiosk is
  non-interactive; chosen detail level is icon + callsign).
- Highlighting "interesting" aircraft (military / emergency squawks). Could be a
  follow-up; not in this pass.
- Feeding airplanes.live to earn API access — the unauthenticated
  non-commercial endpoint is sufficient.

## Licensing note

All the free public ADS-B tiers (airplanes.live, adsb.fi/lol, OpenSky) are
**non-commercial use only**. This kiosk is a personal, non-monetized wall
display, which fits those terms. If the display ever becomes commercial/
customer-facing, the data source licensing must be revisited.
