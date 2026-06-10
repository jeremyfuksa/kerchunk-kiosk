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

DSP per chain (lane_count <= MAX_CHANS chains built once, offsets retuned per
group; lane-fit sizes lane_count to the busiest group and builds the AM path
only where a group carries an AM channel):
  soapy source @ samp_rate -> freq_xlating_fir (decim -> 48k) ->
    [power: mag^2 -> moving_average -> probe]
    [audio FM: nbfm_rx(48k/48k, 5k dev) -> fm gate]  -> add ->
    [audio AM: complex_to_mag -> dc_blocker -> am gate] ^ (airband; lane's
     active gate selected by the channel's mode in the tune command)
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
import os
import queue
import shutil
import subprocess
import sys
import threading
import time

import numpy as np

from gnuradio import analog, audio, blocks, fft as grfft, filter as grfilter, gr, soapy
from gnuradio.filter import firdes

from wideband_dsp_math import channel_bins, bin_power_db

MAX_CHANS = 12           # CAP on channelizer lanes (~2.5 cores of 8 at the
                         # full 12). Lane-fit (--lanes) builds only as many as
                         # the busiest group needs; this stays the ceiling. Must
                         # match MAX_CHANNELS_PER_GROUP in WidebandEngine.ts —
                         # grouping splits clusters bigger than this so tune
                         # never truncates.
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
LEVEL_SLEW_DOWN = 0.08   # ~4 dB/s. Even the downward clamp is GENTLE now:
                         # 15 dB/s ducked audibly on loud talker segments
                         # (operator heard it on 145.130 after the first
                         # retune) — transient peaks are the rail's job, the
                         # leveler only sets long-term per-channel loudness.
LEVEL_SLEW_UP = 0.04     # ~2 dB/s creep upward. NOTE: this leveler replaced
                         # a gr agc2 block whose rectified-waveform detector
                         # chirped CW tones; envelope + slew can't distort.
LEVEL_EMA_ALPHA = 0.03   # ~0.7 s speech-level smoothing
LEVEL_DEADBAND_DB = 4.0  # generous: correct only when clearly wrong, then
                         # stop — per-talker dynamics live inside the band
CC_FFT = 2048            # Close Call: FFT bins over the whole window
CC_EVERY = 10            # check every 10th poll (~200 ms)
CC_CONFIRM = 2           # consecutive checks on the same raster freq to fire
CC_COOLDOWN_S = 300      # per-frequency re-fire suppression
CC_RASTER_HZ = 12_500      # discoveries round to the 12.5 kHz channel raster
SAME_RATE = 22_050         # multimon-ng's native raw input rate
SAME_SCALE = 16_384        # float demod (±~1) -> s16 headroom
CC_IMAGE_REJECT_DB = 6.0   # mirror bin this much hotter = candidate is an image
CC_GUARD_HZ = 12_500     # suppression half-width around known frequencies
CC_DC_FRAC = 0.02        # exclude +-2% of bins around DC (RTL center spike)
CC_EDGE_FRAC = 0.10      # exclude outer 10% (channelizer/filter rolloff)
SKIP_HOLDOFF_S = 10.0    # after SKIP, a regular channel may not reopen for
                         # this long (the skipped transmission is usually
                         # still keyed; without a holdoff it reopens next poll)
AM_GAIN = 0.7            # AM audio gain AFTER carrier normalization (audio
                         # is modulation-depth units, ~±0.8 at full depth)
FLOOR_ALPHA_UP = 0.02    # floor rises slowly
FLOOR_ALPHA_DOWN = 0.2   # floor falls fast
# FFT-detect integrations (detect_via="fft"). cc_mag emits one CC_FFT-vector per
# CC_FFT input samples -> ~rate/CC_FFT = 1172 vectors/s. Lengths set the
# averaging window: long for floor/open (~150 ms), short for the fast audio gate.
FFT_SLOW_FRAMES = 176    # ~150 ms — floor/open, matches the per-lane slow probe (~100 ms class)
# NOTE first estimate, tune at the bench A/B (see specs/2026-06-08-fft-detect-power-design.md):
# the per-lane fast gate averages only ~10 ms, but FFT bins are noisier (~1.2 dB std), so the
# short integration trades a slightly longer mute for stability against gate chatter. ~30 ms here
# is a starting point, NOT a match to the 10 ms lane probe window.
FFT_FAST_FRAMES = 35     # ~30 ms (bench-tunable; see note above)
DETECT_HALF_HZ = 8_000   # half-bandwidth summed per channel (~16 kHz NFM)


def emit(obj):
    print(json.dumps(obj), flush=True)


class Chain:
    """One channelizer lane: xlating filter + power probe + NBFM + gate."""

    def __init__(self, tb, src, taps, samp_rate, adder, port, same_fd=None,
                 build_power=True, am_port=None):
        self.xlate = grfilter.freq_xlating_fir_filter_ccf(
            samp_rate // QUAD_RATE, taps, 0, samp_rate)
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
        # AM path (airband): envelope detector with CARRIER NORMALIZATION —
        # the envelope is divided by its own slow average (the carrier level),
        # so loudness is RF-independent like the FM demod's, then the DC (=1
        # after normalization) is removed. Without this, audio level rode the
        # raw carrier amplitude and weak-but-readable ATIS played near-silent.
        self.am_mag = blocks.complex_to_mag(1)
        self.am_carrier = grfilter.single_pole_iir_filter_ff(0.0005, 1)  # ~40 ms carrier tracker
        self.am_div = blocks.divide_ff(1)
        self.am_dc = blocks.add_const_ff(-1.0)
        self.am_amp = blocks.multiply_const_ff(AM_GAIN)
        self.am_gate = blocks.multiply_const_ff(0.0)
        # Audio envelope (mean square over ~100 ms) for the per-channel
        # loudness leveler — measured BEFORE the gate so the gain we apply
        # never feeds back into the measurement.
        self.audio_sq = blocks.multiply_ff(1)
        self.audio_avg = blocks.moving_average_ff(
            AUDIO_RATE // 10, 10.0 / AUDIO_RATE)
        self.audio_probe = blocks.probe_signal_f()
        tb.connect(src, self.xlate)
        self.probe = None
        self.probe_fast = None
        if build_power:
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
            tb.connect(self.xlate, self.mag2, self.avg, self.probe)
            tb.connect(self.mag2, self.avg_fast, self.probe_fast)
        tb.connect(self.xlate, self.demod, self.gate)
        # AM path (lane-fit, spec 2026-06-09): built only when this slot ever
        # carries an AM channel (positional union across groups). On FM-only
        # lanes the am_* blocks stay constructed-but-UNCONNECTED — the GR
        # scheduler skips them so they cost no CPU, while assign()/park()/
        # fade_to() can still call am_gate.set_k() as harmless no-ops (an
        # AM channel never lands on an FM-only lane by construction). The adder
        # port is handed in by the builder so connected inputs stay contiguous
        # (GR rejects gaps) regardless of which lanes prune the AM path.
        if am_port is not None:
            tb.connect(self.xlate, self.am_mag)
            tb.connect(self.am_mag, (self.am_div, 0))
            tb.connect(self.am_mag, self.am_carrier, (self.am_div, 1))
            tb.connect(self.am_div, self.am_dc, self.am_amp, self.am_gate)
            tb.connect(self.am_gate, (adder, am_port))
        tb.connect(self.demod, (self.audio_sq, 0))
        tb.connect(self.demod, (self.audio_sq, 1))
        tb.connect(self.audio_sq, self.audio_avg, self.audio_probe)
        # SAME decoder tap (last lane only): demod audio, pre-gate, resampled
        # to multimon-ng's 22.05 kHz s16 and pushed down a pipe. Runs whether
        # or not a weather channel is assigned — a parked lane feeds noise,
        # which decodes to nothing.
        if same_fd is not None:
            self.same_resamp = grfilter.rational_resampler_fff(
                interpolation=147, decimation=320)  # 48k -> 22.05k
            self.same_s16 = blocks.float_to_short(1, SAME_SCALE)
            self.same_sink = blocks.file_descriptor_sink(
                gr.sizeof_short, same_fd)
            tb.connect(self.demod, self.same_resamp, self.same_s16, self.same_sink)
        tb.connect(self.demod, self.noise_hpf)
        tb.connect(self.noise_hpf, (self.noise_sq, 0))
        tb.connect(self.noise_hpf, (self.noise_sq, 1))
        tb.connect(self.noise_sq, self.noise_avg, self.noise_probe)
        tb.connect(self.gate, (adder, port))

        self.gain = 0.0          # current gate value (fade_to bookkeeping)
        self.kind = "fm"         # demod selection: "fm" (nbfm) or "am" (airband)
        self.allow_audio = True  # hear-vs-see: False = detect/report, never speak
        self.audible_cfg = True
        self.alert_until = None
        self.open_db_o = None
        self.quiet_db_o = None
        self.hang_ms_o = None
        self.background = False
        self.rf_samples = []     # received power while open (ERP estimator)
        self.level_db = 0.0      # learned per-channel loudness correction (dB)
        self.level_emitted = 0.0 # last trim value reported to Node
        self.speech_db = None    # smoothed voiced-audio level (leveler input)
        self.priority = False    # preempts non-priority audible when it opens
        self.channel_id = None   # None = parked (no channel assigned)
        self.bin_lo = None       # FFT-detect: cached channel bin range (fft mode)
        self.bin_hi = None
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
        gate = self.am_gate if self.kind == "am" else self.gate
        if self.gain > 0.0 and target > 0.0:
            gate.set_k(target)
            self.gain = target
            return
        start = self.gain
        for i in range(1, FADE_STEPS + 1):
            gate.set_k(start + (target - start) * i / FADE_STEPS)
            time.sleep(FADE_STEP_S)
        self.gain = target

    def reset_detection(self):
        self.floor_db = None
        self.open = False
        self.carrier = False   # instantaneous carrier presence (fast audio gate)
        self.quiet = False     # discriminator quieted (HF noise below threshold)
        self.above_polls = 0
        self.below_since = None
        self.skip_until = 0.0
        self.warmup = WARMUP_POLLS

    def assign(self, channel_id, offset_hz, priority=False, level_db=0.0,
               mode="nfm", audible=True,
               open_db=None, quiet_db=None, hang_ms=None,
               background=False):
        # Background channels (continuous-carrier, e.g. NWR for SAME): the
        # lane demodulates — feeding the decoder tap — but the channel never
        # opens, never holds the hop, never touches the speaker or history.
        self.background = background
        self.channel_id = channel_id
        self.priority = priority
        self.allow_audio = audible
        self.audible_cfg = audible      # restore target when an alert hold ends
        self.alert_until = None         # monotonic deadline of an alert unmute
        # Per-channel squelch profile (banks, ROADMAP Idea 7); None = the
        # process-global --open-db/--quiet-db/--hang-ms defaults.
        self.open_db_o = open_db
        self.quiet_db_o = quiet_db
        self.hang_ms_o = hang_ms
        self.rf_samples = []
        self.kind = "am" if mode == "am" else "fm"
        self.xlate.set_center_freq(offset_hz)
        self.gate.set_k(0.0)   # hard cut is fine: we just retuned, no audio context
        self.am_gate.set_k(0.0)
        self.gain = 0.0
        # Seed the leveler with the channel's PERSISTED trim (tune carries it
        # back from config) so audio resumes at the learned loudness instead
        # of jumping unleveled after every hop/restart.
        self.level_db = float(level_db)
        self.level_emitted = self.level_db
        self.speech_db = None
        self.reset_detection()

    def flush_rf(self):
        n = len(self.rf_samples)
        if n >= 25 and self.channel_id and not self.channel_id.startswith("cc_"):
            med = sorted(self.rf_samples)[n // 2]
            emit({"ev": "rf", "id": self.channel_id,
                  "db": round(med, 1), "n": n})
        self.rf_samples = []

    def park(self):
        self.channel_id = None
        self.bin_lo = None
        self.bin_hi = None
        self.priority = False
        self.allow_audio = True
        self.audible_cfg = True
        self.alert_until = None
        self.open_db_o = None
        self.quiet_db_o = None
        self.hang_ms_o = None
        self.background = False
        self.rf_samples = []
        self.kind = "fm"
        self.xlate.set_center_freq(0)
        self.gate.set_k(0.0)
        self.am_gate.set_k(0.0)
        self.gain = 0.0
        self.reset_detection()

    def power_db(self):
        if self.probe is None:
            return -120.0
        p = self.probe.level()
        return 10 * math.log10(p) if p > 0 else -120.0

    def fast_power_db(self):
        if self.probe_fast is None:
            return -120.0
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
        self.detect_via = args.detect_via

        # Device selection (multi-SDR). Prefer SERIAL: SoapySDR resolves
        # serial=KIOSK01 to the exact dongle regardless of enumeration order —
        # robust where the librtlsdr INDEX shifts between dongles at runtime
        # (the port->index map proved unreliable with two dongles on a hub).
        # Falls back to rtl=N (index) then first-found.
        if args.rtl_serial:
            dev_args = f"driver=rtlsdr,serial={args.rtl_serial}"
        elif args.rtl_index >= 0:
            dev_args = f"driver=rtlsdr,rtl={args.rtl_index}"
        else:
            dev_args = "driver=rtlsdr"
        self.src = soapy.source(dev_args, "fc32", 1, "", "", [""], [""])
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
        # sink "none": a decode-only radio (parked NWR for SAME) has no
        # speaker claim — audio terminates in a null sink until the
        # cross-device arbiter exists (Idea 10 phase 2).
        if args.sink == "none":
            self.sink = blocks.null_sink(gr.sizeof_float)
        else:
            self.sink = audio.sink(AUDIO_RATE, args.sink, True)
        self.connect(self.adder, self.limiter, self.sink)
        # Remote-listening tee (ROADMAP stretch): the exact post-limiter
        # speaker feed, as s16 PCM, down an fd Node inherits. Node MUST
        # always drain it (a full pipe would stall the GR audio thread).
        if args.audio_fd >= 0:
            self.stream_s16 = blocks.float_to_short(1, 28_000)
            self.stream_sink = blocks.file_descriptor_sink(
                gr.sizeof_short, args.audio_fd)
            self.connect(self.limiter, self.stream_s16, self.stream_sink)

        # Channel filter: pass the NFM channel (~16 kHz), reject neighbors.
        taps = firdes.low_pass(1.0, args.rate, 8_000, 4_000)
        # SAME decoder (ROADMAP Idea 11, visiting-slot tier): the LAST lane
        # carries a permanent audio tap into multimon-ng -a EAS. Whatever
        # background channel (NWR) is assigned there gets decoded whenever
        # its window is tuned; a parked lane feeds noise, which decodes to
        # nothing. Absent multimon-ng the tap is simply not built.
        self.same_proc = None
        same_fd = None
        if args.same_enable and shutil.which("multimon-ng"):
            rfd, wfd = os.pipe()
            os.set_inheritable(rfd, True)
            self.same_proc = subprocess.Popen(
                ["multimon-ng", "-t", "raw", "-a", "EAS", "-"],
                stdin=rfd, stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL, close_fds=False, text=True)
            os.close(rfd)
            same_fd = wfd
            threading.Thread(target=self._same_reader, daemon=True).start()
        elif args.same_enable:
            emit({"ev": "log", "msg": "multimon-ng not found: SAME decoding disabled"})
        build_power = (self.detect_via == "lane")
        # Lane-fit (spec 2026-06-09): build only the lanes this config needs
        # (lane_count = busiest group, <= MAX_CHANS) and, on each, only its
        # required demod path. FM is ALWAYS built (operator decision: the
        # leveler, quieting squelch and SAME tap hang off self.demod, so keeping
        # FM avoids any rehang risk); the AM path is built only where the mask
        # says some group places an AM channel ('a'/'b'). AM gate ports are
        # handed out sequentially AFTER the lane_count FM ports so the adder's
        # connected inputs are contiguous (GR rejects gaps). Default mask = all
        # 'b' (both paths on every lane) == the historical fixed-12 behavior.
        lane_count = max(1, min(MAX_CHANS, args.lanes))
        modes = args.lane_modes or ("b" * lane_count)
        am_next = lane_count
        chains = []
        for i in range(lane_count):
            want_am = (modes[i] if i < len(modes) else "b") in ("a", "b")
            am_port = None
            if want_am:
                am_port = am_next
                am_next += 1
            chains.append(Chain(self, self.src, taps, args.rate, self.adder, i,
                                same_fd=(same_fd if i == lane_count - 1 else None),
                                build_power=build_power, am_port=am_port))
        self.chains = chains

        # Close Call: FFT over the full window. Median bin power = noise
        # floor; a sustained peak well above it on a non-configured frequency
        # is a nearby transmission (see close_call_check).
        # Build the window FFT only when something consumes it: Close Call
        # discovery (--close-call) or fft-detect. With Close Call off (and lane
        # detection) this 2048-pt FFT would otherwise run 24/7 for nothing.
        # Toggling closeCall in config respawns the helper, so the build flag
        # always matches the running mode.
        self.cc_probe = None
        if args.close_call or self.detect_via == "fft":
            self.cc_s2v = blocks.stream_to_vector(gr.sizeof_gr_complex, CC_FFT)
            self.cc_fft = grfft.fft_vcc(
                CC_FFT, True, grfft.window.blackmanharris(CC_FFT), True, 1)
            self.cc_mag = blocks.complex_to_mag_squared(CC_FFT)
            self.cc_probe = blocks.probe_signal_vf(CC_FFT)
            self.connect(self.src, self.cc_s2v, self.cc_fft, self.cc_mag, self.cc_probe)
        # FFT-detect: long (floor/open) and short (fast gate) integrations over
        # the same |.|^2 spectrum the Close Call FFT already produces. Built only
        # in fft mode so lane mode pays nothing.
        # Populated only in fft mode; callers (poll/power_levels, Task 5) MUST guard for None.
        self.slow_probe = None
        self.fast_probe = None
        if self.detect_via == "fft":
            self.cc_slow = blocks.moving_average_ff(
                FFT_SLOW_FRAMES, 1.0 / FFT_SLOW_FRAMES, 4000, CC_FFT)
            self.slow_probe = blocks.probe_signal_vf(CC_FFT)
            self.connect(self.cc_mag, self.cc_slow, self.slow_probe)
            self.cc_fast = blocks.moving_average_ff(
                FFT_FAST_FRAMES, 1.0 / FFT_FAST_FRAMES, 4000, CC_FFT)
            self.fast_probe = blocks.probe_signal_vf(CC_FFT)
            self.connect(self.cc_mag, self.cc_fast, self.fast_probe)

        self.cc_enabled = False
        self.cc_db = 15.0
        self.known_hz = set()
        self.cc_cooldown = {}    # rounded freq -> monotonic EXPIRY of suppression
        self.cc_pending = None   # (rounded freq, consecutive count)

        self.center_hz = None
        self.monitor = False     # weather-only: hold chain 0 open, no squelch
        self.audible = None      # chain currently gated into the sink

    # -- commands ------------------------------------------------------------

    def tune(self, center_hz, channels, monitor=False,
             close_call=False, close_call_db=15.0, known_hz=None):
        # Lane-fit: the helper may have built fewer than MAX_CHANS lanes, so the
        # SAME/weather lane is the LAST BUILT lane and truncation is to the built
        # count (lane-fit guarantees no group exceeds it, but stay defensive).
        n = len(self.chains)
        if len(channels) > n:
            emit({"ev": "log",
                  "msg": f"group truncated to {n} channels"})
            channels = channels[:n]
        self.monitor = monitor
        self.cc_enabled = close_call and not monitor
        self.cc_db = float(close_call_db)
        self.known_hz = set(known_hz or [])
        self.cc_pending = None
        self.center_hz = center_hz
        self.src.set_frequency(0, center_hz)
        self.set_audible(None)
        bgs = [c for c in channels if c.get("background")]
        regs = [c for c in channels if not c.get("background")]
        if bgs:
            regs = regs[:n - 1]   # the SAME lane (last built) is spoken for
        for i, chain in enumerate(self.chains):
            is_same_lane = (i == n - 1)
            c = None
            if is_same_lane and bgs:
                c = bgs[0]
            elif not is_same_lane and i < len(regs):
                c = regs[i]
            elif is_same_lane and i < len(regs):
                c = regs[i]   # no background in this group: lane scans normally
            if c is not None:
                chain.assign(c["id"], c["freqHz"] - center_hz,
                             bool(c.get("priority", False)),
                             float(c.get("levelDb", 0.0)),
                             str(c.get("mode", "nfm")),
                             bool(c.get("audible", True)),
                             c.get("openDb"), c.get("quietDb"),
                             c.get("hangMs"),
                             bool(c.get("background", False)))
                chain.bin_lo, chain.bin_hi = channel_bins(
                    c["freqHz"], center_hz, self.args.rate, CC_FFT, DETECT_HALF_HZ)
            else:
                chain.park()
        emit({"ev": "tuned", "centerHz": center_hz})
        if monitor and channels:
            # Monitor mode (weather-only): the operator chose this channel —
            # hold it open and audible with NO squelch. A lone continuously-
            # keyed station (NOAA) can't be squelched against its own carrier.
            chain = self.chains[0]
            chain.open = True
            chain.carrier = True
            chain.quiet = True
            emit({"ev": "open", "id": chain.channel_id, "db": 0})
            self.set_audible(chain)
            chain.fade_to(chain.level_gain())

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

    def chan_power_db(self, chain, slow_vec):
        if self.detect_via == "fft":
            if slow_vec is None or chain.bin_lo is None:
                return -120.0
            return bin_power_db(slow_vec, chain.bin_lo, chain.bin_hi)
        return chain.power_db()

    def chan_fast_power_db(self, chain, fast_vec):
        if self.detect_via == "fft":
            if fast_vec is None or chain.bin_lo is None:
                return -120.0
            return bin_power_db(fast_vec, chain.bin_lo, chain.bin_hi)
        return chain.fast_power_db()

    def poll(self, now):
        g_open_db = self.args.open_db
        g_quiet_db = self.args.quiet_db
        g_hang_s = self.args.hang_ms / 1000.0

        # fft mode: snapshot both FFT power vectors once per poll; the chan_*_db
        # accessors fall back to the per-lane probes in lane mode.
        slow_vec = fast_vec = None
        if self.detect_via == "fft":
            sv = self.slow_probe.level() if self.slow_probe else None
            fv = self.fast_probe.level() if self.fast_probe else None
            slow_vec = np.asarray(sv) if sv and len(sv) == CC_FFT else None
            fast_vec = np.asarray(fv) if fv and len(fv) == CC_FFT else None

        # Pass 1: update per-chain floors (frozen while a chain is open).
        readings = {}
        for chain in self.chains:
            if chain.channel_id is None:
                continue
            db = self.chan_power_db(chain, slow_vec)

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
            if chain.background:
                continue   # decoder-only lane: no squelch, no speaker, no hold
            # Per-channel squelch profile (banks): fall back to the globals.
            open_db = chain.open_db_o if chain.open_db_o is not None else g_open_db
            quiet_db = chain.quiet_db_o if chain.quiet_db_o is not None else g_quiet_db
            hang_s = (chain.hang_ms_o / 1000.0) if chain.hang_ms_o is not None else g_hang_s
            # Expired alert hold: restore the configured mute. If the chain
            # owns the speaker mid-transmission, hand off like a close.
            if chain.alert_until is not None and now >= chain.alert_until:
                chain.alert_until = None
                chain.allow_audio = chain.audible_cfg
                if not chain.allow_audio and self.audible is chain:
                    chain.fade_to(0.0)
                    self.set_audible(self.next_open_chain())
            db = readings[chain.channel_id]
            # RF telemetry for the ERP estimator: received power while open,
            # capped at ~60 s (the first minute is representative).
            if chain.open and len(chain.rf_samples) < 3000:
                chain.rf_samples.append(db)

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
            fast_db = self.chan_fast_power_db(chain, fast_vec)
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
                        if chain.speech_db is None:
                            chain.speech_db = ms_db
                        else:
                            chain.speech_db += LEVEL_EMA_ALPHA * (ms_db - chain.speech_db)
                        desired = max(-LEVEL_MAX_DB, min(LEVEL_MAX_DB,
                                      (LEVEL_REF_DB - chain.speech_db) / 2))
                        err = desired - chain.level_db
                        if abs(err) > LEVEL_DEADBAND_DB:
                            step = max(-LEVEL_SLEW_DOWN, min(LEVEL_SLEW_UP, err))
                            chain.level_db += step
                        # Report meaningful trim movement so Node persists it
                        # (>=0.5 dB hysteresis keeps the event rate trivial).
                        if abs(chain.level_db - chain.level_emitted) >= 0.5:
                            chain.level_emitted = chain.level_db
                            emit({"ev": "level", "id": chain.channel_id,
                                  "db": round(chain.level_db, 1)})
                chain.fade_to(chain.level_gain() if open_now else 0.0)

            if not chain.open:
                if db > floor + open_db and chain.quiet and now >= chain.skip_until:
                    chain.above_polls += 1
                    if chain.above_polls >= OPEN_POLLS:
                        chain.open = True
                        chain.below_since = None
                        emit({"ev": "open", "id": chain.channel_id,
                              "db": round(db, 1)})
                        if not chain.allow_audio:
                            pass               # see-only: report, never speak
                        elif self.audible is None:   # first-active-wins...
                            self.set_audible(chain)
                        elif chain.priority and not self.audible.priority:
                            # ...except priority channels take the speaker
                            # from non-priority ones (hardware-scanner
                            # priority scan).
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
                        chain.flush_rf()
                        emit({"ev": "close", "id": chain.channel_id})
                        if self.audible is chain:
                            self.set_audible(self.next_open_chain())
                        if chain.channel_id.startswith("cc_"):
                            chain.park()   # discovery over: free the lane
                else:
                    chain.below_since = None

    def close_call_check(self, now):
        """Find strong RF on non-configured frequencies in the window."""
        if self.cc_probe is None:
            return   # FFT not built (Close Call off) — nothing to scan
        levels = self.cc_probe.level()
        if not levels or len(levels) != CC_FFT:
            return
        db = 10.0 * np.log10(np.asarray(levels) + 1e-20)
        floor = float(np.median(db))

        rate = self.args.rate
        mask = np.ones(CC_FFT, dtype=bool)
        edge = int(CC_FFT * CC_EDGE_FRAC)
        mask[:edge] = False
        mask[-edge:] = False
        dc = CC_FFT // 2
        dcw = max(1, int(CC_FFT * CC_DC_FRAC))
        mask[dc - dcw:dc + dcw + 1] = False
        # Suppress every known frequency (configured channels — enabled or
        # not — plus anything a lane is currently assigned to).
        suppress = set(self.known_hz)
        for c in self.chains:
            if c.channel_id is not None:
                suppress.add(self.center_hz + c.xlate.center_freq())
        binw = rate / CC_FFT
        for f in suppress:
            b = int(round((f - self.center_hz) / binw)) + dc
            g = int(CC_GUARD_HZ / binw) + 1
            lo, hi = max(0, b - g), min(CC_FFT, b + g + 1)
            if lo < hi:
                mask[lo:hi] = False

        if not mask.any():
            return
        idx = int(np.argmax(np.where(mask, db, -np.inf)))
        if db[idx] < floor + self.cc_db:
            self.cc_pending = None
            return
        # Image rejection: the tuner mirrors strong signals around the
        # window center; the ghost lands at the mirrored bin. If the mirror
        # is markedly stronger than the candidate, the candidate IS the
        # ghost — the classic in-band false Close Call.
        mirror = 2 * dc - idx
        if 0 <= mirror < CC_FFT and db[mirror] > db[idx] + CC_IMAGE_REJECT_DB:
            self.cc_pending = None
            return
        freq = self.center_hz + (idx - dc) * binw
        freq = int(round(freq / CC_RASTER_HZ) * CC_RASTER_HZ)
        expiry = self.cc_cooldown.get(freq)
        if expiry is not None and now < expiry:
            return
        if self.cc_pending and self.cc_pending[0] == freq:
            self.cc_pending = (freq, self.cc_pending[1] + 1)
        else:
            self.cc_pending = (freq, 1)
        if self.cc_pending[1] < CC_CONFIRM:
            return

        self.cc_pending = None
        self.cc_cooldown[freq] = now + CC_COOLDOWN_S
        emit({"ev": "closecall", "freqHz": freq})
        # Listen immediately on a parked lane (priority => preempts). The
        # lane flows through the normal squelch/leveler/fade path and parks
        # itself again when the transmission closes.
        for chain in self.chains:
            if chain.channel_id is None:
                chain.assign(f"cc_{freq}", freq - self.center_hz, priority=True)
                chain.bin_lo, chain.bin_hi = channel_bins(
                    freq, self.center_hz, self.args.rate, CC_FFT, DETECT_HALF_HZ)
                break

    def skip(self, holdoff_s=SKIP_HOLDOFF_S):
        """Scanner SKIP key: force-close whatever owns the speaker.

        A cc lane parks; its frequency is suppressed (cc cooldown) for
        holdoff_s. A regular channel may not reopen for holdoff_s. The
        default is a short bump; a LONG holdoff is temp lockout (cleared
        by an engine restart, hardware-scanner style).
        """
        chain = self.audible
        if chain is None or chain.channel_id is None:
            return
        now = time.monotonic()
        cid = chain.channel_id
        chain.open = False
        chain.above_polls = 0
        chain.below_since = None
        chain.flush_rf()
        emit({"ev": "close", "id": cid})
        self.set_audible(self.next_open_chain())
        if cid.startswith("cc_"):
            try:
                self.cc_cooldown[int(cid[3:])] = now + holdoff_s
            except ValueError:
                pass
            chain.park()
        else:
            chain.skip_until = now + holdoff_s

    def _same_reader(self):
        for line in self.same_proc.stdout:
            line = line.strip()
            # multimon-ng emits "EAS: ZCZC-WXR-TOR-..." and "EAS: NNNN".
            if "ZCZC" in line or "NNNN" in line:
                emit({"ev": "same", "raw": line})

    def alert_unmute(self, channel_id, hold_s):
        """Alert pull-in (ROADMAP Idea 6): route a see-only chain's audio to
        the speaker for hold_s seconds.

        The lane is already demodulating (SEE costs a slot) — this only flips
        allow_audio and lets the normal speaker arbitration run. poll()
        restores the configured mute when the hold expires. Alerts preempt
        like priority hits: the operator flagged this channel as
        interrupt-worthy."""
        now = time.monotonic()
        for chain in self.chains:
            if chain.channel_id == channel_id:
                chain.allow_audio = True
                chain.alert_until = now + hold_s
                if chain.open and self.audible is not chain:
                    self.set_audible(chain)
                break

    def next_open_chain(self):
        best = None
        for chain in self.chains:
            if chain.channel_id is not None and chain.open and chain.allow_audio:
                if chain.priority:
                    return chain   # open priority channel wins the handoff
                if best is None:
                    best = chain
        return best

    def power_levels(self):
        if self.detect_via == "fft":
            sv = self.slow_probe.level() if self.slow_probe else None
            vec = np.asarray(sv) if sv and len(sv) == CC_FFT else None
            return {c.channel_id: round(self.chan_power_db(c, vec), 1)
                    for c in self.chains if c.channel_id is not None}
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
    ap.add_argument("--rtl-index", type=int, default=-1,
                    help="librtlsdr device index (multi-SDR); -1 = first found")
    ap.add_argument("--rtl-serial", type=str, default="",
                    help="RTL-SDR EEPROM serial (multi-SDR); takes precedence "
                         "over --rtl-index — robust against index reordering")
    ap.add_argument("--audio-fd", type=int, default=-1,
                    help="fd to tee the speaker feed to as s16 PCM (remote listen)")
    ap.add_argument("--same-enable", action="store_true",
                    help="spawn the SAME/multimon-ng decoder and tap it onto the "
                         "last lane; off => no decoder process and no tap")
    ap.add_argument("--hang-ms", type=float, default=2000.0,
                    help="sustained silence before close")
    ap.add_argument("--detect-via", choices=["lane", "fft"], default="lane",
                    help="power-detection source: per-lane probes (default) or "
                         "the Close Call FFT")
    ap.add_argument("--close-call", action="store_true",
                    help="build the window FFT for Close Call discovery; omit to "
                         "skip it entirely when Close Call is disabled")
    ap.add_argument("--lanes", type=int, default=MAX_CHANS,
                    help="channelizer lanes to build (<= MAX_CHANS); lane-fit "
                         "sizes this to the busiest group. Default = MAX_CHANS "
                         "(historical fixed-12 behavior)")
    ap.add_argument("--lane-modes", type=str, default="",
                    help="per-lane demod path mask, one char per lane: "
                         "f=FM-only, a=AM(+FM), b=both. Empty = all 'b'. FM is "
                         "always built, so 'a' lanes carry FM+AM")
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
                if cmd.get("cmd") == "known":
                    helper.known_hz = set(cmd.get("knownHz", []))
                if cmd.get("cmd") == "alert_unmute":
                    helper.alert_unmute(cmd["id"], float(cmd.get("holdS", 30.0)))
                if cmd.get("cmd") == "skip":
                    helper.skip(float(cmd.get("holdoffS", SKIP_HOLDOFF_S)))
                if cmd.get("cmd") == "tune":
                    helper.tune(cmd["centerHz"], cmd.get("channels", []),
                                bool(cmd.get("monitor", False)),
                                bool(cmd.get("closeCall", False)),
                                float(cmd.get("closeCallDb", 15.0)),
                                cmd.get("knownHz", []))
            if helper.center_hz is not None and not helper.monitor:
                now_mono = time.monotonic()
                helper.poll(now_mono)
                polls += 1
                if polls % POWER_EVERY == 0:
                    emit({"ev": "power", "levels": helper.power_levels(),
                          "noise": helper.noise_levels()})
                if helper.cc_enabled and polls % CC_EVERY == 0:
                    helper.close_call_check(now_mono)
    finally:
        helper.stop()
        helper.wait()


if __name__ == "__main__":
    sys.stdout.reconfigure(line_buffering=True)
    main()
