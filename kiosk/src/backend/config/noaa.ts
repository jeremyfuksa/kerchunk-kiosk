// kiosk/src/backend/config/noaa.ts
//
// NOAA Weather Radio (NWR) channels. These 7 frequencies are fixed nationwide
// (set by the National Weather Service); every US transmitter uses one of them,
// so the operator picks their local channel rather than typing a frequency.
// NWR is narrowband FM → mode "nfm".

export interface NoaaChannel {
  /** Canonical NWR channel label, e.g. "WX1". */
  label: string;
  /** Frequency in Hz. */
  freq: number;
  /** Frequency in MHz as a display string, e.g. "162.400". */
  mhz: string;
}

export const NOAA_CHANNELS: readonly NoaaChannel[] = [
  { label: "WX2", freq: 162400000, mhz: "162.400" },
  { label: "WX4", freq: 162425000, mhz: "162.425" },
  { label: "WX5", freq: 162450000, mhz: "162.450" },
  { label: "WX3", freq: 162475000, mhz: "162.475" },
  { label: "WX6", freq: 162500000, mhz: "162.500" },
  { label: "WX7", freq: 162525000, mhz: "162.525" },
  { label: "WX1", freq: 162550000, mhz: "162.550" },
] as const;

/** NWR is always narrowband FM. */
export const NOAA_MODE = "nfm" as const;
