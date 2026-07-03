import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { LookupHit, LookupProvider } from "./lookup.js";
import { candidatesFor, matchesChain, type BusinessChain } from "./businessFreqs.js";

// Best-guess identification of national-retail Close Call hits (ROADMAP: business
// frequency guessing). A discovered business-band frequency maps to one or more
// candidate chains (businessFreqs.ts); this provider narrows them to the chain
// that actually has a store near the QTH (Google Places API New) and returns it
// as "<chain> (likely)", pinning the real store's coordinates as the map blip.
//
// It sits LAST in the lookup chain — only a guess, never overriding an
// authoritative RepeaterBook/RadioReference/FccProx hit — and degrades to null
// (never throwing) so it can't break Close Call filing if Places is unavailable.

const PLACES_URL = "https://places.googleapis.com/v1/places:searchText";
// Channels sit on 12.5 kHz centers; ±2.5 kHz absorbs Close Call's estimate
// jitter without bleeding into the adjacent channel.
const TOLERANCE_HZ = 2_500;
// A store farther than this isn't "in your area" — a national query can return
// the nearest store three states over when the chain isn't local at all.
const MAX_KM = 40;
const SEARCH_RADIUS_M = 40_000;
// Re-check a "not in area" chain roughly monthly so a newly-opened store is
// eventually rediscovered. Positive hits are kept indefinitely (a store's
// coordinates don't move). Only NEGATIVE cache entries expire.
const NEGATIVE_TTL_MS = 30 * 24 * 3600 * 1000;
// Places error statuses that mean the KEY/request is broken (not a transient
// blip): latch the provider off only for these. Quota (RESOURCE_EXHAUSTED),
// 5xx (INTERNAL/UNAVAILABLE), and DEADLINE_EXCEEDED are retryable.
const PERMANENT_ERRORS = new Set(["PERMISSION_DENIED", "UNAUTHENTICATED", "INVALID_ARGUMENT"]);

interface PlaceResult { name: string; lat: number; lon: number; city?: string; }

type PlacesResponse = {
  error?: { status?: string; message?: string };
  places?: Array<{
    displayName?: { text?: string };
    formattedAddress?: string;
    location?: { latitude?: number; longitude?: number };
  }>;
};

export interface BusinessGuessFetchResult {
  json(): Promise<unknown>;
}
export interface BusinessGuessOpts {
  apiKey: string;
  home: { lat: number; lon: number };
  cacheDir: string;
  /** Injected for tests; defaults to global fetch. */
  fetcher?: (url: string, init: {
    method: string; headers: Record<string, string>; body: string;
  }) => Promise<BusinessGuessFetchResult>;
}

export class BusinessGuess implements LookupProvider {
  private readonly opts: BusinessGuessOpts;
  private readonly fetcher: NonNullable<BusinessGuessOpts["fetcher"]>;
  private readonly cacheFile: string;
  // Per-chain nearest store (or null = looked up, genuinely not in area), with
  // the time it was resolved so negatives can expire.
  private readonly cache = new Map<string, { result: PlaceResult | null; ts: number }>();
  // Latched ONLY on a hard Places auth/config error so one misconfigured key
  // doesn't make every Close Call lookup pay a doomed round-trip. A transient
  // quota/5xx error must NOT latch (it would kill guessing for the process).
  private disabled = false;

