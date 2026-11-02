# HF mode proofs, 2026-11-02

Measured on the kiosk (i7-4770HQ) against an Airspy HF+ Discovery on an 80 m loop, served by SpyServer
v2.0.1922 on a Pi at `192.168.1.30:5555`. The kiosk reaches the Pi over Wi-Fi (5785 MHz, −70 dBm, 117 Mbit/s).
Helper: `kerchunk-dsp --spyserver` at commit `5d1e760`, digital gain 24 unless noted. Runs were daytime into
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
hot. It does not show HF mode runs cooler than map mode. A thermal A/B with the real wall stage is still owed.

Result: **passes**, except audio quality, which has not been judged by ear.

One earlier survey run, before this soak, exited 3 with `SDR stalled (no samples for 2.0 s)` about 30 s in. It
did not recur in reruns of 63 s and 40 s or in this hour. Cause unknown.

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

**A, respawn.** The HF helper exits and an RTL helper starts on KIOSK01 at the real scanner settings (2.5 Msps,
32 lanes). From stop signal to first audio, three runs each:

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

**Decision: A.** Both pass. A needs no native work and keeps one helper as the audio owner. B needs `--pcm-in-fd`
ported and a pipe between helpers to save about 0.9 s the operator has already accepted. Plan 2 has to keep the
warm-up overlay off and the banner up during this respawn, since those are why the invariant exists.
