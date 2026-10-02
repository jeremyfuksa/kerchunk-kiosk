import { describe, it, expect } from "vitest";
import { deflateSync } from "node:zlib";
import { randomBytes } from "node:crypto";
import { decodeIndexedCrop, PngFormatError } from "../src/backend/radar/pngIndexed.js";

// Minimal indexed-PNG encoder for fixtures. CRCs are written as 0: the decoder
// doesn't check them (zlib's adler32 already covers the image data).
function chunk(type: string, data: Uint8Array): Buffer {
  const b = Buffer.alloc(12 + data.length);
  b.writeUInt32BE(data.length, 0);
  b.write(type, 4, "ascii");
  Buffer.from(data).copy(b, 8);
  return b;
}
function paeth(a: number, b: number, c: number): number {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}
function encode(w: number, h: number, px: Uint8Array, filterFor: (row: number) => number,
                opts: { color?: number; depth?: number } = {}): Buffer {
  const raw = Buffer.alloc(h * (w + 1));
  for (let y = 0; y < h; y++) {
    const f = filterFor(y);
    raw[y * (w + 1)] = f;
    for (let x = 0; x < w; x++) {
      const cur = px[y * w + x]!;
      const a = x > 0 ? px[y * w + x - 1]! : 0;
      const b = y > 0 ? px[(y - 1) * w + x]! : 0;
      const c = x > 0 && y > 0 ? px[(y - 1) * w + x - 1]! : 0;
      const pred = f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : paeth(a, b, c);
      raw[y * (w + 1) + 1 + x] = (cur - pred) & 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = opts.depth ?? 8; ihdr[9] = opts.color ?? 3; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("PLTE", new Uint8Array(768)),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", new Uint8Array(0)),
  ]);
}
function pixels(w: number, h: number, seed = 7): Uint8Array {
  const out = new Uint8Array(w * h);
  let s = seed;
  for (let i = 0; i < out.length; i++) { s = (s * 1103515245 + 12345) >>> 0; out[i] = s >>> 24; }
  return out;
}
function expectCrop(px: Uint8Array, w: number, win: { x0: number; y0: number; width: number; height: number }): Uint8Array {
  const out = new Uint8Array(win.width * win.height);
  for (let y = 0; y < win.height; y++)
    out.set(px.subarray((win.y0 + y) * w + win.x0, (win.y0 + y) * w + win.x0 + win.width), y * win.width);
  return out;
}

