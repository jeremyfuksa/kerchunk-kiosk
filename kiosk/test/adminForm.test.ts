import { describe, it, expect } from "vitest";
import { formToChannel, mhzToHz, weatherFormToChannel, restoreDiscovery } from "../src/frontend/admin/admin.js";

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
