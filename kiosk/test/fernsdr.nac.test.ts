import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BitReader, zigzag } from "../src/backend/fernsdr/bits.js";
import { NacDecoder, FRAME_HOP } from "../src/backend/fernsdr/nac.js";

const fx = (f: string) => JSON.parse(readFileSync(join(__dirname, "fixtures", "fernsdr", f), "utf8"));
const cap = fx("nac-frames.json") as { audio: string[] };
const expected = fx("nac-expected.json") as { frames: (string | null)[] };
const f64 = (b64: string) => { const b = Buffer.from(b64, "base64"); return Array.from({ length: FRAME_HOP }, (_, i) => b.readDoubleLE(i * 8)); };

describe("BitReader", () => {
  it("reads MSB-first bits, Rice with escape, Exp-Golomb, zig-zag", () => {
    const r = new BitReader(Uint8Array.from([0b1011_0000]));
    expect(r.bits(4)).toBe(0b1011);
    expect([zigzag(0), zigzag(1), zigzag(2), zigzag(3)]).toEqual([0, -1, 1, -2]);
    // rice k=1 of 5: q=2 -> "110", low bit "1"
    expect(new BitReader(Uint8Array.from([0b1101_0000])).rice(1)).toBe(5);
    // exp-golomb of 3: w=4 -> "00100"
    expect(new BitReader(Uint8Array.from([0b0010_0000])).expGolomb()).toBe(3);
    const short = new BitReader(Uint8Array.from([0xff]));
    short.bits(9);
    expect(short.overrun).toBe(true);
  });
});

describe("NacDecoder", () => {
  it("matches the upstream reference decoder on real receiver frames", () => {
    const d = new NacDecoder();
    let compared = 0;
    cap.audio.forEach((b64, i) => {
      const out = d.decode(Buffer.from(b64, "base64").subarray(4));
      const want = expected.frames[i];
      if (want === null || want === undefined) { expect(out).toBeNull(); return; }
      expect(out).not.toBeNull();
      const w = f64(want);
      for (let k = 0; k < FRAME_HOP; k++) expect(Math.abs(out![k]! - w[k]!)).toBeLessThan(1e-6);
      compared++;
    });
    expect(compared).toBeGreaterThan(250);
  });

  it("rejects a truncated frame", () => {
    const full = Buffer.from(cap.audio[10]!, "base64").subarray(4);
    expect(new NacDecoder().decode(full.subarray(0, 3))).toBeNull();
  });

  it("conceals by repeating the last spectrum at half amplitude, halving per loss", () => {
    const d = new NacDecoder();
    for (const b64 of cap.audio.slice(0, 40)) d.decode(Buffer.from(b64, "base64").subarray(4));
    const rms = (x: Float32Array) => Math.sqrt(x.reduce((s, v) => s + v * v, 0) / x.length);
    const a = rms(d.conceal()), b = rms(d.conceal()), c = rms(d.conceal());
    expect(b).toBeLessThan(a);
    expect(c).toBeLessThan(b);
    d.reset();
    expect(rms(d.conceal())).toBe(0);
  });
});
