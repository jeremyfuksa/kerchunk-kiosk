// Rolling scan-coverage meter (spec 2026-10-13 silent chatter): where the
// scanner's wall time goes — holding for audible opens, holding for silent
// ones (visual hold, until it is retired), quiet dwell, sweep stops. Fixed
// one-minute buckets over a ten-minute window: O(1) record, no per-tick alloc.
export type CoverageKind = "audible" | "silent" | "quiet" | "sweep";
const KINDS: readonly CoverageKind[] = ["audible", "silent", "quiet", "sweep"];

interface Bucket { start: number; ms: Record<CoverageKind, number> }

export class CoverageMeter {
  private readonly buckets: Bucket[] = [];
  constructor(private readonly windowMs = 600_000, private readonly bucketMs = 60_000) {}

  record(kind: CoverageKind, ms: number, now: number): void {
    if (!(ms > 0)) return;
    const start = Math.floor(now / this.bucketMs) * this.bucketMs;
    let b = this.buckets[this.buckets.length - 1];
    if (!b || b.start !== start) {
      b = { start, ms: { audible: 0, silent: 0, quiet: 0, sweep: 0 } };
      this.buckets.push(b);
    }
    b.ms[kind] += ms;
    this.prune(now);
  }

  fractions(now: number): Record<CoverageKind, number> & { windowMs: number } {
    this.prune(now);
    const sum: Record<CoverageKind, number> = { audible: 0, silent: 0, quiet: 0, sweep: 0 };
    for (const b of this.buckets) for (const k of KINDS) sum[k] += b.ms[k];
    const total = KINDS.reduce((t, k) => t + sum[k], 0);
    const out = { windowMs: this.windowMs } as Record<CoverageKind, number> & { windowMs: number };
    for (const k of KINDS) out[k] = total > 0 ? sum[k] / total : 0;
    return out;
  }

  private prune(now: number): void {
    const cutoff = now - this.windowMs;
    while (this.buckets.length && this.buckets[0]!.start + this.bucketMs <= cutoff) this.buckets.shift();
  }
}
