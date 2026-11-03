import { describe, it, expect } from "vitest";
import { atlasDots, atlasTraces, bandColor, hitAction, hitChange, legend, tracePath, HF_BANDS_ORDER, type AtlasRow, type HitKey } from "../src/frontend/dashboard/atlas.js";
import { readFileSync } from "node:fs";
import { lineKeyframes, pulseFrames, tracePoints, tracesSvg } from "../src/frontend/dashboard/atlas.js";
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

describe("tracesSvg", () => {
  const t = (key: string) => ({ key, color: "red", segments: ["M0 0L1 1"] });
  it("fades as one group, so overlapping traces can't add up to full brightness", () => {
    const html = tracesSvg([t("a"), t("b")], 0.34);
    expect(html).toMatch(/^<g opacity="0\.34"/);
    expect(html).not.toContain("stroke-opacity");
    expect(html.match(/<path/g)).toHaveLength(2);
  });
});

describe("still layers", () => {
  it("dots have their own layer, so a new dot doesn't repaint the land mid-hit", () => {
    const src = readFileSync("src/frontend/dashboard/dashboard.ts", "utf8");
    expect(src).toContain('<svg id="hfDots" class="kc-hf__layer"');
    expect(src).not.toMatch(/hfLandEl\.querySelector\("svg"\)\?\.insertAdjacentHTML/);
  });
});

describe("pulseFrames", () => {
  const seg = (...xs: number[]) => xs.map((x) => ({ x, y: 0 }));
  const toPx = (p: { x: number; y: number }) => ({ x: p.x * 2, y: p.y });
  it("travels start to end, invisible at both ends", () => {
    const f = pulseFrames([seg(0, 50, 100)], toPx);
    expect(f[0]).toMatchObject({ offset: 0, opacity: 0, transform: "translate(0.0px,0.0px)" });
    expect(f.at(-1)).toMatchObject({ offset: 1, opacity: 0, transform: "translate(200.0px,0.0px)" });
    expect(f.some((k) => (k.opacity as number) > 0.5)).toBe(true);
  });
  it("only animates what the compositor can move on its own", () => {
    for (const k of pulseFrames([seg(0, 100)], toPx)) {
      expect(Object.keys(k).sort()).toEqual(["offset", "opacity", "transform"]);
    }
  });
  it("offsets never go backwards", () => {
    const o = pulseFrames([seg(0, 40), seg(500, 560)], toPx).map((k) => k.offset as number);
    for (let i = 1; i < o.length; i++) expect(o[i]!).toBeGreaterThanOrEqual(o[i - 1]!);
  });
  it("crossing the antimeridian, it's invisible during the jump", () => {
    const f = pulseFrames([seg(0, 100), seg(1000, 1100)], toPx);
    const jump = f.findIndex((k) => k.transform === "translate(2000.0px,0.0px)");
    expect(f[jump]!.opacity).toBe(0);
    expect(f[jump - 1]!.opacity).toBe(0);
    expect(f[jump - 1]!.offset).toBe(f[jump]!.offset);
  });
  it("tracePoints splits where tracePath does", () => {
    expect(tracePoints({ lat: -38.8, lon: 176.4 }, HOME)).toHaveLength(2);
    expect(tracePoints({ lat: 44.75, lon: 26.1 }, HOME)).toHaveLength(1);
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

describe("hitAction", () => {
  it("first_status_holds_rather_than_starts", () => {
    expect(hitAction(false, null, ROMANIA)).toBe("hold");
    expect(hitAction(false, null, null)).toBe("none");
  });
  it("re_entering_the_stage_holds", () => {
    // Leaving the stage resets known and the previous key, so coming back is a first status.
    expect(hitAction(false, ROMANIA, ROMANIA)).toBe("hold");
  });
  it("after the first status it follows hitChange", () => {
    expect(hitAction(true, null, ROMANIA)).toBe("start");
    expect(hitAction(true, ROMANIA, null)).toBe("end");
    expect(hitAction(true, ROMANIA, { ...ROMANIA, hz: 1 })).toBe("replace");
    expect(hitAction(true, ROMANIA, ROMANIA)).toBe("none");
  });
});

describe("lineKeyframes", () => {
  it("one path runs 1 to 0, starting and ending still", () => {
    const [k] = lineKeyframes([100], 10);
    expect(k![0]).toBe(1);
    expect(k!.at(-1)).toBe(0);
    expect(k!).toHaveLength(11);
    expect(k![1]! - k![0]!).toBeGreaterThan(k![5]! - k![4]!);   // eased: slow at the start
  });
  it("two paths draw one after the other", () => {
    const [a, b] = lineKeyframes([100, 300], 20);
    expect(a!.at(-1)).toBe(0);
    expect(b![0]).toBe(1);
    const firstMoved = b!.findIndex((v) => v < 1);
    expect(a![firstMoved]).toBe(0);    // the second starts only once the first is done
    expect(b!.at(-1)).toBe(0);
  });
});

describe("display.hf", () => {
  const base = () => ({ ...defaultConfig(), display: { weatherLat: 39.1, weatherLon: -94.58 } });
  it("display_hf_defaults", () => {
    expect(configSchema.parse(base()).display!.hf).toEqual({
      greylineStepMs: 300_000, traceOpacity: 0.34, hitGrowMs: 900, hitLineDelayMs: 550, hitLineMs: 2000, hitPingMs: 800, hitFadeMs: 700, zoomMs: 1500, pulseEveryMs: 4500, pulseMs: 2000,
    });
  });
  it("pulses can be turned off", () => {
    expect(configSchema.parse({ ...base(), display: { ...base().display, hf: { pulseEveryMs: 0 } } }).display!.hf.pulseEveryMs).toBe(0);
  });
  it("rejects a trace opacity above 1", () => {
    expect(() => configSchema.parse({ ...base(), display: { ...base().display, hf: { traceOpacity: 1.5 } } })).toThrow();
  });
});
