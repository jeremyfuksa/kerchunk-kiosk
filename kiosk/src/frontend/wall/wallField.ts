// Pure accumulator for the Kerchunk Wall (spec 2026-06-09). One column per
// configured channel; every key-up deposits a mark keyed by frequency. Tracks
// per-frequency hit counts (column height, relative to the busiest) and a
// decaying "breath" (the fresh-hit bloom). No DOM, no canvas, no wall-clock —
// the caller passes `now`. Mirrors art/sediment.ts's SedimentField.

export interface MarkInput {
  freq: number;
  ts: number;
}

export interface WallFieldOptions {
  breathMs: number;
}

interface Column {
  count: number;
  lastTs: number;
}

export class WallField {
  private cols = new Map<number, Column>();
  private readonly breathMs: number;

  constructor(opts: WallFieldOptions) {
    this.breathMs = opts.breathMs;
  }

  deposit(m: MarkInput): void {
    const col = this.cols.get(m.freq) ?? { count: 0, lastTs: m.ts };
    col.count += 1;
    col.lastTs = Math.max(col.lastTs, m.ts);
    this.cols.set(m.freq, col);
  }

  countFor(freq: number): number {
    return this.cols.get(freq)?.count ?? 0;
  }

  /** Busiest column's count, floored at 1 so renderers can divide safely. */
  maxCount(): number {
    let max = 1;
    for (const col of this.cols.values()) max = Math.max(max, col.count);
    return max;
  }

  /** 1 at the latest hit on this column, linear to 0 at breathMs. */
  bloomFor(freq: number, now: number): number {
    const col = this.cols.get(freq);
    if (!col) return 0;
    const age = now - col.lastTs;
    return age >= this.breathMs ? 0 : Math.max(0, 1 - age / this.breathMs);
  }

  /** True if any column is still blooming — the loop's "keep animating" signal. */
  anyBloom(now: number): boolean {
    for (const col of this.cols.values()) {
      if (now - col.lastTs < this.breathMs) return true;
    }
    return false;
  }

  clear(): void {
    this.cols.clear();
  }
}
