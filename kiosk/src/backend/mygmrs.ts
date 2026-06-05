import { readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { LookupHit, LookupProvider } from "./lookup.js";

// myGMRS.com — the GMRS repeater directory, and the authority RadioReference
// county data isn't for this service. Keyless JSON API; we identify with the
// registered UA and cache state lists like the RepeaterBook provider.
// Matching is by repeater OUTPUT frequency with NEAREST-to-home winning,
// because GMRS has eight shared channels and four machines on 462.550 within
// an hour's drive is normal.

interface GmrsItem {
  Name?: string;
  Location?: string;
  State?: string;
  Frequency?: string;
  Status?: string;
  Latitude?: number;
  Longitude?: number;
}

export interface MyGmrsOptions {
  /** Full state names (shared with the RepeaterBook config). */
  states: string[];
  home: { lat: number; lon: number };
  userAgent: string;
  cacheDir: string;
  ttlMs?: number;
  /** Only consider machines within this range of home (km). */
  maxKm?: number;
  fetcher?: (url: string, init: { headers: Record<string, string> })
    => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
}

const MATCH_TOLERANCE_HZ = 2_500;
const GMRS_LOW = 462_000_000;
const GMRS_HIGH = 463_000_000;

const STATE_ABBR: Record<string, string> = {
  Missouri: "MO", Kansas: "KS", Iowa: "IA", Nebraska: "NE", Oklahoma: "OK",
  Arkansas: "AR", Illinois: "IL", Colorado: "CO", Texas: "TX",
};

export class MyGmrs implements LookupProvider {
  private readonly opts: Required<MyGmrsOptions>;
  private mem = new Map<string, GmrsItem[]>();

  constructor(opts: MyGmrsOptions) {
    this.opts = {
      ttlMs: 7 * 24 * 3600 * 1000,
      maxKm: 120,
      fetcher: (url, init) => fetch(url, init),
      ...opts,
    };
  }

  async lookup(freqHz: number): Promise<LookupHit | null> {
    // GMRS repeater outputs only — anything else is out of this directory's
    // jurisdiction and fails fast without a network call.
    if (freqHz < GMRS_LOW || freqHz > GMRS_HIGH) return null;

    let best: { item: GmrsItem; km: number } | null = null;
    for (const state of this.opts.states) {
      for (const item of await this.stateItems(state)) {
        if (item.Status !== "Online") continue;
        const f = Number(item.Frequency) * 1e6;
        if (!Number.isFinite(f) || Math.abs(f - freqHz) > MATCH_TOLERANCE_HZ) continue;
        if (item.Latitude == null || item.Longitude == null) continue;
        const km = distKm(this.opts.home, item.Latitude, item.Longitude);
        if (km > this.opts.maxKm) continue;
        if (!best || km < best.km) best = { item, km };
      }
    }
    if (!best) return null;
    const r = best.item;
    const st = r.State ?? "";
    const where = [r.Location, st].filter(Boolean).join(", ");
    return {
      tag: `${r.Name ?? "GMRS repeater"}${where ? ` · ${where}` : ""}`,
      mode: "FM",
      location: {
        lat: r.Latitude!, lon: r.Longitude!,
        ...(r.Location ? { city: r.Location } : {}),
        ...(st ? { state: st } : {}),
        source: "mygmrs",
      },
    };
  }

  private async stateItems(state: string): Promise<GmrsItem[]> {
    const hit = this.mem.get(state);
    if (hit) return hit;
    const path = join(this.opts.cacheDir, `mygmrs-${state.toLowerCase().replace(/\s+/g, "-")}.json`);
    try {
      if (Date.now() - statSync(path).mtimeMs < this.opts.ttlMs) {
        const items = JSON.parse(readFileSync(path, "utf8")) as GmrsItem[];
        this.mem.set(state, items);
        return items;
      }
    } catch { /* no/stale cache */ }
    try {
      const abbr = STATE_ABBR[state] ?? state;
      // The endpoint paginates at 25 by default and silently truncates —
      // a Cameron machine 53 km out was invisible until the operator found
      // it by hand. limit=1000 covers every US state's GMRS census.
      const res = await this.opts.fetcher(
        `https://api.mygmrs.com/repeaters?state=${encodeURIComponent(abbr)}&limit=1000`,
        { headers: { "User-Agent": this.opts.userAgent } });
      if (!res.ok) return this.mem.get(state) ?? [];
      const body = await res.json() as { items?: GmrsItem[]; info?: { total?: number } };
      const items = body.items ?? [];
      if (body.info?.total !== undefined && items.length < body.info.total) {
        console.error(`[mygmrs] ${state}: got ${items.length} of ${body.info.total} — raise the limit`);
      }
      this.mem.set(state, items);
      try {
        mkdirSync(this.opts.cacheDir, { recursive: true });
        writeFileSync(path, JSON.stringify(items));
      } catch { /* cache write is best-effort */ }
      return items;
    } catch {
      return [];
    }
  }
}

function distKm(home: { lat: number; lon: number }, lat: number, lon: number): number {
  const dLat = ((lat - home.lat) * Math.PI) / 180;
  const dLon = ((lon - home.lon) * Math.PI) / 180;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos((home.lat * Math.PI) / 180) * Math.cos((lat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(a));
}
