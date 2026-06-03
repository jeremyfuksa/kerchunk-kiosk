// Pure PCM-energy helpers + squelch state machine.
//
// rtl_fm writes raw signed-16-bit little-endian mono PCM. When the squelch is
// open (a signal is present) the PCM has high amplitude; when scanning/idle it
// is near-silent. We derive active/idle transitions from PCM energy. Everything
// here is pure and clock-free (the caller supplies timestamps) so it can be
// unit-tested with synthetic Buffers.

const FULL_SCALE = 32768;

// Computes RMS amplitude (0..32768) of a chunk of signed-16-bit LE mono PCM.
// Reads complete 2-byte samples; ignores a trailing odd byte if present.
export function rmsAmplitude(pcm: Buffer): number {
  const sampleCount = Math.floor(pcm.length / 2);
  if (sampleCount === 0) return 0;
  let sumSquares = 0;
  for (let i = 0; i < sampleCount; i++) {
    const sample = pcm.readInt16LE(i * 2);
    sumSquares += sample * sample;
  }
  return Math.sqrt(sumSquares / sampleCount);
}

// Converts an RMS amplitude (1..32768) to approximate dBFS (<= 0).
// dbfs = 20 * log10(rms / 32768). rms <= 0 returns -Infinity.
export function amplitudeToDbfs(rms: number): number {
  if (rms <= 0) return -Infinity;
  return 20 * Math.log10(rms / FULL_SCALE);
}

export interface SquelchDetectorOptions {
  openThreshold: number; // rms at/above which signal is considered present
  hangMs: number;        // how long energy must stay BELOW threshold before declaring idle
}

export type SquelchState = "idle" | "active";

export class SquelchDetector {
  private readonly openThreshold: number;
  private readonly hangMs: number;
  private _state: SquelchState = "idle";
  // Timestamp at which energy first dropped below threshold while active.
  // null means we are not currently in a hang window.
  private belowStart: number | null = null;

  constructor(opts: SquelchDetectorOptions) {
    this.openThreshold = opts.openThreshold;
    this.hangMs = opts.hangMs;
  }

  get state(): SquelchState {
    return this._state;
  }

  // Feed one energy reading taken at time `nowMs` (monotonic, ms).
  // Returns a transition string if the state changed this push, else null.
  push(rms: number, nowMs: number): "opened" | "closed" | null {
    const above = rms >= this.openThreshold;

    if (this._state === "idle") {
      if (above) {
        this._state = "active";
        this.belowStart = null;
        return "opened";
      }
      return null;
    }

    // state === "active"
    if (above) {
      // Signal still present: reset any pending hang timer.
      this.belowStart = null;
      return null;
    }

    // Below threshold while active.
    if (this.belowStart === null) {
      // First below-threshold reading: start the hang timer, stay active.
      this.belowStart = nowMs;
      return null;
    }

    if (nowMs - this.belowStart >= this.hangMs) {
      this._state = "idle";
      this.belowStart = null;
      return "closed";
    }

    return null;
  }
}
