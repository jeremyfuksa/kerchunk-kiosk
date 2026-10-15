// Plain NAC decoder (FernSDR's MDCT audio codec, upstream docs/CODEC.md):
// dequantise, inverse MDCT, sine window, overlap-add. CbNet never negotiates
// nac2/nac3, so only the original frame layout is decoded. The direct
// 256x128 IMDCT is ~32k multiply-adds a frame — trivial at ~111 frames/s.
import { BitReader } from "./bits.js";

export const FRAME_HOP = 128;
const BAND_WIDTHS = [4, 4, 4, 4, 4, 4, 4, 4, 8, 8, 8, 8, 8, 8, 16, 16, 16];
const BAND_STARTS = BAND_WIDTHS.map((_, b) => BAND_WIDTHS.slice(0, b).reduce((s, w) => s + w, 0));
const EXPONENT_REFERENCE = -40;
const MAX_COEFFICIENT = 1e7;   // larger is not receiver audio: reject the frame

const riceK = (quality: number): number => Math.max(0, Math.min(20, Math.floor(quality / 4) - 1));

const M = FRAME_HOP;
const WINDOW = Float64Array.from({ length: 2 * M }, (_, n) => Math.sin((Math.PI / (2 * M)) * (n + 0.5)));
const COSINE = (() => {
  const t = new Float64Array(2 * M * M);
  for (let n = 0; n < 2 * M; n++)
    for (let k = 0; k < M; k++) t[n * M + k] = Math.cos((Math.PI / M) * (n + 0.5 + M / 2) * (k + 0.5));
  return t;
})();

export class NacDecoder {
  private overlap = new Float64Array(M);
  private last: Float64Array | null = null;
  private concealGain = 1;

  /** One plain NAC frame → 128 samples, or null when malformed. */
  decode(payload: Uint8Array): Float32Array | null {
    const r = new BitReader(payload);
    const quality = r.bits(6);
    const active = BAND_WIDTHS.map(() => r.bit());
    const exps = new Array<number>(BAND_WIDTHS.length).fill(0);
    let prev = EXPONENT_REFERENCE;
    for (let b = 0; b < BAND_WIDTHS.length; b++) {
      if (!active[b]) continue;
      prev += r.signedExpGolomb();
      if (prev < -200 || prev > 200 || r.overrun) return null;
      exps[b] = prev;
    }
    const k = riceK(quality);
    const coeffs = new Float64Array(M);
    for (let b = 0; b < BAND_WIDTHS.length; b++) {
      if (!active[b]) continue;
      const step = 2 ** (((exps[b] ?? 0) - quality) * 0.25);
      const start = BAND_STARTS[b] ?? 0;
      for (let i = 0; i < (BAND_WIDTHS[b] ?? 0); i++) {
        const v = r.signedRice(k) * step;
        if (Math.abs(v) > MAX_COEFFICIENT) return null;
        coeffs[start + i] = v;
      }
    }
    if (r.overrun) return null;
    this.last = coeffs;
    this.concealGain = 1;
    return this.synthesise(coeffs);
  }

  /** One frame of concealment: the previous spectrum at half amplitude,
   *  halving again per consecutive loss. Keeps the sample clock intact. */
  conceal(): Float32Array {
    this.concealGain *= 0.5;
    const c = new Float64Array(M);
    if (this.last) for (let i = 0; i < M; i++) c[i] = (this.last[i] ?? 0) * this.concealGain;
    return this.synthesise(c);
  }

  /** Discontinuity / retune: drop the MDCT overlap and concealment memory. */
  reset(): void {
    this.overlap.fill(0);
    this.last = null;
    this.concealGain = 1;
  }

  private synthesise(c: Float64Array): Float32Array {
    const out = new Float32Array(M);
    const scale = 2 / M;
    for (let n = 0; n < 2 * M; n++) {
      let acc = 0;
      const row = n * M;
      for (let k = 0; k < M; k++) {
        const v = c[k] ?? 0;
        if (v) acc += v * (COSINE[row + k] ?? 0);
      }
      const value = acc * scale * (WINDOW[n] ?? 0);
      if (n < M) out[n] = (this.overlap[n] ?? 0) + value;
      else this.overlap[n - M] = value;
    }
    return out;
  }
}
