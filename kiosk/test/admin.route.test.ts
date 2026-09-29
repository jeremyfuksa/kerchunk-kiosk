import { describe, it, expect } from "vitest";
import { parseRoute, hrefFor, legacyRedirect, resolveLegacy } from "../src/frontend/admin/route.js";

describe("admin routes", () => {
  it("defaults to radio", () => {
    expect(parseRoute("")).toEqual({ tab: "radio" });
    expect(parseRoute("#")).toEqual({ tab: "radio" });
    expect(parseRoute("#/")).toEqual({ tab: "radio" });
    expect(parseRoute("#/bogus")).toEqual({ tab: "radio" });
  });
  it("parses tabs and the triage sub-route", () => {
    expect(parseRoute("#/tune")).toEqual({ tab: "tune" });
    expect(parseRoute("#/library")).toEqual({ tab: "library" });
    expect(parseRoute("#/library/new")).toEqual({ tab: "library", sub: "new" });
    expect(parseRoute("#/system")).toEqual({ tab: "system" });
  });
  it("no longer strips a #/next prefix itself (legacyRedirect handles that era)", () => {
    expect(parseRoute("#/next/tune")).toEqual({ tab: "radio" });
  });
  it("builds hrefs at the root", () => {
    expect(hrefFor({ tab: "radio" })).toBe("#/");
    expect(hrefFor({ tab: "tune" })).toBe("#/tune");
    expect(hrefFor({ tab: "library", sub: "new" })).toBe("#/library/new");
    expect(hrefFor({ tab: "system" })).toBe("#/system");
  });
  it("round-trips", () => {
    for (const r of [{ tab: "radio" }, { tab: "tune" }, { tab: "library" }, { tab: "library", sub: "new" }, { tab: "system" }] as const) {
      expect(parseRoute(hrefFor(r))).toEqual(r);
    }
  });
  it("redirects classic pages and the #/next era to the current routes", () => {
    expect(legacyRedirect("#/home")).toBe("#/");
    expect(legacyRedirect("#/triage")).toBe("#/library/new");
    expect(legacyRedirect("#/channels")).toBe("#/library");
    expect(legacyRedirect("#/banks")).toBe("#/library");
    expect(legacyRedirect("#/scan")).toBe("#/tune");
    expect(legacyRedirect("#/next")).toBe("#/");
    expect(legacyRedirect("#/next/")).toBe("#/");
    expect(legacyRedirect("#/next/tune")).toBe("#/tune");
    expect(legacyRedirect("#/next/library/hz/146520000")).toBe("#/library/hz/146520000");
    expect(legacyRedirect("#/next/library/add/tag/air%20band")).toBe("#/library/add/tag/air%20band");
    expect(legacyRedirect("#/next/library/ch/ch_x%2Fy")).toBe("#/library/ch/ch_x%2Fy");
  });
  it("leaves current routes alone", () => {
    for (const h of ["", "#", "#/", "#/tune", "#/library", "#/library/new", "#/system", "#/library/ch/a"]) {
      expect(legacyRedirect(h)).toBeNull();
    }
  });
  it("resolves a single-hop legacy hash the same as legacyRedirect", () => {
    for (const h of ["#/home", "#/triage", "#/channels", "#/banks", "#/scan", "#/next/tune"]) {
      expect(resolveLegacy(h)).toBe(legacyRedirect(h));
    }
  });
  it("resolves nothing for a current route", () => {
    for (const h of ["", "#", "#/", "#/tune", "#/library", "#/library/new", "#/system"]) {
      expect(resolveLegacy(h)).toBeNull();
    }
  });
  it("chases a chained legacy hash (#/next/triage) through both eras to its final destination", () => {
    // #/next/triage -> #/triage (strip the pre-flip #/next prefix) -> #/library/new (classic triage page)
    expect(resolveLegacy("#/next/triage")).toBe("#/library/new");
    expect(parseRoute(resolveLegacy("#/next/triage")!)).toEqual({ tab: "library", sub: "new" });
  });
  it("bounds the redirect chase so a cycle can't loop forever", () => {
    expect(resolveLegacy("#/next/triage", 1)).toBe("#/triage");
  });
  it("redirected routes parse to the intended tab", () => {
    expect(parseRoute(legacyRedirect("#/triage")!)).toEqual({ tab: "library", sub: "new" });
    expect(parseRoute(legacyRedirect("#/next/library/hz/146520000")!)).toEqual({ tab: "library", detail: { kind: "hz", hz: 146_520_000 } });
  });
  it("parses library detail routes", () => {
    expect(parseRoute("#/library/ch/ch_ab12")).toEqual({ tab: "library", detail: { kind: "ch", id: "ch_ab12" } });
    expect(parseRoute("#/library/hz/146520000")).toEqual({ tab: "library", detail: { kind: "hz", hz: 146_520_000 } });
    expect(parseRoute("#/library/add")).toEqual({ tab: "library", detail: { kind: "add" } });
    expect(parseRoute("#/library/add/from/cc_1")).toEqual({ tab: "library", detail: { kind: "add", from: "cc_1" } });
    expect(parseRoute("#/library/add/tag/air%20band")).toEqual({ tab: "library", detail: { kind: "add", tag: "air band" } });
  });
  it("ignores malformed detail routes", () => {
    expect(parseRoute("#/library/hz/abc")).toEqual({ tab: "library" });
    expect(parseRoute("#/library/hz/-5")).toEqual({ tab: "library" });
    expect(parseRoute("#/library/ch/")).toEqual({ tab: "library" });
    expect(parseRoute("#/library/ch/%E0%A4%A")).toEqual({ tab: "library" });
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
