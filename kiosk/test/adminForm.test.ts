import { describe, it, expect } from "vitest";
import { formToChannel, mhzToHz, weatherFormToChannel, restoreDiscovery, readStoredStringSet, lockoutFreqIn, unlockFreqIn } from "../src/frontend/admin/admin.js";

describe("admin form helpers", () => {
  it("mhzToHz converts MHz string to integer Hz", () => {
    expect(mhzToHz("145.130")).toBe(145130000);
    expect(mhzToHz("146.94")).toBe(146940000);
  });

  it("formToChannel builds a valid payload", () => {
    const payload = formToChannel({ mhz: "145.130", alphaTag: "KC0KW", mode: "nfm" });
    expect(payload).toEqual({ freq: 145130000, alphaTag: "KC0KW", mode: "nfm", enabled: true });
  });

  it("formToChannel throws on a non-numeric frequency", () => {
    expect(() => formToChannel({ mhz: "abc", alphaTag: "x", mode: "fm" })).toThrow();
  });
});

describe("weather form helper", () => {
  it("weatherFormToChannel builds a valid weather-channel payload", () => {
    const payload = weatherFormToChannel({ mhz: "162.550", alphaTag: "NOAA WX", mode: "nfm" });
    expect(payload).toEqual({ freq: 162550000, alphaTag: "NOAA WX", mode: "nfm", enabled: true });
  });

  it("weatherFormToChannel throws on a non-numeric frequency", () => {
    expect(() => weatherFormToChannel({ mhz: "x", alphaTag: "y", mode: "fm" })).toThrow();
  });
});

describe("priority in the add form", () => {
  it("formToChannel includes priority only when set", () => {
    const p = formToChannel({ mhz: "464.275", alphaTag: "WOF", mode: "nfm", priority: true });
    expect(p.priority).toBe(true);
    const np = formToChannel({ mhz: "464.275", alphaTag: "WOF", mode: "nfm" });
    expect("priority" in np).toBe(false);
  });
});

describe("restoreDiscovery", () => {
  it("clears all suppression bookkeeping, not just the suppressed flag", () => {
    // The server re-suppresses on hitCount >= 6 once suppressedAt is cleared,
    // so a restore that leaves hitCount intact gets undone on the next hit.
    const restored = restoreDiscovery({
      id: "cc_1", freq: 462887500, alphaTag: "Close Call 462.8875", ts: 1,
      hitCount: 9, lastSeenAt: 123, suppressedAt: 456, suppressionReason: "Likely repeated noise",
    });
    expect(restored.suppressedAt).toBeUndefined();
    expect(restored.suppressionReason).toBeUndefined();
    expect(restored.hitCount).toBeUndefined();
    expect(restored.lastSeenAt).toBeUndefined();
    expect(restored.id).toBe("cc_1"); // identity + other fields preserved
    expect(restored.freq).toBe(462887500);
  });
});

describe("readStoredStringSet", () => {
  it("parses a stored JSON string array", () => {
    expect(readStoredStringSet('["tuning","weather"]', [])).toEqual(new Set(["tuning", "weather"]));
  });

  it("falls back on corrupt JSON instead of throwing (a throw bricks the whole admin page)", () => {
    expect(readStoredStringSet("{", ["tuning"])).toEqual(new Set(["tuning"]));
    expect(readStoredStringSet("undefined", ["a"])).toEqual(new Set(["a"]));
  });

  it("falls back on valid JSON that isn't a string array", () => {
    expect(readStoredStringSet("{}", ["x"])).toEqual(new Set(["x"]));       // not iterable
    expect(readStoredStringSet('"abc"', ["x"])).toEqual(new Set(["x"]));    // iterable, wrong shape
    expect(readStoredStringSet("[1,2]", ["x"])).toEqual(new Set(["x"]));    // wrong element type
  });

  it("uses the fallback when nothing is stored (localStorage returns null)", () => {
    expect(readStoredStringSet(null, ["a", "b"])).toEqual(new Set(["a", "b"]));
  });
});

describe("lockout / unlock round trip", () => {
  // The channel the operator locked out: rich, expensively-identified metadata
  // that the lookup chain (RepeaterBook -> MyGMRS -> RadioReference -> FccProx
  // -> BusinessGuess) paid API calls to build.
  const arrowhead = {
    id: "ch_1", freq: 463562500, alphaTag: "Kansas City Chiefs Arrowhead",
    mode: "nfm" as const, enabled: true, audible: false,
    rfDb: -4.2, levelTrimDb: 2.7, tags: ["business"],
    location: { lat: 39.04886, lon: -94.48389, city: "Kansas City", state: "MO", source: "fccprox" },
    lookedUpAt: 1780689240771,
  };
  const other = { id: "ch_2", freq: 463600000, alphaTag: "Argosy", mode: "nfm" as const, enabled: true };
  const cfg = () => ({
    channels: [{ ...arrowhead }, { ...other }],
    discoveries: [{ freq: 463562500 }, { freq: 464175000 }],
    scan: { lockoutHz: [146012500] },
  });

  it("lockout archives the channel instead of deleting it", () => {
    const out = lockoutFreqIn(cfg(), 463562500);
    const ch = out.channels.find((c) => c.freq === 463562500);
    expect(ch).toBeDefined();
    expect(ch!.enabled).toBe(false);
  });

  it("lockout keeps every field the lookup chain built", () => {
    const ch = lockoutFreqIn(cfg(), 463562500).channels.find((c) => c.freq === 463562500)!;
    expect(ch.alphaTag).toBe("Kansas City Chiefs Arrowhead");
    expect(ch.location).toEqual(arrowhead.location);
    expect(ch.rfDb).toBe(-4.2);
    expect(ch.levelTrimDb).toBe(2.7);
    expect(ch.lookedUpAt).toBe(1780689240771);
  });

  it("lockout suppresses Close Call and clears the pending discovery", () => {
    const out = lockoutFreqIn(cfg(), 463562500);
    expect(out.scan.lockoutHz).toContain(463562500);
    expect(out.scan.lockoutHz).toContain(146012500); // existing entries survive
    expect(out.discoveries.map((d) => d.freq)).toEqual([464175000]);
  });

  it("lockout leaves other channels untouched", () => {
    const out = lockoutFreqIn(cfg(), 463562500);
    expect(out.channels.find((c) => c.freq === 463600000)!.enabled).toBe(true);
  });

  it("unlock restores a scanning channel — not just an empty suppression list", () => {
    // The operator-reported bug: unlock cleared lockoutHz and left nothing to
    // scan, because lockout had deleted the channel outright.
    const locked = lockoutFreqIn(cfg(), 463562500);
    const out = unlockFreqIn(locked, 463562500);
    expect(out.scan.lockoutHz).not.toContain(463562500);
    const ch = out.channels.find((c) => c.freq === 463562500);
    expect(ch).toBeDefined();
    expect(ch!.enabled).toBe(true);
  });

  it("a lockout -> unlock round trip is lossless", () => {
    const before = cfg();
    const after = unlockFreqIn(lockoutFreqIn(before, 463562500), 463562500);
    expect(after.channels).toEqual(before.channels);
  });

  it("locking out an unknown frequency still suppresses it (Close-Call-only lockout)", () => {
    const out = lockoutFreqIn(cfg(), 999000000);
    expect(out.scan.lockoutHz).toContain(999000000);
    expect(out.channels).toEqual(cfg().channels);
  });
});
