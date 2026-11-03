# HF mode proofs, 2026-11-02

Measured on the kiosk (i7-4770HQ) against an Airspy HF+ Discovery on an 80 m loop, served by SpyServer
v2.0.1922 on a Pi at `192.168.1.30:5555`. The kiosk reaches the Pi over Wi-Fi (5785 MHz, −70 dBm, 117 Mbit/s).
Helper: `kerchunk-dsp --spyserver` at commit `5d1e760`, digital gain 24 unless noted (the default is now 32). Runs were daytime into
evening local time, one afternoon only. Driver scripts were throwaway and are not in the repo.

## Stream

Gap probe, no DSP, from the kiosk, 120 s with a retune every 21 s:

| | |
| --- | --- |
| Throughput | 12.3 Mbit/s steady (12.2 average) |
| Gaps over 0.25 s | 1 (0.32 s, at startup) |
| Ping to the Pi | 240 sent, 0% loss, RTT 1.1 / 4.7 / 171.9 ms min/avg/max |

## Gain

Default gain leaves the 8-bit stream nearly empty, 7350 kHz window, gain index 5:

| Format, digital gain | RMS | Distinct u8 values |
| --- | --- | --- |
| s16, none | −63.7 dBFS | n/a |
| u8, 0 | −54.4 dBFS | 9 |
| u8, 16 | −46.1 dBFS | 7 |
| u8, 24 | −38.7 dBFS | 25 |
| u8, 32 | −32.5 dBFS | 31 |

At default the helper's level sat at −45.1 dB. At 32 it moved (−45.9 to −30.4 dB). The 9650 kHz window was
−39.7 dBFS on s16, about 24 dB above 7350 kHz. Gain index changes level by roughly 6 dB per step (0: −96.7,
5: −66.1, 8: −48.6 dBFS on s16). Digital gain is about 1 dB per step near the top of this range.

## Proof A: measuring and listening together

60 minutes, 13 windows from 120 m to 13 m at 60 s each, strongest station not played in 30 minutes on the
speaker, digital gain 24.

| | |
| --- | --- |
| Helper exits | 0 |
| Dropped IQ samples | 0 |
| Helper CPU | 27.0% of a core mean, 29.1% max |
| Package temperature | 68 °C start, 52 °C mean, 49 °C at end |
| Distinct raster channels logged | 157 |
| Carriers per visit | 11.0 at 7350 kHz, 13.8 at 9650 kHz, 0 at 21650 kHz |
| Strongest carrier | +60.6 dB at 9650 kHz window, floor stayed −14.9 |
| Squelch | Open in 94 of 179 `txstat` reports |
| Speaker underrun | Usually 100–400 ms per minute, up to 9.6 s |

**The temperature comparison is not a fair one against map mode.** The service was stopped, so the wall had no
data to draw and the weather helper (about 10% of a core) was not running. 52 °C shows the helper alone isn't
hot. It does not show HF mode runs cooler than map mode. The thermal comparison below settles it.

Result: **partial.** Stream stability and listening with measuring at once pass. Still open:

- Audio quality has not been judged by ear.
- Peak temperature has no map-mode baseline to compare against, as above.
- The up to 9.6 s per minute of underrun is unexplained. Part of it may be retune discards and bursts (see below).
- Survey carriers were not spot-checked by hand beyond WWV.

One earlier survey run, before this soak, exited 3 with `SDR stalled (no samples for 2.0 s)` about 30 s in. It
did not recur in reruns of 63 s and 40 s or in this hour. Cause unknown.

## Does 8-bit lose stations?

Same windows and survey rule, 4 s captures taken in turn, around 17:30 local. "Missed" is a 16-bit carrier with no
8-bit carrier within 5 kHz. Captures aren't simultaneous, so fading accounts for some differences.

| Window kHz | s16 floor, carriers | u8 at 24: floor, carriers, missed | u8 at 32: floor, carriers, missed |
| --- | --- | --- | --- |
| 2400 | −43.1, 2 | −17.1, 2, 0 | −9.9, 2, 0 |
| 4900 | −45.2, 3 | −17.2, 3, 0 | −13.5, 3, 0 |
| 6050 | −39.2, 7 | −13.5, 6, 1 | −6.2, 7, 1 |
| 7350 | −40.4, 13 | −14.6, 12, 2 | −7.3, 15, 2 |
| 9650 | −42.9, 18 | −16.2, 15, 3 | −10.6, 21, 0 |
| 11850 | −41.5, 9 | −15.7, 9, 0 | −9.0, 9, 0 |
| 15300 | −45.8, 4 | −17.1, 3, 1 | −12.9, 5, 0 |

