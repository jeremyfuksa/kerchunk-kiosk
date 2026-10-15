// Receiver audio (any rate, e.g. 14 250 Hz) → the helper's 50 kHz lane rate.
// Catmull-Rom cubic interpolation, streaming across chunks. The helper's own
// 50→48 kHz resampler and speaker chain follow, so this only needs to be
// clean in the voice band.
export const LANE_RATE = 50_000;

export class Resampler {
  private buf: number[] = [0, 0, 0];   // the last 3 input samples
  private pos = 1;                       // next output position, in buf index units
  private readonly step: number;
  constructor(readonly inRate: number, readonly outRate = LANE_RATE) {
    this.step = inRate / outRate;
  }

  push(x: Float32Array): Float32Array {
    const b = this.buf.concat(Array.from(x));
    const out: number[] = [];
    while (Math.floor(this.pos) + 2 < b.length) {
      const i = Math.floor(this.pos), f = this.pos - i;
      const y0 = b[i - 1]!, y1 = b[i]!, y2 = b[i + 1]!, y3 = b[i + 2]!;
      out.push(y1 + 0.5 * f * (y2 - y0 + f * (2 * y0 - 5 * y1 + 4 * y2 - y3 + f * (3 * (y1 - y2) + y3 - y0))));
      this.pos += this.step;
    }
    this.buf = b.slice(b.length - 3);
    this.pos -= b.length - 3;
    return Float32Array.from(out);
  }
}

export function toS16le(x: Float32Array): Buffer {
  const out = Buffer.alloc(x.length * 2);
  for (let i = 0; i < x.length; i++) {
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round((x[i] ?? 0) * 32767))), i * 2);
  }
  return out;
}
