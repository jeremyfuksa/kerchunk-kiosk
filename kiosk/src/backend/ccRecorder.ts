// Close Call sample recording (#222). The wideband helper tees the post-limiter
// speaker feed on fd 3 as 48 kHz mono s16le; this module turns the span of that
// feed during a Close Call hit into a small WAV on disk.

/** Pre-roll kept ahead of every clip. The engine's `audible` event lands
 *  slightly after the carrier opens, so a clip that began there would lose the
 *  first syllable. A correctness margin, not a taste dial — deliberately not a
 *  config knob. */
export const PREROLL_SECONDS = 2;

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