Clipping was 0.000% in every window at both gains. Floors rise with gain, so antenna noise rather than
quantization sets them at 32. Every missed carrier was within 6 dB of the 10 dB threshold except 15000 kHz at 24
(+15.7, WWV) and 9440 kHz at 24 (+16.2). **8-bit stands, with default gain raised to 32.** Not tested after dark,
when the strongest stations could clip: re-measure in a night run.

## Retune marker

SpyServer sends no confirmation after a retune, and accepted an out-of-range 40 kHz with no message. But IQ frames
echo the digital gain in their flags. Tuning away from WWV 10 MHz (+52 dB) and back, six trials, carrier level per
frame around the gain change: the flip arrives 42–63 ms after the send, and the carrier changes on the flip frame
or the one after, every time. A retune therefore also steps the gain, the reader holds until the echo, then drops
two frames. No echo means a stall and exit 3, so an ignored retune can't label the old window as the new one. The
gain steps through a 3-value cycle of about 1 dB per step, which the survey's floor-relative dB doesn't see.

In the helper, 8 retunes between 10050 and 7350 kHz: WWV reported in all 4 of its windows, and no ghost at 7300 kHz,
where old-center WWV would land. This replaced a 150 ms wall-clock discard.

## WWV check

Each WWV frequency for 90 s through the real helper, one window, no retunes, audio captured from the tee. WWV
was 50 kHz off center to avoid the center spike.

| kHz | Survey hits | Carrier | 1 Hz tick | Strongest tone | Time code (100 Hz) | Underrun in 60 s | Drift-trimmed in 60 s |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2500 | 4/17 | +10.2 dB | +11.9 dB | 600 Hz +34.7 | +34.5 dB | 450 ms | 0 |
| 5000 | 17/17 | +19.4 dB | +19.7 dB | 440 Hz +49.2 | +41.3 dB | 2190 ms | 1700 ms |
| 10000 | 17/17 | +30.7 dB | +25.2 dB | 600 Hz +16.4 | +46.2 dB | 1250 ms | 820 ms |
| 15000 | 1/17 | +10.2 dB | +9.0 dB | 500 Hz +27.1 | +20.3 dB | 460 ms | 0 |
| 20000 | 0/17 | none | none | none | none | 2240 ms | 1819 ms |
| 25000 | 0/17 | none | none | none | none | 450 ms | 0 |

Demodulation and survey frequency are correct on 2.5, 5, 10 and 15 MHz. The tones differ by run because WWV's
schedule changes minute to minute.

Tuning error from a 16-bit, 12 kHz stream, 19.5 s, 0.05 Hz resolution:

| kHz | Offset | ppm | Peak SNR |
| --- | --- | --- | --- |
| 2500 | +0.23 Hz | 0.092 | 59.4 dB |
| 5000 | +0.28 Hz | 0.056 | 69.8 dB |
| 10000 | +0.90 Hz | 0.090 | 76.5 dB |
| 15000 | +0.90 Hz | 0.060 | 46.3 dB |
| 20000 | +1.77 Hz | 0.088 | 28.9 dB |
| 25000 | Not valid | | 13.6 dB, no carrier: the search found noise |

The 20 MHz carrier is present in the narrow stream at about 0.09 ppm, and it's too weak for the survey or audio.
The radio needs no frequency correction.

### What this says about audio gaps

With no retunes, about 450 ms of underrun is the baseline, probably startup: it appears in each run's only
speaker log and the runs with none trimmed show nothing else. Three of six runs also had 820–1819 ms
**drift-trimmed** plus matching extra underrun. That is bursty arrival: IQ arrives late, the speaker runs dry,
the backlog then lands at once and gets trimmed. So gaps of a second or two are not caused by retunes. Wi-Fi
bursts are the likely source but this is not proven. The helper's speaker path was built for USB timing, where
this doesn't happen.

## Proof B: SAME break-in audio

Bar: up to about 2 s of silence, no overlay, banner kept.

**A, respawn.** This is not the plan's candidate A (two engines in one helper), which turned out to be unnecessary.
The HF helper exits and an RTL helper starts on KIOSK01 at the real scanner settings (2.5 Msps, 32 lanes). From stop
signal to first audio, three runs each, from a throwaway driver, so Node's stop and spawn path, the warm-up gate and
the banner are **not** included:

