// RF-derived transmitter power estimation (operator idea).
//
// We know each located channel's DISTANCE (site → QTH) and the helper now
// measures each channel's median received power per transmission (the "rf"
// events, accumulated into channel.rfDb). Invert a path-loss model and the
// licensed power falls out — except for one unknown: the receiver constant
// (antenna gain, coax, tuner gain, dBFS reference). The FCC-licensed
// channels are CALIBRATION ANCHORS: their power is known, so each one
// solves for that constant; the median across anchors is robust to any
// single anchor sitting in a null.
//
// Accuracy is honest-order-of-magnitude: terrain scatter is ±6-10 dB. But
// coverage radii scale with sqrt(P), so even a 4x power error only moves a
// blip 2x — exactly the tolerance the map's coverage circles were designed
// around.

/** Path-loss exponent: 2 = free space; suburban VHF/UHF runs ~2.5-3. */
const PATH_LOSS_EXP = 2.7;
const MIN_WATTS = 1;
const MAX_WATTS = 500;
/** Anchors needed before estimates are trusted at all. */
const MIN_ANCHORS = 3;

export interface Anchor {
  rfDb: number;       // median received power (helper units, relative dB)
  distKm: number;
  freqMhz: number;
  powerWatts: number; // licensed (FCC) — ground truth
}

/** Model path loss in dB (constant offsets absorbed by the solved K). */
export function pathLossDb(distKm: number, freqMhz: number): number {
  const d = Math.max(0.05, distKm) * 1000;
  return 10 * PATH_LOSS_EXP * Math.log10(d) + 20 * Math.log10(freqMhz);
}

/**
 * Solve the receiver constant K from licensed channels:
 *   rfDb = 10*log10(P) - PL(d, f) + K   →   K = rfDb + PL - 10*log10(P)
 * Median across anchors; null when too few to trust.
 */
export function solveK(anchors: Anchor[]): number | null {
  if (anchors.length < MIN_ANCHORS) return null;
  const ks = anchors
    .map((a) => a.rfDb + pathLossDb(a.distKm, a.freqMhz) - 10 * Math.log10(a.powerWatts))
    .sort((a, b) => a - b);
  return ks[Math.floor(ks.length / 2)]!;
}

/** Estimate ERP watts for a measured channel, clamped and 2-sig-fig rounded. */
export function estimateWatts(rfDb: number, distKm: number, freqMhz: number, k: number): number {
  const pDbw = rfDb + pathLossDb(distKm, freqMhz) - k;
  // Regulatory ceilings beat path-loss math: a GMRS machine "measuring"
  // 130 W is a great antenna site, not an illegal transmitter (Part 95
  // caps the main channels at 50 W). The model lumps height into power;
  // the law un-lumps it for us where it can.
  const cap = freqMhz >= 462 && freqMhz < 468 ? 50 : MAX_WATTS;
  const w = Math.min(cap, Math.max(MIN_WATTS, 10 ** (pDbw / 10)));
  // 2 significant figures — the model has no business claiming more.
  const mag = 10 ** Math.floor(Math.log10(w) - 1);
  return Math.round(w / mag) * mag;
}

export function distKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
}
