# Weather Channel + Scan ⇄ Weather-Only Mode — Design

**Date:** 2026-06-03
**Status:** Approved (pending spec review)

## Goal

Designate one channel as the **weather channel**, stored separately from the
scan list, and add a runtime **scan ⇄ weather-only** mode toggle. In weather-only
mode the engine holds the weather channel with audio playing continuously
instead of scanning. Controlled from the admin UI and an API.

## Context / constraints (verified in code)

- Channels are a flat `config.channels` array; each has `id/freq/alphaTag/mode/
  enabled`. The engine scans across the `enabled` ones.
- `RtlFmEngine` writes rtl_fm audio to the sink **unconditionally** on every
  chunk (`RtlFmEngine.ts:201-204`). The squelch detector only drives hopping and
  active/idle events — NOT whether audio plays.
- With a single channel, `startHopTimer` early-returns
  (`RtlFmEngine.ts:238: if (this.enabled.length <= 1) return`), so a lone channel
  is held and its audio streams continuously. **Weather-only mode therefore needs
  no engine internals change** — it is just "run the engine with a channel set of
  exactly the weather channel."
- The server already restarts the engine on config changes via
  `engine.stop()` + `engine.start(toScanConfig(config))` (`server.ts:55-58`).

## Decisions

| Question | Decision |
|---|---|
| Weather channel storage | **Dedicated `weatherChannel` in config**, separate from `channels[]` |
| Mode | Runtime `"scan" \| "weather"` toggle |
| Mode persistence | **Not persisted — always boots into scan** (never stuck in weather after a crash) |
| Weather-only behavior | **Hold the weather channel, audio always on**, no squelch gating, no hopping |
| Control | **Admin UI toggle + API**; dashboard shows current mode |

## Architecture

The mode is expressed entirely as **which channel set the engine runs** — no
new engine behavior:

```
mode = "scan"     → engine.start({ channels: config.channels, ... })   (today)
mode = "weather"  → engine.start({ channels: [weatherChannel], ... })  (lone, held, audio on)
```

```
Admin toggle ──POST /api/mode {mode}──► server: set runtime mode
                                          → engine.stop()
                                          → engine.start(toScanConfig(config, mode))
Admin form ──PUT /api/weather-channel──► server: validate, assign id, persist config
GET /api/status ─────────────────────► { state, mode, config }  → dashboard badge
```

## Components

### 1. Data model — `src/backend/config/schema.ts`
Add an optional weather channel reusing the existing channel shape:
```ts
// inside configSchema
weatherChannel: channelSchema.optional(),
```
- `defaultConfig()` leaves `weatherChannel` undefined.
- No change to `channelSchema` itself.
- Existing configs (no `weatherChannel`) remain valid (optional).

### 2. Mode state — `src/backend/server.ts`
- A module-level runtime `let mode: "scan" | "weather" = "scan"`. Not read from
  or written to config — always starts `"scan"`.
- `toScanConfig(cfg, mode)` gains the mode arg and selects the channel list:
  - `"scan"` → `cfg.channels`
  - `"weather"` → `cfg.weatherChannel ? [{ ...cfg.weatherChannel, enabled: true }] : []`
    (force `enabled: true` so the held channel always runs; empty list if unset,
    but the API guard below prevents entering weather mode with no channel).
- All existing `toScanConfig(config)` call sites pass the current `mode`.

### 3. API — `src/backend/server.ts`
- `GET /api/weather-channel` → `200 { weatherChannel: config.weatherChannel ?? null }`.
- `PUT /api/weather-channel` → body validated by `channelSchema.omit({ id: true })`;
  server assigns `id` (`wx_${randomUUID().slice(0,8)}`); sets
  `config.weatherChannel`, `configStore.save(config)`; `200 { weatherChannel }`.
  Invalid body → `400`.
- `POST /api/mode` → body `{ mode: "scan" | "weather" }` (validate the enum).
  - `weather` with no `config.weatherChannel` → `400 { error: "no weather channel configured" }`, mode unchanged.
  - else: set runtime `mode`, `await engine.stop()`,
    `await engine.start(toScanConfig(config, mode))`; `200 { mode, state: engine.state }`.
- `GET /api/status` → extend to `{ state: engine.state, mode, config }`.

### 4. UI — `src/frontend/admin/admin.ts` + `dashboard/dashboard.ts` + `lib/api.ts`
- `lib/api.ts`: `getStatus` already exists — widen its return type from
  `{ state: string; config: Config }` to `{ state: string; mode: "scan" |
  "weather"; config: Config }`. Add `setMode(mode)`, `getWeatherChannel()`,
  `setWeatherChannel(c)`.
- **Admin**: a "Weather" section — inputs for weather-channel freq (MHz)/alphaTag/
  mode + Save (calls `PUT /api/weather-channel`), and a scan ⇄ weather-only toggle
  (calls `POST /api/mode`). Reflects current mode from `GET /api/status`.
  The MHz→Hz conversion reuses the existing `mhzToHz` helper.
- **Dashboard**: show a small `WEATHER` badge when `status.mode === "weather"`
  (the dashboard already fetches status / consumes WS). Mode is read on load via
  `GET /api/status`; no new WS event type required.

## Error handling
- Enter weather mode with no weather channel → `400`, mode and engine unchanged.
- Weather channel validated like any channel (positive int freq, mode enum).
- `POST /api/mode` with an invalid `mode` value → `400`.
- Engine start/stop failures surface through existing `error` engine events.

## Testing
- **schema.test**: `weatherChannel` is optional (config without it parses);
  a valid weatherChannel round-trips; bad freq/mode rejected.
- **toScanConfig** (new unit coverage in an api/server test): returns
  `cfg.channels` for `"scan"`; returns `[{...weatherChannel, enabled:true}]` for
  `"weather"`; returns `[]` when weather mode + no weather channel.
- **api.test** (using the existing fake engine):
  - `PUT /api/weather-channel` persists and assigns an id.
  - `POST /api/mode {weather}` with a weather channel set → engine restarted with
    a single-channel set; response `{ mode: "weather", state }`.
  - `POST /api/mode {weather}` with NO weather channel → `400`, engine not restarted.
  - `POST /api/mode {scan}` → engine restarted with `config.channels`.
  - `GET /api/status` includes `mode`.
- **adminForm.test**: weather-channel form maps MHz→Hz and builds a valid
  `Omit<Channel,"id">` (reuse existing `formToChannel`/`mhzToHz` patterns).

## Out of scope
- Persisting the mode (deliberately always boots to scan).
- Physical/GPIO button control (separate future feature).
- Multiple weather channels.
- Migrating the live Pi config's existing NOAA channel into the new slot
  (operator sets it via the admin once shipped).
