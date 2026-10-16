import { describe, it, expect } from "vitest";
import { CbWatch, channelLevel, type CbWatchChannel, type WatchRow } from "../src/backend/fernsdr/cbWatch.js";

const LOW = 26_957_000, HIGH = 27_413_000, W = 456;   // ~1 kHz bins
const binOf = (f: number) => Math.floor(((f - LOW) / (HIGH - LOW)) * W);
function row(hot: Record<number, number> = {}, floor = -100): WatchRow {
  const levels = new Array<number>(W).fill(floor);
  for (const [f, db] of Object.entries(hot)) levels[binOf(Number(f))] = db;
  return { lowHz: LOW, highHz: HIGH, levels };
}
const CH: CbWatchChannel[] = [
  { n: 6, freq: 27_025_000, priority: true, hangMs: 2000 },
  { n: 14, freq: 27_125_000, priority: false, hangMs: 2000 },
  { n: 23, freq: 27_255_000, priority: false, hangMs: 2000 },
  { n: 38, freq: 27_385_000, priority: false, hangMs: 1500 },
];
const opts = { openDb: 10, openRows: 2, maxOpenMs: 180_000 };
const feed = (w: CbWatch, r: WatchRow, t0: number, rows: number) => {
  const out = [];
  for (let i = 0; i < rows; i++) out.push(...w.row(r, t0 + i * 100));
  return out;
};

describe("channelLevel", () => {
  it("is max-within-±3 kHz minus the row median; null outside the row", () => {
    expect(channelLevel(row({ 27_125_000: -70 }), 27_125_000)).toBe(30);
    expect(channelLevel(row({ 27_129_500: -70 }), 27_125_000)).toBe(0);   // 4.5 kHz away
    expect(channelLevel(row(), 28_000_000)).toBeNull();
  });
});

describe("CbWatch", () => {
  it("needs openRows consecutive rows over the baseline to open, then speaks it", () => {
    const w = new CbWatch(CH, opts);
    feed(w, row(), 0, 10);
    expect(w.row(row({ 27_125_000: -80 }), 1000)).toEqual([]);   // 1 row: not yet
    expect(w.row(row({ 27_125_000: -80 }), 1100)).toEqual([
      { kind: "open", n: 14, ts: 1100 },
      { kind: "audible", n: 14, ts: 1100 },
    ]);
  });

  it("one noisy row between quiet rows never opens", () => {
    const w = new CbWatch(CH, opts);
    feed(w, row(), 0, 10);
    expect([...w.row(row({ 27_125_000: -80 }), 1000), ...w.row(row(), 1100), ...w.row(row({ 27_125_000: -80 }), 1200)]).toEqual([]);
  });

  it("closes after its hang (LSB channels use their own) and goes silent", () => {
    const w = new CbWatch(CH, opts);
    feed(w, row(), 0, 10);
    feed(w, row({ 27_385_000: -80 }), 1000, 3);   // 38 opens at 1100
    const quiet = feed(w, row(), 1300, 20);       // last hot row at 1200; hang 1500
    const close = quiet.find((t) => t.kind === "close");
    expect(close).toEqual({ kind: "close", n: 38, ts: 2700 });
    expect(quiet).toContainEqual({ kind: "audible", n: null, ts: 2700 });
  });

  it("a priority channel pre-empts; the other stays open (history) but silent", () => {
    const w = new CbWatch(CH, opts);
    feed(w, row(), 0, 10);
    feed(w, row({ 27_125_000: -80 }), 1000, 2);
    const t = feed(w, row({ 27_125_000: -80, 27_025_000: -80 }), 1200, 2);
    expect(t).toContainEqual({ kind: "open", n: 6, ts: 1300 });
    expect(t).toContainEqual({ kind: "audible", n: 6, ts: 1300 });
    expect(w.openChannels().sort((a, b) => a - b)).toEqual([6, 14]);
  });

  it("a non-priority channel does not steal the speaker", () => {
    const w = new CbWatch(CH, opts);
    feed(w, row(), 0, 10);
    feed(w, row({ 27_125_000: -80 }), 1000, 2);
    const t = feed(w, row({ 27_125_000: -80, 27_255_000: -80 }), 1200, 2);   // ch 23 (out of order freq)
    expect(t).toContainEqual({ kind: "open", n: 23, ts: 1300 });
    expect(t.some((x) => x.kind === "audible")).toBe(false);
    expect(w.audible).toBe(14);
  });

  it("a steady carrier closes at maxOpenMs and is absorbed into the baseline", () => {
    const w = new CbWatch(CH, { ...opts, maxOpenMs: 10_000 });
    feed(w, row(), 0, 10);
    const t = feed(w, row({ 27_125_000: -80 }), 1000, 150);   // 15 s of carrier
    expect(t.filter((x) => x.kind === "open" && x.n === 14)).toHaveLength(1);
    expect(t).toContainEqual({ kind: "close", n: 14, ts: 11_100 });
  });

  it("baseline absorbs a slow floor rise while closed", () => {
    const w = new CbWatch(CH, opts);
    for (let i = 0; i < 200; i++) w.row(row({ 27_125_000: -100 + Math.min(8, i * 0.1) }), i * 100);
    expect(w.openChannels()).toEqual([]);
  });

  it("an open channel that leaves the row span still closes at its hang", () => {
    const w = new CbWatch(CH, opts);
    feed(w, row(), 0, 10);
    feed(w, row({ 27_125_000: -80 }), 1000, 2);   // 14 opens at 1100, lastHot 1100
    // Span now starts above 27_125 kHz, so ch 14 has no level in these rows.
    const span: WatchRow = { lowHz: 27_200_000, highHz: 27_413_000, levels: new Array<number>(213).fill(-100) };
    const t: ReturnType<CbWatch["row"]> = [];
    for (let ts = 1200; ts <= 3200; ts += 100) t.push(...w.row(span, ts));
    expect(t).toContainEqual({ kind: "close", n: 14, ts: 3100 });   // lastHot 1100 + 2000
    expect(t).toContainEqual({ kind: "audible", n: null, ts: 3100 });
    expect(w.openChannels()).toEqual([]);
  });

  it("closeAll releases everything (pause/stop)", () => {
    const w = new CbWatch(CH, opts);
    feed(w, row(), 0, 10);
    feed(w, row({ 27_125_000: -80 }), 1000, 2);
    expect(w.closeAll(5000)).toEqual([
      { kind: "close", n: 14, ts: 5000 },
      { kind: "audible", n: null, ts: 5000 },
    ]);
    expect(w.audible).toBeNull();
  });
});
