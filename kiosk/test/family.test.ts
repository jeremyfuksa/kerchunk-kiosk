import { describe, it, expect } from "vitest";
import { familyFor } from "../src/backend/config/family.js";
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
