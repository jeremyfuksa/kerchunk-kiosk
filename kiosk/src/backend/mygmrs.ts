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

// Full name → USPS code for every state (+ DC). The API's ?state= expects the
// two-letter code; passing a full name for an out-of-region state silently
// returned nothing (an incomplete feature masquerading as "no repeaters").
const STATE_ABBR: Record<string, string> = {
  Alabama: "AL", Alaska: "AK", Arizona: "AZ", Arkansas: "AR", California: "CA",
  Colorado: "CO", Connecticut: "CT", Delaware: "DE", "District of Columbia": "DC",
  Florida: "FL", Georgia: "GA", Hawaii: "HI", Idaho: "ID", Illinois: "IL",
  Indiana: "IN", Iowa: "IA", Kansas: "KS", Kentucky: "KY", Louisiana: "LA",
  Maine: "ME", Maryland: "MD", Massachusetts: "MA", Michigan: "MI",
  Minnesota: "MN", Mississippi: "MS", Missouri: "MO", Montana: "MT",
  Nebraska: "NE", Nevada: "NV", "New Hampshire": "NH", "New Jersey": "NJ",
  "New Mexico": "NM", "New York": "NY", "North Carolina": "NC",
  "North Dakota": "ND", Ohio: "OH", Oklahoma: "OK", Oregon: "OR",
  Pennsylvania: "PA", "Rhode Island": "RI", "South Carolina": "SC",
  "South Dakota": "SD", Tennessee: "TN", Texas: "TX", Utah: "UT",
  Vermont: "VT", Virginia: "VA", Washington: "WA", "West Virginia": "WV",
  Wisconsin: "WI", Wyoming: "WY",
};

// After a failed fetch, don't re-hit the API for this long (independent of TTL).
const FAIL_BACKOFF_MS = 10 * 60_000;

export class MyGmrs implements LookupProvider {
  private readonly opts: Required<MyGmrsOptions>;
  private mem = new Map<string, { items: GmrsItem[]; expiresAt: number }>();

  constructor(opts: MyGmrsOptions) {
    this.opts = {
      ttlMs: 7 * 24 * 3600 * 1000,
      maxKm: 120,
      fetcher: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(15_000) }),
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
    const name = tidy(r.Name ?? "");
    const city = tidyCity(r.Location ?? "");
    const st = tidy(r.State ?? "").toUpperCase();
    const where = [city, st].filter(Boolean).join(", ");
    return {
      tag: `${name || "GMRS repeater"}${where ? ` · ${where}` : ""}`,
      mode: "FM",
      location: {
        lat: r.Latitude!, lon: r.Longitude!,
        ...(city ? { city } : {}),
        ...(st ? { state: st } : {}),
        source: "mygmrs",
      },
    };
  }

  private async stateItems(state: string): Promise<GmrsItem[]> {
    const now = Date.now();
    const hit = this.mem.get(state);
    if (hit && now < hit.expiresAt) return hit.items;

    const path = join(this.opts.cacheDir, `mygmrs-${state.toLowerCase().replace(/\s+/g, "-")}.json`);
    // Load the disk cache regardless of age: fresh is served directly, stale is
    // the fallback if the refetch below fails (better than degrading to no-match).
    let diskItems: GmrsItem[] | null = null;
    let diskAgeMs = Infinity;
    try {
      diskAgeMs = now - statSync(path).mtimeMs;
      diskItems = JSON.parse(readFileSync(path, "utf8")) as GmrsItem[];
    } catch { /* no cache on disk */ }
    if (diskItems && diskAgeMs < this.opts.ttlMs) {
      this.mem.set(state, { items: diskItems, expiresAt: now + (this.opts.ttlMs - diskAgeMs) });
      return diskItems;
    }

    try {
      const abbr = STATE_ABBR[state] ?? state;
      // The endpoint paginates at 25 by default and silently truncates —
      // a Cameron machine 53 km out was invisible until the operator found
      // it by hand. limit=1000 covers every US state's GMRS census.
      const res = await this.opts.fetcher(
        `https://api.mygmrs.com/repeaters?state=${encodeURIComponent(abbr)}&limit=1000`,
        { headers: { "User-Agent": this.opts.userAgent } });
      if (!res.ok) return this.degrade(state, diskItems, now);
      const body = await res.json() as { items?: GmrsItem[]; info?: { total?: number } };
      const items = body.items ?? [];
      if (body.info?.total !== undefined && items.length < body.info.total) {
        console.error(`[mygmrs] ${state}: got ${items.length} of ${body.info.total} — raise the limit`);
      }
      this.mem.set(state, { items, expiresAt: now + this.opts.ttlMs });
      try {
        mkdirSync(this.opts.cacheDir, { recursive: true });
        writeFileSync(path, JSON.stringify(items));
      } catch { /* cache write is best-effort */ }
      return items;
    } catch {
      return this.degrade(state, diskItems, now);
    }
  }

  /** Fetch failed: serve a stale disk copy if any (else no-match), and throttle
   *  the next attempt so an erroring endpoint isn't hammered per Close Call. */
  private degrade(state: string, diskItems: GmrsItem[] | null, now: number): GmrsItem[] {
    const items = diskItems ?? [];
    this.mem.set(state, { items, expiresAt: now + FAIL_BACKOFF_MS });
    return items;
  }
}

// Directory entries are owner-typed free text — "Basehor ", "shawnee" —
// so tidy at the provider boundary before anything is stored or displayed.
function tidy(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

// Capitalize only letters that START lowercase ("shawnee" → "Shawnee",
// "o'fallon" → "O'Fallon") — interior caps like McPherson survive untouched,
// and a lone letter after an apostrophe stays down (Smith's, not Smith'S).
function tidyCity(s: string): string {
  return tidy(s)
    .replace(/(^|[\s-])([a-z])/g, (_, pre, ch) => pre + ch.toUpperCase())
    .replace(/'([a-z])(?=[a-z])/g, (_, ch) => `'${ch.toUpperCase()}`);
}

function distKm(home: { lat: number; lon: number }, lat: number, lon: number): number {
  const dLat = ((lat - home.lat) * Math.PI) / 180;
  const dLon = ((lon - home.lon) * Math.PI) / 180;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos((home.lat * Math.PI) / 180) * Math.cos((lat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(a));
}
