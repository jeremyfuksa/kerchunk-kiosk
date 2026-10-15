import { describe, it, expect } from "vitest";
import { hourPrefix, hourPrefixes, keyFloor, keyTimes, parseListing, stamp } from "../src/backend/lightning/keys.js";

const REAL = "GLM-L2-LCFA/2026/287/02/OR_GLM-L2-LCFA_G19_s20262870229000_e20262870229200_c20262870229219.nc";

describe("GLM S3 keys", () => {
  it("stamp is yyyydddhhmmss + tenths", () => {
    expect(stamp(Date.parse("2026-10-14T02:29:00.000Z"))).toBe("20262870229000");
    expect(stamp(Date.parse("2026-01-01T00:00:00.950Z"))).toBe("20260010000009");
  });

  it("hourPrefix uses day-of-year", () => {
    expect(hourPrefix(Date.parse("2026-10-14T02:29:00Z"))).toBe("GLM-L2-LCFA/2026/287/02/");
  });

  it("keyFloor sorts just before the real key at the same start", () => {
    const floor = keyFloor(Date.parse("2026-10-14T02:29:00Z"), 19);
    expect(REAL.startsWith(floor)).toBe(true);
    expect(REAL > floor).toBe(true);
    expect(keyFloor(Date.parse("2026-10-14T02:29:00.100Z"), 19) > REAL).toBe(true);
  });

  it("keyTimes reads start and end", () => {
    expect(keyTimes(REAL)).toEqual({ start: Date.parse("2026-10-14T02:29:00Z"), end: Date.parse("2026-10-14T02:29:20Z") });
    expect(keyTimes("nonsense")).toBeNull();
  });

  it("hourPrefixes spans a New Year boundary", () => {
    expect(hourPrefixes(Date.parse("2026-12-31T23:58:30Z"), Date.parse("2027-01-01T00:00:30Z")))
      .toEqual(["GLM-L2-LCFA/2026/365/23/", "GLM-L2-LCFA/2027/001/00/"]);
  });

  it("hourPrefixes inside one hour is one prefix", () => {
    expect(hourPrefixes(Date.parse("2026-10-14T02:20:00Z"), Date.parse("2026-10-14T02:29:00Z"))).toEqual(["GLM-L2-LCFA/2026/287/02/"]);
  });

  it("parseListing reads keys and the continuation token only when truncated", () => {
    const xml = `<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>ab+c/d=&amp;</NextContinuationToken>`
      + `<Contents><Key>${REAL}</Key><Size>400000</Size></Contents><Contents><Key>k2</Key></Contents></ListBucketResult>`;
    expect(parseListing(xml)).toEqual({ keys: [REAL, "k2"], next: "ab+c/d=&" });
    expect(parseListing(xml.replace("<IsTruncated>true", "<IsTruncated>false")).next).toBeNull();
    expect(parseListing("<ListBucketResult></ListBucketResult>")).toEqual({ keys: [], next: null });
  });
});
