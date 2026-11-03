import { describe, it, expect } from "vitest";
import { greatCircle, robinson } from "../src/frontend/dashboard/robinson.js";
import { ituToIso2 } from "../src/frontend/dashboard/ituCountry.js";
import { hfView, hfHtml, type HfViewInput } from "../src/frontend/dashboard/hfView.js";

describe("robinson", () => {
  it("matches the calibration measured for this map", () => {
    expect(robinson(0, 0).x).toBeCloseTo(985.7, 1);
    expect(robinson(0, 0).y).toBeCloseTo(501.94, 1);
    // X = PLEN(40) * -94.58, Y = PDFE(40), from the Robinson table.
    expect(robinson(40, -94.58).x).toBeCloseTo(985.7 + 5.6579 * 0.9216 * -94.58, 1);
    expect(robinson(40, -94.58).y).toBeCloseTo(501.94 - 518.393 * 0.4958, 1);
    expect(robinson(-40, 10).y).toBeCloseTo(501.94 + 518.393 * 0.4958, 1);
  });
  it("interpolates between table rows and stays on the map", () => {
    const y = robinson(42.5, 0).y;
    expect(y).toBeLessThan(robinson(40, 0).y);
    expect(y).toBeGreaterThan(robinson(45, 0).y);
    for (const [lat, lon] of [[90, 180], [-90, -180], [0, 180], [0, -180]] as const) {
      const p = robinson(lat, lon);
      expect(p.x).toBeGreaterThanOrEqual(-40);   // the calibration runs a little past the map at the dateline
      expect(p.x).toBeLessThanOrEqual(2010);
      expect(Number.isFinite(p.y)).toBe(true);
    }
  });
});

describe("greatCircle", () => {
  it("starts and ends at the two places", () => {
    const pts = greatCircle({ lat: 39, lon: -94 }, { lat: 52, lon: -2 }, 10);
    expect(pts).toHaveLength(11);
    expect(pts[0]!.lat).toBeCloseTo(39, 3);
    expect(pts[10]!.lon).toBeCloseTo(-2, 3);
  });
  it("arcs north of both ends on a long east-west path in the northern hemisphere", () => {
    const pts = greatCircle({ lat: 39, lon: -94 }, { lat: 39, lon: 30 }, 20);
    expect(Math.max(...pts.map((p) => p.lat))).toBeGreaterThan(55);
  });
  it("handles the same place twice", () => {
    expect(greatCircle({ lat: 1, lon: 2 }, { lat: 1, lon: 2 }, 4).every((p) => Number.isFinite(p.lat))).toBe(true);
  });
});

describe("ituToIso2", () => {
  it("maps the codes that differ, and unknown ones to nothing", () => {
    expect(ituToIso2("USA")).toBe("US");
    expect(ituToIso2("G")).toBe("GB");
    expect(ituToIso2("D")).toBe("DE");
    expect(ituToIso2("J")).toBe("JP");
    expect(ituToIso2("HOL")).toBe("NL");
    expect(ituToIso2("ZZZ")).toBeNull();
    expect(ituToIso2(undefined)).toBeNull();
  });
});

const base: HfViewInput = {
  hf: { stage: "sweep", band: "41m", centerHz: 7_402_500, listenHz: null, loHz: 7_200_000, hiHz: 7_600_000 },
  carriers: [], error: null, muted: false, signalDb: null, heardCount: 0, heard: [], home: { lat: 39.1, lon: -94.58 }, fmtTime: () => "10:00",
};

