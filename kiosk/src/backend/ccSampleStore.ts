import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { encodeWav8k, CLIP_RATE } from "./ccRecorder.js";

export interface CcSampleMeta {
  freqHz: number;
  bytes: number;
  /** Playable length, excluding the 44-byte WAV header. */
  seconds: number;
  /** Last write, ms since epoch. */
  ts: number;
}

/** How long an unclaimed clip is kept. A frequency must hit TWICE to earn a
 *  discovery row and the helper spaces hits >=5 min apart, so a clip recorded
 *  on hit 1 needs to outlive that gap comfortably before it counts as junk. */
export const ORPHAN_GRACE_MS = 60 * 60 * 1000;

const WAV_HEADER_BYTES = 44;
const CLIP_RE = /^(\d+)\.wav$/;

/** The `cc-samples` directory. Clips are keyed by FREQUENCY, not discovery id:
 *  a frequency's first hit is recorded before any discovery row exists, so a
 *  frequency is the only identifier available at write time. */
export class CcSampleStore {
  constructor(private readonly dir: string) {}

  pathFor(freqHz: number): string {
    return join(this.dir, `${freqHz}.wav`);
  }

  write(freqHz: number, pcm8k: Buffer): void {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.pathFor(freqHz), encodeWav8k(pcm8k));
  }

  meta(freqHz: number): CcSampleMeta | null {
    try {
      const st = statSync(this.pathFor(freqHz));
      return {
        freqHz,
        bytes: st.size,
        seconds: Math.max(0, st.size - WAV_HEADER_BYTES) / 2 / CLIP_RATE,
        ts: st.mtimeMs,
      };
    } catch {
      return null; // absent, or an unreadable directory — same answer either way
    }
  }

  /** Newest first. */
  list(): CcSampleMeta[] {
    if (!existsSync(this.dir)) return [];
    const out: CcSampleMeta[] = [];
    for (const name of readdirSync(this.dir)) {
      const m = CLIP_RE.exec(name);
      if (!m?.[1]) continue; // stray file in the directory; not ours to report
      const meta = this.meta(Number(m[1]));
      if (meta) out.push(meta);
    }
    return out.sort((a, b) => b.ts - a.ts);
  }

  delete(freqHz: number): boolean {
    const path = this.pathFor(freqHz);
    if (!existsSync(path)) return false;
    rmSync(path, { force: true });
    return true;
  }

  /** Drop clips nothing will ever claim, then hold the directory under budget.
   *  Orphans go first (they have no row to be played from), then oldest-first
   *  eviction takes whatever is still over the cap. */
  sweep(opts: { knownFreqs: number[]; maxBytes: number; nowMs: number }): void {
    const known = new Set(opts.knownFreqs);
    let clips = this.list();
    for (const clip of clips) {
      if (known.has(clip.freqHz)) continue;
      if (opts.nowMs - clip.ts < ORPHAN_GRACE_MS) continue;
      this.delete(clip.freqHz);
    }
    clips = this.list();
    let total = clips.reduce((sum, c) => sum + c.bytes, 0);
    // list() is newest-first, so walking backwards evicts the oldest.
    for (let i = clips.length - 1; i >= 0 && total > opts.maxBytes; i--) {
      const clip = clips[i];
      if (!clip) continue;
      this.delete(clip.freqHz);
      total -= clip.bytes;
    }
  }
}
