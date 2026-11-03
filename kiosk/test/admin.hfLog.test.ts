import { describe, it, expect } from "vitest";
import { logRows, sortRows, type HfLogRow } from "../src/frontend/admin/hfLogModel.js";

const row = (o: Partial<HfLogRow>): HfLogRow => ({
  night: "2026-11-02", firstTs: 1, lastTs: 2, freqHz: 5_950_000, band: "49m", peakDb: 30, passes: 1, onSpeaker: false,
  station: null, country: null, language: null, site: null, lat: null, lon: null, powerKw: null, distanceKm: null, others: [], ...o,
});

describe("HF log view", () => {
  it("marks schedule names as likely and leaves unidentified rows plain", () => {
    const [a, b] = logRows([row({ station: "VOA", others: ["BBC"], country: "USA", language: "E", site: "Greenville", powerKw: 250, distanceKm: 1700 }), row({ freqHz: 6_000_000 })]);
    expect(a).toMatchObject({ freq: "5950", station: "VOA", likely: true, others: "BBC", where: "Greenville, USA", power: "250 kW", distance: "1,700 km", peak: "+30.0" });
    expect(b).toMatchObject({ station: "Unidentified", likely: false, others: "", where: "", power: "", distance: "" });
  });
  it("shows fractional frequencies only when they exist", () => {
    expect(logRows([row({ freqHz: 5_952_500 })])[0]?.freq).toBe("5952.5");
  });
  it("sorts by any column, unidentified last on station", () => {
    const rows = [row({ freqHz: 3, peakDb: 10, station: "B" }), row({ freqHz: 1, peakDb: 30 }), row({ freqHz: 2, peakDb: 20, station: "A" })];
    expect(sortRows(rows, "freqHz").map((r) => r.freqHz)).toEqual([1, 2, 3]);
    expect(sortRows(rows, "peakDb").map((r) => r.peakDb)).toEqual([30, 20, 10]);
    expect(sortRows(rows, "station").map((r) => r.station)).toEqual(["A", "B", null]);
    expect(sortRows(rows, "lastTs")).toHaveLength(3);
  });
  it("doesn't change the rows it's given", () => {
    const rows = [row({ freqHz: 2 }), row({ freqHz: 1 })];
    sortRows(rows, "freqHz");
    expect(rows[0]?.freqHz).toBe(2);
  });
});
