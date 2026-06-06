#!/usr/bin/env python3
"""Transcription worker (ROADMAP stretch): wav path in, JSON line out.

Runs under the dedicated venv (faster-whisper, tiny.en int8) at low CPU
priority — the DSP owns this machine; transcription rides the leftovers.
Protocol, line-oriented like the DSP helper:
  stdin:  /path/to/segment.wav\n
  stdout: {"path": "...", "text": "..."}\n   (text "" = nothing intelligible)
The worker deletes each wav after transcribing it.
"""
import json
import os
import sys

os.nice(15)   # the scanner's DSP outranks us, always

from faster_whisper import WhisperModel  # noqa: E402  (after nice())

MODEL = WhisperModel("tiny.en", device="cpu", compute_type="int8")

for line in sys.stdin:
    path = line.strip()
    if not path:
        continue
    text = ""
    try:
        segments, _info = MODEL.transcribe(
            path, language="en", beam_size=1, vad_filter=True)
        text = " ".join(s.text.strip() for s in segments).strip()
    except Exception:
        text = ""
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass
    sys.stdout.write(json.dumps({"path": path, "text": text}) + "\n")
    sys.stdout.flush()