  constructor(opts: BusinessGuessOpts) {
    this.opts = opts;
    this.fetcher = opts.fetcher ?? ((url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(15_000) }));
    this.cacheFile = join(opts.cacheDir, "places-cache.json");
    try {
      const disk = JSON.parse(readFileSync(this.cacheFile, "utf8")) as Record<string, unknown>;
      for (const [k, v] of Object.entries(disk)) {
        // New format is {result, ts}; migrate a legacy bare PlaceResult|null
        // (ts 0 → any negative is immediately re-checked, positives kept).
        if (v && typeof v === "object" && "ts" in v && "result" in v) {
          this.cache.set(k, v as { result: PlaceResult | null; ts: number });
        } else {
          this.cache.set(k, { result: v as PlaceResult | null, ts: 0 });
        }
      }
    } catch { /* no cache yet */ }
  }

  async lookup(freqHz: number): Promise<LookupHit | null> {
    if (this.disabled) return null;
    const candidates = candidatesFor(freqHz, TOLERANCE_HZ);
    for (const chain of candidates) {
      const place = await this.nearest(chain);
      if (place && haversineKm(this.opts.home, place) <= MAX_KM) {
        // No mode/listen: we can't know analog-vs-DMR from frequency alone, so
        // the operator triages by ear. The value is the name + the real pin.
        return {
          tag: `${chain.name} (likely)`,
          location: {
            lat: place.lat, lon: place.lon,
            ...(place.city ? { city: place.city } : {}),
            source: "google-places",
          },
        };
      }
    }
    return null;
  }

  private async nearest(chain: BusinessChain): Promise<PlaceResult | null> {
    const cached = this.cache.get(chain.name);
    if (cached && (cached.result !== null || Date.now() - cached.ts < NEGATIVE_TTL_MS)) {
      return cached.result; // positive = permanent; negative = until it expires
    }
    let result: PlaceResult | null = null;
    try {
      const res = await this.fetcher(PLACES_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": this.opts.apiKey,
          "X-Goog-FieldMask": "places.displayName,places.formattedAddress,places.location",
        },
        body: JSON.stringify({
          textQuery: chain.query,
          locationBias: {
            circle: {
              center: { latitude: this.opts.home.lat, longitude: this.opts.home.lon },
              radius: SEARCH_RADIUS_M,
            },
          },
          maxResultCount: 1,
        }),
      });
      const body = (await res.json()) as PlacesResponse;
      if (body?.error) {
        const status = body.error.status ?? "";
        const permanent = PERMANENT_ERRORS.has(status);
        console.error(
          `[business-guess] Places ${permanent ? "disabled" : "error"}: ${status} ${body.error.message ?? ""}`.trim().slice(0, 200),
        );
        if (permanent) this.disabled = true; // else a transient blip — retry next time
        return null;   // don't cache: a fixed key / passed quota should work later
      }
      const p = body?.places?.[0];
      const lat = p?.location?.latitude;
      const lon = p?.location?.longitude;
      if (p && typeof lat === "number" && typeof lon === "number"
          && matchesChain(p.displayName?.text ?? "", chain)) {
        result = { name: p.displayName?.text ?? "", lat, lon, city: cityOf(p.formattedAddress) };
      }
    } catch {
      return null;   // network blip: don't cache a transient miss as "absent"
    }
    // Cache the verified answer — including a genuine null (chain not in area),
    // so absent chains (e.g. Kroger here) aren't re-queried every Close Call.
    // The timestamp lets a negative expire (NEGATIVE_TTL_MS) so a store that
    // opens later is eventually found.
    this.cache.set(chain.name, { result, ts: Date.now() });
    this.persist();
    return result;
  }

  private persist(): void {
    try {
      mkdirSync(this.opts.cacheDir, { recursive: true });
      writeFileSync(this.cacheFile, JSON.stringify(Object.fromEntries(this.cache)));
    } catch { /* cache is best-effort */ }
  }
}

/** US formatted_address "street, City, ST zip, USA" → "City" (best-effort). */
function cityOf(addr: string | undefined): string | undefined {
  if (!addr) return undefined;
  const parts = addr.split(",").map((s) => s.trim()).filter(Boolean);
  // Drop the country and "ST zip" tail; the city is the part before them.
  return parts.length >= 3 ? parts[parts.length - 3] : undefined;
}

function haversineKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const R = 6371;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLon = (b.lon - a.lon) * Math.PI / 180;
  const la1 = a.lat * Math.PI / 180, la2 = b.lat * Math.PI / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
