# CB mode via FernSDR — design

Date: 2026-10-15 · Status: approved in chat, awaiting spec review

## Why

The operator's HF receiver (Airspy HF+ Discovery on an 80 m loop, served by
FernSDR 0.1.2 on a Pi at `192.168.1.30:8073`) receives CB far better than the
RTL-SDR scanner. CB mode switches its source to that receiver. The SDR CB path
is removed (operator decision: no fallback; offline shows offline).

Side benefit: FernSDR's waterfall watches all 40 channels at once, so CB mode
is no longer capped at one helper window (`scan.lanesPerGroup` channels).

## Receiver facts (verified 2026-10-15)

- `GET /api/status`: band `cb-radio`, 26.957–27.413 MHz, centre 27.185 MHz,
  running. `/api/health` 200. A `20m` band exists on a schedule — ignored.
- WebSocket `ws://192.168.1.30:8073/ws`, no login. 16 listeners / 32
  connections per IP; control messages < 8 kB. Never touch `/admin`.
- Audio is server-demodulated NAC (FernSDR's own MDCT codec, mono, 128-sample
  frames); no IQ, no standard codec. Byte layouts: upstream `docs/PROTOCOL.md`
  and `docs/CODEC.md` (authoritative).
- Sending `hello` with only `audio-discontinuity` (no `nac2`/`nac3`/`meter-v1`)
  and a `viewport` without `codec` makes the server send **plain NAC**, JSON
  meters and **plain WFC** rows (temporal/intra + Rice) — the smallest decoder
  surface. Bandwidth is irrelevant on the LAN.

## Architecture

```
FernSDR ──ws──► Node src/backend/fernsdr/
                  client.ts   WS session: welcome→hello→audio→tune→viewport;
                              reconnect w/ backoff+jitter, replays settings
                  nac.ts      plain-NAC decoder: header, Exp-Golomb exponents,
                              Rice coefficients, IMDCT (fold + DCT-IV), sine
                              window, overlap-add, concealment
                  wfc.ts      plain WFC row decoder (mode 0/1)
                  resample.ts server rate (e.g. 14 250 Hz) → 50 kHz s16
                  cbWatch.ts  PURE: per-row channel levels → open/close
                  cbNet.ts    orchestrator: owns client + watch, picks the
                              audible channel, tunes, emits EngineEvents,
                              writes PCM to the helper
                         │ 50 kHz s16le                │ EngineEvents
                         ▼                             ▼
   kerchunk-dsp (parked, pcmIn) → AGC → 48k → gate → limiter → ALSA + fd-3 tee
                                             server history / WS / CB stage
```

### Mode lifecycle (server.ts)

- **Enter CB:** `switchMode` retunes the live scanner helper to
  `{channels: [], pcmIn: true}` (a `retune`, never a respawn), then
  `cbNet.start(cfg)`.
- **Leave CB:** `cbNet.stop()` (closes the socket), helper retunes to the new
  mode's config with `pcmIn: false`.
- **SAME break-in from CB:** `cbNet.pause()` stops routing PCM and events but
  keeps the socket; the helper gets its ordinary `retune()` to NWR (invariant
  untouched; `breakIn` guard untouched). Revert: helper back to parked+pcmIn,
  `cbNet.resume()` re-tunes the current/next channel.
- `toScanConfig(cfg, "cb")` returns an empty channel set with `pcmIn: true`
  (no sweep, no Close Call, unchanged). `WidebandEngine.retune` must treat
  "empty channels + pcmIn" as a parked tune, NOT the release-the-SDR respawn
  path (that path stays for empty channels without pcmIn).

### FernSDR session (client.ts)

1. Receive `welcome`; send `hello` with `["audio-discontinuity"]` ∩ caps.
2. `{"type":"audio","enabled":true,"rate":12000}` (a ceiling; server may pick
   14 250 Hz for AM — honour `audio-config`, map generation→rate).
3. `{"type":"dsp","squelch":-200,"agc":"auto"}` — server squelch open; gating
   is ours.
4. `{"type":"viewport","enabled":true,"low":<band.low>,"high":<band.high>,
   "width":456,"fps":10}` — edges taken from `welcome.bands`, not hardcoded.
5. `tune` `{band, freq, mode, request_id}` on each channel change.

