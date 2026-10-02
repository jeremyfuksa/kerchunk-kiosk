// Streaming crop decoder for 8-bit palette-indexed, non-interlaced PNGs (the
// IEM n0q composite). Inflate runs on the libuv threadpool via node:zlib; row
// un-filtering happens in the 'data' callbacks, so the event loop yields
// between ~64 KB chunks. The PNG may arrive as a byte stream (a fetch body):
// chunks are parsed as they land, and once past the crop's last row both the
// inflate and the source are dropped, so a crop in the top half of the
// 12200x5400 image never DOWNLOADS the rest — on a slow link that is the
// difference between finishing and timing out. Indices are returned raw (n0q.ts maps them to dBZ).
import { createInflate } from "node:zlib";

export class PngFormatError extends Error {}

export interface IndexedCrop {
  width: number;
  height: number;
  /** Row-major palette indices; row 0 is the crop's top (northern) row. */
  bytes: Uint8Array;
  imageWidth: number;
  imageHeight: number;
}

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

/** A whole PNG, or its bytes as they arrive (e.g. a fetch Response body). */
export type PngSource = Uint8Array | AsyncIterable<Uint8Array>;

export async function decodeIndexedCrop(
  src: PngSource,
  win: { x0: number; y0: number; width: number; height: number },
): Promise<IndexedCrop> {
  const parts: AsyncIterable<Uint8Array> = src instanceof Uint8Array ? (async function* () { yield src; })() : src;
  // Chunk-level parse as bytes arrive: signature, then [len,type] headers,
  // bodies (IHDR kept, IDAT streamed into inflate, the rest skipped) and CRCs.
  let stage: "sig" | "head" | "body" | "crc" | "end" = "sig";
  const head = new Uint8Array(13); // signature (8), chunk header (8) or IHDR (13)
  let headFill = 0, left = 8, type = "";
  let dec: Decoder | null = null;
  try {
    for await (const part of parts) {
      let i = 0;
      while (i < part.length) {
        if (dec?.settled) break;
        if (stage === "body" && type === "IDAT") {
          const take = Math.min(left, part.length - i);
          await dec!.write(part.subarray(i, i + take)); // backpressure: decode before pulling more
          i += take; left -= take;
        } else if (stage === "body" && type !== "IHDR" || stage === "crc") {
          const take = Math.min(left, part.length - i);
          i += take; left -= take;
        } else {
          const take = Math.min(left, part.length - i);
          head.set(part.subarray(i, i + take), headFill);
          headFill += take; i += take; left -= take;
        }
        if (left > 0) continue;
        headFill = 0;
        if (stage === "sig") {
          for (let k = 0; k < 8; k++) if (head[k] !== SIGNATURE[k]) throw new PngFormatError("not a PNG");
          stage = "head"; left = 8;
        } else if (stage === "head") {
          const len = ((head[0]! << 24) | (head[1]! << 16) | (head[2]! << 8) | head[3]!) >>> 0;
          type = String.fromCharCode(head[4]!, head[5]!, head[6]!, head[7]!);
          if (type === "IHDR" && len !== 13) throw new PngFormatError("bad IHDR length");
          if (type === "IDAT" && !dec) throw new PngFormatError("missing IHDR");
          if (type === "IEND") { stage = "end"; break; }
          stage = "body"; left = len;
          if (len === 0) { stage = "crc"; left = 4; }
        } else if (stage === "body") {
          if (type === "IHDR") dec = new Decoder(head, win);
          stage = "crc"; left = 4;
        } else {
          stage = "head"; left = 8;
        }
      }
      if (dec?.settled || stage === "end") break; // stops the download
    }
  } catch (err) {
    dec?.abort();
    throw err;
  }
  if (!dec) throw new PngFormatError("missing IHDR");
  return dec.end();
}

/** Row un-filtering + crop over an inflate stream, fed IDAT bytes. */
class Decoder {
  settled = false;
  private readonly inflate = createInflate();
  private readonly result: Promise<IndexedCrop>;
  private readonly waiting = new Set<() => void>();

