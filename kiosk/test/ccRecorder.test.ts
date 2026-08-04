import { describe, it, expect } from "vitest";
import { decimate48kTo8k, encodeWav8k, PrerollRing } from "../src/backend/ccRecorder.js";

function s16(samples: number[]): Buffer {
  const buf = Buffer.alloc(samples.length * 2);
  samples.forEach((v, i) => buf.writeInt16LE(v, i * 2));
  return buf;
}
function readS16(buf: Buffer): number[] {
  const out: number[] = [];
  for (let i = 0; i < buf.length / 2; i++) out.push(buf.readInt16LE(i * 2));
  return out;
}

describe("decimate48kTo8k", () => {
  it("averages each run of six samples into one", () => {
    const out = decimate48kTo8k(s16([0, 0, 0, 60, 60, 60, 12, 12, 12, 12, 12, 12]));
    expect(readS16(out)).toEqual([30, 12]);
  });

  it("drops a trailing partial run rather than distorting it", () => {
    const out = decimate48kTo8k(s16([6, 6, 6, 6, 6, 6, 100, 100]));
    expect(readS16(out)).toEqual([6]);
  });

  it("preserves negative amplitudes", () => {
    const out = decimate48kTo8k(s16([-30, -30, -30, -30, -30, -30]));
    expect(readS16(out)).toEqual([-30]);
  });
});

describe("encodeWav8k", () => {
  it("writes a 44-byte 8 kHz mono s16 header ahead of the data", () => {
    const data = s16([1, 2, 3, 4]);
    const wav = encodeWav8k(data);
    expect(wav.length).toBe(44 + data.length);
    expect(wav.subarray(0, 4).toString()).toBe("RIFF");
    expect(wav.readUInt32LE(4)).toBe(36 + data.length);
    expect(wav.subarray(8, 12).toString()).toBe("WAVE");
    expect(wav.readUInt16LE(20)).toBe(1);      // PCM
    expect(wav.readUInt16LE(22)).toBe(1);      // mono
    expect(wav.readUInt32LE(24)).toBe(8000);   // sample rate
    expect(wav.readUInt32LE(28)).toBe(16000);  // byte rate
    expect(wav.readUInt16LE(32)).toBe(2);      // block align
    expect(wav.readUInt16LE(34)).toBe(16);     // bits
    expect(wav.subarray(36, 40).toString()).toBe("data");
    expect(wav.readUInt32LE(40)).toBe(data.length);
    expect(wav.subarray(44)).toEqual(data);
  });
});

describe("PrerollRing", () => {
  it("returns everything written while under capacity", () => {
    const ring = new PrerollRing(8);
    ring.write(s16([1, 2]));
    expect(readS16(ring.read())).toEqual([1, 2]);
  });

  it("keeps only the most recent bytes once it wraps, in order", () => {
    const ring = new PrerollRing(8); // 4 samples
    ring.write(s16([1, 2, 3, 4]));
    ring.write(s16([5, 6]));
    expect(readS16(ring.read())).toEqual([3, 4, 5, 6]);
  });

  it("handles a single write larger than capacity", () => {
    const ring = new PrerollRing(8);
    ring.write(s16([1, 2, 3, 4, 5, 6, 7]));
    expect(readS16(ring.read())).toEqual([4, 5, 6, 7]);
  });

  it("clear() empties it", () => {
    const ring = new PrerollRing(8);
    ring.write(s16([1, 2]));
    ring.clear();
    expect(ring.read().length).toBe(0);
  });
});
