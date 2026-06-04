#!/usr/bin/env python3
"""Kerchunk wideband DSP helper — one persistent GNU Radio flowgraph.

Spawned by WidebandEngine with the SYSTEM python (/usr/bin/python3 — GNU Radio
lives in dist-packages; mise pythons cannot import it). Protocol
(line-delimited JSON):

  stdin  <- {"cmd":"tune","centerHz":N,"channels":[{"id":"...","freqHz":N},...]}
  stdin  <- {"cmd":"quit"}
  stdout -> {"ev":"ready"}                               once, device open
  stdout -> {"ev":"tuned","centerHz":N}                  after each tune
  stdout -> {"ev":"open","id":...,"db":N}                channel went active
  stdout -> {"ev":"close","id":...}                      channel went idle
  stdout -> {"ev":"audible","id":...|null}               who owns the speaker
  stdout -> {"ev":"power","levels":{id: dB,...}}         ~5 Hz telemetry
  stdout -> {"ev":"log","msg":"..."}                     diagnostics

Audio goes straight to ALSA (gr audio.sink); Node never touches PCM. Audible
selection is first-active-wins: hold until that channel closes, then hand off
to any other open channel, else silence. Group-hop is Node's job — it just
sends another "tune"; the device is NEVER re-opened (spike-proven:
set_frequency on the running soapy source retunes VHF<->UHF cleanly).

DSP per chain (MAX_CHANS chains built once, offsets retuned per group):
  soapy source @ samp_rate -> freq_xlating_fir (decim -> 48k) ->
    [power: mag^2 -> moving_average -> probe]
    [audio: nbfm_rx(48k/48k, 5k dev) -> gate(multiply_const 0|1)] -> add -> sink

Detection (per assigned chain, in the 50 ms poll loop):
  Adaptive noise floor: asymmetric EMA of channel power while closed — tracks
  DOWN fast (a transmission present at tune time decays away quickly) and UP
  slowly (so a real carrier doesn't become the floor). Open when power exceeds
  floor + open_db for two consecutive polls; close when power stays below
  floor + open_db - 3 (hysteresis) for hang_ms. Floors reset on every tune.
"""

import argparse
import json
import math
import queue
import sys
import threading
import time

from gnuradio import analog, audio, blocks, filter as grfilter, gr, soapy
from gnuradio.filter import firdes

MAX_CHANS = 8
QUAD_RATE = 48_000
AUDIO_RATE = 48_000
POLL_S = 0.05            # detection poll
POWER_EVERY = 4          # power telemetry every 4th poll (~200 ms)
OPEN_POLLS = 2           # consecutive above-threshold polls to open
CLOSE_HYST_DB = 3.0
FLOOR_ALPHA_UP = 0.02    # floor rises slowly
FLOOR_ALPHA_DOWN = 0.2   # floor falls fast


def emit(obj):
    print(json.dumps(obj), flush=True)


