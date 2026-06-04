// Frequency-identification provider chain.
//
// Close Call discoveries are identified by asking each provider in order and
// taking the first hit: RepeaterBook (ham/GMRS repeaters, state-export cache)
// then RadioReference (curated county DB — business band, public safety).
// Providers degrade to null on any failure, so the chain can't break filing.

export interface LookupHit {
  /** Display tag for the channel table / dashboard. */
  tag: string;
  /** Modulation as the source reports it (FMN, FM, DMR, P25, NXDN, ...). */
  mode?: string;
  /** Transmitter location when the source knows it. */
  location?: {
    lat?: number;
    lon?: number;
    city?: string;
    state?: string;
    source: string;
  };
}

export interface LookupProvider {
  lookup(freqHz: number): Promise<LookupHit | null>;
}

export function composeLookups(providers: LookupProvider[]): LookupProvider {
  return {
    async lookup(freqHz: number): Promise<LookupHit | null> {
      for (const p of providers) {
        try {
          const hit = await p.lookup(freqHz);
          if (hit) return hit;
        } catch { /* provider failure: fall through to the next */ }
      }
      return null;
    },
  };
}

// Source vocabularies differ from ours: RadioReference says "FMN" where this
// system (and the wider scanner world) says "NFM". Normalize at the provider
// boundary so storage, display, and mode-mapping all speak one dialect.
const MODE_ALIASES: Record<string, string> = {
  FMN: "NFM",
};

export function normalizeMode(raw: string): string {
  const up = raw.trim().toUpperCase();
  return MODE_ALIASES[up] ?? up;
}
