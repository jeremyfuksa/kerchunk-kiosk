import { describe, it, expect } from "vitest";
import { hasCarrier, hfWindows, HF_BANDS_DEFAULT, HF_DEFAULTS, HfSweep, type HfOpts } from "../src/backend/hf/sweep.js";

const opts = (over: Partial<HfOpts> = {}): HfOpts => ({ ...HF_DEFAULTS, ...over });
const W = [{ centerHz: 5_952_500, band: "49m", loHz: 5_700_000, hiHz: 6_200_000 }, { centerHz: 7_252_500, band: "41m", loHz: 7_200_000, hiHz: 7_600_000 }];
const car = (hz: number, db: number) => ({ hz, db });

describe("hfWindows", () => {
  const all = hfWindows(HF_BANDS_DEFAULT);
  it("covers every band within 600 kHz windows, centered off the 5 kHz raster", () => {
    for (const b of HF_BANDS_DEFAULT) {
      const ws = all.filter((w) => w.band === b.name);
      expect(ws.length).toBe(Math.ceil((b.hiHz - b.loHz) / 600_000));
      for (let hz = b.loHz; hz <= b.hiHz; hz += 5_000) {
        expect(ws.some((w) => Math.abs(hz - w.centerHz) <= 302_500)).toBe(true);
      }
    }
    for (const w of all) expect(w.centerHz % 5_000).toBe(2_500);
  });
  it("reaches the broadcasters the schedules list just outside the ITU bands, and stays off ham 20 m", () => {
    const inBand = (hz: number) => HF_BANDS_DEFAULT.some((b) => hz >= b.loHz && hz <= b.hiHz);
    for (const hz of [5_850_000, 7_780_000, 9_265_000, 9_395_000, 9_955_000, 12_160_000]) expect(inBand(hz)).toBe(true);
    expect(inBand(14_200_000)).toBe(false);
  });
  it("runs 120 m to 13 m in ascending order", () => {
    expect(all[0]!.band).toBe("120m");
    expect(all.at(-1)!.band).toBe("13m");
    expect([...all].sort((a, b) => a.centerHz - b.centerHz)).toEqual(all);
  });
});

describe("HfSweep windows", () => {
  it("starts on the first window with nothing playing", () => {
    expect(new HfSweep(opts(), W, 0).current()).toMatchObject({ centerHz: W[0]!.centerHz, listenHz: null, band: "49m", loHz: W[0]!.loHz, hiHz: W[0]!.hiHz });
  });

  it("moves on when the window timer ends, whatever is playing", () => {
    const s = new HfSweep(opts(), W, 0);
    s.onCarriers(5_000, W[0]!.centerHz, [car(5_950_000, 40)]);
    expect(s.tick(59_000)).toBeNull();
    const t = s.tick(60_000);
    expect(t?.centerHz).toBe(W[1]!.centerHz);
    expect(t?.listenHz).toBeNull();
  });

  it("wraps to the first window after the last, with no stop on CB", () => {
    const s = new HfSweep(opts(), W, 0);
    s.tick(60_000);
    expect(s.tick(120_000)?.centerHz).toBe(W[0]!.centerHz);
  });

  it("skip moves on early and restarts the timer", () => {
    const s = new HfSweep(opts(), W, 0);
    expect(s.skip(10_000).centerHz).toBe(W[1]!.centerHz);
    expect(s.tick(69_999)).toBeNull();
  });

  it("ignores a survey from a window it already left", () => {
    const s = new HfSweep(opts(), W, 0);
    s.tick(60_000);
    expect(s.onCarriers(61_000, W[0]!.centerHz, [car(5_950_000, 40)])).toBeNull();
    expect(s.onCarriers(61_000, W[0]!.centerHz, [car(7_300_000, 40)])).toBeNull();   // in the new band, but an old survey
  });
});

