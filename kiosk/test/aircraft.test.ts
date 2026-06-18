import { describe, it, expect, vi } from "vitest";
import { AircraftFeed, parseAircraft, classifyKind } from "../src/backend/aircraft.js";

const QTH = { lat: 39.29, lon: -94.5 };

// A trimmed airplanes.live /v2/point body.
function body(ac: unknown[]) {
  return { json: async () => ({ ac }) };
}
const plane = (over: Record<string, unknown> = {}) => ({
  hex: "add10d", flight: "N99HV   ", r: "N99HV", t: "C172",
  category: "A1", alt_baro: 1900, track: 155.56, lat: 39.0, lon: -94.6, ...over,
});

describe("classifyKind", () => {
  it("maps emitter categories to visual kinds", () => {
    expect(classifyKind("A1")).toBe("prop");
    expect(classifyKind("A2")).toBe("airliner"); // small/regional/biz jet
    expect(classifyKind("A3")).toBe("airliner");
    expect(classifyKind("A4")).toBe("airliner");
    expect(classifyKind("A5")).toBe("airliner");
    expect(classifyKind("A6")).toBe("military");
    expect(classifyKind("A7")).toBe("helicopter");
  });
  it("is case-insensitive", () => {
    expect(classifyKind("a7")).toBe("helicopter");
  });
  it("falls back to unknown for A0, B/C classes, and missing", () => {
    expect(classifyKind("A0")).toBe("unknown");
    expect(classifyKind("B2")).toBe("unknown"); // lighter-than-air
    expect(classifyKind("C3")).toBe("unknown"); // surface obstruction
    expect(classifyKind(null)).toBe("unknown");
    expect(classifyKind(undefined)).toBe("unknown");
  });
});

describe("parseAircraft", () => {
  it("maps fields, trims the callsign, and classifies the kind", () => {
    const out = parseAircraft({ ac: [plane()] }, QTH, 60);
    expect(out).toEqual([
      { hex: "add10d", callsign: "N99HV", lat: 39.0, lon: -94.6, heading: 155.56, kind: "prop", category: "A1" },
    ]);
  });

  it("classifies an A3 as an airliner and normalises missing category to null", () => {
    expect(parseAircraft({ ac: [plane({ category: "A3" })] }, QTH, 60)[0]!.kind).toBe("airliner");
    const noCat = parseAircraft({ ac: [plane({ category: undefined })] }, QTH, 60)[0]!;
    expect(noCat.category).toBeNull();
    expect(noCat.kind).toBe("unknown");
  });

  it("drops on-ground targets (alt_baro === 'ground')", () => {
    const out = parseAircraft({ ac: [plane({ alt_baro: "ground" })] }, QTH, 60);
    expect(out).toEqual([]);
  });

  it("keeps targets with missing/numeric altitude", () => {
    const out = parseAircraft({ ac: [plane({ alt_baro: undefined })] }, QTH, 60);
    expect(out).toHaveLength(1);
  });

  it("falls back to registration then hex when flight is blank", () => {
    expect(parseAircraft({ ac: [plane({ flight: "   ", r: "N1234" })] }, QTH, 60)[0]!.callsign).toBe("N1234");
    expect(parseAircraft({ ac: [plane({ flight: "", r: "" })] }, QTH, 60)[0]!.callsign).toBe("ADD10D");
  });

  it("sets heading null when track is absent", () => {
    expect(parseAircraft({ ac: [plane({ track: undefined })] }, QTH, 60)[0]!.heading).toBeNull();
  });

  it("skips entries without numeric lat/lon", () => {
    expect(parseAircraft({ ac: [plane({ lat: undefined })] }, QTH, 60)).toEqual([]);
  });

  it("keeps the nearest maxTargets, sorted by distance from home", () => {
    const near = plane({ hex: "near", lat: 39.30, lon: -94.5 });   // ~1 km
    const far = plane({ hex: "far", lat: 40.5, lon: -94.5 });      // ~130 km
    const out = parseAircraft({ ac: [far, near] }, QTH, 1);
    expect(out.map((t) => t.hex)).toEqual(["near"]);
  });

  it("returns [] when the body has no ac array", () => {
    expect(parseAircraft({}, QTH, 60)).toEqual([]);
  });
});

describe("AircraftFeed", () => {
  it("queries {url}/{lat}/{lon}/{radiusNm} and emits parsed targets", async () => {
    const urls: string[] = [];
    const feed = new AircraftFeed({
      home: QTH, radiusKm: 75,
      fetcher: async (u) => { urls.push(u); return body([plane()]); },
    });
    let got: unknown = null;
    feed.onUpdate((t) => { got = t; });
    await feed.pollOnce();
    expect(urls[0]).toBe("http://api.airplanes.live/v2/point/39.29/-94.5/40"); // 75 km → 40 nm
    expect(got).toHaveLength(1);
  });

  it("retains the last good snapshot for maxStaleTicks failures, then clears", async () => {
    let mode: "ok" | "fail" = "ok";
    const feed = new AircraftFeed({
      home: QTH, maxStaleTicks: 2,
      fetcher: async () => { if (mode === "fail") throw new Error("boom"); return body([plane()]); },
    });
    const seen: number[] = [];
    feed.onUpdate((t) => seen.push(t.length));
    await feed.pollOnce();          // ok → 1
    mode = "fail";
    await feed.pollOnce();          // fail 1 → retain (1)
    await feed.pollOnce();          // fail 2 → retain (1)
    await feed.pollOnce();          // fail 3 → clear (0)
    expect(seen).toEqual([1, 1, 1, 0]);
  });

  it("polls repeatedly while started and stops on stop()", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const feed = new AircraftFeed({
        home: QTH, pollIntervalMs: 1000,
        fetcher: async () => { calls++; return body([]); },
      });
      feed.onUpdate(() => {});
      feed.start();
      await vi.advanceTimersByTimeAsync(0);     // first poll runs immediately
      expect(calls).toBe(1);
      await vi.advanceTimersByTimeAsync(1000);  // next interval
      expect(calls).toBe(2);
      feed.stop();
      await vi.advanceTimersByTimeAsync(5000);  // no further polls after stop
      expect(calls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
