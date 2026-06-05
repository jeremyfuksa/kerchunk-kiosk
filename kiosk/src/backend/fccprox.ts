import { readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { LookupHit, LookupHint, LookupProvider } from "./lookup.js";
import { decodeXml } from "./radioreference.js";

// FCC license proximity (ROADMAP stretch item): raw FCC ULS data via the
// RadioReference SOAP gateway — the missing path to COORDINATES for
// business-band channels. RadioReference's county search names them
// ("Worlds of Fun Security") but carries no geo; the FCC license at
// 4545 Worlds Of Fun Ave does.
//
// Shape: fccGetProxCallsigns only returns {callsign, licensee, lat, lon}
// (no frequencies), and the API advises probes ≤3 miles. So:
//   1. A cached INDEX is built from a small probe grid around the QTH
//      (home + 6 hex ring points) — licensee names and coordinates.
//   2. lookup() requires a NAME HINT (the channel's existing tag): index
//      entries whose licensee shares a significant word are candidates.
//   3. Each candidate's full license (fccGetCallsign, cached) confirms by
//      FREQUENCY — only a license actually granted the channel's frequency
//      may donate its coordinates. Name-match alone never places a pin.

const ENDPOINT = "http://api.radioreference.com/soap2/";
const MATCH_TOLERANCE_HZ = 2_500;
const PROBE_RANGE_MILES = 3;     // per the API's own guidance
const PROBE_RINGS: Array<{ miles: number; points: number }> = [
  { miles: 5.5, points: 6 },     // inner hex
  { miles: 11, points: 12 },     // outer ring — downtown/yards are 15-20 km out
];
const MAX_SITE_KM = 80;          // a metro scanner's license can't live in Trenton
const MAX_CANDIDATES = 5;        // detail fetches per lookup, worst case

// Words too generic to identify a licensee on their own.
const STOP_WORDS = new Set([
  "security", "maintenance", "operations", "dispatch", "channel", "radio",
  "north", "south", "east", "west", "main", "city", "county", "company",
]);

interface FccDetails {
  licensee: string;
  freqs: Array<{ locationNumber: number; freqHz: number; powerWatts?: number; emission?: string }>;
  locations: Array<{ locationNumber: number; lat: number; lon: number; city?: string; state?: string; antennaHaatM?: number }>;
}

// Emission designator's final symbol: E = telephony (voice), D = data.
// "11K0F3E" speaks, "7K60F1D" doesn't. A grant set with NO voice emission
// is something the speaker can't carry — paging, telemetry, digital.
function listenFromEmissions(emissions: Array<string | undefined>): "voice" | "data" | undefined {
  const known = emissions.filter((e): e is string => !!e && /[A-Z]$/.test(e));
  if (known.length === 0) return undefined;
  return known.some((e) => e.endsWith("E")) ? "voice" : "data";
}

interface ProxEntry {
  callsign: string;
  licensee: string;
  lat: number;
  lon: number;
  distance: number;
}

export interface FccProxOptions {
  appKey: string;
  username: string;
  password: string;
  home: { lat: number; lon: number };
  cacheDir: string;
  ttlMs?: number;
  fetcher?: (url: string, init: {
    method: string; headers: Record<string, string>; body: string;
  }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;
}

export class FccProx implements LookupProvider {
  private readonly opts: Required<FccProxOptions>;
  private index: ProxEntry[] | null = null;
  private details = new Map<string, FccDetails | null>();

  constructor(opts: FccProxOptions) {
    this.opts = {
      ttlMs: 30 * 24 * 3600 * 1000,
      fetcher: (url, init) => fetch(url, init),
      ...opts,
    };
  }

  async lookup(freqHz: number, hint?: LookupHint): Promise<LookupHit | null> {
    const name = hint?.name?.trim();
    if (!name) {
      // Bare frequency (a Close Call): answer ONLY from already-cached
      // license details — no network. primeDetails() fills that cache in
      // the background, after which the whole metro identifies offline.
      const best = { km: Infinity, hit: null as LookupHit | null };
      for (const det of this.cachedDetails().values()) {
        if (!det) continue;
        const hit = this.hitFrom(det, freqHz);
        if (!hit?.location?.lat) continue;
        const km = distKm(this.opts.home, hit.location.lat, hit.location.lon!);
        if (km < best.km) { best.km = km; best.hit = hit; }
      }
      return best.hit;
    }
    const tokens = name.toLowerCase().split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 4 && !STOP_WORDS.has(t));
    if (tokens.length === 0) return null;

    const index = await this.proxIndex();
    const candidates = index
      .map((e) => ({
        e,
        matched: tokens.filter((t) => e.licensee.toLowerCase().includes(t)).length,
      }))
      .filter((c) => c.matched > 0)
      .sort((a, b) => b.matched - a.matched || a.e.distance - b.e.distance)
      .slice(0, MAX_CANDIDATES);

    for (const { e } of candidates) {
      const det = await this.callsignDetails(e.callsign);
      const hit = det && this.hitFrom(det, freqHz, name);
      if (hit) return hit;
    }
    return null;
  }

  /** Build a hit from a license iff it holds this frequency at a sane site. */
  private hitFrom(det: FccDetails, freqHz: number, tag?: string): LookupHit | null {
    const matched = det.freqs.filter((f) => Math.abs(f.freqHz - freqHz) <= MATCH_TOLERANCE_HZ);
    if (matched.length === 0) return null;
    const locNums = new Set(matched.map((f) => f.locationNumber));
    // Among the locations actually granted this frequency, nearest to home
    // wins — beyond MAX_SITE_KM it's some other city's grant on a
    // system-wide license, not our transmitter.
    const sites = det.locations
      .filter((l) => locNums.has(l.locationNumber))
      .map((l) => ({ l, km: distKm(this.opts.home, l.lat, l.lon) }))
      .filter((sk) => sk.km <= MAX_SITE_KM)
      .sort((a, b) => a.km - b.km);
    const site = sites[0]?.l;
    if (!site) return null;
    const atSite = matched.filter((f) => f.locationNumber === site.locationNumber);
    const power = Math.max(0, ...atSite.map((f) => f.powerWatts ?? 0));
    const listen = listenFromEmissions(atSite.map((f) => f.emission));
    return {
      // A hinted channel keeps its name (FCC donates geography); a bare
      // frequency (Close Call) is NAMED by its licensee.
      tag: tag ?? `${title(det.licensee)}${site.city ? ` · ${site.city}` : ""}`,
      ...(listen ? { listen } : {}),
      location: {
        lat: site.lat, lon: site.lon,
        ...(site.city ? { city: site.city } : {}),
        ...(site.state ? { state: site.state } : {}),
        ...(power > 0 ? { powerWatts: power } : {}),
        ...(site.antennaHaatM ? { antennaHaatM: site.antennaHaatM } : {}),
        source: "fcc",
      },
    };
  }

  /** All cached license details (memory merged over disk). */
  private cachedDetails(): Map<string, FccDetails | null> {
    if (!this.diskLoaded) {
      this.diskLoaded = true;
      try {
        const disk = JSON.parse(readFileSync(join(this.opts.cacheDir, "fcc-callsigns.json"), "utf8")) as Record<string, FccDetails>;
        for (const [cs, det] of Object.entries(disk)) {
          if (!this.details.has(cs)) this.details.set(cs, det);
        }
      } catch { /* nothing cached yet */ }
    }
    return this.details;
  }
  private diskLoaded = false;

  /**
   * Background index priming: fetch license details for every callsign in
   * the probe-grid index that isn't cached yet, gently paced — after one
   * pass, bare-frequency (Close Call) lookups answer offline for the whole
   * metro. Resolves with how many licenses were fetched.
   */
  async primeDetails(spacingMs = 4_000): Promise<number> {
    const index = await this.proxIndex();
    const cached = this.cachedDetails();
    const pending = index.filter((e) => !cached.has(e.callsign));
    let fetched = 0;
    for (const e of pending) {
      await this.callsignDetails(e.callsign);
      fetched++;
      await new Promise((r) => setTimeout(r, spacingMs));
    }
    return fetched;
  }

  // ── Probe grid: home + 6 hex points, merged + deduped, disk-cached.
  private async proxIndex(): Promise<ProxEntry[]> {
    if (this.index) return this.index;
    const path = join(this.opts.cacheDir, "fcc-prox-index.json");
    try {
      if (Date.now() - statSync(path).mtimeMs < this.opts.ttlMs) {
        this.index = JSON.parse(readFileSync(path, "utf8")) as ProxEntry[];
        return this.index;
      }
    } catch { /* no/stale cache */ }

    const probes = [{ lat: this.opts.home.lat, lon: this.opts.home.lon }];
    for (const ring of PROBE_RINGS) {
      for (let i = 0; i < ring.points; i++) {
        const a = (i / ring.points) * 2 * Math.PI;
        probes.push({
          lat: this.opts.home.lat + (ring.miles * 1609 * Math.cos(a)) / 111_320,
          lon: this.opts.home.lon + (ring.miles * 1609 * Math.sin(a))
            / (111_320 * Math.cos((this.opts.home.lat * Math.PI) / 180)),
        });
      }
    }
    const byCallsign = new Map<string, ProxEntry>();
    for (const p of probes) {
      for (const e of await this.proxQuery(p.lat, p.lon)) {
        const prev = byCallsign.get(e.callsign);
        if (!prev || e.distance < prev.distance) byCallsign.set(e.callsign, e);
      }
    }
    this.index = [...byCallsign.values()];
    if (this.index.length > 0) {
      try {
        mkdirSync(this.opts.cacheDir, { recursive: true });
        writeFileSync(path, JSON.stringify(this.index));
      } catch { /* cache write is best-effort */ }
    }
    return this.index;
  }

  private async proxQuery(lat: number, lon: number): Promise<ProxEntry[]> {
    const body = await this.soap("fccGetProxCallsigns", `
   <lat>${lat.toFixed(6)}</lat>
   <lon>${lon.toFixed(6)}</lon>
   <range>${PROBE_RANGE_MILES}</range>
   <unit>m</unit>`);
    if (!body) return [];
    const out: ProxEntry[] = [];
    for (const item of body.match(/<item[^>]*>[\s\S]*?<\/item>/g) ?? []) {
      const callsign = field(item, "callsign");
      const licensee = field(item, "licensee");
      const plat = Number(field(item, "lat"));
      const plon = Number(field(item, "lon"));
      const distance = Number(field(item, "distance"));
      if (!callsign || !licensee || !Number.isFinite(plat) || !Number.isFinite(plon)) continue;
      out.push({ callsign, licensee: decodeXml(licensee), lat: plat, lon: plon, distance });
    }
    return out;
  }

  // ── Per-callsign license details, memoized + disk-cached as one map.
  private async callsignDetails(callsign: string) {
    if (this.details.has(callsign)) return this.details.get(callsign) ?? null;
    const path = join(this.opts.cacheDir, "fcc-callsigns.json");
    let disk: Record<string, FccDetails> = {};
    try { disk = JSON.parse(readFileSync(path, "utf8")); } catch { /* fresh */ }
    if (disk[callsign]) {
      this.details.set(callsign, disk[callsign]!);
      return disk[callsign]!;
    }

    const body = await this.soap("fccGetCallsign", `
   <callsign>${callsign}</callsign>`);
    if (!body || !/<status[^>]*>A</.test(body)) {
      this.details.set(callsign, null);   // expired/cancelled: don't re-ask this boot
      return null;
    }
    // Keep the freq<->location linkage: a railroad's system license lists
    // dozens of sites, and "first location" once pinned Armourdale Yard to
    // Trenton MO. Each frequency grant names its locationNumber; power and
    // antenna height feed the map's coverage-radius blips.
    const freqs: FccDetails["freqs"] = [];
    for (const item of body.match(/<item xsi:type="tns:fccFrequency">[\s\S]*?<\/item>/g) ?? []) {
      const mhz = Number(field(item, "frequency"));
      const locN = Number(field(item, "locationNumber"));
      const power = Number(field(item, "power"));
      if (!Number.isFinite(mhz)) continue;
      const emission = field(item, "emission");
      freqs.push({
        locationNumber: Number.isFinite(locN) ? locN : 1,
        freqHz: Math.round(mhz * 1e6),
        ...(Number.isFinite(power) && power > 0 ? { powerWatts: power } : {}),
        ...(emission ? { emission } : {}),
      });
    }
    const locations: FccDetails["locations"] = [];
    for (const item of body.match(/<item xsi:type="tns:fccLocation">[\s\S]*?<\/item>/g) ?? []) {
      const llat = Number(field(item, "lat"));
      const llon = Number(field(item, "lon"));
      if (!Number.isFinite(llat) || !Number.isFinite(llon) || llat === 0) continue;
      const locN = Number(field(item, "locationNumber"));
      const city = field(item, "city");
      const state = field(item, "state");
      const haat = Number(field(item, "antennaHeight"));
      locations.push({
        locationNumber: Number.isFinite(locN) ? locN : 1,
        lat: llat, lon: llon,
        ...(city ? { city: title(decodeXml(city)) } : {}),
        ...(state ? { state } : {}),
        ...(Number.isFinite(haat) && haat > 0 ? { antennaHaatM: haat } : {}),
      });
    }
    const det: FccDetails = {
      licensee: decodeXml(field(body, "licensee") ?? ""),
      freqs, locations,
    };
    this.details.set(callsign, det);
    try {
      mkdirSync(this.opts.cacheDir, { recursive: true });
      writeFileSync(path, JSON.stringify({ ...disk, [callsign]: det }));
    } catch { /* best-effort */ }
    return det;
  }

  private async soap(op: string, params: string): Promise<string | null> {
    const { appKey, username, password } = this.opts;
    const envelope = `<?xml version="1.0" encoding="UTF-8"?>
<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/">
 <SOAP-ENV:Body>
  <${op}>${params}
   <authInfo>
    <username>${xml(username)}</username>
    <password>${xml(password)}</password>
    <appKey>${xml(appKey)}</appKey>
    <version>latest</version>
    <style>rpc</style>
   </authInfo>
  </${op}>
 </SOAP-ENV:Body>
</SOAP-ENV:Envelope>`;
    try {
      const res = await this.opts.fetcher(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "text/xml; charset=utf-8", SOAPAction: "" },
        body: envelope,
      });
      if (!res.ok) return null;
      const text = await res.text();
      if (/<SOAP-ENV:Fault|faultstring/i.test(text)) {
        console.error(`[fccprox] ${op} fault:`, /<faultstring[^>]*>([^<]*)/.exec(text)?.[1] ?? "?");
        return null;
      }
      return text;
    } catch {
      return null;
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

function field(xmlChunk: string, name: string): string | null {
  const m = new RegExp(`<${name}[^>]*>([^<]*)</${name}>`).exec(xmlChunk);
  return m ? m[1]!.trim() || null : null;
}

function xml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// FCC ULS shouts ("KANSAS CITY"); the map whispers.
function title(s: string): string {
  return s.toLowerCase().replace(/(^|[\s-])([a-z])/g, (_, pre, ch) => pre + ch.toUpperCase());
}