| Direction | Old helper exit | New helper ready | First audio |
| --- | --- | --- | --- |
| HF to RTL | 0.016–0.032 s | 0.920–0.933 s | **0.991–1.004 s** |
| RTL to HF | 0.064 s | 0.511–0.691 s | **0.905–1.020 s** |

**B, KIOSK03 supplies audio.** The weather helper, already on NWR, is asked to speak:

| | |
| --- | --- |
| Time to first audio | 0.115 s |
| CPU | 10.3% of a core decode-only, 16.8% with audio |
| Voice band over hiss | 48.8 dB, against 45.2 dB through KIOSK01 |

Not measured: SAME header timing before the voice message. There was no alert or recording to measure. From
memory of the EAS format, three header bursts and then an attention tone come before the voice, so a 1 s gap
would cost part of the tone. SAME decoding while the weather helper also produces audio was not exercised either.

**Provisional decision: A, pending the operator's call and a measurement through Node.** Both pass the bar, and the
plan said to prefer B. A was chosen because it needs no native work and keeps one helper as the audio owner, while B
needs `--pcm-in-fd` ported and a pipe between helpers to save about 0.9 s the operator has already accepted. B is
faster and measured slightly cleaner. Plan 2 must measure A through Node, and keep the warm-up overlay off and the
banner up during the respawn, since those are why the invariant exists. If that can't hold 2 s, use B.

## Speaker jitter buffer

The link stays on Wi-Fi, so the helper got `--audio-buffer-ms`. Same window (5050 kHz, WWV lane) with the speaker path live and muted, sizes rotated in 5-minute rounds so changing Wi-Fi conditions don't favor one size, around 21:10 local. Totals per round:

| Buffer | Round | Drift-trimmed | Underrun silence | Overflow, xruns |
| --- | --- | --- | --- | --- |
| 0 ms | 1 | 420 ms | 860 ms | 0, 0 |
| 500 ms | 1 | 0 | 940 ms | 0, 0 |
| 1000 ms | 1 | 0 | 1450 ms | 0, 0 |
| 0 ms | 2 | 3590 ms | 4240 ms | 0, 0 |
| 500 ms | 2 | 0 | 940 ms | 0, 0 |
| 1000 ms | 2 | 0 | 1430 ms | 0, 0 |

At 500 and 1000 ms the silence sits entirely in the first report window, which is the startup prefill, and no later window reported any. **500 ms is the default.** Audio plays about 500 ms behind the helper's open and close events.

This is 20 minutes at each buffered size, one evening. It doesn't explain the bursts, and it wasn't run with the wall or the weather helper up.

## SAME switch through Node

`POST /api/mode` from `cb` on SpyServer to `weather` on KIOSK01, through the real backend, five cycles, timed to the first NWR audio on `/api/stream.wav`: **998–1034 ms**. Over all cycles the WebSocket carried no `warmup` or `stopped` event and no error, and `warmed` stayed true. The return to CB adds the 500 ms speaker buffer, and at night it had no audio to time.

This used the mode API. A real SAME header can't be produced on demand, so the break-in path itself is covered by server tests only, and how much of the header and attention tone the 1 s costs is still unmeasured.

## CB on the live wall

- Dead SpyServer address in CB mode: "Radio error" with the connect failure on the wall, and `scan` started KIOSK01 at once. After restoring the address, the error cleared with no restart.
- A test alert banner displayed over the CB stage.
- 30 minutes in CB with the real wall: 71 °C peak, 55.2 °C mean, helper 74.7% of a core mean (32 lanes). The map-mode leg was stopped for operator listening; see the thermal comparison below for HF against map mode.
- Direct tune to 5850 kHz through the backend: −22.7 dBFS over 12 s on the tee, wall card correct, held over a minute with only the startup prefill as silence. Not yet judged by ear.

## 8-bit after dark

The same comparison at 23:50 local, the check owed above. Clipping was again 0.000% in every window at gains 24 and 32. Gain 32 missed at most one carrier per window, all under +15 dB. The strongest night signals don't clip, so the default of 32 stands. One night, 4 s per capture.

## HF mode on the live wall

Night of 2026-11-02, speaker muted. The CB stop and hold described here were removed on 2026-11-03: HF and CB are now separate manual modes.

- Full pass: every window on its 60 s timer, then the 30 s CB stop, then wrapping to 120 m. No false CB hold.
- Helper 24% of a core and 55 °C over the first few minutes with the real stage. Measured before the map-pause and redraw fixes, so see the thermal comparison.
- Schedules: EiBi, Aoki and HFCC all downloaded on the kiosk. The log named WWV, WWCR Nashville and Radio Rebelde plausibly. None was confirmed by ear.
- Test alert banner shown over the stage.
- Dead SpyServer address: "Receiver offline" held steady across windows, with six helper exits in 75 s of backoff. It returned to a station within 30 s of restoring the address, with no restart.

