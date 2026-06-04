import { readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { normalizeMode } from "./lookup.js";

// RepeaterBook frequency lookup, used to identify Close Call discoveries.
//
// Integration rules (per RepeaterBook's API guidance):
// - identify with a REGISTERED User-Agent (config.lookup.userAgent — the
//   operator applied with "Kerchunk/1.0 (JeremyFuksa, hello@jeremyfuksa.com)");
// - do NOT hammer export.php: we fetch each configured state's full export at
//   most once per CACHE_TTL and answer every lookup from the local cache.
//
// Coverage note: RepeaterBook lists ham + GMRS repeaters. Business-band
// discoveries won't match and keep their plain "Close Call <MHz>" names.

export interface RepeaterHit {
  callsign: string;
  city: string;
  state: string;
  pl: string | null;
  /** Display tag for the channel table / dashboard. */
  tag: string;
  location?: {
    lat?: number; lon?: number; city?: string; state?: string; source: string;
  };
}

interface RbRecord {
  Callsign?: string;
  Frequency?: string;
  "Nearest City"?: string;
  State?: string;
  PL?: string;
  Lat?: string | number;
  Long?: string | number;
  [flag: string]: unknown;   // per-mode "Yes" flags vary by export version
}

export type Fetcher = (url: string, init: { headers: Record<string, string> })
  => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface RepeaterBookOptions {
  userAgent: string;
  /** Bearer token issued with API approval (required since March 2026). */
  apiToken?: string;
  states: string[];
  cacheDir: string;
  fetcher?: Fetcher;
  /** Cache TTL in ms (default 7 days — repeater data moves slowly). */
  ttlMs?: number;
}

const MATCH_TOLERANCE_HZ = 2_500; // close calls round to a 12.5 kHz raster

// RepeaterBook reports capability as per-mode "Yes" flags; key spellings have
// varied across export versions, so probe the known aliases. First digital
// hit wins (a mixed-mode repeater is most useful labeled by its digital side
// — analog gear can't decode it).
const RB_MODE_FLAGS: Array<[string, string[]]> = [
  ["DMR", ["DMR", "DMR Capable"]],
  ["P25", ["APCO P-25", "P-25", "P25"]],
  ["D-STAR", ["D-Star", "DSTAR"]],
  ["YSF", ["System Fusion", "YSF"]],
  ["NXDN", ["NXDN"]],
  ["FM", ["FM Analog", "FM"]],
];

function rbMode(r: RbRecord): string | null {
  for (const [mode, keys] of RB_MODE_FLAGS) {
    for (const k of keys) {
      if (String(r[k] ?? "").toLowerCase() === "yes") return mode;
    }
  }
  return null;
}

const STATE_ABBR: Record<string, string> = {
  Alabama: "AL", Alaska: "AK", Arizona: "AZ", Arkansas: "AR", California: "CA",
  Colorado: "CO", Connecticut: "CT", Delaware: "DE", Florida: "FL", Georgia: "GA",
  Hawaii: "HI", Idaho: "ID", Illinois: "IL", Indiana: "IN", Iowa: "IA",
  Kansas: "KS", Kentucky: "KY", Louisiana: "LA", Maine: "ME", Maryland: "MD",
  Massachusetts: "MA", Michigan: "MI", Minnesota: "MN", Mississippi: "MS",
  Missouri: "MO", Montana: "MT", Nebraska: "NE", Nevada: "NV",
  "New Hampshire": "NH", "New Jersey": "NJ", "New Mexico": "NM",
  "New York": "NY", "North Carolina": "NC", "North Dakota": "ND", Ohio: "OH",
  Oklahoma: "OK", Oregon: "OR", Pennsylvania: "PA", "Rhode Island": "RI",
  "South Carolina": "SC", "South Dakota": "SD", Tennessee: "TN", Texas: "TX",
  Utah: "UT", Vermont: "VT", Virginia: "VA", Washington: "WA",
  "West Virginia": "WV", Wisconsin: "WI", Wyoming: "WY",
};

export class RepeaterBook {
  private readonly opts: Omit<Required<RepeaterBookOptions>, "apiToken"> & { apiToken?: string };
  private mem = new Map<string, RbRecord[]>();

  constructor(opts: RepeaterBookOptions) {
    this.opts = {
      ttlMs: 7 * 24 * 3600 * 1000,
      fetcher: (url, init) => fetch(url, init),
      ...opts,
    };
  }

  /** Find a repeater whose output matches freqHz (±2.5 kHz). Null = no match/any failure. */
  async lookup(freqHz: number): Promise<RepeaterHit | null> {
    for (const state of this.opts.states) {
      const records = await this.stateRecords(state);
      for (const r of records) {
        const f = Number(r.Frequency) * 1e6;
        if (!Number.isFinite(f) || Math.abs(f - freqHz) > MATCH_TOLERANCE_HZ) continue;
        const callsign = r.Callsign?.trim();
        if (!callsign) continue;
        const city = r["Nearest City"]?.trim() ?? "";
        const st = STATE_ABBR[r.State ?? ""] ?? r.State ?? "";
        const pl = r.PL && r.PL.trim() !== "" ? r.PL.trim() : null;
        const tag = `${callsign} ${city} ${st}`.trim() + (pl ? ` · PL ${pl}` : "");
        const lat = Number(r.Lat), lon = Number(r.Long);
        const rawMode = rbMode(r);
        const mode = rawMode ? normalizeMode(rawMode) : null;
        return {
          callsign, city, state: st, pl, tag,
          ...(mode ? { mode } : {}),
          location: {
            ...(Number.isFinite(lat) && lat !== 0 ? { lat } : {}),
            ...(Number.isFinite(lon) && lon !== 0 ? { lon } : {}),
            ...(city ? { city } : {}),
            ...(st ? { state: st } : {}),
            source: "repeaterbook",
          },
        };
      }
    }
    return null;
  }

  private cachePath(state: string): string {
    return join(this.opts.cacheDir, `repeaterbook-${state.toLowerCase().replace(/\s+/g, "-")}.json`);
  }

  private async stateRecords(state: string): Promise<RbRecord[]> {
    const hit = this.mem.get(state);
    if (hit) return hit;

    // Disk cache survives restarts (and respects RepeaterBook between them).
    const path = this.cachePath(state);
    try {
      if (Date.now() - statSync(path).mtimeMs < this.opts.ttlMs) {
        const records = JSON.parse(readFileSync(path, "utf8")) as RbRecord[];
        this.mem.set(state, records);
        return records;
      }
    } catch { /* no/stale cache: fetch */ }

    try {
      const url = "https://www.repeaterbook.com/api/export.php?country=United%20States&state="
        + encodeURIComponent(state);
      const headers: Record<string, string> = { "User-Agent": this.opts.userAgent };
      if (this.opts.apiToken) headers["Authorization"] = `Bearer ${this.opts.apiToken}`;
      const res = await this.opts.fetcher(url, { headers });
      if (!res.ok) return this.mem.get(state) ?? [];
      const body = await res.json() as { results?: RbRecord[] };
      const records = body.results ?? [];
      this.mem.set(state, records);
      try {
        mkdirSync(this.opts.cacheDir, { recursive: true });
        writeFileSync(path, JSON.stringify(records));
      } catch { /* cache write failure is non-fatal */ }
      return records;
    } catch {
      return []; // offline / DNS / etc: lookup degrades to no-match
    }
  }
}