Handling: `state` (track `ack.tune`), `audio-config`, `meter` (JSON `dbfs` →
`signal` event, throttled like the helper's), `inactivity` → `{"type":"active"}`,
`error` (log, stay connected). Ignore chat/station/theme/rds/band-status.
Close 4001/4002: no auto-reconnect until CB mode is next entered. Other closes
and connect failures: exponential backoff with jitter, capped at
`backoffMaxMs`, replay steps 2–5. Rows/frames are decoded using **each
message's own** edges/width/rate, never the requested ones.

### Audio (nac.ts, resample.ts, cbNet.ts)

- Byte 1 flags: bit0 muted, bit2 discontinuity (reset overlap, no concealment),
  bits 4–7 generation. Bytes 2–3 seq (u16 LE). Sequence gaps → one concealed
  frame per missing frame (half amplitude, halving), keeping the clock.
- After every `tune` with id N, drop audio until a `state` with
  `ack.tune >= N` arrives, then reset decoder overlap.
- Malformed frame (read past end, coefficient > 1e7) → conceal, never use.
- Resample to 50 kHz (helper `LANE_RATE`) s16le; write to the helper's
  PCM-in fd only while a channel is audible. Server peaks are ~0.1–0.4 FS
  with AGC — the helper's speaker AGC handles level; no Node-side gain.

### Channel selection (cbWatch.ts — pure)

Input per row: `{lowHz, highHz, width, levels[]}`. For each configured channel:
`level = max(bins within ±3 kHz) − median(row)`.

- Baseline per channel: EMA learned **only while that channel is closed**, so
  steady carriers/interference are absorbed.
- Open when `level − baseline ≥ openDb` for `openRows` consecutive rows.
- Close after `hangMs` below threshold (`ssbHangMs` for LSB channels).
- Audible channel: first-open wins and holds until it closes; a **priority**
  channel opening pre-empts a non-priority one. Multiple open channels each
  emit `active`/`release` (history pairs durations); only the audible one gets
  audio and the `audible` event.
- Output: a list of transitions; cbNet maps them to EngineEvents with the
  existing `cb_N` ids, `cbLabel` names, `tags:["cb"]`, `freq`.

### Helper PCM-in (kiosk/native)

- New CLI `--pcm-in-fd N`, `--pcm-target-ms` (120), `--pcm-max-ms` (400).
  WidebandEngine always spawns the **scanner** helper with fd 4 as a pipe (so
  CB never forces a respawn); the weather helper never gets it.
- `tune` gains `pcmIn` (bool). With `pcmIn` and no channels, the speaker
  source is an external ring instead of a lane.
- New demod kind `Ext`: passthrough at the point AM/FM produce a sample in
  `SpeakerPath::process`, so external audio runs the existing AGC → 50→48k
  resample → gate fade → limiter → ALSA + tee. All `config.audio.agc*` /
  `limiter*` knobs, volume/mute and remote listening apply unchanged.
- Jitter ring: reader thread drains the fd. Playback starts after
  `pcm-target-ms` buffered; underrun → silence and re-prime; above
  `pcm-max-ms` → drop oldest. Ring running dry fades the gate like a lane
  close.

### Offline state

`/api/status` gains `cb: {connected: boolean, error: string | null}` (additive
— safe for the jeremyfuksa.com consumer; `docs/API.md` updated). The CB stage
renders "Receiver offline" through cbView's existing `error` slot; the admin
live LCD shows the same.

## Config

`config.cb` (all optional):

| key | default | meaning |
|---|---|---|
| `channels` | all 40 | watched channels (was capped at the lane count) |
| `names` | 6/9/19 | unchanged |
| `modes` | `{"38":"lsb"}` | sent to FernSDR as the tune mode |
| `priority` | `[6,9,19]` | pre-empt the audible channel |
| `ssbHangMs` | 1500 | hang for LSB channels (kept) |
| `fernsdr.url` | `ws://192.168.1.30:8073/ws` | receiver |
| `fernsdr.band` | `cb-radio` | band id |
| `fernsdr.openDb` | 10 | dB over baseline to open |
| `fernsdr.openRows` | 2 | consecutive rows to open |
| `fernsdr.hangMs` | 2000 | AM hang |
| `fernsdr.bufferMs` | 120 | helper `--pcm-target-ms` |
| `fernsdr.maxBufferMs` | 400 | helper `--pcm-max-ms` |
| `fernsdr.backoffMaxMs` | 60000 | reconnect cap |

`cb.fernsdr.*` changes apply on the next CB entry (cbNet restart); buffer
changes are helper spawn args (respawn via the existing scanChanged diff).

## Removed

- SDR CB branch of `toScanConfig`; `cbDefaultChannels` lane-window logic.
- `cb.ssbOpenDb`; `scan.nativeSsbGainDb` and `--ssb-gain-db` — old configs
  have these stripped on load (the `levelTrimDb` precedent).
- Native `SsbDemod` / `SsbLevel`, the LSB energy squelch and
  `SSB_GATE_HOLD_MS` (#298) — CB was their only user. `--ppm` and txstat
  `offsetHz` stay (general).
- `cbView` live meta `"CB only · AM · Live"` → shows the channel's mode.

## Testing

- **Decoders:** capture ~10 s of real NAC frames + WFC rows from the receiver
  into a fixture; decode the same capture with upstream
  `tools/fernsdr-probe.py` (run once, offline, `python3 -I`, never committed)
  to produce expected output; vitest asserts our decode within 1e-6.
- **cbWatch:** baseline learning only-while-closed, openRows, hang (AM vs
  LSB), priority pre-emption, channel-23 ordering.
- **cbNet / client:** fake WS server — handshake, ack-gated audio drop,
  sequence-gap concealment, 4001/4002 no-reconnect, backoff, pause/resume.
- **Native:** ring prime/underrun/overflow, `Ext` reaches the AGC, CLI flags,
  `pcmIn` tune parsing; LSB tests removed with the code.
- **Hardware:** enter CB from admin; helper PID unchanged; audio by ear on a
  live channel; CB stage screenshot; the break-in out of CB and back is covered
  by a server test (test alerts skip the real break-in, so it can't be forced
  on air) plus a manual CB → weather → CB mode round-trip watching the helper
  PID and audio; block the receiver → "Receiver offline" → recovery.
- DoD: `npm test`, `npm run test:native`, `npm run typecheck`,
  `npm run build`.
