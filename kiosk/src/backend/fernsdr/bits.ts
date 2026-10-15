// MSB-first bit reader for FernSDR's NAC and WFC bitstreams (upstream
// docs/CODEC.md "Shared conventions"). Reading past the end sets `overrun`
// and yields zeros; callers must discard the frame.
const RICE_ESCAPE = 24;

export function zigzag(u: number): number {
  return u % 2 === 0 ? u / 2 : -(u + 1) / 2;
}

export class BitReader {
  overrun = false;
  private pos = 0;
  constructor(private readonly data: Uint8Array) {}

  bit(): number {
    if (this.pos >= this.data.length * 8) { this.overrun = true; return 0; }
    const v = ((this.data[this.pos >> 3] ?? 0) >> (7 - (this.pos & 7))) & 1;
    this.pos++;
    return v;
  }

  /** Up to 32 bits, as a non-negative number (no 32-bit sign wrap). */
  bits(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) v = v * 2 + this.bit();
    return v;
  }

  rice(k: number): number {
    let q = 0;
    while (this.bit()) {
      q++;
      if (q >= RICE_ESCAPE) { this.bit(); return this.bits(32); }
      if (this.overrun) return 0;
    }
    return q * 2 ** k + (k ? this.bits(k) : 0);
  }

  signedRice(k: number): number { return zigzag(this.rice(k)); }

  expGolomb(): number {
    let lead = 0;
    while (!this.bit()) {
      lead++;
      if (lead > 32 || this.overrun) { this.overrun = true; return 0; }
    }
    let v = 1;
    for (let i = 0; i < lead; i++) v = v * 2 + this.bit();
    return v - 1;
  }

  signedExpGolomb(): number { return zigzag(this.expGolomb()); }
}