Not proven: a real CB hold (the band was quiet), a real SAME alert from HF, and audio by ear.

## Thermal comparison

Night of 2026-11-03 from 00:19 local, on `main` at `5c87527`, with the real wall and the speaker muted. Each leg settled for 2 minutes, then ran 30 minutes, sampled every 15 s.

| Leg | Peak | Mean | Helper mean | Helper max |
|---|---|---|---|---|
| HF | 51 °C | 48.4 °C | 23.1% of a core | 25.8% |
| Map | 64 °C | 57.5 °C | 34.5% | 57.7% |
| HF again | 51 °C | 48.4 °C | 22.8% | 25.7% |

HF ran about 9 °C cooler than map mode on average, and the two HF legs agree. The meter was dark through these legs (see below), so they don't include its redraws. Map-mode traffic may differ by day. CB's 71 °C peak above was a separate run with 32 lanes, not part of this comparison.

## One pass, window by window

Recorded 02:07 to 02:25 local. Windows with anything to play: 60 m, 49 m, 41 m, 25 m, and 75 m on the second pass. 22 m to 13 m were empty at that hour.

Two defects came out of it, both fixed in the PR that adds this section:

- 9395 kHz (WRMI) at +46 dB, second only to 5935 at +47, was neither played nor logged, because 31 m started at 9400. The bands now follow where Aoki and HFCC list broadcasters. Rows outside the old edges included 9955 (93), 5850 (62), 9930 (41), 9395 (38), 7730 (37), 9965 (29) and 7780 (26). 31 m now takes two windows, so a pass is a minute longer.
- The wall's meter was dark on most stations. Across both passes that night, levels ran from −59 dBFS (p10, weakest) to −9 (p90, strongest), and the shared meter scale starts at −35. HF now uses −60 to −10.

Rerun after both fixes, 02:30 to 03:00 local, with the meter moving:

- 30 minutes in HF: 54 °C peak, 47.9 °C mean, helper 23.0% of a core mean. The meter's redraws add no measurable heat.
- 9395 (WRMI, +49 dB) and 9965 (Hope Radio 5, +24 dB) played and were logged. 5850, 7730 and 7780 (WRMI) were logged. The wider 41 m also logs some non-broadcast carriers: 7755 and 7800 unidentified, 7795 JMH Japan Meteo Fax.
- A strong station can stay silent on alternate passes: 9395 at +46 dB played nothing on the second pass, because a pass takes about 15 minutes and `config.hf.cooldownMs` is 30. It is still logged.

## The Atlas wall

2026-11-03, 11:11 to 11:41 local, in daylight, on the branch at `26075a4`, with the real wall and the speaker on. Same sampling as above, plus Chromium's CPU summed across its processes.

| | Peak | Mean | Helper mean | Chromium mean | Chromium max |
|---|---|---|---|---|---|
| Atlas | 52 °C | 49.5 °C | 23.2% of a core | 10.0% | 34.7% |

Bar: under map mode's 64 °C. It passes, and it's no hotter than the old HF wall (54 °C peak, 47.9 °C mean at night). Chromium's CPU has no earlier number to compare with, so this is the baseline for the pulses and the zoom. Daytime bands give fewer hits than a night does, so a night's number could be a little higher.

Seen on the live wall: a hit in flight, a held station, hunting, a test alert above the panel, and a trip to weather and back with traces intact. The greyline matched the time of day, and 16 date and time combinations across four seasons show no flat band edge. A lone trace measured 34% brightness from the wall's pixels.

With pulses on the live trace, 11:56 to 12:26 local, against that run: 53 °C peak, 49.9 °C mean, helper 23.1%, Chromium 12.0% mean and 42.2% max. A station was playing for 38% of the samples, in daylight. So pulses cost about 1 °C at peak and 2% of a core here; a night that plays nearly all the time might cost closer to 5%. That's an extrapolation, not a measurement.

Not proven live yet: noon clearing the traces, because no noon has passed on this code.

### The zoom

Final version, which moves a flat picture. Six zooms on the wall, 25 s apart, 2026-11-03 at about 13:10 local: 53 °C before, 58 °C peak, 50 °C within two minutes of the last one. An earlier version that scaled the live layers peaked at 62 °C.

Landing, checked by comparing frames with the settled wall over the top 470 px, three trips from a fresh load: 0% different right after landing, with no late repaint.
