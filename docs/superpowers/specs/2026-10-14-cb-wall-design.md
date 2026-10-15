# CB wall: the dial

Status: implemented (PR pending).
Depends on CB mode (PR #296: `POST /api/mode {mode:"cb"}`, `config.cb.channels`).

## Why

CB mode makes the scanner listen only to CB. The kiosk wall is still the map,
and CB hits never reach the map (no location; `isSilentHit`/`nofix` skip the
`cb` tag). So in CB mode the wall shows a map with nothing on it and a corner
pill that says "CB only". The map is irrelevant to CB. The wall needs its own
layout, and that layout should answer two questions at a glance from across
the room: **which channel is talking**, and **where on the band has there been
activity**.

The operator listens for three channels: **6 "Super Bowl", 9 "Emergency",
19 "Highway"**. Everything else is bonus.

## Layout (picked: "A · The dial")

Mockups: `.superpowers/brainstorm/133633-1792018833/content/cb-layout.html`
(the three options; A picked) and `cb-dial-states.html` (live vs idle).

```
┌───────────────────────────────────────────────────────────────┐
│ CB MODE                                            5:43 PM    │
│ ┌─────────────────────────────────┐            63° · Wed …    │
│ │ CB only · AM · Live     −41 dB  │                           │
│ │ 19                              │    HEARD ON CB            │
│ │ Highway            27.185 MHz   │    CB 19 · Highway   now  │
│ │ ▮▮▮▮▮▮▮▮▯▯▯▯                    │    CB 9 · Emergency  5:39 │
│ └─────────────────────────────────┘    CB 6 · Super Bowl 5:30 │
│ ┌───────────────────────────────────────────────────────────┐ │
│ │ ╷ ╷ ╷╷ ┃ ╷  ┃ ╷ ╷ ╷  ╷ ╷ ╷ ╷  ╷ ╷ ║ ╷ ╷ ╷╷ ╷╷ ╷ ╷ ╷ ╷ ┊ ┊ ┊ │ │
│ │ 1    5 6   9 10        15  19 20      25      30   35   40 │ │
│ └───────────────────────────────────────────────────────────┘ │
└───────────────────────────────────────────────────────────────┘
```

- **Readout (top left, the wall-size LCD well, ~52% wide).**
  - *Live:* meta `CB only · AM · Live` plus the signal in dB on the right;
    the channel number at display size in glass teal with glow; name and
    frequency; the 12-segment meter.
  - *Idle (the common state):* the last-heard channel stays up, dimmed
    (`--kc-dim` number with no glow, muted meta). Meta reads
    `CB only · Listening on N channels` with `Last heard 5:39 PM` on the right.
    The meter is all-off.
  - *Never heard (fresh page, empty history):* `Listening on N channels`,
    with no number.
  - *Error:* the same error state and wording the corner glass uses today
    (`friendlyError`, coral meta).
- **Dial (bottom, full width, in a well).** One tick per channel at **true
  frequency spacing**, so 23 sits between 25 and 26.
  - 6, 9 and 19 are always tall and labelled.
  - Other labels: 1, 5, 10, 15 … 40, plus any channel at fade level ≥ 3.
  - Channels outside `config.cb.channels` are drawn hollow (not listened to).
  - A heard channel's tick lights in glass teal and steps down through
    **4 levels** (heard < 2, < 10, < 20, < 30 min, then plain).
  - A hay-coloured **needle** marks the live channel, only while it's live.
- **"Heard on CB" log (right).** The last `logRows` transmissions:
  `CB 19 · Highway`, then the time and duration. The live row is teal and
  reads `now`.
- **Shared, unchanged:** clock and weather (top right), the machine-warning
  pill, and the alert banner. A small `CB MODE` tag at top left says why the
  map is gone.

## Behaviour

### Mode switch: a stage inside the existing wall page (approach 1)

- `dashboard.ts` already re-reads `/api/status` on every engine `status` event.
  When `mode === "cb"`, it adds `.cbStage` to `.dash` and mounts the dial
  view. On any other mode it removes `.cbStage`. No page reload.
- `.cbStage` hides `#mapBase` (`display:none`), the corner (pill/glass) and
  the Recent aside, and shows `#cbStage`.
- **Map pause.** `mountActivityMap` returns a handle with `pause()` and
  `resume()`. This is reversible and separate from the glass's give-up `off`
  state. While paused:
  - `glass.poke()` and `redrawAt()` do nothing, and the smoke step tick stops;
  - the radar and lightning polls and `checkStale` are skipped;
  - live WS events still update the in-memory glass state (cheap), so resume
    shows a correct map.

  `resume()` triggers one redraw and one radar poll. With no map (no key, or
  the mount failed), the handle's methods do nothing.
- **SAME break-in:** the mode becomes `weather`, so `.cbStage` comes off and
  the normal wall and storm card take over. When it returns to CB, the stage
  comes back.
- **Page load in CB mode:** `.cbStage` is applied on the first status poll.
  The map mounts but starts paused.

### Data

- **On entering CB (and on load in CB):** one
  `GET /api/history?tag=cb&since=<now − 24 h>&limit=200` (24 h, not the fade window: the log rows can predate it),
  through the dashboard's sequential poller (never parallel: the appliance
  deadlocks on concurrent requests). It seeds each channel's last-heard time,
  the readout's last-heard channel and the log. If it fails, the dial starts
  empty and fills from live events; nothing shown.
