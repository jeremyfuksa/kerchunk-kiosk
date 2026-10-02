// Streaming crop decoder for 8-bit palette-indexed, non-interlaced PNGs (the
// IEM n0q composite). Inflate runs on the libuv threadpool via node:zlib; row
// un-filtering happens in the 'data' callbacks, so the event loop yields
// between ~64 KB chunks. It keeps only the crop window and destroys the stream
// once past the crop's last row, so a crop near the top of a 12200x5400 image
// never inflates the rest. Indices are returned raw (n0q.ts maps them to dBZ).
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

export function decodeIndexedCrop(
  png: Uint8Array,
  win: { x0: number; y0: number; width: number; height: number },
): Promise<IndexedCrop> {
  for (let i = 0; i < 8; i++) {
    if (png[i] !== SIGNATURE[i]) return Promise.reject(new PngFormatError("not a PNG"));
  }
  const dv = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let off = 8;
  let width = 0, height = 0;
  const idat: Uint8Array[] = [];
  while (off + 8 <= png.length) {
    const len = dv.getUint32(off);
    const type = String.fromCharCode(png[off + 4]!, png[off + 5]!, png[off + 6]!, png[off + 7]!);
    if (type === "IHDR") {
      width = dv.getUint32(off + 8);
      height = dv.getUint32(off + 12);
      const depth = png[off + 16], color = png[off + 17], interlace = png[off + 20];
      if (depth !== 8 || color !== 3 || interlace !== 0) {
        return Promise.reject(new PngFormatError(
          `unsupported PNG: depth ${depth} color ${color} interlace ${interlace}`));
      }
    } else if (type === "IDAT") {
      idat.push(png.subarray(off + 8, Math.min(png.length, off + 8 + len)));
    } else if (type === "IEND") {
      break;
    }
    off += 12 + len;
  }
  if (!width || !height) return Promise.reject(new PngFormatError("missing IHDR"));
  if (win.x0 < 0 || win.y0 < 0 || win.width <= 0 || win.height <= 0
      || win.x0 + win.width > width || win.y0 + win.height > height) {
    return Promise.reject(new RangeError("crop window outside the image"));
  }

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
    const inflate = createInflate();
    let settled = false;
    const finish = (err: Error | null): void => {
      if (settled) return;
      settled = true;
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
    inflate.on("end", () => finish(row >= endRow ? null : new PngFormatError("image data ended before the crop")));
    for (const d of idat) inflate.write(d);
    inflate.end();
  });
}