describe("hfView", () => {
  it("hunting: the band and no station", () => {
    const v = hfView(base);
    expect(v.readout).toMatchObject({ state: "hunting", meta: "41m · Hunting", headline: "", name: "Listening for a station" });
    expect(v.map.dot).toBeNull();
    expect(v.needle).toBeNull();
  });

  it("identified: frequency as headline, name marked likely, details, map dot and path", () => {
    const v = hfView({ ...base, signalDb: -20, hf: { ...base.hf!, listenHz: 7_355_000, candidate: {
      station: "Radio Marti", itu: "USA", country: "United States of America", language: "Spanish", site: "Greenville, NC", lat: 35.47, lon: -77.2, powerKw: 250, distanceKm: 1587,
    } } });
    expect(v.readout).toMatchObject({ state: "live", meta: "41m · AM · Live", headline: "7355", name: "Radio Marti", likely: "Likely · from schedule" });
    expect(v.readout.details).toEqual(["Spanish", "Greenville, NC, United States of America", "250 kW", "1,587 km"]);
    expect(v.map.tint).toBe("US");
    expect(v.map.dot).not.toBeNull();
    expect(v.map.path.length).toBeGreaterThan(0);
    expect(v.needle).toBeCloseTo(((7_355_000 - 7_200_000) / 400_000) * 100, 3);
    const html = hfHtml(v);
    expect(html).toContain("Likely · from schedule");
    expect(html).toContain("Radio Marti");
  });

  it("shows a utility mode code as a word", () => {
    const v = hfView({ ...base, hf: { ...base.hf!, listenHz: 5_000_000, candidate: { station: "WWV", language: "-TS" } } });
    expect(v.readout.details).toEqual(["Utility"]);
  });

  it("unidentified: plain, with no name claimed and no map path", () => {
    const v = hfView({ ...base, hf: { ...base.hf!, listenHz: 7_355_000, candidate: null } });
    expect(v.readout).toMatchObject({ state: "live", headline: "7355", name: "Unidentified station", likely: "" });
    expect(v.map.dot).toBeNull();
    expect(v.map.path).toBe("");
    expect(v.map.tint).toBeNull();
  });

  it("a candidate with no coordinates has no path, but still tints", () => {
    const v = hfView({ ...base, hf: { ...base.hf!, listenHz: 7_355_000, candidate: { station: "X", itu: "G" } } });
    expect(v.map.dot).toBeNull();
    expect(v.map.tint).toBe("GB");
  });

  it("offline: the error, and no live claim", () => {
    const v = hfView({ ...base, error: "failed to open SpyServer (airspy.local:5555): connect failed", hf: { ...base.hf!, listenHz: 7_355_000 } });
    expect(v.readout.state).toBe("error");
    expect(v.readout.meta).toBe("Receiver offline");
    expect(v.needle).toBeNull();
  });

  it("the CB stop says so", () => {
    const v = hfView({ ...base, hf: { stage: "cbStop", band: "CB", centerHz: 27_195_000, listenHz: null } });
    expect(v.readout).toMatchObject({ state: "hunting", meta: "CB · Checking the band" });
  });

  it("dial: carriers in the band become ticks, others are dropped", () => {
    const v = hfView({ ...base, carriers: [{ hz: 7_300_000, db: 20 }, { hz: 7_000_000, db: 50 }] });
    expect(v.ticks).toHaveLength(1);
    expect(v.ticks[0]!.x).toBeCloseTo(25, 3);
  });

  it("heard tonight: count and the latest rows, unidentified shown by frequency", () => {
    const v = hfView({ ...base, heardCount: 12, heard: [
      { freqHz: 7_355_000, station: "Radio Marti", lastTs: 1, onSpeaker: true }, { freqHz: 5_950_000, station: null, lastTs: 2, onSpeaker: false },
    ] });
    expect(v.heardTitle).toBe("Heard tonight · 12");
    expect(v.rows[0]).toEqual({ label: "7355 Radio Marti", when: "10:00" });
    expect(v.rows[1]).toEqual({ label: "5950 Unidentified", when: "10:00" });
  });

  it("the key ignores a clock change but not a station change, so redraws stay event-paced", () => {
    const a = hfView(base);
    expect(hfView({ ...base, fmtTime: () => "10:01" }).key).toBe(a.key);
    expect(hfView({ ...base, hf: { ...base.hf!, listenHz: 7_355_000 } }).key).not.toBe(a.key);
  });

  it("escapes schedule text", () => {
    const v = hfView({ ...base, hf: { ...base.hf!, listenHz: 7_355_000, candidate: { station: "<b>x</b>" } } });
    expect(hfHtml(v)).not.toContain("<b>x</b>");
  });
});
