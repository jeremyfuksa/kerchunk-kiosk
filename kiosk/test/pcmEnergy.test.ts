import { describe, it, expect } from "vitest";
import {
  rmsAmplitude,
  amplitudeToDbfs,
  SquelchDetector,
} from "../src/backend/engine/pcmEnergy.js";

function int16Buf(values: number[]): Buffer {
  const buf = Buffer.alloc(values.length * 2);
  values.forEach((v, i) => buf.writeInt16LE(v, i * 2));
  return buf;
}

describe("rmsAmplitude", () => {
  it("returns 0 for an all-zero buffer", () => {
    expect(rmsAmplitude(int16Buf([0, 0, 0, 0]))).toBe(0);
  });

  it("returns 0 for an empty buffer", () => {
    expect(rmsAmplitude(Buffer.alloc(0))).toBe(0);
  });

  it("returns ~constant amplitude for constant max-positive samples", () => {
    const buf = int16Buf([30000, 30000, 30000, 30000, 30000, 30000]);
    expect(rmsAmplitude(buf)).toBeCloseTo(30000, 0);
  });

  it("ignores a trailing odd byte without throwing", () => {
    const buf = int16Buf([30000, 30000]);
    const odd = Buffer.concat([buf, Buffer.from([0x7f])]);
    expect(() => rmsAmplitude(odd)).not.toThrow();
    expect(rmsAmplitude(odd)).toBeCloseTo(30000, 0);
  });

  it("computes RMS of mixed positive and negative samples", () => {
    // values +/- 10000 => RMS is 10000
    const buf = int16Buf([10000, -10000, 10000, -10000]);
    expect(rmsAmplitude(buf)).toBeCloseTo(10000, 0);
  });
});

describe("amplitudeToDbfs", () => {
  it("returns ~0 dBFS at full scale (32768)", () => {
    expect(amplitudeToDbfs(32768)).toBeCloseTo(0, 5);
  });

  it("returns ~-20 dBFS at 3277", () => {
    expect(amplitudeToDbfs(3277)).toBeCloseTo(-20, 0.5);
  });

  it("returns -Infinity for rms 0", () => {
    expect(amplitudeToDbfs(0)).toBe(-Infinity);
  });

  it("returns -Infinity for negative rms", () => {
    expect(amplitudeToDbfs(-5)).toBe(-Infinity);
  });
});

describe("SquelchDetector", () => {
  const opts = { openThreshold: 1000, hangMs: 500 };

  it("starts in idle state", () => {
    const d = new SquelchDetector(opts);
    expect(d.state).toBe("idle");
  });

  it("opens when rms >= threshold while idle", () => {
    const d = new SquelchDetector(opts);
    expect(d.push(1000, 0)).toBe("opened");
    expect(d.state).toBe("active");
  });

  it("does not open when rms below threshold while idle", () => {
    const d = new SquelchDetector(opts);
    expect(d.push(999, 0)).toBe(null);
    expect(d.state).toBe("idle");
  });

  it("stays active and returns null when rms remains above threshold", () => {
    const d = new SquelchDetector(opts);
    d.push(2000, 0);
    expect(d.push(2000, 100)).toBe(null);
    expect(d.state).toBe("active");
  });

  it("first below-threshold push stays active and returns null (starts hang timer)", () => {
    const d = new SquelchDetector(opts);
    d.push(2000, 0);
    expect(d.push(500, 100)).toBe(null);
    expect(d.state).toBe("active");
  });

  it("closes once below-threshold time reaches hangMs", () => {
    const d = new SquelchDetector(opts);
    d.push(2000, 0);
    d.push(500, 100); // belowStart = 100
    expect(d.push(500, 600)).toBe("closed"); // 600-100 = 500 >= hangMs
    expect(d.state).toBe("idle");
  });

  it("does not close before hangMs elapses", () => {
    const d = new SquelchDetector(opts);
    d.push(2000, 0);
    d.push(500, 100);
    expect(d.push(500, 599)).toBe(null); // 599-100 = 499 < 500
    expect(d.state).toBe("active");
  });

  it("cancels hang timer if energy rises back above threshold", () => {
    const d = new SquelchDetector(opts);
    d.push(2000, 0);
    d.push(500, 100); // below, hang starts
    expect(d.push(2000, 200)).toBe(null); // back above, cancel
    expect(d.state).toBe("active");
    // now go below again; hang restarts from new timestamp
    d.push(500, 300); // belowStart = 300
    expect(d.push(500, 799)).toBe(null); // 799-300 = 499 < 500
    expect(d.push(500, 800)).toBe("closed"); // 800-300 = 500
    expect(d.state).toBe("idle");
  });

  it("returns null on pushes that do not change state", () => {
    const d = new SquelchDetector(opts);
    expect(d.push(0, 0)).toBe(null);
    expect(d.push(100, 50)).toBe(null);
  });

  it("can reopen after closing", () => {
    const d = new SquelchDetector(opts);
    d.push(2000, 0);
    d.push(0, 100);
    expect(d.push(0, 600)).toBe("closed");
    expect(d.push(2000, 700)).toBe("opened");
    expect(d.state).toBe("active");
  });
});
