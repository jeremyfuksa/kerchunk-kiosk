# Processor Efficiency Code Review

Date: 2026-06-06

Scope: static review of the wideband DSP helper, backend control plane, kiosk
dashboard/map, and admin UI. Existing hardware benchmark results were used as
the performance baseline. No live profiler was run on the deployed appliance
during this review.

## Executive Summary

The dominant processor cost is the GNU Radio wideband helper, not the Node
backend. The current helper builds a fixed 12-lane flowgraph and runs every
lane continuously, including parked lanes. Each lane also runs both FM and AM
demodulation paths, multiple moving averages, and noise/audio probes.

The source already documents approximately 2.4 to 2.5 CPU cores for 12 lanes.
A dedicated one-channel weather radio starts a second identical helper, so a
dual-radio deployment can roughly double the dominant DSP cost.

The highest-return work is:

1. Build only the number and type of DSP lanes needed by the current engine.
2. Give the dedicated weather radio a one-lane decode-only flowgraph.
3. Do not run the Close Call FFT, SAME decoder, or PCM streaming tee when those
   features are disabled.
4. Reduce continuous Chromium work by making dashboard/map rendering
   event-driven while idle.

## Findings

### 1. Critical: Every helper continuously runs 12 full demodulation lanes

References:

- `kiosk/src/backend/engine/wideband_helper.py:70`
- `kiosk/src/backend/engine/wideband_helper.py:144`
- `kiosk/src/backend/engine/wideband_helper.py:157`
- `kiosk/src/backend/engine/wideband_helper.py:175`
- `kiosk/src/backend/engine/wideband_helper.py:405`
- `kiosk/src/backend/engine/wideband_helper.py:449`
- `docs/ROADMAP.md:893`

`Helper.__init__` constructs `MAX_CHANS = 12` chains once. Parking a chain only
clears its assignment and gates its audio; it does not stop its GNU Radio
blocks. Every parked lane continues to run:

- A frequency-translating FIR at the full input sample rate.
- Slow and fast RF power calculations.
- NBFM demodulation.
- AM envelope demodulation.
- Audio-level measurement.
- FM quieting/high-pass measurement.

The repository documents about 2.4 to 2.5 CPU cores for 12 lanes. This cost is
paid even when a group contains one or two channels.

Recommendation:

- At helper spawn, pass the maximum lane count actually required by the grouped
  channel configuration, plus only the required spare/background lane.
- Build mode-specific chains. An NFM-only lane should not continuously run the
  AM path; an AM-only lane does not need FM quieting and NBFM audio blocks.
- Longer term, implement the already-documented polyphase filter-bank
  channelizer so the expensive channel-selection filter is shared.

Expected impact: very high. This directly reduces the application's largest
continuous CPU consumer.

### 2. Critical: A dedicated one-channel weather radio starts another full helper

References:

- `kiosk/src/backend/index.ts:55`
- `kiosk/src/backend/index.ts:58`
- `kiosk/src/backend/index.ts:144`
- `kiosk/src/backend/index.ts:145`
- `kiosk/src/backend/engine/wideband_helper.py:405`

When a weather-role SDR is configured, `index.ts` creates a second
`WidebandEngine` for one background NOAA channel. That helper still constructs
all 12 lanes and the other optional pipelines described below.

The weather helper uses `audioSink: "none"` and `closeCall: false`, so most of
the generic scanner graph is unnecessary. It only needs one FM demodulation
lane and the SAME decoder.

Recommendation:

- Add a dedicated decode-only helper mode, for example
  `--role weather --lanes 1 --no-close-call --no-audio-tee`.
- In that mode, omit the speaker adder/limiter, unused demodulators, spare
  lanes, Close Call FFT, and remote-listening conversion.

Expected impact: very high on dual-radio systems. It should reduce the weather
radio from roughly another full scanner helper to a small one-lane pipeline.

### 3. High: The Close Call FFT runs continuously even when Close Call is off

References:

- `kiosk/src/backend/engine/wideband_helper.py:409`
- `kiosk/src/backend/engine/wideband_helper.py:417`
- `kiosk/src/backend/engine/wideband_helper.py:438`
- `kiosk/src/backend/engine/wideband_helper.py:850`

The 2048-point window-wide FFT is always connected to the 2.4 MS/s source.
`cc_enabled` only prevents the Python-side `close_call_check`; it does not stop
GNU Radio from continuously producing FFT vectors and magnitude results.

This means the FFT also runs in monitor mode and in the dedicated weather
helper where Close Call is explicitly disabled.

Recommendation:

- Pass Close Call capability at helper startup and omit the FFT graph entirely
  when the scan configuration does not use it.
- If runtime toggling without a helper restart is required, lock the flowgraph
  and connect/disconnect the FFT branch when capability changes.

Expected impact: high, particularly for weather-only and Close-Call-disabled
deployments. Measure separately because the current benchmark does not isolate
FFT cost.

### 4. Medium: Optional PCM and SAME pipelines run when nobody consumes them

References:

- `kiosk/src/backend/engine/WidebandEngine.ts:173`
- `kiosk/src/backend/engine/WidebandEngine.ts:178`
- `kiosk/src/backend/engine/WidebandEngine.ts:196`
- `kiosk/src/backend/engine/WidebandEngine.ts:203`
- `kiosk/src/backend/engine/wideband_helper.py:375`
- `kiosk/src/backend/engine/wideband_helper.py:393`
- `kiosk/src/backend/engine/wideband_helper.py:405`

