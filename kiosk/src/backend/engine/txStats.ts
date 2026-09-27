import { appendFile, rename, stat } from "node:fs/promises";

// Squelch-calibration log: one JSON line per helper `txstat` event (a carrier
// episode on one lane, opened or rejected by the quieting check — see
// kiosk/native/src/scanner.hpp TxEpisode). Instrumentation only: nothing reads
// it at runtime; kiosk/bench/squelch_calibrate.py analyses it offline.
//
// Appends are serialized on one promise chain (no interleaved writes, no
// rotate/append race). Errors are swallowed — a full disk must never disturb
// the scanner — with a rate-limited log line.

/** Rotate to `<path>.1` (single generation) once the file would exceed this. */
export const TXSTATS_MAX_BYTES = 20 * 1024 * 1024;
const ERROR_LOG_EVERY_MS = 60_000;

export interface TxStatsLogOptions {
  maxBytes?: number;
  log?: (msg: string) => void;
  now?: () => number;
}

export class TxStatsLog {
  private readonly maxBytes: number;
  private readonly log: (msg: string) => void;
  private readonly now: () => number;
  private chain: Promise<void> = Promise.resolve();
  // Current file size, learned by one stat() and then tracked; null = unknown
  // (first write, or after an error) so the next write re-stats.
  private size: number | null = null;
  private lastErrorLogAt = -Infinity;
  private suppressed = 0;

  constructor(readonly path: string, opts: TxStatsLogOptions = {}) {
    this.maxBytes = opts.maxBytes ?? TXSTATS_MAX_BYTES;
    this.log = opts.log ?? ((m) => console.warn(m));
    this.now = opts.now ?? Date.now;
  }

  append(record: Record<string, unknown>): void {
    const line = JSON.stringify(record) + "\n";
    this.chain = this.chain.then(() => this.write(line));
  }

  /** Resolves once every append issued so far has landed (or failed). */
  flush(): Promise<void> { return this.chain; }

  private async write(line: string): Promise<void> {
    try {
      if (this.size === null) {
        try { this.size = (await stat(this.path)).size; } catch { this.size = 0; }
      }
      const bytes = Buffer.byteLength(line);
      if (this.size > 0 && this.size + bytes > this.maxBytes) {
        await rename(this.path, `${this.path}.1`);
        this.size = 0;
      }
      await appendFile(this.path, line);
      this.size += bytes;
    } catch (e) {
      this.size = null;
      const t = this.now();
      if (t - this.lastErrorLogAt >= ERROR_LOG_EVERY_MS) {
        const extra = this.suppressed > 0 ? ` (${this.suppressed} more suppressed)` : "";
        this.log(`txstats: write to ${this.path} failed: ${(e as Error).message}${extra}`);
        this.lastErrorLogAt = t;
        this.suppressed = 0;
      } else {
        this.suppressed++;
      }
    }
  }
}
