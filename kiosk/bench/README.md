# Kerchunk Kiosk — Hardware Bench Protocol

The unit tests prove the software in isolation. THIS is the real success gate:
the whole stack on a Pi 4 with a real dongle and display. Run these in order.

## Prerequisites
- Pi 4, Raspberry Pi OS, HD display on micro-HDMI (audio-capable).
- RTL-SDR dongle + antenna.
- At least one active local repeater you can key up (or wait for traffic).
- Ran `scripts/setup-kiosk.sh`, rebooted once.

## B1 — Dongle detected
Run: `rtl_test -t`
Pass: prints tuner info, no "usb_claim_interface error". If it fails, confirm the
DVB module is blacklisted and reboot.

## B2 — Verify the detection model (PCM energy, not stderr)
This build of `rtl_fm` (2.0.2) emits only a startup banner on stderr — no
per-channel "Tuned to"/"Signal level"/"Squelch closed" lines. Active-channel
detection therefore reads the PCM audio energy, not stderr. To sanity-check the
energy threshold against your antenna/noise floor, capture a short sample on a
known-busy frequency (e.g. a NOAA weather channel ~162.4–162.55 MHz, always on):

`bench/capture-stderr.sh 162400000` (or any active local freq)

The captured fixture in `test/fixtures/rtl_fm-stderr.captured.txt` documents the
real banner format. If the dashboard never goes "ACTIVE" on a channel you can
hear, the energy threshold needs tuning: lower `openThreshold` (default 2000 RMS)
in the engine, or raise it if noise falsely triggers activity. (A future
enhancement: expose `openThreshold` in admin.)

## B3 — Dashboard appears on boot
Reboot. Pass: the HD display shows the dashboard fullscreen within ~30s, in the
"scanning…" state.

## B4 — Audio out HDMI on activity
From a laptop open `http://<pi-ip>:8080/admin`, add 2-3 local repeater freqs.
Pass: when one is active, audio plays through the HDMI display, and the dashboard
"Now Playing" shows the right frequency + tag within ~1s; the log grows.

## B5 — Volume/mute live
Move the volume slider and toggle mute in admin. Pass: audio responds without the
scan stopping or the dashboard resetting.

## B6 — Dongle loss + recovery
Unplug the dongle. Pass: dashboard shows an error within a few seconds (rtl_fm
exits, the engine emits an error and retries). Replug. Pass: it recovers and
resumes scanning without a manual restart.

## B7 — Reboot persistence
Reboot. Pass: comes back scanning the saved channel list with no manual steps.

Record pass/fail for B1-B7. All seven passing = v1 success criteria met.
