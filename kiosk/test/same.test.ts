import { describe, it, expect } from "vitest";
import { parseSame, fipsMatch, isTest, isEom } from "../src/backend/same.js";

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
