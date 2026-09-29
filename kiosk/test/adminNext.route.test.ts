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
  it("parses library detail routes", () => {
    expect(parseRoute("#/next/library/ch/ch_ab12")).toEqual({ tab: "library", detail: { kind: "ch", id: "ch_ab12" } });
    expect(parseRoute("#/next/library/hz/146520000")).toEqual({ tab: "library", detail: { kind: "hz", hz: 146_520_000 } });
    expect(parseRoute("#/next/library/add")).toEqual({ tab: "library", detail: { kind: "add" } });
    expect(parseRoute("#/next/library/add/from/cc_1")).toEqual({ tab: "library", detail: { kind: "add", from: "cc_1" } });
    expect(parseRoute("#/next/library/add/tag/air%20band")).toEqual({ tab: "library", detail: { kind: "add", tag: "air band" } });
  });
  it("ignores malformed detail routes", () => {
    expect(parseRoute("#/next/library/hz/abc")).toEqual({ tab: "library" });
    expect(parseRoute("#/next/library/hz/-5")).toEqual({ tab: "library" });
    expect(parseRoute("#/next/library/ch/")).toEqual({ tab: "library" });
    expect(parseRoute("#/next/library/ch/%E0%A4%A")).toEqual({ tab: "library" });
  });
  it("round-trips detail routes", () => {
    for (const r of [
      { tab: "library", detail: { kind: "ch", id: "ch_x/y" } },
      { tab: "library", detail: { kind: "hz", hz: 462_562_500 } },
      { tab: "library", detail: { kind: "add" } },
      { tab: "library", detail: { kind: "add", from: "cc_9" } },
      { tab: "library", detail: { kind: "add", tag: "rail" } },
    ] as const) {
      expect(parseRoute(hrefFor(r))).toEqual(r);
    }
  });
});
