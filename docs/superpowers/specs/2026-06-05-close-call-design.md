# Close Call — Design Spec

**Date:** 2026-06-05
**Status:** Decided with operator; implementing immediately.

## What it is

Uniden-style nearby-transmission discovery: when strong RF appears in the
currently tuned window on a frequency that is NOT a configured channel, the
kiosk (a) plays it immediately, preempting non-priority audio, and (b) adds it
to the channel list **disabled** for operator review.

Key insight: a hardware scanner must sweep to do this. The wideband engine
already captures a 2.4 MHz window continuously — Close Call is an FFT over
samples we are already holding, plus a spare channelizer lane to listen.

## Operator decisions (settled)

| Question | Decision |
|---|---|
| Audio on discovery | **Preempt** like a priority channel (Uniden behavior) |
| Threshold | **Eager** — default 15 dB over the window noise floor, tunable |
| Disposition | **Auto-add as a channel, disabled** — operator enables/deletes in the table |

## Architecture

- **Detection (helper):** 2048-bin FFT over the full window, polled ~5 Hz from
  the existing poll loop. Noise floor = median bin power (robust). A peak
  ≥ `closeCallDb` over the floor, sustained 2 consecutive polls, rounded to
  the 12.5 kHz raster, fires a discovery. Excluded: ±2% of bins around DC
  (RTL center spike), outer 10% (filter rolloff), and ±12.5 kHz around every
  KNOWN frequency (all configured channels — enabled or not — sent in the
  tune command as `knownHz`, plus a 5-minute in-helper cooldown per fired
  frequency).
- **Listen (helper):** on fire, a PARKED lane is assigned `cc_<freqHz>` with
  priority=true. It flows through the normal squelch/leveler/fade path —
  energy is present, so it opens and preempts. When it closes, the lane is
  parked again. No free lane → event only, no audio.
- **Events:** helper emits `{"ev":"closecall","freqHz":N}`; the engine emits a
  `closecall` EngineEvent and synthesizes a Channel (`alphaTag: "CLOSE CALL"`)
  for the lane's open/audible events so the dashboard banner and Recent log
  work unchanged.
- **Persistence (server):** on the engine's closecall event the server adds
  `{ id: cc_*, freq, alphaTag: "Close Call <MHz>", mode: nfm, enabled: false }`
  to config and saves WITHOUT an engine restart (a disabled channel doesn't
  affect scanning, and a restart would kill the live discovery audio).
  Duplicate frequencies are never re-added.
- **Config:** `scan.closeCall` (bool, default ON for the wideband engine),
  `scan.closeCallDb` (default 15). Both in the admin Scan-tuning section.

## Scope

- Phase 1 (this): discoveries within the currently tuned window — finds
  activity NEAR programmed channels (new WoF/GMRS/business traffic).
- Phase 2 (explicitly deferred): dedicated sweep mode hunting across whole
  bands when idle.
