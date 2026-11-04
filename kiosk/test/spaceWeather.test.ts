import { describe, it, expect, vi } from "vitest";
import { SpaceWeather } from "../src/backend/spaceWeather.js";

// Shapes as NOAA served them on 2026-11-04.
const FLUX = [{ flux: 100, time_tag: "2026-11-03T20:00:00" }];
const KP = [{ time_tag: "2026-11-04T09:00:00", Kp: 2.33 }, { time_tag: "2026-11-04T12:00:00", Kp: 3.0 }];
const SCALES = { "0": { R: { Scale: "3", Text: "strong" }, S: { Scale: "0", Text: "none" }, G: { Scale: "2", Text: "moderate" } }, "1": { R: { Scale: null }, S: { Scale: "5" }, G: { Scale: "5" } } };

function make(over: Partial<Record<"flux" | "kp" | "scales", unknown>> = {}) {
  let t = 1_000;
  const bodies = { flux: FLUX as unknown, kp: KP as unknown, scales: SCALES as unknown, ...over };
  const fetcher = vi.fn(async (url: string) => {
    const b = url.includes("flux") ? bodies.flux : url.includes("k-index") ? bodies.kp : bodies.scales;
    if (b instanceof Error) throw b;
    return { ok: b !== 500, status: b === 500 ? 500 : 200, json: async () => b };
  });
  const sw = new SpaceWeather({ ttlMs: 1_800_000, staleMaxMs: 7_200_000, fetcher, now: () => t });
  return { sw, fetcher, bodies, advance: (ms: number) => { t += ms; } };
}

describe("SpaceWeather", () => {
  it("reads today's flux, the newest Kp and the current scales, not the forecast", async () => {
    const { sw } = make();
    await sw.refreshIfDue();
    expect(sw.current()).toEqual({ solarFlux: 100, kp: 3, r: 3, s: 0, g: 2 });
  });

  it("answers at once while NOAA hangs, and starts only one refresh", () => {
    const { sw, fetcher } = make();
    fetcher.mockImplementation(() => new Promise(() => {}));
    expect(sw.current()).toEqual({ solarFlux: null, kp: null, r: null, s: null, g: null });
    sw.current();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("serves the cache until the interval is up", async () => {
    const { sw, fetcher, advance } = make();
    await sw.refreshIfDue();
    advance(1_799_999);
    await sw.refreshIfDue();
    expect(fetcher).toHaveBeenCalledTimes(3);
    advance(1);
    await sw.refreshIfDue();
    expect(fetcher).toHaveBeenCalledTimes(6);
  });

  it("asks NOAA one product at a time, and two pollers share one refresh", async () => {
    const { sw, fetcher } = make();
    let inFlight = 0, most = 0;
    const real = fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async (url: string) => {
      most = Math.max(most, ++inFlight);
      const r = await real(url);
      inFlight--;
      return r;
    });
    await Promise.all([sw.refreshIfDue(), sw.refreshIfDue()]);
    expect(most).toBe(1);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("one product failing costs nothing else, and doesn't throw", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { sw } = make({ kp: new Error("timeout") });
    await sw.refreshIfDue();
    expect(sw.current()).toEqual({ solarFlux: 100, kp: null, r: 3, s: 0, g: 2 });
    warn.mockRestore();
  });

  it("keeps the last good value through an outage, then drops it once it's too old", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { sw, bodies, advance } = make();
    await sw.refreshIfDue();
    bodies.flux = 500; bodies.kp = new Error("down"); bodies.scales = "<html>";
    advance(1_800_000);
    await sw.refreshIfDue();
    expect(sw.current()).toEqual({ solarFlux: 100, kp: 3, r: 3, s: 0, g: 2 });
    advance(5_400_001);
    await sw.refreshIfDue();
    expect(sw.current()).toEqual({ solarFlux: null, kp: null, r: null, s: null, g: null });
    warn.mockRestore();
  });

  it("doesn't take an unusable reply for a value", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { sw } = make({ flux: [{ flux: "100" }], kp: [], scales: { "0": { R: { Scale: "x" } } } });
    await sw.refreshIfDue();
    expect(sw.current()).toEqual({ solarFlux: null, kp: null, r: null, s: null, g: null });
    warn.mockRestore();
  });
});