  constructor(ihdr: Uint8Array, win: { x0: number; y0: number; width: number; height: number }) {
    const width = ((ihdr[0]! << 24) | (ihdr[1]! << 16) | (ihdr[2]! << 8) | ihdr[3]!) >>> 0;
    const height = ((ihdr[4]! << 24) | (ihdr[5]! << 16) | (ihdr[6]! << 8) | ihdr[7]!) >>> 0;
    const depth = ihdr[8], color = ihdr[9], interlace = ihdr[12];
    if (depth !== 8 || color !== 3 || interlace !== 0) {
      throw new PngFormatError(`unsupported PNG: depth ${depth} color ${color} interlace ${interlace}`);
    }
    if (!width || !height) throw new PngFormatError("missing IHDR");
    if (win.x0 < 0 || win.y0 < 0 || win.width <= 0 || win.height <= 0
        || win.x0 + win.width > width || win.y0 + win.height > height) {
      throw new RangeError("crop window outside the image");
    }
    this.result = cropRows(this.inflate, width, height, win, () => {
      this.settled = true;
      for (const r of this.waiting) r(); // a destroyed inflate may never call back
      this.waiting.clear();
    });
    this.result.catch(() => {}); // observed via end(); never an unhandled rejection
  }

  write(b: Uint8Array): Promise<void> {
    if (this.settled) return Promise.resolve();
    return new Promise((resolve) => {
      const done = (): void => { this.waiting.delete(done); resolve(); };
      this.waiting.add(done);
      this.inflate.write(b, done);
    });
  }
  abort(): void { this.settled = true; this.inflate.destroy(); }
  end(): Promise<IndexedCrop> {
    if (!this.settled) this.inflate.end();
    return this.result;
  }
}

function cropRows(
  inflate: ReturnType<typeof createInflate>,
  width: number, height: number,
  win: { x0: number; y0: number; width: number; height: number },
  onSettle: () => void,
): Promise<IndexedCrop> {
  const stride = width + 1; // filter byte + one index per pixel
  const out = new Uint8Array(win.width * win.height);
  const rowBuf = new Uint8Array(stride);
  let prev = new Uint8Array(width);
  let cur = new Uint8Array(width);
  let fill = 0;
  let row = 0;
  const endRow = win.y0 + win.height; // exclusive

  function unfilter(): void {
    const f = rowBuf[0];
    for (let x = 0; x < width; x++) {
      const raw = rowBuf[x + 1]!;
      const a = x > 0 ? cur[x - 1]! : 0;
      const b = prev[x]!;
      const c = x > 0 ? prev[x - 1]! : 0;
      let v: number;
      switch (f) {
        case 0: v = raw; break;
        case 1: v = raw + a; break;
        case 2: v = raw + b; break;
        case 3: v = raw + ((a + b) >> 1); break;
        case 4: {
          const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          v = raw + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: throw new PngFormatError(`bad filter type ${f} on row ${row}`);
      }
      cur[x] = v & 255;
    }
  }

  function consume(chunk: Uint8Array): void {
    let i = 0;
    while (i < chunk.length && row < endRow) {
      const take = Math.min(stride - fill, chunk.length - i);
      rowBuf.set(chunk.subarray(i, i + take), fill);
      fill += take;
      i += take;
      if (fill === stride) {
        unfilter();
        if (row >= win.y0) out.set(cur.subarray(win.x0, win.x0 + win.width), (row - win.y0) * win.width);
        const t = prev; prev = cur; cur = t;
        row++;
        fill = 0;
      }
    }
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err: Error | null): void => {
      if (settled) return;
      settled = true;
      onSettle();
      inflate.removeAllListeners("data");
      inflate.destroy();
      if (err) reject(err);
      else resolve({ width: win.width, height: win.height, bytes: out, imageWidth: width, imageHeight: height });
    };
    inflate.on("data", (chunk: Buffer) => {
      if (settled) return;
      try { consume(chunk); } catch (err) { finish(err as Error); return; }
      if (row >= endRow) finish(null);
    });
    inflate.on("error", (err) => finish(row >= endRow ? null : err));
    inflate.on("close", () => finish(row >= endRow ? null : new PngFormatError("image data ended before the crop")));
    inflate.on("end", () => finish(row >= endRow ? null : new PngFormatError("image data ended before the crop")));
  });
}
