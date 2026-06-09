import { describe, it, expect } from "vitest";
import { parseSame, fipsMatch, fipsNames, isTest, isEom } from "../src/backend/same.js";

describe("SAME header parsing", () => {
  const TOR = "EAS: ZCZC-WXR-TOR-029047-029095+0030-1561800-KEAX/NWS-";
  it("parses a tornado warning", () => {
    const h = parseSame(TOR)!;
    expect(h.event).toBe("TOR");
    expect(h.eventName).toBe("TORNADO WARNING");
    expect(h.fips).toEqual(["029047", "029095"]);
    expect(h.purgeMinutes).toBe(30);
    expect(h.sender).toBe("KEAX/NWS");
  });
  it("parses long durations and unknown events", () => {
    const h = parseSame("EAS: ZCZC-WXR-XYZ-129095+0130-1561800-KEAX/NWS-")!;
    expect(h.purgeMinutes).toBe(90);
    expect(h.eventName).toBe("XYZ");
  });
  it("rejects garbage and recognizes EOM", () => {
    expect(parseSame("EAS: static noise")).toBeNull();
    expect(isEom("EAS: NNNN")).toBe(true);
  });
});

describe("FIPS scoping", () => {
  it("matches 5-digit county codes against 6-digit SAME codes", () => {
    expect(fipsMatch(["029047"], ["29047"])).toBe(true);
    expect(fipsMatch(["029047"], ["029047"])).toBe(true);
    expect(fipsMatch(["029047"], ["20091"])).toBe(false);
    expect(fipsMatch(["029047"], undefined)).toBe(true); // unscoped = all
  });
  it("flags routine tests", () => {
    expect(isTest("RWT")).toBe(true);
    expect(isTest("TOR")).toBe(false);
  });
});

describe("FIPS county names (banner display)", () => {
  it("names only the COVERED counties when a filter is set", () => {
    // A 3-county warning, operator scoped to Clay+Platte: Jackson is dropped.
    expect(fipsNames(["029047", "029165", "029095"], ["029047", "029165"]))
      .toBe("Clay, Platte");
  });
  it("names all counties when unscoped", () => {
    expect(fipsNames(["029047", "020091"], undefined)).toBe("Clay, Johnson KS");
  });
  it("resolves part-of-county subdivisions and de-dupes", () => {
    // 1/2-prefixed subdivisions of Jackson collapse to one "Jackson".
    expect(fipsNames(["129095", "229095"], undefined)).toBe("Jackson");
  });
  it("falls back to the raw code for an unknown county (never blank)", () => {
    expect(fipsNames(["099999"], undefined)).toBe("099999");
  });
});
