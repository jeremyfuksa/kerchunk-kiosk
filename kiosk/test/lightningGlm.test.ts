import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseGlm, readGlm, toFlashes, J2000_MS, type RawGlm } from "../src/backend/lightning/glm.js";

const FIXTURE = join(import.meta.dirname, "fixtures/glm/OR_GLM-L2-LCFA_G19_s20262870229000_e20262870229200_c20262870229219.nc");
// QTH 39.29, -94.5 ± spanDeg/2 (4 x 3)
const KC = { n: 40.79, s: 37.79, e: -92.5, w: -96.5 };
const WORLD = { n: 90, s: -90, e: 180, w: -180 };

describe("parseGlm (real GOES-19 file, values cross-checked with h5py)", () => {
  it("reads every flash and applies the CF scaling", async () => {
    const all = await parseGlm(new Uint8Array(readFileSync(FIXTURE)), WORLD);
    expect(all).toHaveLength(398);
  });

  it("keeps only flashes in the box, time-ordered, with h5py's values", async () => {
    const kc = await parseGlm(new Uint8Array(readFileSync(FIXTURE)), KC);
    expect(kc).toHaveLength(32);
    const [a, b] = kc;
    expect(a!.t).toBe(1791944938919);                 // rounded ms
    expect(a!.lat).toBeCloseTo(39.48687, 4);
    expect(a!.lon).toBeCloseTo(-93.01659, 4);
    expect(a!.energyFj).toBeCloseTo(403.28, 1);
    expect(a!.areaKm2).toBeCloseTo(798.26, 1);
    expect(b!.t).toBe(1791944939495);
    expect(b!.energyFj).toBeCloseTo(50.28, 1);
    expect(b!.areaKm2).toBeCloseTo(145.28, 1);
    for (let i = 1; i < kc.length; i++) expect(kc[i]!.t).toBeGreaterThanOrEqual(kc[i - 1]!.t);
  });

  it("reads product_time as seconds since J2000 noon", async () => {
    const raw = await readGlm(new Uint8Array(readFileSync(FIXTURE)));
    expect(J2000_MS + raw.productTime * 1000).toBe(Date.parse("2026-10-14T02:29:00Z"));
  });

  it("rejects bytes that are not HDF5", async () => {
    await expect(parseGlm(new Uint8Array([1, 2, 3, 4]), KC)).rejects.toThrow();
  });
});

describe("toFlashes", () => {
  const v = (values: number[], scale = 1, offset = 0, unsigned = false) => ({ values, scale, offset, unsigned });
  const raw = (o: Partial<RawGlm> = {}): RawGlm => ({
    productTime: 0, lat: [39], lon: [-94.5],
    time: v([0]), energy: v([0]), area: v([0]), ...o,
  });

  it("a quiet hemisphere (zero flashes) is an empty list, not a throw", () => {
    expect(toFlashes(raw({ lat: [], lon: [], time: v([]), energy: v([]), area: v([]) }), KC)).toEqual([]);
  });

  it("_Unsigned int16 wraps negatives before scaling", () => {
    const [f] = toFlashes(raw({ area: v([-1], 2, 0, true) }), KC);
    expect(f!.areaKm2).toBeCloseTo((65535 * 2) / 1e6, 9);
  });

  it("box edges are inclusive", () => {
    expect(toFlashes(raw({ lat: [40.79], lon: [-96.5] }), KC)).toHaveLength(1);
  });
});
