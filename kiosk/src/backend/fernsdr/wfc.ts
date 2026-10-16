// Plain waterfall rows (upstream docs/CODEC.md "The waterfall line codec"):
// 1-bit mode (0 temporal, 1 intra from a -100 dB seed), 4-bit Rice k, one
// signed Rice residual per bin, 1 dB units. CbNet never negotiates
// wfc2..wfc5, so frames with any flag bit set are not decoded here.
import { BitReader } from "./bits.js";

export interface WaterfallFrame { flags: number; seq: number; lowHz: number; highHz: number; width: number; payload: Uint8Array }

export function parseWaterfallFrame(buf: Uint8Array): WaterfallFrame | null {
  if (buf.length < 22) return null;
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  return {
    flags: v.getUint8(1), seq: v.getUint16(2, true),
    lowHz: v.getFloat64(4, true), highHz: v.getFloat64(12, true),
    width: v.getUint16(20, true), payload: buf.subarray(22),
  };
}

const LOW = -200, HIGH = 100, SEED = -100;

export class WfcDecoder {
  private prev: number[] | null = null;

  decode(payload: Uint8Array, width: number): number[] | null {
    if (payload.length === 0 || width < 1 || width > 4096) { this.prev = null; return null; }
    const r = new BitReader(payload);
    const mode = r.bit();
    const k = r.bits(4);
    const prev = this.prev;
    if (mode === 0 && (!prev || prev.length !== width)) { this.prev = null; return null; }
    const line = new Array<number>(width);
    for (let i = 0; i < width; i++) {
      const pred = mode === 1 ? (i ? line[i - 1]! : SEED) : prev![i]!;
      const v = pred + r.signedRice(k);
      if (v < LOW || v > HIGH || r.overrun) { this.prev = null; return null; }
      line[i] = v;
    }
    this.prev = line;
    return line;
  }

  reset(): void { this.prev = null; }
}
