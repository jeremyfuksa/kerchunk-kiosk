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
inline constexpr int SPEECH_WINDOW = 10 * CHUNK_SAMPLES;    // leveler speech meter window (100 ms)
inline constexpr double AM_CARRIER_TAU_S = 0.04;   // AM carrier tracker (~40 ms)
inline constexpr double AUDIO_LPF_HZ = 3500;
inline constexpr double AUDIO_LPF_TRANSITION_HZ = 1500;
inline constexpr int AUDIO_RATE = 48000;           // speaker/tee rate (50k -> 48k = 24/25)
inline constexpr int SAME_RATE = 22050;            // multimon-ng raw rate (50k -> 22.05k = 441/1000)
inline constexpr double SPEAKER_RS_CUTOFF_HZ = 20000;      // 50k->48k resampler -6 dB point
inline constexpr double SPEAKER_RS_TRANSITION_HZ = 4000;   // 50k->48k resampler transition width
inline constexpr double SAME_RS_CUTOFF_HZ = 10000;         // 50k->22.05k resampler -6 dB point
inline constexpr double SAME_RS_TRANSITION_HZ = 1000;      // 50k->22.05k resampler transition width

// ---- Engine (P1b). GR ran 20 ms polls; the native engine decides every 10 ms chunk, so the
// per-poll rates below are GR's re-timed to the same wall-clock time constants.
inline constexpr int MAX_LANES = 12;               // fixed lane slots; background/SAME lane = last slot
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
inline constexpr double LEVEL_REF_DB = -14;
inline constexpr double LEVEL_MIN_DB = -40;
inline constexpr double LEVEL_MAX_DB = 12;
inline constexpr double LEVEL_SLEW_DOWN = 0.04;    // dB per poll (~4 dB/s)
inline constexpr double LEVEL_SLEW_UP = 0.02;      // dB per poll (~2 dB/s)
inline constexpr double LEVEL_EMA_ALPHA = 0.01511; // GR 0.03 per 20 ms (~0.7 s)
inline constexpr double LEVEL_DEADBAND_DB = 4.0;
inline constexpr double LEVEL_EMIT_STEP_DB = 0.5;
inline constexpr double SKIP_HOLDOFF_S = 10.0;
inline constexpr int RF_MAX_SAMPLES = 6000;        // ~60 s of open-power samples
inline constexpr int RF_MIN_SAMPLES = 50;          // ~0.5 s before an rf estimate is emitted
inline constexpr int FADE_SAMPLES = 288;           // 6 ms at 48 kHz; only on silence edges
inline constexpr float RAIL = 0.8f;                // hard speaker guard
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
}  // namespace kc
