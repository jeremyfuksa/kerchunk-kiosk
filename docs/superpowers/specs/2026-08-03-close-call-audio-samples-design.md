# Close Call audio samples — design

**Issue:** [#222 — record close call hits](https://github.com/jeremyfuksa/kerchunk-kiosk/issues/222)
**Date:** 2026-08-03

## Problem

When Close Call finds a frequency, the only way to judge whether it is worth
adding is the discovery row's **Listen** button — which retunes the live radio
to that frequency. If the frequency is quiet (usually), the operator hears
nothing and learns nothing. The moment that actually carried information — the
hit itself — is gone.

Capture a short audio sample at the moment of the hit, play it back from the
discovery row, and delete it once the discovery is triaged.

## Scope

- One clip per discovered frequency, overwritten by each new hit ("latest
  sample").
- Playable from the triage table and the discovery drawer.
- Deleted automatically when the discovery is triaged; deletable by hand.

Non-goals: recording regular channels, waveform display, multi-clip history per
frequency, editing or exporting clips.

## Capture

New module `kiosk/src/backend/ccRecorder.ts`, subscribed to the engine's PCM
tee via `engine.onAudio()` (48 kHz mono s16le, the post-limiter speaker feed).

### Trigger

Recording is gated on the engine's **`audible`** event, not the `closecall`
event.

`WidebandEngine` emits `audible` whenever speaker ownership changes, and
synthesizes a channel for Close Call lanes with id `cc_<freqHz>`
(`WidebandEngine.findChannel`, the `/^cc_(\d+)$/` branch). So:

- **Start** when an `audible` event arrives whose `channel.id` matches
  `/^cc_(\d+)$/`. The frequency is parsed straight from the id.
- **Stop** when `audible` moves to any other id (or null), or when the clip
  reaches `closeCallSampleSeconds`, whichever comes first.

This matters: the tee is the *speaker mix*, not a per-channel tap. Gating on
`audible` is what guarantees a clip contains the Close Call lane's audio and
never a neighbouring channel's traffic. Gating on the `closecall` detection
event would not — detection and speaker ownership are separate moments.

### Pre-roll

A rolling **2 s ring buffer** of raw 48 kHz PCM (`PREROLL_SECONDS`, a module
constant in `ccRecorder.ts` — a correctness detail, not a taste dial) is kept
at all times while the feature is on. The `audible` event lands slightly after
the carrier opens, so a clip that started there would clip the first syllable.
On start, the ring's contents are prepended to the clip.

The ring holds **raw** 48 kHz samples (~192 KB); decimation happens once, at
flush. Steady-state cost is a ring copy per chunk — no per-chunk arithmetic.

### Write

On stop:

1. Decimate 48 kHz → 8 kHz by averaging each run of 6 samples. A box filter is
   adequate anti-aliasing for "is this worth adding" voice triage.
2. Write a 16-bit mono 8 kHz WAV to
   `<stateDir>/cc-samples/<freqHz>.wav`, overwriting any existing clip.
   `<stateDir>` is `dirname(KERCHUNK_CONFIG)` — the same directory that holds
   `config.json` and `history.db`.

At 8 kHz mono s16 a clip costs ~16 KB/s: a 20 s clip is ~320 KB, and 30
discoveries cost ~10 MB.

### Why the filename is a frequency, not a discovery id

A frequency must hit **twice** before it earns a discovery row
(`server.ts`, `CC_FILE_AFTER`). Hit 1 is recorded before any discovery exists.
Keying the file by frequency means hit 1's clip is simply already on disk when
hit 2 files the row — no rename, no deferred write, no lost first sample. The
API maps discovery id → frequency → path.

### Guards

The recorder skips a frequency when any of these hold, mirroring the filing
path in `server.ts`:

- `config.scan.recordCloseCalls` is off (the recorder is not even subscribed)
- the frequency matches a configured channel
- the frequency is in `config.scan.lockoutHz`

## Config knobs

Added under `scan` in `kiosk/src/backend/config/schema.ts`:

| Knob | Default | Meaning |
|---|---|---|
| `recordCloseCalls` | `false` | Master switch; also gates the helper's PCM tee |
| `closeCallSampleSeconds` | `20` | Per-clip length cap |
| `closeCallSampleMaxMb` | `50` | Total clip-directory cap; oldest evicted first |

`PREROLL_SECONDS` (2) stays a constant at the top of `ccRecorder.ts`.

## Engine plumbing

The helper only builds its fd-3 PCM tee when given `--audio-fd 3`, and today
that happens only when `remoteListening` is on
(`WidebandEngine.helperArgs()`). `config.audio.remoteListening` is currently
`false` on the appliance, so there is no tee to record from.

Change: `ScanConfig` gains `recordCloseCalls`, and `helperArgs()` passes
`--audio-fd 3` when **`remoteListening || recordCloseCalls`**. Recording is
therefore independent of remote listening — enabling it does not expose
`/api/stream.wav`.

The do-not-undo invariant "the engine must always drain the helper's fd-3 audio
tee" is untouched: `spawnHelper` already drains fd 3 unconditionally.

**Cost to accept:** flipping `recordCloseCalls` is an engine restart (a helper
spawn arg changed), and once on, the helper's float→s16 tee conversion runs
continuously. That is the standing price of the feature. The recorder itself is
a memcpy per chunk plus one small file write per hit — negligible against
12-lane DSP.

## API

All routes are new. The shapes of `/api/status`, `/api/logs`, and
`/api/weather` — polled by jeremyfuksa.com — are unchanged.

- `GET /api/discoveries/:id/sample.wav` — the clip. `404` when the discovery
  has no clip, when the id is unknown, or when recording is disabled. Serves
  `Content-Type: audio/wav`, `Content-Length`, `Cache-Control: no-store` (a
  clip can be overwritten by the next hit).
- `DELETE /api/discoveries/:id/sample` — manual delete. `200 {ok:true}`;
  `404` when there is no clip.
- `GET /api/discoveries/samples` — `{ [discoveryId]: { bytes, seconds, ts } }`.
  A single `readdir` + `stat` pass, so the triage table knows which rows have a
  clip without probing each one. The admin folds this into its existing 15 s
  discoveries poll.

Clip metadata is deliberately **not** added to the discovery objects in
`config.json`: config is the operator's persisted intent, and clip presence is
derived filesystem state.

`docs/API.md` is updated with all three routes.

## Cleanup

**On triage — backend, in the config PUT handler.** Diff the incoming
`discoveries` array against the current one; for every frequency that
disappeared, delete its clip. This covers Add, Dismiss, Lockout, the drawer,
and bulk selection in one place, instead of four UI call sites that can drift.

**Manual.** `DELETE /api/discoveries/:id/sample`, surfaced as a button in the
drawer.

A **suppressed** discovery ("Repeated unidentified carrier") is still a
discovery — it stays in `config.discoveries`, so its clip is kept and remains
playable if the row is restored. It is not orphaned, but it is ordinary
eviction fodder for the disk cap like any other clip.

**Sweep.** Periodically (and after each write) the recorder:

- deletes clips whose frequency has no discovery **and** whose mtime is older
  than one hour — orphans from hits that never earned a row;
- enforces `closeCallSampleMaxMb` by deleting oldest-first.

## Admin UI

Two touch points in `kiosk/src/frontend/admin/`:

- **Triage row** — the existing icon cluster (`dListen`, `dAdd`, `dLock`,
  `dDismiss`) gains a **Play** button, rendered only when
  `/api/discoveries/samples` reports a clip for that row. Click plays the clip
  through an `<audio>` element; the icon toggles to stop while playing.
- **Discovery drawer** — a small player block: play/stop, clip duration,
  recorded-at timestamp, and **Delete sample**.

Icons come from `lucide-static` only — never hand-rolled SVG.

The drawer player is a new block rather than a rearrangement of existing
markup, so it goes through the `frontend-design` skill during implementation
per the repo's "designed, not rearranged" rule. The row button follows the
existing `iconBtn` pattern and needs no new visual design.

## Testing

**Unit** (`kiosk/test/`, no hardware):

- decimator: 48 k → 8 k averaging, including a chunk boundary that splits a
  6-sample run
- pre-roll ring: wraps correctly, yields the last 2 s in order
- WAV header: byte-exact for 8 kHz mono s16
- recorder state machine driven by synthetic `audible` events plus PCM chunks:
  starts on `cc_*`, stops on a different id, stops at the length cap, ignores
  non-`cc_*` audible spans, respects the channel/lockout guards
- disk cap: evicts oldest first; orphan sweep respects the one-hour grace

**Integration:**

- a config PUT that removes a discovery deletes its clip
- `GET .../sample.wav` 404s when recording is disabled and when no clip exists
- `GET /api/discoveries/samples` reports only clips with a matching discovery

**Hardware** (the operator verifies by ear within minutes):

- enable `recordCloseCalls`, accept the one engine restart
- wait for (or force) a Close Call hit
- play the clip from the triage table — confirm it is the Close Call traffic
  and not a neighbouring channel, and that the pre-roll caught the opening
- confirm live audio is unaffected and the box's steady-state temperature does
  not move meaningfully

## Risks

- **Restart on first enable.** Unavoidable — it is a helper spawn arg. Once on,
  no further restarts.
- **Truncated clips.** If the Close Call lane loses the speaker mid-transmission
  (priority channel, SAME break-in), the clip ends there. Correct behaviour:
  the clip only ever contains what was actually heard.
- **A busy band fills disk faster.** Bounded by `closeCallSampleMaxMb` with
  oldest-first eviction.
