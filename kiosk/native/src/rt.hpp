// Real-time thread setup for the DSP thread.
#pragma once
#include <pmmintrin.h>
#include <xmmintrin.h>

namespace kc {
// Flush-to-zero + denormals-are-zero: IIR tails (de-emphasis, AM carrier) decay into subnormals
// on silence, and Haswell pays ~100x per subnormal op. Call once at the top of the DSP thread.
inline void dsp_thread_init() {
  _MM_SET_FLUSH_ZERO_MODE(_MM_FLUSH_ZERO_ON);
  _MM_SET_DENORMALS_ZERO_MODE(_MM_DENORMALS_ZERO_ON);
}
}  // namespace kc
