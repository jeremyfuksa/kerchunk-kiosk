import { describe, it, expect } from "vitest";
import { familyFor, ccAudibleRanges } from "../src/backend/config/family.js";
import { serviceFor } from "../src/backend/config/banks.js";
import { categoryFor } from "../src/frontend/lib/serviceColor.js";

describe("familyFor (shared backend/frontend classifier)", () => {
  it("classifies by allocation", () => {
    expect(familyFor(127_250_000)).toBe("air");
    expect(familyFor(146_790_000)).toBe("ham");
    expect(familyFor(160_920_000)).toBe("rail");
    expect(familyFor(156_800_000)).toBe("marine");
    expect(familyFor(162_550_000)).toBe("weather");
    expect(familyFor(462_612_500)).toBe("gmrs");
    expect(familyFor(463_562_500)).toBe("biz");
    expect(familyFor(851_012_500)).toBe("publicsafety");
    expect(familyFor(300_000_000)).toBe("unknown");   // unallocated gap
    expect(familyFor(930_000_000)).toBe("unknown");   // paging
    expect(familyFor(undefined)).toBe("unknown");
  });
  it("operator tags win over the frequency", () => {
    expect(familyFor(463_562_500, ["ham"])).toBe("ham");
    expect(familyFor(463_562_500, ["liberty", "public-safety"])).toBe("publicsafety");
  });
  it("serviceColor.categoryFor is the same function", () => {
    expect(categoryFor).toBe(familyFor);
  });
});

describe("ccAudibleRanges", () => {
  const FAM = ["air", "rail", "marine", "ham", "gmrs"] as const;
  const inRanges = (r: Array<[number, number]>, f: number) => r.some(([lo, hi]) => f >= lo && f <= hi);
  const audible = (f: number) => { const fam = familyFor(f); return fam === "weather" || (FAM as readonly string[]).includes(fam); };

  it("agrees with familyFor exactly at every allocation edge and its neighbours", () => {
    const r = ccAudibleRanges(FAM);
    const probes: number[] = [];
    for (let f = 100_000_000; f <= 1_000_000_000; f += 12_500) probes.push(f);
    // The table's own edges +-1 Hz: where an off-by-one would hide.
    for (const e of [118e6, 137e6, 144e6, 148e6, 156e6, 157.45e6, 159.81e6, 161.565e6, 161.6e6, 162.025e6,
      162.4e6, 162.55e6, 174e6, 222e6, 225e6, 420e6, 450e6, 462.5375e6, 462.7375e6, 467.5375e6, 467.7375e6,
      470e6, 512e6]) probes.push(e - 1, e, e + 1);
    for (const f of probes) expect(inRanges(r, f), `${f} (${serviceFor(f)})`).toBe(audible(f));
  });
  it("is sorted and merged", () => {
    const r = ccAudibleRanges(FAM);
    for (let i = 1; i < r.length; i++) expect(r[i]![0]).toBeGreaterThan(r[i - 1]![1] + 1);
  });
  it("unknown in the list makes the gaps audible", () => {
    expect(inRanges(ccAudibleRanges(["unknown"]), 300_000_000)).toBe(true);
  });
});