class Chain:
    """One channelizer lane: xlating filter + power probe + NBFM + gate."""

    def __init__(self, tb, src, taps, samp_rate, adder, port):
        self.xlate = grfilter.freq_xlating_fir_filter_ccf(
            samp_rate // QUAD_RATE, taps, 0, samp_rate)
        self.mag2 = blocks.complex_to_mag_squared(1)
        # ~100 ms power average at the 48 kHz quad rate.
        self.avg = blocks.moving_average_ff(QUAD_RATE // 10, 10.0 / QUAD_RATE)
        self.probe = blocks.probe_signal_f()
        self.demod = analog.nbfm_rx(
            audio_rate=AUDIO_RATE, quad_rate=QUAD_RATE, tau=75e-6, max_dev=5_000)
        self.gate = blocks.multiply_const_ff(0.0)
        tb.connect(src, self.xlate, self.mag2, self.avg, self.probe)
        tb.connect(self.xlate, self.demod, self.gate)
        tb.connect(self.gate, (adder, port))

        self.channel_id = None   # None = parked (no channel assigned)
        self.reset_detection()

    def reset_detection(self):
        self.floor_db = None
        self.open = False
        self.above_polls = 0
        self.below_since = None

    def assign(self, channel_id, offset_hz):
        self.channel_id = channel_id
        self.xlate.set_center_freq(offset_hz)
        self.gate.set_k(0.0)
        self.reset_detection()

    def park(self):
        self.channel_id = None
        self.xlate.set_center_freq(0)
        self.gate.set_k(0.0)
        self.reset_detection()

    def power_db(self):
        p = self.probe.level()
        return 10 * math.log10(p) if p > 0 else -120.0


class Helper(gr.top_block):
    def __init__(self, args):
        gr.top_block.__init__(self, "kerchunk-wideband-helper")
        self.args = args

        self.src = soapy.source("driver=rtlsdr", "fc32", 1, "", "", [""], [""])
        self.src.set_sample_rate(0, args.rate)
        if args.gain == "auto":
            self.src.set_gain_mode(0, True)
        else:
            self.src.set_gain_mode(0, False)
            self.src.set_gain(0, float(args.gain))

        # One shared adder feeds the sink; exactly one gate is ever non-zero.
        self.adder = blocks.add_ff(1)
        self.sink = audio.sink(AUDIO_RATE, args.sink, True)
        self.connect(self.adder, self.sink)

        # Channel filter: pass the NFM channel (~16 kHz), reject neighbors.
        taps = firdes.low_pass(1.0, args.rate, 8_000, 4_000)
        self.chains = [Chain(self, self.src, taps, args.rate, self.adder, i)
                       for i in range(MAX_CHANS)]

        self.center_hz = None
        self.audible = None      # chain currently gated into the sink

    # -- commands ------------------------------------------------------------

    def tune(self, center_hz, channels):
        if len(channels) > MAX_CHANS:
            emit({"ev": "log",
                  "msg": f"group truncated to {MAX_CHANS} channels"})
            channels = channels[:MAX_CHANS]
        self.center_hz = center_hz
        self.src.set_frequency(0, center_hz)
        self.set_audible(None)
        for i, chain in enumerate(self.chains):
            if i < len(channels):
                c = channels[i]
                chain.assign(c["id"], c["freqHz"] - center_hz)
            else:
                chain.park()
        emit({"ev": "tuned", "centerHz": center_hz})

    def set_audible(self, chain):
        if self.audible is chain:
            return
        if self.audible is not None:
            self.audible.gate.set_k(0.0)
        self.audible = chain
        if chain is not None:
            chain.gate.set_k(1.0)
        emit({"ev": "audible",
              "id": chain.channel_id if chain else None})

    # -- detection -----------------------------------------------------------

    def poll(self, now):
        open_db = self.args.open_db
        hang_s = self.args.hang_ms / 1000.0
        for chain in self.chains:
            if chain.channel_id is None:
                continue
            db = chain.power_db()

            if chain.floor_db is None:
                chain.floor_db = db
            elif not chain.open:
                alpha = FLOOR_ALPHA_UP if db > chain.floor_db else FLOOR_ALPHA_DOWN
                chain.floor_db += alpha * (db - chain.floor_db)

            if not chain.open:
                if db > chain.floor_db + open_db:
                    chain.above_polls += 1
                    if chain.above_polls >= OPEN_POLLS:
                        chain.open = True
                        chain.below_since = None
                        emit({"ev": "open", "id": chain.channel_id,
                              "db": round(db, 1)})
                        if self.audible is None:   # first-active-wins
                            self.set_audible(chain)
                else:
                    chain.above_polls = 0
            else:
                if db < chain.floor_db + open_db - CLOSE_HYST_DB:
                    if chain.below_since is None:
                        chain.below_since = now
                    elif now - chain.below_since >= hang_s:
                        chain.open = False
                        chain.above_polls = 0
                        chain.below_since = None
                        emit({"ev": "close", "id": chain.channel_id})
                        if self.audible is chain:
                            self.set_audible(self.next_open_chain())
                else:
                    chain.below_since = None

    def next_open_chain(self):
        for chain in self.chains:
            if chain.channel_id is not None and chain.open:
                return chain
        return None

    def power_levels(self):
        return {c.channel_id: round(c.power_db(), 1)
                for c in self.chains if c.channel_id is not None}


def stdin_reader(q):
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            q.put(json.loads(line))
        except json.JSONDecodeError:
            emit({"ev": "log", "msg": f"bad command line: {line[:120]}"})
    q.put({"cmd": "quit"})   # EOF = parent went away


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sink", required=True, help="ALSA device, e.g. plughw:1,0")
    ap.add_argument("--rate", type=int, default=2_400_000)
    ap.add_argument("--gain", default="auto", help='tuner gain dB or "auto"')
    ap.add_argument("--open-db", type=float, default=9.0,
                    help="dB above learned floor to open squelch")
    ap.add_argument("--hang-ms", type=float, default=2000.0,
                    help="sustained silence before close")
    args = ap.parse_args()

    helper = Helper(args)
    helper.start()
    emit({"ev": "ready"})

    q = queue.Queue()
    threading.Thread(target=stdin_reader, args=(q,), daemon=True).start()

    polls = 0
    try:
        while True:
            try:
                cmd = q.get(timeout=POLL_S)
            except queue.Empty:
                cmd = None
            if cmd is not None:
                if cmd.get("cmd") == "quit":
                    break
                if cmd.get("cmd") == "tune":
                    helper.tune(cmd["centerHz"], cmd.get("channels", []))
            if helper.center_hz is not None:
                helper.poll(time.monotonic())
                polls += 1
                if polls % POWER_EVERY == 0:
                    emit({"ev": "power", "levels": helper.power_levels()})
    finally:
        helper.stop()
        helper.wait()


if __name__ == "__main__":
    sys.stdout.reconfigure(line_buffering=True)
    main()
