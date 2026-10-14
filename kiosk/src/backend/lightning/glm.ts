// Reads one GOES-R GLM L2 LCFA file (NetCDF4/HDF5) into flashes. h5wasm, not
// jsfive: jsfive reads the arrays but drops the CF attributes (scale_factor,
// add_offset, _Unsigned) on the scaled int16 variables, and without them time,
// energy and area are garbage (spike 2026-10-13). h5wasm's Node build opens
// real paths, so each file goes through a temp file.
import { writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as h5wasm from "h5wasm/node";
import type { Box, Flash } from "./types.js";

/** GOES-R epoch: product_time is seconds since 2000-01-01 12:00:00 UTC. */
export const J2000_MS = Date.UTC(2000, 0, 1, 12);

export interface ScaledVar { values: ArrayLike<number>; scale: number; offset: number; unsigned: boolean }
export interface RawGlm {
  /** File start, seconds since J2000 noon. */
  productTime: number;
  lat: ArrayLike<number>;
  lon: ArrayLike<number>;
  /** Seconds relative to productTime. */
  time: ScaledVar;
  /** Joules. */
  energy: ScaledVar;
  /** m². */
  area: ScaledVar;
}

function unscale(v: ScaledVar, i: number): number {
  let x = v.values[i] ?? 0;
  if (v.unsigned && x < 0) x += 65_536;   // GLM's scaled vars are int16 flagged _Unsigned
  return x * v.scale + v.offset;
}

/** Pure: raw arrays → in-box flashes, time-ordered. */
export function toFlashes(raw: RawGlm, box: Box): Flash[] {
  const n = Math.min(raw.lat.length, raw.lon.length, raw.time.values.length, raw.energy.values.length, raw.area.values.length);
  const base = J2000_MS + raw.productTime * 1000;
  const out: Flash[] = [];
  for (let i = 0; i < n; i++) {
    const lat = raw.lat[i]!, lon = raw.lon[i]!;
    if (!(lat <= box.n && lat >= box.s && lon >= box.w && lon <= box.e)) continue;
    out.push({
      t: Math.round(base + unscale(raw.time, i) * 1000),
      lat, lon,
      energyFj: unscale(raw.energy, i) * 1e15,
      areaKm2: unscale(raw.area, i) / 1e6,
    });
  }
  return out.sort((a, b) => a.t - b.t);
}

const arr = (v: unknown): ArrayLike<number> =>
  ArrayBuffer.isView(v) ? (v as unknown as ArrayLike<number>) : typeof v === "number" ? [v] : [];
const first = (v: unknown, dflt: number): number => {
  const x = ArrayBuffer.isView(v) ? (v as unknown as ArrayLike<number>)[0] : v;
  return typeof x === "number" ? x : dflt;
};

let ready: Promise<unknown> | null = null;
let seq = 0;

export async function readGlm(bytes: Uint8Array): Promise<RawGlm> {
  ready ??= h5wasm.ready;
  await ready;
  const path = join(tmpdir(), `kerchunk-glm-${process.pid}-${seq++}.nc`);
  await writeFile(path, bytes);
  try {
    const f = new h5wasm.File(path, "r");
    try {
      const ds = (name: string): h5wasm.Dataset => {
        const d = f.get(name);
        if (!(d instanceof h5wasm.Dataset)) throw new Error(`GLM file has no ${name}`);
        return d;
      };
      const scaled = (name: string): ScaledVar => {
        const d = ds(name);
        return {
          values: arr(d.value),
          scale: first(d.attrs["scale_factor"]?.value, 1),
          offset: first(d.attrs["add_offset"]?.value, 0),
          unsigned: d.attrs["_Unsigned"]?.value === "true",
        };
      };
      return {
        productTime: first(ds("product_time").value, NaN),
        lat: arr(ds("flash_lat").value),
        lon: arr(ds("flash_lon").value),
        time: scaled("flash_time_offset_of_first_event"),
        energy: scaled("flash_energy"),
        area: scaled("flash_area"),
      };
    } finally {
      f.close();
    }
  } finally {
    await unlink(path).catch(() => { /* already gone */ });
  }
}

export async function parseGlm(bytes: Uint8Array, box: Box): Promise<Flash[]> {
  const raw = await readGlm(bytes);
  if (!Number.isFinite(raw.productTime)) throw new Error("GLM product_time missing");
  return toFlashes(raw, box);
}