Every `WidebandEngine` passes `--audio-fd 3`. The helper continuously converts
the post-limiter audio to s16 and writes about 96 KB/s into Node. Node drains
and dispatches the chunks even when there are no remote listeners and
transcription is disabled.

Separately, if `multimon-ng` is installed, every helper starts it and feeds the
last lane's demodulated audio. Without a background weather channel, that lane
may simply feed noise to the decoder.

Recommendation:

- Enable the PCM tee only when transcription is configured or a remote listener
  exists. A listener-triggered helper command or a restart-on-first-listener
  policy would both remove the idle cost.
- Start `multimon-ng` only for a helper that has a configured SAME background
  channel or is explicitly running in weather decode mode.

Expected impact: medium. The savings are smaller than reducing channelizer
lanes, but these are unnecessary continuous costs and straightforward to
measure.

### 5. Medium: The kiosk browser performs continuous rendering while idle

References:

- `kiosk/src/backend/engine/WidebandEngine.ts:306`
- `kiosk/src/backend/engine/WidebandEngine.ts:311`
- `kiosk/src/frontend/dashboard/dashboard.ts:205`
- `kiosk/src/frontend/dashboard/dashboard.ts:242`
- `kiosk/src/frontend/dashboard/dashboard.ts:308`
- `kiosk/src/frontend/dashboard/dashboard.ts:313`
- `kiosk/src/frontend/map/map.ts:530`
- `kiosk/src/frontend/map/map.ts:580`

The engine emits signal telemetry up to four times per second. The dashboard
calls the full `paint()` function for every WebSocket event, rebuilding the
Now Playing HTML and the entire recent-log HTML even when only the meter value
changed.

The embedded Google Map also keeps an animation loop alive forever. With no
pings it wakes every 200 ms, scans the blip field and circle map, and schedules
another frame. This runs on the kiosk's Chromium process alongside GNU Radio.

Recommendation:

- Split dashboard rendering by event type. Update only the meter DOM for
  `signal`; rebuild the recent log only for `active`; repaint full status only
  on status/audible transitions.
- Stop the map animation loop when there are no live blips or pings. Restart it
  from `push`, `nofix`, or `ping`.
- Pause map animation and nonessential polling when `document.hidden` is true.

Expected impact: medium. This reduces Chromium CPU and improves thermal
headroom, especially on lower-power hardware.

### 6. Low: Admin polling continues for every route and duplicates work

References:

- `kiosk/src/frontend/admin/admin.ts:448`
- `kiosk/src/frontend/admin/admin.ts:493`
- `kiosk/src/frontend/admin/admin.ts:508`
- `kiosk/src/frontend/admin/admin.ts:548`
- `kiosk/src/frontend/admin/admin.ts:562`
- `kiosk/src/frontend/admin/admin.ts:1095`
- `kiosk/src/backend/history.ts:158`

Opening the admin page starts all route-specific timers immediately. Insights,
home tiles, alerts, system health, transcripts, and discovery polling continue
even while their route is hidden. The home tiles and Insights each execute
`/api/stats` every minute, causing duplicate synchronous SQLite aggregate work.

Recommendation:

- Start and stop route-specific refresh loops in `applyRoute`.
- Skip refreshes while the tab is hidden.
- Fetch `/api/stats` once per period and share/cache the result between home
  tiles and Insights.

Expected impact: low for the appliance as a whole, but worthwhile when the
admin remains open for long periods.

## Lower-Priority Observations

- `SystemStats` performs synchronous `/proc`, thermal-zone, and filesystem
  reads every 2.5 seconds. This is reasonable diagnostic overhead and is not a
  priority until profiling proves otherwise.
- The Python control poll runs at 50 Hz. It is justified by the audio gate
  latency target, and its assigned-chain loops are small compared with the
  continuously-running GNU Radio graph.
- SQLite writes for loudness and RF telemetry are already debounced. That is a
  good existing optimization.
- The persistent helper and runtime retuning avoid repeated SDR open/reset
  cycles. That is both processor-efficient and hardware-stability-positive.

## Recommended Implementation Order

1. Add benchmark instrumentation that reports helper CPU for 1, 2, 4, 8, and
   12 assigned channels with Close Call on/off.
2. Add helper startup options for lane count, Close Call capability, PCM tee,
   and SAME decoding.
3. Implement the one-lane dedicated weather helper mode.
4. Build mode-specific analog demodulation branches, then reassess whether a
   PFB channelizer is still necessary.
5. Make dashboard/map rendering event-driven and visibility-aware.
6. Gate and consolidate admin polling.

## Measurement Plan

For each optimization, record steady-state helper CPU, Chromium CPU, total
machine CPU, temperature, and open-to-audio latency for at least five minutes.
Use these scenarios:

| Scenario | Channels | Close Call | Weather radio | Browser |
|---|---:|---|---|---|
| Idle minimum | 1 | off | off | dashboard |
| Typical scan | current config | on | off | dashboard |
| Heavy window | 12 | on | off | dashboard |
| Dedicated weather | current config | on | on | dashboard |
| Headless baseline | current config | on | on/off | no browser |

The headless baseline separates DSP/backend cost from Chromium/map cost. The
one-channel and dedicated-weather cases will verify the largest findings before
undertaking the PFB refactor.