describe("decodeIndexedCrop", () => {
  const W = 37, H = 23, px = pixels(37, 23);

  for (const f of [0, 1, 2, 3, 4]) {
    it(`round-trips filter type ${f}`, async () => {
      const win = { x0: 0, y0: 0, width: W, height: H };
      const out = await decodeIndexedCrop(encode(W, H, px, () => f), win);
      expect(Buffer.from(out.bytes).equals(Buffer.from(px))).toBe(true);
      expect(out).toMatchObject({ width: W, height: H, imageWidth: W, imageHeight: H });
    });
  }

  it("decodes mixed per-row filters and an interior crop", async () => {
    const win = { x0: 5, y0: 4, width: 11, height: 9 };
    const out = await decodeIndexedCrop(encode(W, H, px, (y) => y % 5), win);
    expect(Buffer.from(out.bytes).equals(Buffer.from(expectCrop(px, W, win)))).toBe(true);
  });

  it("crops at the right/bottom image edges", async () => {
    const win = { x0: W - 4, y0: H - 3, width: 4, height: 3 };
    const out = await decodeIndexedCrop(encode(W, H, px, (y) => (y * 3) % 5), win);
    expect(Buffer.from(out.bytes).equals(Buffer.from(expectCrop(px, W, win)))).toBe(true);
  });

  it("stops early: a crop in the top rows survives a truncated tail", async () => {
    // Truly incompressible pixels: the LCG ones repeat, so deflate front-loads
    // them and a 60% cut would leave only ~18 rows instead of ~180.
    const big = new Uint8Array(randomBytes(400 * 300));
    const png = encode(400, 300, big, () => 4);
    // Find the IDAT payload and cut its last 40%: rows near the top are still intact.
    const idatAt = png.indexOf(Buffer.from("IDAT")) - 4;
    const len = png.readUInt32BE(idatAt);
    const cut = Math.floor(len * 0.6);
    const truncated = Buffer.concat([png.subarray(0, idatAt), (() => {
      const head = Buffer.alloc(8); head.writeUInt32BE(cut, 0); head.write("IDAT", 4, "ascii"); return head;
    })(), png.subarray(idatAt + 8, idatAt + 8 + cut), Buffer.alloc(4), chunk("IEND", new Uint8Array(0))]);
    const top = { x0: 10, y0: 2, width: 50, height: 20 };
    const out = await decodeIndexedCrop(truncated, top);
    expect(Buffer.from(out.bytes).equals(Buffer.from(expectCrop(big, 400, top)))).toBe(true);
    await expect(decodeIndexedCrop(truncated, { x0: 0, y0: 280, width: 10, height: 10 }))
      .rejects.toBeInstanceOf(Error);
  });

  it("decodes from a byte stream split at awkward offsets (mid-header, mid-IDAT)", async () => {
    const png = encode(W, H, px, (y) => y % 5);
    const win = { x0: 3, y0: 4, width: 20, height: 11 };
    for (const size of [1, 5, 13, 97]) {
      async function* parts(): AsyncGenerator<Uint8Array> {
        for (let i = 0; i < png.length; i += size) yield png.subarray(i, i + size);
      }
      const out = await decodeIndexedCrop(parts(), win);
      expect([size, Buffer.from(out.bytes).equals(Buffer.from(expectCrop(px, W, win)))]).toEqual([size, true]);
    }
  });

  it("stops pulling a stream once the crop is decoded (the download is abandoned)", async () => {
    const big = new Uint8Array(randomBytes(400 * 300));
    const png = encode(400, 300, big, () => 4);
    let pulled = 0, closed = false;
    async function* parts(): AsyncGenerator<Uint8Array> {
      try {
        for (let i = 0; i < png.length; i += 4096) { pulled += 4096; yield png.subarray(i, i + 4096); }
      } finally { closed = true; }
    }
    const top = { x0: 10, y0: 2, width: 50, height: 20 };
    const out = await decodeIndexedCrop(parts(), top);
    expect(Buffer.from(out.bytes).equals(Buffer.from(expectCrop(big, 400, top)))).toBe(true);
    expect(closed).toBe(true);
    expect(pulled).toBeLessThan(png.length * 0.5);
  });

  it("a stream that errors before the crop rejects with that error", async () => {
    const png = encode(W, H, px, () => 0);
    async function* parts(): AsyncGenerator<Uint8Array> {
      yield png.subarray(0, 40);
      throw new Error("socket hang up");
    }
    await expect(decodeIndexedCrop(parts(), { x0: 0, y0: 0, width: 4, height: 4 })).rejects.toThrow("socket hang up");
  });

  it("rejects a non-PNG", async () => {
    await expect(decodeIndexedCrop(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]), { x0: 0, y0: 0, width: 1, height: 1 }))
      .rejects.toBeInstanceOf(PngFormatError);
  });

  it("rejects a non-palette or non-8-bit PNG (IEM changed format)", async () => {
    await expect(decodeIndexedCrop(encode(4, 4, pixels(4, 4), () => 0, { color: 2 }), { x0: 0, y0: 0, width: 1, height: 1 }))
      .rejects.toThrow(/unsupported PNG/);
    await expect(decodeIndexedCrop(encode(4, 4, pixels(4, 4), () => 0, { depth: 4 }), { x0: 0, y0: 0, width: 1, height: 1 }))
      .rejects.toThrow(/unsupported PNG/);
  });

  it("rejects a window outside the image", async () => {
    await expect(decodeIndexedCrop(encode(4, 4, pixels(4, 4), () => 0), { x0: 2, y0: 0, width: 3, height: 1 }))
      .rejects.toBeInstanceOf(RangeError);
  });
});
