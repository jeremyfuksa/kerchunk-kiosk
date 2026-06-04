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
to any other open channel, else silence. The audio gate itself follows
INSTANTANEOUS carrier power (~50 ms mute on carrier drop — no squelch-tail
static), while open/close hold semantics ride hang_ms for scan behavior. Group-hop is Node's job — it just
sends another "tune"; the device is NEVER re-opened (spike-proven:
set_frequency on the running soapy source retunes VHF<->UHF cleanly).

DSP per chain (MAX_CHANS chains built once, offsets retuned per group):
  soapy source @ samp_rate -> freq_xlating_fir (decim -> 48k) ->
    [power: mag^2 -> moving_average -> probe]
    [audio: nbfm_rx(48k/48k, 5k dev) -> gate(multiply_const 0|1)] -> add ->
    rail(+-0.8 hard limiter, speaker guard) -> sink

Detection (per assigned chain, in the 20 ms poll loop; the audio gate also
uses a separate fast ~10 ms power estimate so the speaker mutes within
~30 ms of carrier drop — see the pass-2 comment):
  Adaptive noise floor: asymmetric EMA of channel power while closed — tracks
  DOWN fast (a transmission present at tune time decays away quickly) and UP
  slowly (so a real carrier doesn't become the floor). The squelch reference
  is the GROUP-WIDE MINIMUM of the per-chain floors: all channels share one
  window and AGC, so the quietest channel defines the noise floor — this is
  what lets a continuously-transmitting station (NOAA never keys down) open,
  since its own floor would otherwise learn the carrier as "noise". Open when
  power exceeds group_floor + open_db for two consecutive polls; close when
  power stays below group_floor + open_db - 3 (hysteresis) for hang_ms.
  Floors reset (and re-warm) on every tune.

  KNOWN LIMITATION: a SINGLE-channel group has no idle neighbor, so a carrier
  that is already up at tune time and never drops cannot be distinguished
  from the floor. Bursty traffic is fine (the floor falls fast between
  bursts). Revisit if weather-only mode moves to this engine.
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

MAX_CHANS = 12           # channelizer lanes (always running; ~2.5 cores of 8
                         # at 12). Must match MAX_CHANNELS_PER_GROUP in
                         # WidebandEngine.ts — grouping splits clusters bigger
                         # than this so tune never truncates.
QUAD_RATE = 48_000
AUDIO_RATE = 48_000
POLL_S = 0.02            # detection/gate poll — 20 ms so the audio gate can
                         # mute within ~30 ms of carrier drop (operator heard
                         # the static tail at the old 50 ms poll + 100 ms avg)
POWER_EVERY = 10         # power telemetry every 10th poll (~200 ms)
OPEN_POLLS = 5           # consecutive above-threshold polls to open (~100 ms)
WARMUP_POLLS = 25        # ~500 ms after tune: let the power average fill
                         # before arming detection (else the floor initializes
                         # from an empty probe at -120 dB and every channel
                         # "opens" — observed in the first live smoke test)
CLOSE_HYST_DB = 3.0
GATE_HYST_DB = 1.0       # +-0.5 dB around the gate threshold so the fast
                         # (10 ms) power estimate can't flutter the audio
                         # on/off on a weak-but-open signal
NOISE_HPF_HZ = 8_000     # HF-noise band for the quieting squelch: voice lives
                         # below ~3 kHz; an FM carrier quiets the discriminator
                         # above that, while no-carrier static is broadband
                         # and LOUD up here. This is how hardware scanners
                         # tell a transmission from junk power.
QUIET_HYST_DB = 2.0      # +-1 dB around the quieting threshold
FADE_STEPS = 6           # gate fade: 6 steps x 1 ms = ~6 ms ramp. A hard 0/1
FADE_STEP_S = 0.001      # flip on 48 kHz audio is an audible click/thump; a
                         # short ramp kills the transient. 12 ms was still a
                         # hair audible at squelch close (operator), 6 ms is
                         # the next stop — don't go much lower or the click
                         # comes back.
LEVEL_REF_DB = -14       # speaker leveler target: mean-square dB of the demod
                         # audio (~0.2 amplitude, ~10 dB headroom to the rail).
LEVEL_MIN_DB = -40       # below this = speech pause/silence: HOLD gain (no
                         # pumping between words).
LEVEL_MAX_DB = 12        # gain clamp: +-12 dB amplitude correction max.
LEVEL_SLEW_DB = 0.3      # max gain change per 20 ms poll (~15 dB/s) — slow,
                         # stepwise envelope control. NOTE: this replaced a
                         # gr agc2 block, whose rectified-waveform detector
                         # gain-modulated WITHIN tone cycles (operator: "CW
                         # tones are very chirpy"). RMS envelope + slow slew
                         # cannot track the waveform, so no distortion; gains
                         # are also PER CHANNEL (each repeater keeps its own).
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
        # ~100 ms power average at the 48 kHz quad rate: stable estimate for
        # DETECTION (open/close, floor learning).
        self.avg = blocks.moving_average_ff(QUAD_RATE // 10, 10.0 / QUAD_RATE)
        self.probe = blocks.probe_signal_f()
        # ~10 ms power average: fast estimate for the AUDIO GATE only, so the
        # speaker mutes within one poll of carrier drop instead of waiting for
        # the 100 ms average to decay through the threshold.
        self.avg_fast = blocks.moving_average_ff(QUAD_RATE // 100, 100.0 / QUAD_RATE)
        self.probe_fast = blocks.probe_signal_f()
        self.demod = analog.nbfm_rx(
            audio_rate=AUDIO_RATE, quad_rate=QUAD_RATE, tau=75e-6, max_dev=5_000)
        # Quieting squelch: HF-noise power in the demod output. A genuine FM
        # carrier suppresses discriminator noise above the voice band; static
        # (no carrier) is broadband and loud there. ~10 ms average so the
        # audio gate can use it too.
        hpf_taps = firdes.high_pass(1.0, AUDIO_RATE, NOISE_HPF_HZ, 2_000)
        self.noise_hpf = grfilter.fir_filter_fff(1, hpf_taps)
        self.noise_sq = blocks.multiply_ff(1)
        self.noise_avg = blocks.moving_average_ff(
            AUDIO_RATE // 100, 100.0 / AUDIO_RATE)
        self.noise_probe = blocks.probe_signal_f()
        self.gate = blocks.multiply_const_ff(0.0)
        # Audio envelope (mean square over ~100 ms) for the per-channel
        # loudness leveler — measured BEFORE the gate so the gain we apply
        # never feeds back into the measurement.
        self.audio_sq = blocks.multiply_ff(1)
        self.audio_avg = blocks.moving_average_ff(
            AUDIO_RATE // 10, 10.0 / AUDIO_RATE)
        self.audio_probe = blocks.probe_signal_f()
        tb.connect(src, self.xlate, self.mag2, self.avg, self.probe)
        tb.connect(self.mag2, self.avg_fast, self.probe_fast)
        tb.connect(self.xlate, self.demod, self.gate)
        tb.connect(self.demod, (self.audio_sq, 0))
        tb.connect(self.demod, (self.audio_sq, 1))
        tb.connect(self.audio_sq, self.audio_avg, self.audio_probe)
        tb.connect(self.demod, self.noise_hpf)
        tb.connect(self.noise_hpf, (self.noise_sq, 0))
        tb.connect(self.noise_hpf, (self.noise_sq, 1))
        tb.connect(self.noise_sq, self.noise_avg, self.noise_probe)
        tb.connect(self.gate, (adder, port))

        self.gain = 0.0          # current gate value (fade_to bookkeeping)
        self.level_db = 0.0      # learned per-channel loudness correction (dB)
        self.channel_id = None   # None = parked (no channel assigned)
        self.reset_detection()

    def fade_to(self, target):
        """Ramp the audio gate to target instead of hard-switching.

        Ramps only on silence transitions (0 <-> non-zero) — those are the
        click-prone edges. Small open-to-open moves (the leveler slewing
        gain by ~0.3 dB) apply directly; ramping them would make the poll
        loop fade constantly.
        """
        if self.gain == target:
            return
        if self.gain > 0.0 and target > 0.0:
            self.gate.set_k(target)
            self.gain = target
            return
        start = self.gain
        for i in range(1, FADE_STEPS + 1):
            self.gate.set_k(start + (target - start) * i / FADE_STEPS)
            time.sleep(FADE_STEP_S)
        self.gain = target

    def reset_detection(self):
        self.floor_db = None
        self.open = False
        self.carrier = False   # instantaneous carrier presence (fast audio gate)
        self.quiet = False     # discriminator quieted (HF noise below threshold)
        self.above_polls = 0
        self.below_since = None
        self.warmup = WARMUP_POLLS

    def assign(self, channel_id, offset_hz):
        self.channel_id = channel_id
        self.xlate.set_center_freq(offset_hz)
        self.gate.set_k(0.0)   # hard cut is fine: we just retuned, no audio context
        self.gain = 0.0
        self.level_db = 0.0    # new channel on this lane: forget the old gain
        self.reset_detection()

    def park(self):
        self.channel_id = None
        self.xlate.set_center_freq(0)
        self.gate.set_k(0.0)
        self.gain = 0.0
        self.reset_detection()

    def power_db(self):
        p = self.probe.level()
        return 10 * math.log10(p) if p > 0 else -120.0

    def fast_power_db(self):
        p = self.probe_fast.level()
        return 10 * math.log10(p) if p > 0 else -120.0

    def noise_db(self):
        p = self.noise_probe.level()
        return 10 * math.log10(p) if p > 0 else -120.0

    def audio_db(self):
        p = self.audio_probe.level()
        return 10 * math.log10(p) if p > 0 else -120.0

    def level_gain(self):
        return 10 ** (self.level_db / 20.0)


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
        # Loudness leveling happens per chain (the gate gain doubles as the
        # channel's learned volume correction — see the poll loop); the rail
        # is the hard speaker guard: demodulated squelch noise swings far
        # beyond the +-1.0 a voice signal at rated deviation produces, so
        # anything that slips past the gate (the ~30 ms close window) gets
        # clipped instead of slamming the speakers at full scale.
        self.adder = blocks.add_ff(1)
        self.limiter = analog.rail_ff(-0.8, 0.8)
        self.sink = audio.sink(AUDIO_RATE, args.sink, True)
        self.connect(self.adder, self.limiter, self.sink)

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
            self.audible.fade_to(0.0)
        self.audible = chain
        if chain is not None:
            # Gate follows the chain's carrier, not just audibility: an open
            # chain whose carrier already dropped (riding its hang time) must
            # not blast squelch noise.
            chain.fade_to(chain.level_gain() if chain.carrier else 0.0)
        emit({"ev": "audible",
              "id": chain.channel_id if chain else None})

    # -- detection -----------------------------------------------------------

    def group_floor_db(self):
        floors = [c.floor_db for c in self.chains
                  if c.channel_id is not None and c.floor_db is not None]
        return min(floors) if floors else None

    def poll(self, now):
        open_db = self.args.open_db
        quiet_db = self.args.quiet_db
        hang_s = self.args.hang_ms / 1000.0

        # Pass 1: update per-chain floors (frozen while a chain is open).
        readings = {}
        for chain in self.chains:
            if chain.channel_id is None:
                continue
            db = chain.power_db()

            if chain.warmup > 0:
                chain.warmup -= 1
                if chain.warmup == 0:
                    chain.floor_db = db   # first trusted reading = initial floor
                continue
            readings[chain.channel_id] = db

            if chain.floor_db is None:
                chain.floor_db = db
            elif not chain.open:
                alpha = FLOOR_ALPHA_UP if db > chain.floor_db else FLOOR_ALPHA_DOWN
                chain.floor_db += alpha * (db - chain.floor_db)

        # Pass 2: squelch against the group-wide noise reference.
        floor = self.group_floor_db()
        if floor is None:
            return
        for chain in self.chains:
            if chain.channel_id is None or chain.channel_id not in readings:
                continue
            db = readings[chain.channel_id]

            # Fast audio gate (static mute). An FM carrier holds steady power
            # while keyed, so the moment power falls to the close threshold the
            # transmission is OVER — demodulated output from here on is loud
            # squelch noise. The gate runs on the FAST (10 ms) power estimate
            # and this 20 ms poll, so it mutes within ~30 ms of carrier drop;
            # hang_ms only governs the logical open/hold (so the scanner
            # doesn't hop away between replies). A re-key inside the hang
            # reopens the gate on the next poll, no event churn. The +-0.5 dB
            # hysteresis keeps the noisier fast estimate from fluttering the
            # audio on a weak-but-open signal.
            gate_thresh = floor + open_db - CLOSE_HYST_DB
            fast_db = chain.fast_power_db()
            if chain.carrier:
                chain.carrier = fast_db > gate_thresh - GATE_HYST_DB / 2
            else:
                chain.carrier = fast_db > gate_thresh + GATE_HYST_DB / 2
            # Quieting check: only a real FM carrier suppresses discriminator
            # HF noise. Power above floor WITHOUT quieting is junk (AGC pump,
            # spur, broadband burst) — the hardware-scanner behavior the
            # operator expects. Hysteresis so a marginal signal doesn't chop.
            noise = chain.noise_db()
            if chain.quiet:
                chain.quiet = noise < quiet_db + QUIET_HYST_DB / 2
            else:
                chain.quiet = noise < quiet_db - QUIET_HYST_DB / 2
            if self.audible is chain:
                open_now = chain.carrier and chain.quiet
                if open_now:
                    # Loudness leveler: slew this channel's gain toward the
                    # reference, only while voice is present (pauses hold).
                    ms_db = chain.audio_db()
                    if ms_db > LEVEL_MIN_DB:
                        desired = max(-LEVEL_MAX_DB, min(LEVEL_MAX_DB,
                                      (LEVEL_REF_DB - ms_db) / 2))
                        step = max(-LEVEL_SLEW_DB, min(LEVEL_SLEW_DB,
                                   desired - chain.level_db))
                        chain.level_db += step
                chain.fade_to(chain.level_gain() if open_now else 0.0)

            if not chain.open:
                if db > floor + open_db and chain.quiet:
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
                if db < floor + open_db - CLOSE_HYST_DB:
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

    def noise_levels(self):
        return {c.channel_id: round(c.noise_db(), 1)
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
    ap.add_argument("--quiet-db", type=float, default=-86.0,
                    help="discriminator HF-noise level (dB) BELOW which the "
                         "channel counts as carrier-quieted; power without "
                         "quieting never opens (rejects non-voice junk). "
                         "Default bench-calibrated on this hardware: dead "
                         "channels read ~-82, voice carriers -94..-96 "
                         "(2026-06-04, see PR)")
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
                    emit({"ev": "power", "levels": helper.power_levels(),
                          "noise": helper.noise_levels()})
    finally:
        helper.stop()
        helper.wait()


if __name__ == "__main__":
    sys.stdout.reconfigure(line_buffering=True)
    main()
