// Close Call sample recording (#222). The wideband helper tees the post-limiter
// speaker feed on fd 3 as 48 kHz mono s16le; this module turns the span of that
// feed during a Close Call hit into a small WAV on disk.

import type { CcSampleStore } from "./ccSampleStore.js";

/** Pre-roll kept ahead of every clip. The engine's `audible` event lands
 *  slightly after the carrier opens, so a clip that began there would lose the
 *  first syllable. A correctness margin, not a taste dial — deliberately not a
 *  config knob. */
export const PREROLL_SECONDS = 2;

/** How much of the pre-roll may predate the moment the PREVIOUS speaker owner
 *  let go. `audible` marks an ownership CHANGE, so a full ring is by
 *  construction whatever was audible before this lane took the speaker — on a
 *  busy band a programmed channel that closed a second ago would otherwise be
 *  spliced onto the head of the clip. The epsilon exists only because the
 *  event lands a beat after the carrier actually moves. */
export const PREROLL_GAP_EPSILON_SECONDS = 0.25;

/** How long after the last clip lands before the store is swept. The sweep is
 *  two readdir passes plus a stat per file, so it is kept off the write path
 *  entirely and coalesced across a burst of hits into one run. */
const SWEEP_DELAY_MS = 5_000;

/** The helper's tee rate. */
export const SOURCE_RATE = 48_000;
/** Clips are voice-triage grade: 8 kHz mono s16 is ~16 KB/s, a sixth of the
 *  tee, and plenty to answer "is this worth adding". */
export const CLIP_RATE = 8_000;

const DECIMATION = SOURCE_RATE / CLIP_RATE; // 6

/** 48 kHz -> 8 kHz by averaging each run of six samples. A box filter is
 *  adequate anti-aliasing at this job: the clip exists to be recognised, not
 *  measured. A trailing partial run is dropped rather than averaged over a
 *  shorter window, which would misrepresent its amplitude. */
export function decimate48kTo8k(pcm: Buffer): Buffer {
  const inSamples = Math.floor(pcm.length / 2);
  const outSamples = Math.floor(inSamples / DECIMATION);
  const out = Buffer.alloc(outSamples * 2);
  for (let i = 0; i < outSamples; i++) {
    let sum = 0;
    for (let j = 0; j < DECIMATION; j++) sum += pcm.readInt16LE((i * DECIMATION + j) * 2);
    out.writeInt16LE(Math.round(sum / DECIMATION), i * 2);
  }
  return out;
}

/** Canonical 44-byte RIFF/WAVE header for 8 kHz mono s16, followed by the data.
 *  Lengths are real (not the 0xffffffff the endless /stream.wav uses) so the
 *  browser's <audio> can show a duration and seek. */
export function encodeWav8k(pcm8k: Buffer): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm8k.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);           // fmt chunk size
  header.writeUInt16LE(1, 20);            // PCM
  header.writeUInt16LE(1, 22);            // mono
  header.writeUInt32LE(CLIP_RATE, 24);
  header.writeUInt32LE(CLIP_RATE * 2, 28); // byte rate
  header.writeUInt16LE(2, 32);            // block align
  header.writeUInt16LE(16, 34);           // bits per sample
  header.write("data", 36);
  header.writeUInt32LE(pcm8k.length, 40);
  return Buffer.concat([header, pcm8k]);
}

/** Fixed-size ring of raw 48 kHz PCM. Holds RAW samples, not decimated ones:
 *  decimation happens once at flush, so the steady-state cost of running the
 *  ring is a copy per chunk and no arithmetic. */
export class PrerollRing {
  private readonly buf: Buffer;
  private offset = 0;
  private filled = 0;

  constructor(byteCapacity: number) {
    this.buf = Buffer.alloc(Math.max(2, byteCapacity));
  }

  write(chunk: Buffer): void {
    const cap = this.buf.length;
    // A chunk larger than the ring: only its tail can survive, so skip
    // straight to it instead of wrapping the whole thing through.
    const src = chunk.length > cap ? chunk.subarray(chunk.length - cap) : chunk;
    const first = Math.min(src.length, cap - this.offset);
    src.copy(this.buf, this.offset, 0, first);
    if (first < src.length) src.copy(this.buf, 0, first);
    this.offset = (this.offset + src.length) % cap;
    this.filled = Math.min(cap, this.filled + src.length);
  }

  /** Contents oldest-first. */
  read(): Buffer {
    if (this.filled < this.buf.length) return Buffer.from(this.buf.subarray(0, this.filled));
    return Buffer.concat([
      this.buf.subarray(this.offset),
      this.buf.subarray(0, this.offset),
    ]);
  }

  clear(): void {
    this.offset = 0;
    this.filled = 0;
  }
}

