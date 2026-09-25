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
}  // namespace kc
