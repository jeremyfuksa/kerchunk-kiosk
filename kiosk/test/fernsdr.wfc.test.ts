import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { WfcDecoder, parseWaterfallFrame } from "../src/backend/fernsdr/wfc.js";
import { Resampler, toS16le } from "../src/backend/fernsdr/resample.js";

const fx = (f: string) => JSON.parse(readFileSync(join(__dirname, "fixtures", "fernsdr", f), "utf8"));
const cap = fx("nac-frames.json") as { rows: string[] };
const expected = fx("nac-expected.json") as { rows: (number[] | null)[] };

describe("WFC rows", () => {
  it("parse the header and match the upstream reference decoder", () => {
    const d = new WfcDecoder();
    let compared = 0;
    cap.rows.forEach((b64, i) => {
      const f = parseWaterfallFrame(Buffer.from(b64, "base64"))!;
      expect(f.highHz).toBeGreaterThan(f.lowHz);
      const line = d.decode(f.payload, f.width);
      const want = expected.rows[i];
      if (want === null || want === undefined) { expect(line).toBeNull(); return; }
      expect(line).toEqual(want);
      compared++;
    });
    expect(compared).toBeGreaterThan(20);
  });

  it("rejects a temporal row with no history", () => {
    const d = new WfcDecoder();
    // mode bit 0 (temporal), k=0, one residual "0" -> needs a previous row
    expect(d.decode(Uint8Array.from([0b0000_0000, 0]), 1)).toBeNull();
  });

  it("decodes an intra row from the -100 dB seed", () => {
    // mode 1, k=0000, three Rice-k0 zero residuals => [-100,-100,-100]
    expect(new WfcDecoder().decode(Uint8Array.from([0b1000_0000, 0b0000_0000]), 3)).toEqual([-100, -100, -100]);
  });

  it("short frames are null", () => {
    expect(parseWaterfallFrame(Uint8Array.from([2, 0, 0]))).toBeNull();
  });
});

describe("Resampler", () => {
  it("emits ~outRate/inRate samples per input and preserves DC", () => {
    const r = new Resampler(14_250);
    let n = 0, last = 0;
    for (let i = 0; i < 100; i++) { const y = r.push(new Float32Array(128).fill(0.5)); n += y.length; if (y.length) last = y[y.length - 1]!; }
    expect(Math.abs(n - (12_800 * 50_000) / 14_250)).toBeLessThan(4);
    expect(last).toBeCloseTo(0.5, 6);
  });

  it("keeps a 1 kHz tone at 1 kHz", () => {
    const r = new Resampler(14_250);
    const x = Float32Array.from({ length: 14_250 }, (_, i) => Math.sin((2 * Math.PI * 1000 * i) / 14_250));
    const y = r.push(x);
    let crossings = 0;
    for (let i = 1000; i < y.length; i++) if ((y[i - 1]! < 0) !== (y[i]! < 0)) crossings++;
    const seconds = (y.length - 1000) / 50_000;
    expect(crossings / 2 / seconds).toBeGreaterThan(990);
    expect(crossings / 2 / seconds).toBeLessThan(1010);
  });

  it("toS16le clamps and scales", () => {
    expect([...toS16le(Float32Array.from([0, 1, -1, 2]))]).toEqual([0, 0, 0xff, 0x7f, 0x01, 0x80, 0xff, 0x7f]);
  });
});
