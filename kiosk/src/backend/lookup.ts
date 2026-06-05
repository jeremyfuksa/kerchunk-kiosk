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
  /** Can the operator actually LISTEN to this? "data" = paging/telemetry/
   *  digital voice we can't decode — file it seen-not-heard. */
  listen?: "voice" | "data";
  /** Transmitter location when the source knows it. */
  location?: {
    lat?: number;
    lon?: number;
    city?: string;
    state?: string;
    /** Licensed transmitter power (FCC), for coverage-radius blips. */
    powerWatts?: number;
    /** Antenna height above terrain (FCC), same use. */
    antennaHaatM?: number;
    source: string;
  };
}

// Context the caller already knows about the frequency. Providers that can
// exploit it do (FccProx name-gates licenses with it); the rest ignore it.
export interface LookupHint {
  name?: string;
}

export interface LookupProvider {
  lookup(freqHz: number, hint?: LookupHint): Promise<LookupHit | null>;
}

// RadioReference leaves mode nil on trunked-SYSTEM site rows (mode belongs
// to the system in their data model) — but the system NAME carries it:
// "MotoNet CP+ (DMR) Site 013", "KC Wireless (LTR) Site 010". Infer from
// well-known tokens when the source didn't say; never override a real mode.
const NAME_MODE_TOKENS = ["DMR", "P25", "NXDN", "LTR", "EDACS", "D-STAR", "YSF", "TETRA"];

export function inferModeFromName(tag: string): string | undefined {
  const up = tag.toUpperCase();
  for (const t of NAME_MODE_TOKENS) {
    if (new RegExp(`(^|[^A-Z0-9])${t.replace("-", "\\-")}([^A-Z0-9]|$)`).test(up)) return t;
  }
  return undefined;
}

// Listenability triage (operator rule): a hit we can identify is either
// something the speaker can carry (analog voice) or something it can't —
// digital voice with no decoder (Idea 12), paging, telemetry, raw data.
// Sources tell us via mode (RR: DMR/P25/Telm...), via the name ("...Paging"),
// or via FCC emission designators (handled in fccprox). Unknown stays
// undefined: the operator triages by ear, as before.
const DATA_MODES = new Set([
  "DMR", "P25", "NXDN", "NXDN48", "NXDN96", "TETRA", "D-STAR", "DSTAR",
  "YSF", "TELM", "POCSAG", "FLEX", "ACARS", "DATA",
]);

export function classifyListen(tag: string, mode?: string): "voice" | "data" | undefined {
  const m = (mode ?? "").trim().toUpperCase();
  if (DATA_MODES.has(m)) return "data";
  if (/PAGING|PAGER|TELEMETRY|\bTELEM\b|POCSAG|\bFLEX\b|SCADA|\bDATA\b/i.test(tag)) return "data";
  if (inferModeFromName(tag)) return "data";   // "MotoNet (DMR) Site 13" etc.
  if (["FM", "NFM", "FMN", "AM", "USB", "LSB"].includes(m)) return "voice";
  return undefined;
}

export function composeLookups(providers: LookupProvider[]): LookupProvider {
  return {
    async lookup(freqHz: number, hint?: LookupHint): Promise<LookupHit | null> {
      // First hit wins tag/mode — but a hit WITHOUT a location keeps the
      // chain walking for location only (RadioReference names business
      // channels but carries no geo; FccProx exists to fill exactly that).
      let best: LookupHit | null = null;
      for (const p of providers) {
        try {
          const hit = await p.lookup(freqHz, hint);
          if (!hit) continue;
          const prev: LookupHit | null = best;
          if (prev === null) {
            best = hit;
          } else if (!prev.location && hit.location) {
            best = { ...(prev as LookupHit), location: hit.location };
          }
          if (best?.location) break;
        } catch { /* provider failure: fall through to the next */ }
      }
      if (best && !best.mode) {
        const inferred = inferModeFromName(best.tag);
        if (inferred) best = { ...best, mode: inferred };
      }
      if (best && !best.listen) {
        const listen = classifyListen(best.tag, best.mode);
        if (listen) best = { ...best, listen };
      }
      return best;
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