describe("HfSweep listening", () => {
  const center = W[0]!.centerHz;
  it("plays the strongest carrier that clears the listen threshold", () => {
    const s = new HfSweep(opts(), W, 0);
    expect(s.onCarriers(5_000, center, [car(5_950_000, 40), car(6_000_000, 45), car(5_900_000, 5)])?.listenHz).toBe(6_000_000);
  });

  it("carriers the window sees outside its band don't play and aren't surveyed", () => {
    const narrow = [{ centerHz: 3_952_500, band: "75m", loHz: 3_900_000, hiHz: 4_000_000 }];
    const s = new HfSweep(opts(), narrow, 0);
    const seen = [car(3_840_000, 50), car(3_950_000, 20), car(4_000_000, 20), car(4_005_000, 50)];
    expect(s.inWindow(seen).map((c) => c.hz)).toEqual([3_950_000, 4_000_000]);
    expect(s.onCarriers(5_000, 3_952_500, [car(3_840_000, 50)])).toBeNull();
    expect(s.onCarriers(5_001, 3_952_500, seen)?.listenHz).toBe(3_950_000);
  });

  it("stays quiet when nothing clears the threshold", () => {
    const s = new HfSweep(opts(), W, 0);
    expect(s.onCarriers(5_000, center, [car(5_950_000, opts().minListenDb - 1)])).toBeNull();
    expect(s.current().listenHz).toBeNull();
  });

  it("doesn't change station while the playing one is still there, even if another is stronger", () => {
    const s = new HfSweep(opts(), W, 0);
    s.onCarriers(5_000, center, [car(5_950_000, 40)]);
    expect(s.onCarriers(10_000, center, [car(5_950_000, 30), car(6_000_000, 50)])).toBeNull();
  });

  it("a station repeats only after the cooldown", () => {
    const s = new HfSweep(opts({ cooldownMs: 1_000_000 }), W, 0);
    s.onCarriers(5_000, center, [car(5_950_000, 40)]);
    s.tick(60_000);
    s.tick(120_000);
    const later = 125_000;
    expect(s.onCarriers(later, center, [car(5_950_000, 40)])).toBeNull();
    expect(s.onCarriers(later + 1, center, [car(5_950_000, 40), car(6_000_000, 20)])?.listenHz).toBe(6_000_000);
    const s2 = new HfSweep(opts({ cooldownMs: 10_000 }), W, 0);
    s2.onCarriers(5_000, center, [car(5_950_000, 40)]);
    s2.tick(60_000); s2.tick(120_000);
    expect(s2.onCarriers(later, center, [car(5_950_000, 40)])?.listenHz).toBe(5_950_000);
  });

  it("a schedule-matched carrier plays ahead of a stronger unidentified one", () => {
    const s = new HfSweep(opts({ isMatched: (hz) => hz === 5_950_000 }), W, 0);
    expect(s.onCarriers(5_000, center, [car(5_950_000, 20), car(6_000_000, 50)])?.listenHz).toBe(5_950_000);
  });

  it("switches to the next station after the playing one fades for fadeMs, and goes quiet if none", () => {
    const s = new HfSweep(opts({ fadeMs: 10_000 }), W, 0);
    s.onCarriers(5_000, center, [car(5_950_000, 40)]);
    expect(s.onCarriers(10_000, center, [car(6_000_000, 30)])).toBeNull();
    expect(s.onCarriers(15_000, center, [car(6_000_000, 30)])?.listenHz).toBe(6_000_000);
    const q = new HfSweep(opts({ fadeMs: 10_000 }), W, 0);
    q.onCarriers(5_000, center, [car(5_950_000, 40)]);
    expect(q.onCarriers(15_000, center, [])?.listenHz).toBeNull();
  });

  it("a carrier a raster step away counts as the playing station", () => {
    const s = new HfSweep(opts({ fadeMs: 10_000 }), W, 0);
    s.onCarriers(5_000, center, [car(5_950_000, 40)]);
    expect(s.onCarriers(15_000, center, [car(5_955_000, 40)])).toBeNull();
  });
});

