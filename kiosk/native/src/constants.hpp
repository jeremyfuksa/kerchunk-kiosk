// Every DSP knob for kerchunk-dsp. Spec: docs/superpowers/specs/2026-09-25-native-dsp-engine-design.md §2.
#pragma once

namespace kc {
inline constexpr int LANE_RATE = 50000;            // every lane is decimated to this
inline constexpr int LANE_BINS = 128;              // bins per lane = lane IFFT size (FFT_N = LANE_BINS * rate/LANE_RATE)
inline constexpr double CHAN_CUTOFF_HZ = 8000;     // channel filter -6 dB point
inline constexpr double CHAN_TRANSITION_HZ = 4000; // channel filter transition width
inline constexpr double TAPS_PER_FS_OVER_TW = 3.3; // Hamming tap-count rule: ntaps = 3.3 * fs / tw
inline constexpr int CHUNK_SAMPLES = LANE_RATE / 100;  // 10 ms meter chunk
inline constexpr int SLOW_CHUNKS = 10;                 // slow meter = mean of last 10 chunks (100 ms)
inline constexpr double FM_MAX_DEV_HZ = 5000;      // discriminator +-1.0 at this deviation
inline constexpr double DEEMPH_TAU_S = 75e-6;
inline constexpr double NOISE_HPF_HZ = 8000;       // quieting band lower edge (lane Nyquist is the top)
inline constexpr double NOISE_HPF_TRANSITION_HZ = 2000;
inline constexpr int NOISE_WINDOW = CHUNK_SAMPLES;          // quieting meter window (10 ms)
inline constexpr double AM_CARRIER_TAU_S = 0.04;   // AM carrier tracker (~40 ms)
// FM speaker audio LPF (after de-emphasis, before 50k->48k). GR parity: nbfm_rx low-passes its
// audio at 2.7 kHz with a 0.5 kHz transition (gnuradio/analog/nbfm_rx.py). FM discriminator noise
// rises with frequency, so everything above the voiceband is hiss on a weak signal -- a 20 kHz cut
// here made weak channels audibly hissier than GR (2026-09-26 A/B, bench hiss-ab). AM bypasses it.
// Runtime knob: --audio-lpf-hz (config scan.fmAudioLpfHz).
inline constexpr double SPEAKER_LPF_HZ = 2700;
inline constexpr double SPEAKER_LPF_TRANSITION_HZ = 500;
// FM speaker high-pass: removes the sub-audible CTCSS tone (67-254 Hz) that repeaters and GMRS/
// business users transmit under the voice -- an audible hum GR never filtered either. 6th-order
// Butterworth at 300 Hz: 100 Hz tone ~-38 dB, 150 Hz ~-36 dB, 250 Hz ~-9 dB; voice (>=300 Hz)
// intact. AM bypasses it. Runtime knob: --audio-hpf-hz (config scan.fmAudioHpfHz; 0 = off).
inline constexpr double SPEAKER_HPF_HZ = 300;
inline constexpr int SPEAKER_HPF_ORDER = 6;
// SAME path LPF: multimon-ng's EAS decoder only needs the voiceband (AFSK 1562.5/2083.3 Hz).
inline constexpr double SAME_LPF_HZ = 3500;
inline constexpr double SAME_LPF_TRANSITION_HZ = 1500;
inline constexpr int AUDIO_RATE = 48000;           // speaker/tee rate (50k -> 48k = 24/25)
inline constexpr int SAME_RATE = 22050;            // multimon-ng raw rate (50k -> 22.05k = 441/1000)
inline constexpr double SPEAKER_RS_CUTOFF_HZ = 20000;      // 50k->48k resampler -6 dB point
inline constexpr double SPEAKER_RS_TRANSITION_HZ = 4000;   // 50k->48k resampler transition width
inline constexpr double SAME_RS_CUTOFF_HZ = 10000;         // 50k->22.05k resampler -6 dB point
inline constexpr double SAME_RS_TRANSITION_HZ = 1000;      // 50k->22.05k resampler transition width

// ---- Engine (P1b). GR ran 20 ms polls; the native engine decides every 10 ms chunk, so the
// per-poll rates below are GR's re-timed to the same wall-clock time constants.
// Lane slots are a runtime count (EngineOptions::lanes, CLI --lanes, config scan.lanesPerGroup);
// the background/SAME lane is always the LAST slot. MAX_LANES is only the upper bound --
// native lanes are cheap (parked slots skip their extract + IFFT), the 12 was a GNU Radio cost cap.
inline constexpr int DEFAULT_LANES = 12;
inline constexpr int MAX_LANES = 64;
inline constexpr int POLL_MS = 10;                 // one squelch decision per lane chunk
inline constexpr int OPEN_POLLS = 10;              // 100 ms sustained above threshold to open
inline constexpr double WARMUP_MS = 500;           // per-lane settle time after (re)assignment
inline constexpr int POWER_EVERY_POLLS = 20;       // power telemetry every 200 ms
inline constexpr int CC_EVERY_POLLS = 20;          // Close Call check every 200 ms
inline constexpr double CLOSE_HYST_DB = 3.0;
inline constexpr double GATE_HYST_DB = 1.0;
inline constexpr double QUIET_HYST_DB = 2.0;
// Native quieting threshold (dB of discriminator HF-noise power; lower = more quieted). NOT the GR
// scale (~90 dB apart): GR measured after nbfm_rx's audio LPF. Chosen, not the midpoint of the
// 2026-09-25 real-RF survey (kiosk/bench/RESULTS-2026-09-25-native-p1b.md): that capture's only
// keyed data was one lane's periodic ~15 dB-hot, likely-non-voice source (5 bursts, steady worst
// -29.7 dB) -- no weak/fluttering/voice carrier was observed, so the midpoint isn't trustworthy.
// -6 keeps every dead-window reading out (0/3172 dead rows below -5.0 dB, worst -4.68) while the
// steady keyed reading (-29.7) and a hot +-5 kHz synthetic carrier (-18.9, test_hardening) sit well
// inside it; biased permissive (vs. -7 or tighter) so a weak carrier doesn't get chopped as noise.
// Validated by ear at the P3 A/B, the real check for a threshold this data-starved. Tune live via
// --quiet-db.
inline constexpr double QUIET_DB_DEFAULT = -6.0;
inline constexpr double FLOOR_ALPHA_UP = 0.01005;  // GR 0.02 per 20 ms
inline constexpr double FLOOR_ALPHA_DOWN = 0.1056; // GR 0.2 per 20 ms
inline constexpr double SKIP_HOLDOFF_S = 10.0;
inline constexpr long long AIRBAND_LO_HZ = 118'000'000;   // VHF aviation voice band: Close Call lanes demod AM here
inline constexpr long long AIRBAND_HI_HZ = 137'000'000;
inline constexpr int RF_MAX_SAMPLES = 6000;        // ~60 s of open-power samples
inline constexpr int RF_MIN_SAMPLES = 50;          // ~0.5 s before an rf estimate is emitted
// Squelch-calibration txstat events (instrumentation only): per carrier episode, keep at most this
// many per-poll quiet/power samples (30 s at POLL_MS); later polls still count, samples stop.
inline constexpr int TX_MAX_SAMPLES = 3000;
// ---- Sub-audible squelch: CTCSS tones + DCS codes, detection + gating (subaudio.hpp, ctcss.hpp,
// dcs.hpp). The detectors run only on FM lanes that are open or have a carrier episode in progress
// (Scanner::wants_tone), and share one decimator per lane (SubaudioDecimator):
// block-average SUBAUDIO_DECIM1 discriminator samples (50 kHz -> 2 kHz), low-pass at
// SUBAUDIO_LPF_HZ, keep every 2nd (-> SUBAUDIO_RATE). Every CTCSS tone (67-254.1 Hz) and the DCS
// bitstream (134.4 bit/s NRZ, energy below ~135 Hz) sit in the passband; voice folding onto the
// sub-audible band on the 2:1 step (746-933 Hz) is in the LPF stopband.
inline constexpr int SUBAUDIO_DECIM1 = 25;              // 50 kHz -> 2 kHz block average
inline constexpr int SUBAUDIO_RATE = LANE_RATE / SUBAUDIO_DECIM1 / 2;   // 1 kHz detector rate
inline constexpr double SUBAUDIO_LPF_HZ = 350;          // 2 kHz-rate FIR -6 dB point
inline constexpr double SUBAUDIO_LPF_TRANSITION_HZ = 200;  // -> 33 taps
// -- CTCSS (CtcssDetector): every CTCSS_HOP_MS a Goertzel per standard tone over CTCSS_WINDOW_MS.
inline constexpr int CTCSS_WINDOW_MS = 400;             // Goertzel window: 2.5 Hz resolution (tightest
                                                        // EIA spacing is 67.0/69.3 = 2.3 Hz)
inline constexpr int CTCSS_HOP_MS = 100;                // one tone decision per 100 ms
// Detected = the strongest tone's power exceeds the mean of the other 49 by this much. On pure
// noise the max of 50 bins is ~6.5 dB over the mean, so 10 dB keeps random picks rare (and a
// random pick must also repeat CTCSS_STABLE_HOPS times on the same tone).
inline constexpr double CTCSS_MARGIN_DB = 10.0;
// Absolute floor: mean-square dB of the tone at the discriminator scale (+-1.0 = FM_MAX_DEV_HZ).
// A standard 0.5-0.75 kHz-deviation tone (amplitude 0.10-0.15) reads about -23..-19 dB; -40 dB
// (~70 Hz deviation) rejects residual hum/rumble yet keeps a low-deviation encoder.
inline constexpr double CTCSS_FLOOR_DB = -40.0;
inline constexpr int CTCSS_STABLE_HOPS = 2;             // same tone on this many hops in a row = detected
inline constexpr double CTCSS_MATCH_HZ = 1.0;           // detected tone must be within this of ctcssHz
inline constexpr double CTCSS_LOSS_MS = 300;            // open tone channel: tone gone this long mutes the gate
// -- DCS (DcsDetector): 23-bit Golay(23,12) word repeated back to back, NRZ at DCS_BITRATE. The
// detector low-passes the 1 kHz stream again (voice that survived the shared LPF), removes DC with a
// one-word moving average, recovers bit timing from zero crossings, integrates-and-dumps each bit
// and matches the last 23 bits against every rotation of every standard code.
inline constexpr double DCS_BITRATE = 134.4;            // bit/s (TIA-603 / ETSI TS 103 236)
inline constexpr int DCS_WORD_BITS = 23;
inline constexpr double DCS_LPF_HZ = 180;               // 1 kHz-rate FIR -6 dB point: keeps the NRZ
inline constexpr double DCS_LPF_TRANSITION_HZ = 160;    // eye (<~135 Hz), stopband from ~260 Hz; 21 taps
// Clock recovery: each zero crossing pulls the bit clock by this fraction of its phase error
// (first-order loop; converges in a handful of transitions, tracks >1% encoder rate error).
inline constexpr double DCS_CLOCK_GAIN = 0.2;
// Detected = the same code matched exactly (no error correction) on this many consecutive 23-bit
// periods (2 = ~0.34 s). A random bit stream confirms a false code about once per 1e9 bits.
inline constexpr int DCS_MATCH_PERIODS = 2;
// Once detected, a single exact 23-bit match of the same code keeps it; the lock is dropped after
// this many bits without one (a new code must then confirm from scratch).
inline constexpr int DCS_RELOCK_BITS = 2 * DCS_WORD_BITS;
// Open DCS channel: code gone this long mutes the gate. One bit error blanks the exact match for
// 23 bits (171 ms), so this rides through isolated errors under voice; longer than CTCSS_LOSS_MS.
inline constexpr double DCS_LOSS_MS = 400;
inline constexpr int FADE_SAMPLES = 288;           // 6 ms at 48 kHz; only on silence edges
inline constexpr float RAIL = 0.8f;                // hard speaker guard (last resort, after the limiter)
// ---- Speaker loudness (replaced the per-channel level-trim learner). Every default below is a
// runtime knob: --agc-* / --limiter-* on the CLI, config.audio.agc* / limiter* in Node.
// AGC: feed-forward, per sample at LANE_RATE right after the demod. Levels are mean-square dBFS
// of the demodulated audio (a full-scale sine is -3 dB).
inline constexpr double AGC_TARGET_DB = -18;       // output level the AGC steers every talker to
inline constexpr double AGC_MAX_GAIN_DB = 15;      // most boost (quiet talker / weak AM)
inline constexpr double AGC_MIN_GAIN_DB = -20;     // most cut (hot talker)
inline constexpr double AGC_ATTACK_MS = 10;        // envelope tau while the level rises
inline constexpr double AGC_RELEASE_MS = 400;      // envelope tau while it falls
inline constexpr double AGC_HOLD_BELOW_DB = -50;   // short-term level below this = pause: freeze
inline constexpr double AGC_DETECT_MS = 5;         // envelope's short-term mean-square detector tau (not a CLI knob)
inline constexpr double AGC_PAUSE_DETECT_MS = 1;   // faster detector for the pause-hold test only (not a CLI knob)
inline constexpr int AGC_BLOCK = 32;               // gain decision every 32 samples (0.64 ms); glided between
// Peak limiter at AUDIO_RATE after the gate gain + fade, before the RAIL clamp.
inline constexpr double LIMITER_CEILING = 0.7;     // linear; must be <= RAIL
inline constexpr double LIMITER_RELEASE_MS = 50;
inline constexpr float AM_GAIN = 0.7f;
inline constexpr float SPEAKER_S16_SCALE = 32767.f;
inline constexpr float TEE_S16_SCALE = 28000.f;
inline constexpr float SAME_S16_SCALE = 16384.f;
inline constexpr int CC_FFT = 2048;
inline constexpr int CC_FPS = 20;
inline constexpr int CC_CONFIRM = 2;
inline constexpr double CC_COOLDOWN_S = 300;
inline constexpr double CC_RASTER_HZ = 12500;
inline constexpr double CC_IMAGE_REJECT_DB = 6.0;
inline constexpr double CC_GUARD_HZ = 12500;
inline constexpr double CC_DC_FRAC = 0.02;
inline constexpr double CC_EDGE_FRAC = 0.10;
inline constexpr double CC_DB_DEFAULT = 15.0;

// ---- Live I/O (P1c)
inline constexpr int IQ_BLOCK_BYTES = 48000;       // max 10 ms of u8 IQ at 2.4 Msps (blocks are <= 10 ms at any rate)
inline constexpr int IQ_RING_BLOCKS = 64;          // ~640 ms of IQ buffering between USB and DSP (RtlSource coalesces USB transfers into 10 ms blocks)
inline constexpr int RTL_BUF_NUM = 4;              // librtlsdr async buffers (small: bounds in-flight samples on retune)
inline constexpr int RTL_BUF_LEN = 16384;          // bytes per async buffer (~3.4 ms at 2.4 Msps; multiple of 512)
inline constexpr double RETUNE_SETTLE_MS = 20;     // PLL margin discarded after a retune, ON TOP of one full RTL_BUF_LEN USB transfer (LiveLoop)
inline constexpr int RETUNE_ATTEMPTS = 3;         // rtlsdr_set_center_freq tries before the helper gives up (exit 3)
inline constexpr int RETUNE_RETRY_MS = 5;          // pause between those tries
inline constexpr double STALL_S = 2.0;             // no samples this long = SDR loss -> exit 3
inline constexpr double BUSY_RETRY_S = 3.0;        // retry rtlsdr_open this long (previous helper releasing)
inline constexpr int ALSA_PERIOD = 480;            // 10 ms at 48 kHz
inline constexpr unsigned ALSA_LATENCY_US = 60000; // requested device buffer latency
// A busy hw/plughw device makes a blocking snd_pcm_open sleep in the kernel indefinitely (and
// SIGTERM can't break it: SA_RESTART). Open non-blocking and retry -EBUSY/-EAGAIN this long,
// every ALSA_BUSY_RETRY_MS, before failing (the previous helper may still be releasing the card).
inline constexpr double ALSA_BUSY_RETRY_S = 3.0;
inline constexpr int ALSA_BUSY_RETRY_MS = 100;
// Upper bound on the whole live teardown once the main loop exits (src/ALSA/pump/multimon stops
// run sequentially, and a sick USB device or sound card can wedge any of them -- exactly on the
// stall/exit-3 path). A watchdog _Exit(4)s past this. Node SIGKILLs after 500 ms on a respawn,
// but a plain service stop may not, so the helper bounds itself.
inline constexpr int SHUTDOWN_DEADLINE_MS = 1500;
inline constexpr int AUDIO_RING = 32768;           // speaker ring (~680 ms)
inline constexpr int AUDIO_MAX_LAT = 7200;         // above 150 ms queued, trim ...
inline constexpr int AUDIO_TARGET_LAT = 2400;      // ... down to 50 ms (SDR vs ALSA clock drift)
inline constexpr int TEE_RING = 96000;             // fd-3 tee ring (2 s)
// multimon-ng (SAME) child restarts: a crash loop gives up after MULTIMON_MAX_RESPAWNS quick
// restarts, but a child that ran at least MULTIMON_HEALTHY_S before dying earns the budget back --
// otherwise one crash a day would end SAME decoding for the rest of the helper's life.
inline constexpr int MULTIMON_MAX_RESPAWNS = 3;
inline constexpr double MULTIMON_HEALTHY_S = 60.0;
inline constexpr int SAME_RING = 44100;            // multimon ring (2 s at 22.05 kHz)
inline constexpr double DROP_LOG_EVERY_S = 10.0;   // rate limit for the IQ-drop log line
inline constexpr double AUDIO_STATS_EVERY_S = 60.0; // speaker-output loss summary cadence (logged only if nonzero)
inline constexpr int CMD_QUEUE = 256;
}  // namespace kc