- **Live, from the existing WS feed** (only `cb_*` channel ids count):
  - `active` / `audible`: sets the live channel, sets its last-heard time to
    now (level 4), shows the needle;
  - `signal`: meter and dB (the existing `segmentsLit` / `dbText` helpers);
  - `release` / `idle`: clears the live channel; the readout goes idle on the
    last-heard channel; a log row is added with its duration;
  - engine `error`: the readout's error state.
- **Fade steps:** one shared `stepTickMs` interval recomputes every channel's
  fade level and repaints **only if** some level changed. The interval runs
  only while `.cbStage` is on.

### Pure logic: `src/frontend/dashboard/cbDial.ts`

- `dialX(freqHz): number` returns 0–1 across the full band (26.965–27.405
  with a small pad at each end).
- `tickStep(lastHeardTs | undefined, now, fadeStepsMin): 0|1|2|3|4`.
- `cbView(state, now, opts): CbView` builds the readout (state, meta, number,
  name, freq, right-hand meta), the tick list (`{n, x, core, monitored, step,
  label}`), the needle position and the log rows. It's a pure function, and
  the painter only writes DOM when the view's key changes (the corner's model).

Channel numbers, frequencies and names stay in the backend `config/cb.ts`.
The frontend imports the table, as it already does for `family.ts`.

## Knobs

| Knob | Default | Notes |
|---|---|---|
| `config.cb.names` | `{6:"Super Bowl", 9:"Emergency", 19:"Highway"}` | Number → name. Used by the dial, and by the channel `alphaTag` (`CB 19 · Highway`), so the admin LCD and history get it too. |
| `config.display.cb.fadeStepsMin` | `[2, 10, 20, 30]` | Minutes at which a tick drops a level; 4 ascending entries. |
| `config.display.cb.stepTickMs` | `60000` | Fade recompute cadence (the heat knob). |
| `config.display.cb.logRows` | `5` | Rows in "Heard on CB". |

`config.cb.channels` (PR #296) still picks which channels are monitored.
The dial draws the rest hollow.

## Heat

The box runs about 1 °C under its 90 °C trip, so heat is a design input:

- No standing animation in CB mode. Paint happens only on CB events and on
  the `stepTickMs` tick. The needle and meter move only on `signal` events
  during a live transmission, as the corner glass does today. No CSS
  transitions longer than the existing grow/release timings, and no
  `backdrop-filter`.
- With the map paused, the CB wall should run **cooler** than the scan wall.
- **Thermal A/B before the PR:** 15 min on the scan wall vs 15 min in CB mode,
  idle, comparing package temperature (`sensors`) and chromium CPU. The
  numbers go in the PR as measured.

## Testing

- **Vitest (headless):**
  - `dialX`: band ends, monotonic in frequency, 23 between 25 and 26.
  - `tickStep`: each threshold boundary, undefined last-heard → 0.
  - `cbView`: live / idle / never-heard / error; names; hollow ticks for
    unmonitored channels; label rule; log order and the `now` row.
  - Map handle: the paused glass ignores poke/redrawAt and the radar poll is
    skipped; resume redraws once.
  - Schema: `cb.names` (1–40 keys) and `display.cb` (4 ascending steps; tick
    ≥ 5000 ms).
  - `cbChannels` uses `cb.names` in `alphaTag`.
  - Dashboard: `mode:"cb"` status applies `.cbStage`; `scan` removes it.
- **On the wall (no input device; drive server-side):**
  - `POST /api/test/tx` gains a `cb_<n>` channel id (synthetic CB transmission
    over the WS only, like the existing preview).
  - A cycle script: enter CB → tx on 19 → release → tx on 9 → idle, with
    `grim` captures of each.
  - The thermal A/B above.
  - By ear if real CB traffic shows up.

## Out of scope

- A third SDR for always-on CB (operator: only if CB gets busy).
- SSB demodulation for channels 36–40.
- Any CB presence on the scan wall or map.