/** Close Call lanes are not configured channels, so `WidebandEngine` synthesises
 *  an id carrying the frequency. That id is the ONLY place a hit's frequency and
 *  its speaker ownership are known together. */
export const CC_LANE_RE = /^cc_(\d+)$/;

/** Below this a "clip" is a squelch tail or a detection glitch, not something
 *  an operator can judge a frequency by. */
const MIN_CLIP_SECONDS = 0.35;

/** How long the post-cap suppression on the SAME lane id lasts. Its job is to
 *  absorb a squelch flap inside one transmission (audible drops and retakes
 *  within a second or two of the cap firing), not to block a later, genuine
 *  hit on the same frequency — that must still record. */
const CAP_FLAP_WINDOW_MS = 3_000;

export interface CcRecorderDeps {
  store: CcSampleStore;
  /** config.scan.recordCloseCalls */
  enabled: () => boolean;
  /** False for configured channels and locked-out frequencies — mirrors the
   *  filing guard in server.ts so the two cannot drift. */
  isRecordable: (freqHz: number) => boolean;
  /** config.scan.closeCallSampleSeconds */
  maxSeconds: () => number;
  /** config.scan.closeCallSampleMaxMb, in bytes */
  maxBytes: () => number;
  /** Frequencies with a discovery row — anything else on disk is an orphan. */
  knownFreqs: () => number[];
  now?: () => number;
}

/** Records the speaker feed for the span a Close Call lane owns it.
 *
 *  Gated on the engine's `audible` event, NOT on the `closecall` detection
 *  event. The tee is the speaker MIX, not a per-channel tap: detection and
 *  speaker ownership are separate moments, and only `audible` tells us the
 *  bytes arriving right now are the Close Call rather than a neighbouring
 *  channel's traffic. */
