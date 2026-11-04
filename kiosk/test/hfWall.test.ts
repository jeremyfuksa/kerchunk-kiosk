import { describe, it, expect } from "vitest";
import { greatCircle, robinson } from "../src/frontend/dashboard/robinson.js";
import { ituToIso2 } from "../src/frontend/dashboard/ituCountry.js";
import { hfView, hfHtml, mapShouldRun, type HfHeard, type HfViewInput } from "../src/frontend/dashboard/hfView.js";

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
  hf: { band: "41m", centerHz: 7_402_500, listenHz: null, loHz: 7_200_000, hiHz: 7_600_000 },
  carriers: [], error: null, muted: false, signalDb: null, log: [],
};
const row = (freqHz: number, station: string | null, lastTs: number): HfHeard => ({ freqHz, station, lastTs, onSpeaker: true, band: "41m", peakDb: 20 });

describe("hfView", () => {
  it("hunting: the band and no station", () => {
    const v = hfView(base);
    expect(v.readout).toMatchObject({ state: "hunting", meta: "41m · Hunting", headline: "", name: "Listening for a station" });
    expect(v.liveStation).toBeNull();
    expect(v.needle).toBeNull();
  });

  it("identified: frequency as headline, name marked likely, details, and a place on the map", () => {
    const v = hfView({ ...base, signalDb: -20, hf: { ...base.hf!, listenHz: 7_355_000, candidate: {
      station: "Radio Marti", itu: "USA", country: "United States of America", language: "Spanish", site: "Greenville, NC", lat: 35.47, lon: -77.2, powerKw: 250, distanceKm: 1587,
    } } });
    expect(v.readout).toMatchObject({ state: "live", meta: "41m · AM · Live", headline: "7355", name: "Radio Marti", likely: "Likely" });
    expect(v.readout.details).toEqual(["Spanish", "Greenville, NC, United States of America", "250 kW", "1,587 km"]);
    expect(v.tint).toBe("US");
    expect(v.liveStation).toEqual({ hz: 7_355_000, lat: 35.47, lon: -77.2, band: "41m" });
    expect(v.needle).toBeCloseTo(((7_355_000 - 7_200_000) / 400_000) * 100, 3);
    const html = hfHtml(v);
    expect(html).toContain("Likely");
    expect(html).toContain("Radio Marti");
  });

  it("the meter spans shortwave levels, not VHF ones, and ignores the helper's 0 dB open placeholder", () => {
    const lit = (signalDb: number) => hfView({ ...base, signalDb, hf: { ...base.hf!, listenHz: 7_355_000 } }).lit;
    expect(lit(-60)).toBe(0);
    expect(lit(-35)).toBe(6);
    expect(lit(-10)).toBe(12);
    expect(lit(0)).toBe(0);
  });

  it("shows a utility mode code as a word", () => {
    const v = hfView({ ...base, hf: { ...base.hf!, listenHz: 5_000_000, candidate: { station: "WWV", language: "-TS" } } });
    expect(v.readout.details).toEqual(["Utility"]);
  });

  it("unidentified_station_has_no_live_station", () => {
    const v = hfView({ ...base, hf: { ...base.hf!, listenHz: 7_355_000, candidate: null } });
    expect(v.readout).toMatchObject({ state: "live", headline: "7355", name: "Unidentified station", likely: "" });
    expect(v.liveStation).toBeNull();
    expect(v.tint).toBeNull();
  });

  it("a candidate with no coordinates has no place, but still tints", () => {
    const v = hfView({ ...base, hf: { ...base.hf!, listenHz: 7_355_000, candidate: { station: "X", itu: "G" } } });
    expect(v.liveStation).toBeNull();
    expect(v.tint).toBe("GB");
  });

  it("offline: the error, and no live claim", () => {
    const v = hfView({ ...base, error: "failed to open SpyServer (airspy.local:5555): connect failed", hf: { ...base.hf!, listenHz: 7_355_000 } });
    expect(v.readout.state).toBe("error");
    expect(v.readout.meta).toBe("Receiver offline");
    expect(v.needle).toBeNull();
    expect(v.liveStation).toBeNull();
    expect(v.liveColor).toBe("var(--kc-glass)");
  });

  it("dial: carriers in the band become ticks, others are dropped", () => {
    const v = hfView({ ...base, carriers: [{ hz: 7_300_000, db: 20 }, { hz: 7_000_000, db: 50 }] });
    expect(v.ticks).toHaveLength(1);
    expect(v.ticks[0]!.x).toBeCloseTo(25, 3);
  });

  it("rows_are_the_last_three_with_no_times", () => {
    const v = hfView({ ...base, log: [row(7_355_000, "Radio Marti", 4), row(5_950_000, null, 3), row(9_600_000, "A", 2), row(9_700_000, "B", 1)] });
    expect(v.heardTitle).toBe("Heard tonight 4");
    expect(v.rows).toEqual(["7355 Radio Marti", "5950 Unidentified", "9600 A"]);
  });

  it("live_color_follows_the_band", () => {
    expect(hfView({ ...base, hf: { ...base.hf!, listenHz: 7_355_000 } }).liveColor).toBe("oklch(.8 .14 112)");
  });

  it("live_color_is_teal_when_hunting_and_on_error", () => {
    expect(hfView(base).liveColor).toBe("var(--kc-glass)");
  });

  it("html_keeps_likely_muted_and_meter", () => {
    const html = hfHtml(hfView({ ...base, muted: true, signalDb: -35, hf: { ...base.hf!, listenHz: 7_355_000, candidate: { station: "X" } } }));
    expect(html).toContain("Likely");
    expect(html).toContain("Muted");
    expect(html.match(/class="on"/g)).toHaveLength(6);
  });

  it("html_has_legend_and_reception_band", () => {
    const html = hfHtml(hfView({ ...base, log: [row(7_355_000, "Radio Marti", 4)], carriers: [{ hz: 7_300_000, db: 20 }] }));
    expect(html).toContain("kc-hf__band");
    expect(html).toContain("kc-hf__legend");
    expect(html).toContain("kc-hf__tick");
    expect(html).toContain("7355 Radio Marti");
  });

  it("the tag names the band", () => {
    expect(hfHtml(hfView(base))).toContain("HF · 41m");
  });

  it("the key follows the station and a new log row, so redraws stay event-paced", () => {
    const a = hfView(base);
    expect(hfView({ ...base }).key).toBe(a.key);
    expect(hfView({ ...base, hf: { ...base.hf!, listenHz: 7_355_000 } }).key).not.toBe(a.key);
    expect(hfView({ ...base, log: [row(7_355_000, "X", 1)] }).key).not.toBe(a.key);
  });

  it("escapes every piece of schedule text", () => {
    const x = "<b>x</b>";
    const v = hfView({ ...base, log: [{ freqHz: 1_000_000, station: x, lastTs: 1, onSpeaker: false, band: "41m", peakDb: 1 }],
      hf: { ...base.hf!, listenHz: 7_355_000, candidate: { station: x, language: x, site: x, country: x } } });
    expect(hfHtml(v)).not.toContain(x);
  });

  it("the map runs only when neither stage covers it", () => {
    expect(mapShouldRun(false, false)).toBe(true);
    expect(mapShouldRun(true, false)).toBe(false);
    expect(mapShouldRun(false, true)).toBe(false);
  });

  it("escapes schedule text", () => {
    const v = hfView({ ...base, hf: { ...base.hf!, listenHz: 7_355_000, candidate: { station: "<b>x</b>" } } });
    expect(hfHtml(v)).not.toContain("<b>x</b>");
  });
});

describe("noon", () => {
  it("a new night's log replaces last night's on the wall", () => {
    const night = [row(5_950_000, "Radio A", 100), row(7_300_000, "Radio B", 200)];
    const before = hfView({ ...base, log: night });
    const after = hfView({ ...base, log: [row(9_600_000, "Radio C", 300)] });
    expect(before.heardTitle).toBe("Heard tonight 2");
    expect(after.heardTitle).toBe("Heard tonight 1");
    expect(after.rows).toEqual(["9600 Radio C"]);
    expect(after.key).not.toBe(before.key);
  });
});
