import { normalizeMode, type LookupHit, type LookupProvider } from "./lookup.js";

// RadioReference Database Web Service (SOAP) — searchCountyFreq only.
//
// Identifies Close Call discoveries that RepeaterBook can't: business band,
// public safety, anything in RR's curated county data. Requirements (per
// https://support.radioreference.com/hc/en-us/articles/18844460198932):
// an approved developer appKey AND the end user's own credentials with an
// active premium subscription — all live in config.lookup.radioReference,
// never in the repo.
//
// Call discipline: queries fire only on Close Call events (already rare:
// 2-poll confirm + 5-minute cooldown + knownHz suppression), and every
// county+frequency result is memoized, so the API sees each new frequency
// at most countyIds.length times ever per process.

export interface RadioReferenceOptions {
  appKey: string;
  username: string;
  password: string;
  /** RR county ids (ctid) to search, in order — e.g. Jackson MO, Johnson KS. */
  countyIds: number[];
  fetcher?: (url: string, init: {
    method: string; headers: Record<string, string>; body: string;
  }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;
}

const ENDPOINT = "https://api.radioreference.com/soap2/index.php";
const MATCH_TOLERANCE_MHZ = 0.0025; // close calls round to a 12.5 kHz raster

export class RadioReference implements LookupProvider {
  private readonly opts: Required<RadioReferenceOptions>;
  private cache = new Map<string, LookupHit | null>();
  // searchCountyFreq returns mode IDs (4 = FMN, 6 = DMR, ...). Resolved via
  // their getMode op and memoized — one call per distinct id, ever.
  private modeNames = new Map<string, string>();

  constructor(opts: RadioReferenceOptions) {
    this.opts = { fetcher: (url, init) => fetch(url, init), ...opts };
  }

  async lookup(freqHz: number): Promise<LookupHit | null> {
    const mhz = freqHz / 1e6;
    for (const ctid of this.opts.countyIds) {
      const key = `${ctid}:${freqHz}`;
      let hit = this.cache.get(key);
      if (hit === undefined) {
        hit = await this.searchCountyFreq(ctid, mhz);
        this.cache.set(key, hit);
      }
      if (hit) return hit;
    }
    return null;
  }

  private authXml(): string {
    const { appKey, username, password } = this.opts;
    return `<authInfo>
    <username>${esc(username)}</username>
    <password>${esc(password)}</password>
    <appKey>${esc(appKey)}</appKey>
    <version>latest</version>
    <style>rpc</style>
   </authInfo>`;
  }

  /** Mode ids -> names ("4" -> "FMN") via getMode; non-numeric passes through. */
  private async resolveMode(raw: string): Promise<string> {
    if (!/^\d+$/.test(raw)) return raw;
    const hit = this.modeNames.get(raw);
    if (hit) return hit;
    try {
      const res = await this.opts.fetcher(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "text/xml; charset=utf-8", SOAPAction: "" },
        body: `<?xml version="1.0" encoding="UTF-8"?>
<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/">
 <SOAP-ENV:Body><getMode><mode>${raw}</mode>${this.authXml()}</getMode></SOAP-ENV:Body>
</SOAP-ENV:Envelope>`,
      });
      if (res.ok) {
        const name = leaf(await res.text(), "modeName");
        if (name) {
          this.modeNames.set(raw, name);
          return name;
        }
      }
    } catch { /* fall through to raw id */ }
    return raw;
  }

  private envelope(ctid: number, mhz: number): string {
    const { appKey, username, password } = this.opts;
    return `<?xml version="1.0" encoding="UTF-8"?>
<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/">
 <SOAP-ENV:Body>
  <searchCountyFreq>
   <ctid>${ctid}</ctid>
   <freq>${mhz.toFixed(4).replace(/0+$/, "").replace(/\.$/, ".0")}</freq>
   <tone></tone>
   <authInfo>
    <username>${esc(username)}</username>
    <password>${esc(password)}</password>
    <appKey>${esc(appKey)}</appKey>
    <version>latest</version>
    <style>rpc</style>
   </authInfo>
  </searchCountyFreq>
 </SOAP-ENV:Body>
</SOAP-ENV:Envelope>`;
  }

  private async searchCountyFreq(ctid: number, mhz: number): Promise<LookupHit | null> {
    try {
      const res = await this.opts.fetcher(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "text/xml; charset=utf-8", SOAPAction: "" },
        body: this.envelope(ctid, mhz),
      });
      if (!res.ok) {
        // SOAP faults arrive as HTTP 500 with a faultstring — surface it in
        // the journal ("Not a premium subscriber" cost a debugging round
        // when this was a silent null).
        const fault = /<faultstring[^>]*>([\s\S]*?)<\/faultstring>/
          .exec(await res.text().catch(() => ""))?.[1]?.trim();
        console.error(`[radioreference] ${res.status}${fault ? `: ${fault}` : ""}`);
        return null;
      }
      const xml = await res.text();
      // Tolerant extraction: each result is an <item>...</item> block with
      // out/callsign/descr/alpha leaf elements (rpc/encoded may add attrs).
      for (const item of xml.match(/<item[\s>][\s\S]*?<\/item>/g) ?? []) {
        const out = Number(leaf(item, "out"));
        if (!Number.isFinite(out) || Math.abs(out - mhz) > MATCH_TOLERANCE_MHZ) continue;
        const alpha = leaf(item, "alpha");
        const descr = leaf(item, "descr");
        const callsign = leaf(item, "callsign");
        const modeRaw = leaf(item, "mode");
        const mode = modeRaw ? normalizeMode(await this.resolveMode(modeRaw)) : null;
        const name = (alpha || descr || "").trim();
        if (!name && !callsign) continue;
        const tag = name
          ? (callsign ? `${name} · ${callsign}` : name)
          : callsign!;
        return { tag, ...(mode ? { mode } : {}) };
      }
      return null;
    } catch {
      return null; // offline/auth/parse: identification is best-effort
    }
  }
}

function leaf(xml: string, name: string): string | null {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`).exec(xml);
  if (!m) return null;
  return decodeXml(m[1]!.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")).trim() || null;
}

// Full XML entity decoding — RR data is rich in named (&apos;) and numeric
// (&#8211;) references; "Harrah&apos;s ..." reached the operator's screen
// when only a hand-picked subset was decoded. &amp; goes LAST so encoded
// ampersands can't re-trigger earlier replacements.
export function decodeXml(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