export class CcRecorder {
  private readonly ring: PrerollRing;
  private readonly now: () => number;
  private clip: Buffer[] = [];
  private clipBytes = 0;
  private freqHz: number | null = null;
  /** The lane we already flushed at the cap; further audio on the same span is
   *  dropped rather than starting a second clip that overwrites the first. */
  private cappedId: string | null = null;
  /** When the cap fired, so the suppression above can time out. */
  private cappedAtMs = 0;
  private currentId: string | null = null;
  /** Ring bytes that arrived while NOBODY owned the speaker. Anything older
   *  than this belongs to the previous owner — see the seed clamp in
   *  `onAudible`. Starts at the ring's capacity: before the first ownership
   *  event there is no previous owner, so the whole ring is fair game. */
  private unownedBytes: number;
  private readonly ringBytes = PREROLL_SECONDS * SOURCE_RATE * 2;
  /** Deferred clip writes, FIFO. Drained one job per tick so two flushes can
   *  never reorder. */
  private writeQueue: Array<{ freqHz: number; chunks: Buffer[] }> = [];
  private draining = false;
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: CcRecorderDeps) {
    this.ring = new PrerollRing(this.ringBytes);
    this.unownedBytes = this.ringBytes;
    this.now = deps.now ?? (() => Date.now());
  }

  onPcm(chunk: Buffer): void {
    if (!this.deps.enabled()) {
      // Disabled mid-clip: the in-flight clip is abandoned (not flushed) and
      // the ring is dropped, so neither a stale partial clip nor stale
      // pre-roll of arbitrary age can survive into a later, re-enabled span.
      this.freqHz = null;
      this.clip = [];
      this.clipBytes = 0;
      this.ring.clear();
      this.unownedBytes = 0;
      return;
    }
    if (this.freqHz === null) {
      this.ring.write(chunk);
      this.unownedBytes = this.currentId === null
        ? Math.min(this.ringBytes, this.unownedBytes + chunk.length)
        : 0; // a channel owns the speaker: this is ITS audio, not free pre-roll
      return;
    }
    const cap = Math.max(1, this.deps.maxSeconds()) * SOURCE_RATE * 2;
    const room = cap - this.clipBytes;
    const take = chunk.length > room ? chunk.subarray(0, room) : chunk;
    this.clip.push(Buffer.from(take));
    this.clipBytes += take.length;
    if (this.clipBytes >= cap) {
      this.cappedId = this.currentId;
      this.cappedAtMs = this.now();
      this.flush();
    }
  }

  onAudible(channelId: string | null): void {
    if (channelId === this.currentId) return;
    // Read the unowned-audio budget before ownership changes, then close it:
    // from here on the ring is being written under a new owner.
    const gapBytes = this.unownedBytes;
    if (channelId !== null) this.unownedBytes = 0;
    this.currentId = channelId;
    this.flush();
    if (!this.deps.enabled() || channelId === null) return;
    // Same span as the one we already capped: suppress only within a short
    // flap window (a squelch stutter inside the same transmission) — a
    // genuine later hit on the same frequency must still record.
    if (channelId === this.cappedId && this.now() - this.cappedAtMs < CAP_FLAP_WINDOW_MS) return;
    this.cappedId = null;
    const match = CC_LANE_RE.exec(channelId);
    if (!match?.[1]) return;
    const freqHz = Number(match[1]);
    if (!this.deps.isRecordable(freqHz)) return;
    this.freqHz = freqHz;
    // Seed with the pre-roll: the carrier opened slightly before this event.
    // Clamped to the per-clip cap so a small `maxSeconds()` (from an older
    // config file predating the schema floor) can never seed a "clip" that
    // is entirely pre-roll audio recorded before the lane took the speaker.
    // Clamped a second way too: never seed more pre-roll than the audio that
    // arrived AFTER the previous speaker owner let go (plus a small epsilon).
    // See PREROLL_GAP_EPSILON_SECONDS.
    const cap = Math.max(1, this.deps.maxSeconds()) * SOURCE_RATE * 2;
    const limit = Math.min(cap, gapBytes + PREROLL_GAP_EPSILON_SECONDS * SOURCE_RATE * 2);
    const preroll = this.ring.read();
    const seed = preroll.length > limit ? preroll.subarray(preroll.length - limit) : preroll;
    this.clip = seed.length > 0 ? [seed] : [];
    this.clipBytes = seed.length;
  }

  /** The engine lost speaker ownership without saying so.
   *
   *  `WidebandEngine` clears its `audibleId` SILENTLY in five places — helper
   *  spawn, `sendTune` (every group hop), `sendSweepTune`, the max-hold
   *  force-hop, and `stop()` — and emits no `audible` event for any of them.
   *  Without this the recorder would keep appending, so a clip could end up
   *  holding a *different window's* speaker mix: exactly the wrong-audio
   *  failure this feature exists to prevent.
   *
   *  The span up to this moment was genuinely heard, so it is flushed
   *  (truncated), per the spec's "the clip only ever contains what was
   *  actually heard" — not thrown away. Everything else is dropped: the
   *  pre-roll ring (its contents describe the window the engine just left),
   *  the current owner, and the post-cap suppression. */
  reset(): void {
    this.flush();
    this.currentId = null;
    this.cappedId = null;
    this.cappedAtMs = 0;
    this.ring.clear();
    this.unownedBytes = 0;
  }

  /** End whatever is in flight and queue it for writing. Safe to call when
   *  nothing is recording. */
  flush(): void {
    const freqHz = this.freqHz;
    const clip = this.clip;
    const bytes = this.clipBytes;
    // The state reset is SYNCHRONOUS, and the buffers are detached here rather
    // than in the deferred body: a chunk arriving on the very next audio
    // callback belongs to the next clip and cannot land in this one.
    this.freqHz = null;
    this.clip = [];
    this.clipBytes = 0;
    if (freqHz === null || bytes === 0) return;
    if (bytes / 2 / SOURCE_RATE < MIN_CLIP_SECONDS) return;
    this.writeQueue.push({ freqHz, chunks: clip });
    if (this.draining) return;
    this.draining = true;
    setImmediate(() => this.drainWrites());
  }

  /** The expensive part, deliberately OFF the audio path. `flush()` is reached
   *  from `onPcm`, which the engine calls synchronously from the helper's fd-3
   *  "data" handler — the one path CLAUDE.md says must never stall, and the
   *  same event loop /api/status is served from. Decimation alone is ~1M
   *  readInt16LE for a 20 s clip, plus a ~320 KB writeFileSync.
   *
   *  One job per tick, in enqueue order, so two flushes can never reorder. */
  private drainWrites(): void {
    const job = this.writeQueue.shift();
    if (!job) { this.draining = false; return; }
    try {
      this.deps.store.write(job.freqHz, decimate48kTo8k(Buffer.concat(job.chunks)));
    } catch {
      // A full or unwritable state directory must never take the radio down.
    }
    if (this.writeQueue.length > 0) { setImmediate(() => this.drainWrites()); return; }
    this.draining = false;
    this.scheduleSweep();
  }

  /** Orphan + size-cap sweep, coalesced: a burst of hits costs one sweep, not
   *  one per clip, and it never runs inside a write. */
  private scheduleSweep(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setTimeout(() => {
      this.sweepTimer = null;
      try {
        this.deps.store.sweep({
          knownFreqs: this.deps.knownFreqs(),
          maxBytes: this.deps.maxBytes(),
          nowMs: this.now(),
        });
      } catch {
        // As above: the store failing is never worth an exception here.
      }
    }, SWEEP_DELAY_MS);
    this.sweepTimer.unref();
  }

  /** Resolves once every queued clip has landed on disk. Tests only —
   *  nothing in production waits for a write. */
  async settle(): Promise<void> {
    while (this.draining) await new Promise<void>((r) => setImmediate(r));
  }
}
