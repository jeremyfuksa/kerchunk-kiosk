// CB channel activity from FernSDR waterfall rows (spec 2026-10-15-cb-fernsdr,
// "Channel selection"). Pure: rows in, open/close/audible transitions out.
export interface CbWatchChannel { n: number; freq: number; priority: boolean; hangMs: number }
export interface CbWatchOpts { openDb: number; openRows: number; maxOpenMs: number; baselineAlpha?: number; closeHystDb?: number }
export interface WatchRow { lowHz: number; highHz: number; levels: ArrayLike<number> }
export type CbTransition = { kind: "open" | "close"; n: number; ts: number } | { kind: "audible"; n: number | null; ts: number };

const HALF_WIDTH_HZ = 3000;

function median(levels: ArrayLike<number>): number {
  const s = Array.from(levels).sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? 0;
}

/** Max level within ±halfWidth of freq, minus the row median; null when the
 *  channel isn't inside the row. Uses the row's own edges and width. */
export function channelLevel(r: WatchRow, freq: number, halfWidthHz = HALF_WIDTH_HZ, med = median(r.levels)): number | null {
  const width = r.levels.length;
  if (width === 0 || freq < r.lowHz || freq > r.highHz) return null;
  const binHz = (r.highHz - r.lowHz) / width;
  const lo = Math.max(0, Math.ceil((freq - halfWidthHz - r.lowHz) / binHz - 0.5));
  const hi = Math.min(width - 1, Math.floor((freq + halfWidthHz - r.lowHz) / binHz - 0.5));
  if (hi < lo) return null;
  let max = -Infinity;
  for (let i = lo; i <= hi; i++) max = Math.max(max, r.levels[i] ?? -Infinity);
  return max - med;
}

interface ChState { ch: CbWatchChannel; baseline: number | null; above: number; open: boolean; openedAt: number; lastHot: number }

export class CbWatch {
  private readonly st: ChState[];
  private readonly alpha: number;
  private readonly hyst: number;
  private _audible: number | null = null;

  constructor(channels: CbWatchChannel[], private readonly opts: CbWatchOpts) {
    this.st = channels.map((ch) => ({ ch, baseline: null, above: 0, open: false, openedAt: 0, lastHot: 0 }));
    this.alpha = opts.baselineAlpha ?? 0.05;
    this.hyst = opts.closeHystDb ?? 3;
  }

  get audible(): number | null { return this._audible; }
  openChannels(): number[] { return this.st.filter((s) => s.open).map((s) => s.ch.n); }

  row(r: WatchRow, ts: number): CbTransition[] {
    const med = median(r.levels);
    const closes: CbTransition[] = [], opens: CbTransition[] = [];
    let preempt: number | null = null;
    for (const s of this.st) {
      const level = channelLevel(r, s.ch.freq, HALF_WIDTH_HZ, med);
      if (level === null) continue;
      if (s.baseline === null) { s.baseline = level; continue; }
      const over = level - s.baseline;
      if (s.open) {
        if (over >= this.opts.openDb - this.hyst) s.lastHot = ts;
        if (ts - s.openedAt >= this.opts.maxOpenMs) {
          s.open = false; s.above = 0; s.baseline = level;   // a carrier: absorb it
          closes.push({ kind: "close", n: s.ch.n, ts });
        } else if (ts - s.lastHot >= s.ch.hangMs) {
          s.open = false; s.above = 0;
          closes.push({ kind: "close", n: s.ch.n, ts });
        }
      } else if (over >= this.opts.openDb) {
        if (++s.above >= this.opts.openRows) {
          s.open = true; s.openedAt = ts; s.lastHot = ts;
          opens.push({ kind: "open", n: s.ch.n, ts });
          if (s.ch.priority) preempt ??= s.ch.n;
        }
      } else {
        s.above = 0;
        s.baseline += this.alpha * (level - s.baseline);
      }
    }
    return [...closes, ...opens, ...this.pickAudible(ts, preempt)];
  }

  closeAll(ts: number): CbTransition[] {
    const out: CbTransition[] = [];
    for (const s of this.st) {
      if (!s.open) continue;
      s.open = false; s.above = 0;
      out.push({ kind: "close", n: s.ch.n, ts });
    }
    if (this._audible !== null) { this._audible = null; out.push({ kind: "audible", n: null, ts }); }
    return out;
  }

  private pickAudible(ts: number, preempt: number | null): CbTransition[] {
    const cur = this.st.find((s) => s.ch.n === this._audible);
    let next = this._audible;
    if (!cur?.open) {
      const open = this.st.filter((s) => s.open);
      const pri = open.filter((s) => s.ch.priority);
      const pool = pri.length ? pri : open;
      next = pool.sort((a, b) => a.openedAt - b.openedAt)[0]?.ch.n ?? null;
    } else if (preempt !== null && !cur.ch.priority) {
      next = preempt;
    }
    if (next === this._audible) return [];
    this._audible = next;
    return [{ kind: "audible", n: next, ts }];
  }
}
