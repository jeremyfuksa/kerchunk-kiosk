import { describe, it, expect } from "vitest";
import { atlasDots, atlasTraces, bandColor, hitChange, legend, tracePath, HF_BANDS_ORDER, type AtlasRow, type HitKey } from "../src/frontend/dashboard/atlas.js";
import { configSchema, defaultConfig } from "../src/backend/config/schema.js";

const HOME = { lat: 39.1, lon: -94.58 };
const row = (o: Partial<AtlasRow>): AtlasRow => ({ freqHz: 11_825_000, band: "25m", peakDb: 20, onSpeaker: true, lat: 44.75, lon: 26.1, ...o });
const ROMANIA: HitKey = { hz: 11_825_000, lat: 44.75, lon: 26.1, band: "25m" };

describe("bandColor", () => {
  it("band_colour_runs_by_wavelength", () => {
    expect(HF_BANDS_ORDER).toHaveLength(13);
    expect(bandColor("120m")).toBe("oklch(.8 .14 20)");
    expect(bandColor("25m")).toBe("oklch(.8 .14 181)");
  });
  it("unlisted_band_and_null_are_live_teal", () => {
    expect(bandColor("11m")).toBe("var(--kc-glass)");
    expect(bandColor(null)).toBe("var(--kc-glass)");
  });
});

describe("atlasDots", () => {
  it("dots_keep_the_strongest_peak_per_site", () => {
    const d = atlasDots([row({ peakDb: 12, onSpeaker: false }), row({ peakDb: 36, freqHz: 9_000_000 })]);
    expect(d).toHaveLength(1);
    expect(d[0]!.r).toBeCloseTo(3 + 36 / 12, 5);
    expect(d[0]!.opacity).toBeCloseTo(0.25 + 36 / 90, 5);
  });
  it("caps size and brightness at 50 dB", () => {
    expect(atlasDots([row({ peakDb: 90 })])[0]!.r).toBeCloseTo(3 + 50 / 12, 5);
  });
  it("dots_skip_rows_without_a_location", () => {
    expect(atlasDots([row({ lat: null, lon: null }), row({ lat: undefined, lon: undefined })])).toEqual([]);
  });
});

describe("atlasTraces", () => {
  it("traces_only_for_played_located_rows", () => {
    expect(atlasTraces([row({ onSpeaker: false }), row({ lat: null, lon: null })], HOME, null)).toEqual([]);
    expect(atlasTraces([row({})], HOME, null)).toHaveLength(1);
  });
  it("traces_one_per_site_and_band", () => {
    const t = atlasTraces([row({}), row({ freqHz: 11_900_000 }), row({ band: "31m", freqHz: 9_600_000 })], HOME, null);
    expect(t).toHaveLength(2);
    expect(t.map((x) => x.color).sort()).toEqual([bandColor("25m"), bandColor("31m")].sort());
  });
  it("live_station_has_no_trace_until_it_ends", () => {
    const rows = [row({})];
    expect(atlasTraces(rows, HOME, ROMANIA)).toEqual([]);
    expect(atlasTraces(rows, HOME, null)).toHaveLength(1);
  });
  it("the live station hides only its own site and band", () => {
    expect(atlasTraces([row({ band: "31m" })], HOME, ROMANIA)).toHaveLength(1);
  });
  it("path_across_the_antimeridian_has_two_segments", () => {
    expect(tracePath({ lat: -38.8, lon: 176.4 }, HOME)).toHaveLength(2);
    expect(tracePath({ lat: 44.75, lon: 26.1 }, HOME)).toHaveLength(1);
  });
  it("a path starts at the transmitter", () => {
    const [first] = tracePath({ lat: 0, lon: 0 }, HOME);
    expect(first).toMatch(/^M985\.7 501\.9/);
  });
});

describe("legend", () => {
  it("legend_lights_bands_with_traces_and_marks_live", () => {
    const l = legend([row({})], "41m");
    expect(l).toHaveLength(13);
    expect(l.find((x) => x.label === "25")).toMatchObject({ lit: true, live: false, color: bandColor("25m") });
    expect(l.find((x) => x.label === "41")).toMatchObject({ lit: false, live: true });
    expect(l.find((x) => x.label === "120")).toMatchObject({ lit: false, live: false });
  });
  it("a logged station that didn't play doesn't light its band", () => {
    expect(legend([row({ onSpeaker: false })], null).find((x) => x.label === "25")?.lit).toBe(false);
  });
});

describe("hitChange", () => {
  const other: HitKey = { ...ROMANIA, hz: 9_600_000 };
  it("hit_change_covers_each_transition", () => {
    expect(hitChange(null, ROMANIA)).toBe("start");
    expect(hitChange(ROMANIA, null)).toBe("end");
    expect(hitChange(ROMANIA, other)).toBe("replace");
    expect(hitChange(ROMANIA, { ...ROMANIA })).toBe("none");
    expect(hitChange(null, null)).toBe("none");
  });
  it("late_schedule_name_starts_one_hit", () => {
    expect(hitChange(null, ROMANIA)).toBe("start");
    expect(hitChange(ROMANIA, ROMANIA)).toBe("none");
  });
});

describe("display.hf", () => {
  const base = () => ({ ...defaultConfig(), display: { weatherLat: 39.1, weatherLon: -94.58 } });
  it("display_hf_defaults", () => {
    expect(configSchema.parse(base()).display!.hf).toEqual({
      greylineStepMs: 300_000, traceOpacity: 0.34, hitGrowMs: 900, hitLineDelayMs: 550, hitLineMs: 2000, hitPingMs: 800, hitFadeMs: 700, zoomMs: 1500,
    });
  });
  it("rejects a trace opacity above 1", () => {
    expect(() => configSchema.parse({ ...base(), display: { ...base().display, hf: { traceOpacity: 1.5 } } })).toThrow();
  });
});
