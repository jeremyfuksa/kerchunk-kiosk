// Engine knob defaults and limits shared by the backend and the admin UI.
// Zod-free on purpose: the admin bundle imports this at runtime and must not
// pull in zod (schema.ts re-exports these for the backend). HELPER_DEFAULTS
// mirrors kerchunk-dsp's own defaults (native/src/constants.hpp) — the value a
// knob takes when config omits it; test/engineDefaults.test.ts fails on drift.
export { AUTO_DWELL_DEFAULTS, PRIORITY_REVISIT_DEFAULTS } from "../engine/scanSchedule.js";

// Scanner front-end defaults, used when config omits the scan field (the
// engine and the schema's window/rate refine share them).
export const DEFAULT_WINDOW_BANDWIDTH_HZ = 2_400_000;   // measured 2026-09-26: RTL floor -1.4 dB at +-1.0 MHz, -4.8 dB at +-1.2 MHz
export const DEFAULT_LANES_PER_GROUP = 32;
export const DEFAULT_SAMPLE_RATE_HZ = 2_500_000;
// RTL flat passband (grouping keeps channels inside +-flat/2 where free): -1.4 dB at +-1.0 MHz.
export const DEFAULT_FLAT_BANDWIDTH_HZ = 2_000_000;
// A lane is 50 kHz wide: the rate must be a whole number of lanes, and a
// channel's lane can sit no closer than half a lane to the band edge, so the
// usable window is (rate - LANE_HZ).
export const LANE_HZ = 50_000;
export const MAX_LANES_PER_GROUP = 64;   // kerchunk-dsp MAX_LANES (native/src/constants.hpp)
export const MIN_SAMPLE_RATE_HZ = 950_000;   // librtlsdr: 900 001..3 200 000 (and 225 001..300 000); first 50 kHz multiple
export const MAX_SAMPLE_RATE_HZ = 3_200_000;

export const DEFAULT_GROUP_DWELL_MS = 3000;
// Helper liveness watchdogs (scan.helperReadyTimeoutMs / helperSilenceTimeoutMs).
export const DEFAULT_READY_TIMEOUT_MS = 10_000;
export const DEFAULT_SILENCE_TIMEOUT_MS = 5_000;

export const HELPER_DEFAULTS = {
  agcTargetDb: -18,
  agcMaxGainDb: 15,
  agcMinGainDb: -20,
  agcAttackMs: 10,
  agcReleaseMs: 400,
  agcHoldBelowDb: -50,
  limiterCeiling: 0.7,
  limiterReleaseMs: 50,
  fmAudioLpfHz: 2700,
  fmAudioHpfHz: 300,
  // Node-side: omitted = no --am-gain-db flag = 0 dB on top of the helper's fixed AM_GAIN.
  nativeAmGainDb: 0,
} as const;