describe("HfSweep resume", () => {
  it("resume gives the playing station a fresh fade", () => {
    const center = W[0]!.centerHz;
    const s = new HfSweep(opts({ fadeMs: 10_000 }), W, 0);
    s.onCarriers(5_000, center, [car(5_950_000, 40)]);
    s.resume(500_000);
    expect(s.onCarriers(500_001, center, [])).toBeNull();
  });

  it("resume after a break-in keeps the window and restarts its timer", () => {
    const s = new HfSweep(opts(), W, 0);
    s.tick(60_000);
    const before = s.current().centerHz;
    expect(s.resume(500_000).centerHz).toBe(before);
    expect(s.tick(559_999)).toBeNull();
    expect(s.tick(560_000)).not.toBeNull();
  });
});

describe("default bands stay out of US ham bands", () => {
  const US_HAM_KHZ = [[1800, 2000], [3500, 4000], [5330, 5407], [7000, 7300], [10100, 10150], [14000, 14350], [18068, 18168], [21000, 21450], [24890, 24990], [28000, 29700]] as const;
  const RASTER_KHZ = 5;   // a peak just inside a ham band can snap to the channel at its edge

  it("no default band touches one, or the raster channel on its edge", () => {
    for (const b of HF_BANDS_DEFAULT) {
      for (const [lo, hi] of US_HAM_KHZ) {
        expect(b.hiHz < (lo - RASTER_KHZ) * 1000 || b.loHz >= (hi + RASTER_KHZ) * 1000, `${b.name} vs ${lo}-${hi}`).toBe(true);
      }
    }
  });
});

describe("carrier check", () => {
  const center = W[0]!.centerHz;
  const ssb = (hz: number, db: number) => ({ hz, db, peakHz: hz + 1_300, steadyDb: 9 });
  const steady = (hz: number, db: number) => ({ hz, db, peakHz: hz + 50, steadyDb: 1 });

  it("a carrier is steady and on the raster", () => {
    expect(hasCarrier(steady(5_950_000, 30), HF_DEFAULTS)).toBe(true);
    expect(hasCarrier({ hz: 5_950_000, db: 30, peakHz: 5_950_050, steadyDb: 9 }, HF_DEFAULTS)).toBe(false);
    expect(hasCarrier({ hz: 5_950_000, db: 30, peakHz: 5_951_300, steadyDb: 1 }, HF_DEFAULTS)).toBe(false);
  });

  it("its limits come from the options", () => {
    const c = { hz: 5_950_000, db: 30, peakHz: 5_950_500, steadyDb: 6 };
    expect(hasCarrier(c, { ...HF_DEFAULTS, carrierSteadyDb: 7, carrierRasterHz: 600 })).toBe(true);
  });

  it("a stronger signal with no carrier doesn't play ahead of a carrier", () => {
    const s = new HfSweep(opts(), W, 0);
    expect(s.onCarriers(5_000, center, [ssb(5_950_000, 40), steady(6_000_000, 20)])?.listenHz).toBe(6_000_000);
  });

  it("a schedule match doesn't lift a signal with no carrier", () => {
    const s = new HfSweep(opts({ isMatched: (hz) => hz === 5_950_000 }), W, 0);
    expect(s.onCarriers(5_000, center, [ssb(5_950_000, 40), steady(6_000_000, 20)])?.listenHz).toBe(6_000_000);
  });

  it("knows whether what's playing has shown a carrier, through a fade and until the next station", () => {
    const s = new HfSweep(opts(), W, 0);
    s.onCarriers(5_000, center, [ssb(5_950_000, 40)]);
    expect(s.listenIsCarrier()).toBe(false);
    s.onCarriers(10_000, center, [steady(5_950_000, 40)]);
    expect(s.listenIsCarrier()).toBe(true);
    s.onCarriers(15_000, center, [ssb(5_950_000, 40)]);
    expect(s.listenIsCarrier()).toBe(true);
    s.skip(20_000);
    expect(s.listenIsCarrier()).toBe(false);
  });
});
