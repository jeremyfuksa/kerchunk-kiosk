import { describe, it, expect } from "vitest";
import { parseRoute, hrefFor, legacyRedirect } from "../src/frontend/admin-next/route.js";

describe("admin-next routes", () => {
  it("defaults to radio", () => {
    expect(parseRoute("")).toEqual({ tab: "radio" });
    expect(parseRoute("#/next")).toEqual({ tab: "radio" });
    expect(parseRoute("#/next/")).toEqual({ tab: "radio" });
    expect(parseRoute("#/next/bogus")).toEqual({ tab: "radio" });
  });
  it("parses tabs and the triage sub-route", () => {
    expect(parseRoute("#/next/tune")).toEqual({ tab: "tune" });
    expect(parseRoute("#/next/library")).toEqual({ tab: "library" });
    expect(parseRoute("#/next/library/new")).toEqual({ tab: "library", sub: "new" });
    expect(parseRoute("#/next/system")).toEqual({ tab: "system" });
  });
  it("builds hrefs under the prefix", () => {
    expect(hrefFor({ tab: "radio" })).toBe("#/next");
    expect(hrefFor({ tab: "library", sub: "new" })).toBe("#/next/library/new");
  });
  it("round-trips", () => {
    for (const r of [{ tab: "radio" }, { tab: "tune" }, { tab: "library" }, { tab: "library", sub: "new" }, { tab: "system" }] as const) {
      expect(parseRoute(hrefFor(r))).toEqual(r);
    }
  });
  it("maps classic routes to the new tabs", () => {
    expect(legacyRedirect("#/triage")).toBe("#/next/library/new");
    expect(legacyRedirect("#/channels")).toBe("#/next/library");
    expect(legacyRedirect("#/banks")).toBe("#/next/library");
    expect(legacyRedirect("#/scan")).toBe("#/next/tune");
    expect(legacyRedirect("#/system")).toBeNull();
    expect(legacyRedirect("#/next/tune")).toBeNull();
  });
});
