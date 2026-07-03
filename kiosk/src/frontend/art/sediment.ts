// Pure accumulator for the artistic kiosk. Each transmission is an INDEPENDENT
// site key-up — deposits never link to other sites. A site accrues per-service
// strata (sub-layers within its own footprint) and a decaying "breath" from
// the most recent hit. Modeled on BlipField; rendered by art.ts each tick.

export { startOfLocalDay, startOfNextLocalDay } from "../lib/localDay.js";

export interface DepositInput {
  lat: number;
  lon: number;
  color: string; // service color from serviceColor.colorFor()
  ts: number;
}

export interface Stratum {
  color: string;
  hits: number;
}

export interface Deposit {
  lat: number;
  lon: number;
  totalHits: number;
  /** Per-service sub-layers, busiest first. */
  strata: Stratum[];
  /** 1 at the most recent hit, linear to 0 at breathMs. */
  breath: number;
}

interface Site {
  lat: number;
  lon: number;
  byColor: Map<string, number>;
  lastTs: number;
}

export interface SedimentOptions {
  breathMs: number;
}

export class SedimentField {
  private sites = new Map<string, Site>();
  private readonly breathMs: number;

  constructor(opts: SedimentOptions) {
    this.breathMs = opts.breathMs;
  }

  deposit(d: DepositInput): void {
    const key = `${d.lat.toFixed(5)},${d.lon.toFixed(5)}`;
    const site = this.sites.get(key) ?? {
      lat: d.lat,
      lon: d.lon,
      byColor: new Map<string, number>(),
      lastTs: d.ts,
    };
    site.byColor.set(d.color, (site.byColor.get(d.color) ?? 0) + 1);
    site.lastTs = Math.max(site.lastTs, d.ts);
    this.sites.set(key, site);
  }

  deposits(now: number): Deposit[] {
    const out: Deposit[] = [];
    for (const site of this.sites.values()) {
      const strata: Stratum[] = [...site.byColor.entries()]
        .map(([color, hits]) => ({ color, hits }))
        .sort((a, b) => b.hits - a.hits);
      const totalHits = strata.reduce((s, x) => s + x.hits, 0);
      const age = now - site.lastTs;
      const breath = age >= this.breathMs ? 0 : Math.max(0, 1 - age / this.breathMs);
      out.push({ lat: site.lat, lon: site.lon, totalHits, strata, breath });
    }
    return out;
  }

  clear(): void {
    this.sites.clear();
  }
}
