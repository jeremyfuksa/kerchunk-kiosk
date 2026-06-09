// National retail / commercial two-way frequency plans → the chains that run
// them, for best-guess identification of Close Call business-band hits.
//
// Provenance: the operator's spectrum-utilization research for the KC North /
// Liberty, MO area (the standardized "color dot" itinerant plan plus the
// published nationwide corporate channel plans). This is the part nothing else
// in the lookup chain can do: RepeaterBook/RadioReference/FccProx identify
// LICENSED, geocoded entities (Worlds of Fun, Liberty Hospital, FedEx, transit)
// — but national retailers run on itinerant/leased licenses that surface as a
// bare Close Call hit with no recognizable name. This table supplies the name.
//
// We CANNOT decode CTCSS/DCS, so a frequency alone is ambiguous: the same UHF
// "Star" channel is Kroger AND Dick's AND Costco. So each frequency carries an
// ORDERED candidate list, and BusinessGuess narrows it by which chain actually
// has a store near the QTH (Google Places), returning the first in-area match
// as "<chain> (likely)". Distinctive single-candidate channels (the Target /
// Home Depot / Menards plans) are high-confidence; shared "Star"/MURS channels
// are weaker and lean entirely on the area filter.

export interface BusinessChain {
  /** Display name for the guess tag. */
  name: string;
  /** Google Places text query. */
  query: string;
  /**
   * Substrings the Places result name must contain (after normalization) to
   * count as a real in-area presence. This is the guard against fuzzy matches:
   * a "Kroger" query in KC returns "Jomac Foods Inc", which matches none of
   * these, so Kroger is correctly rejected (it doesn't operate in this metro).
   */
  match: string[];
}

// Chain registry — shared across the frequencies each chain runs.
const TARGET: BusinessChain = { name: "Target", query: "Target", match: ["target"] };
const HOME_DEPOT: BusinessChain = { name: "Home Depot", query: "Home Depot", match: ["home depot"] };
const LOWES: BusinessChain = { name: "Lowe's", query: "Lowe's Home Improvement", match: ["lowes"] };
const MENARDS: BusinessChain = { name: "Menards", query: "Menards", match: ["menards"] };
const WALMART: BusinessChain = { name: "Walmart", query: "Walmart", match: ["walmart", "wal mart"] };
const SAMS: BusinessChain = { name: "Sam's Club", query: "Sam's Club", match: ["sams club"] };
const DICKS: BusinessChain = { name: "Dick's Sporting Goods", query: "Dick's Sporting Goods", match: ["dicks"] };
const COSTCO: BusinessChain = { name: "Costco", query: "Costco Wholesale", match: ["costco"] };
const BASS_PRO: BusinessChain = { name: "Bass Pro Shops", query: "Bass Pro Shops", match: ["bass pro"] };
const CABELAS: BusinessChain = { name: "Cabela's", query: "Cabela's", match: ["cabelas"] };
const KOHLS: BusinessChain = { name: "Kohl's", query: "Kohl's", match: ["kohls"] };
const CVS: BusinessChain = { name: "CVS", query: "CVS Pharmacy", match: ["cvs"] };
const WALGREENS: BusinessChain = { name: "Walgreens", query: "Walgreens", match: ["walgreens"] };
const KROGER: BusinessChain = { name: "Kroger", query: "Kroger", match: ["kroger"] };

export interface BusinessFreq {
  /** Channel center, Hz. */
  hz: number;
  /** Candidate chains, ordered best-guess first (the area filter prunes them). */
  candidates: BusinessChain[];
}

// Ordered best-guess first. Distinctive plans first, shared channels after.
export const BUSINESS_FREQS: BusinessFreq[] = [
  // ── Target nationwide plan (Plan B is the prevalent modern deployment) ──
  { hz: 461_037_500, candidates: [TARGET, LOWES] }, // Target Ch1; also a Lowe's UHF channel
  { hz: 466_287_500, candidates: [TARGET] },        // Target Ch2
  { hz: 469_487_500, candidates: [TARGET] },        // Target Assets Protection
  { hz: 462_912_500, candidates: [TARGET] },        // Target Exec/Leadership
  // ── The Home Depot nationwide plan ──
  { hz: 467_762_500, candidates: [HOME_DEPOT] },    // HD Ch1 (signature front-end/paging)
  { hz: 467_837_500, candidates: [HOME_DEPOT] },    // HD Ch3 (fulfillment/freight)
  { hz: 461_887_500, candidates: [HOME_DEPOT] },    // HD legacy/misc ops
  // ── Menards nationwide plan ──
  { hz: 469_562_500, candidates: [MENARDS] },       // Menards Ch1 (front end)
  { hz: 467_887_500, candidates: [MENARDS] },       // Menards Ch2 (yard)
  { hz: 466_037_500, candidates: [MENARDS] },       // Menards Ch3 (hardware)
  { hz: 464_487_500, candidates: [MENARDS] },       // Menards Ch4 (inventory)
  // ── Lowe's UHF (MotoTRBO) ──
  { hz: 461_112_500, candidates: [LOWES] },
  { hz: 464_537_500, candidates: [LOWES] },
  // ── Costco discrete-site UHF ──
  { hz: 468_212_500, candidates: [COSTCO] },
  { hz: 464_962_500, candidates: [COSTCO] },
  // ── Bass Pro Shops distinctive UHF ──
  { hz: 451_587_500, candidates: [BASS_PRO] },
  { hz: 456_462_500, candidates: [BASS_PRO] },
  // ── Pharmacy ──
  { hz: 461_237_500, candidates: [CVS] },
  { hz: 468_262_500, candidates: [WALGREENS] },
  // ── Kohl's (often DMR) ──
  { hz: 463_725_000, candidates: [KOHLS] },
  { hz: 463_650_000, candidates: [KOHLS] },
  // ── Shared UHF "Star" channels — ambiguous; ordered by whose plan treats
  //    the channel as primary. The area filter does the real work here. ──
  { hz: 467_850_000, candidates: [HOME_DEPOT, DICKS, CABELAS, BASS_PRO, COSTCO, KOHLS, KROGER] },
  { hz: 467_875_000, candidates: [DICKS, HOME_DEPOT, KROGER] },
  { hz: 467_900_000, candidates: [BASS_PRO, CABELAS, HOME_DEPOT, KROGER] },
  { hz: 467_925_000, candidates: [DICKS, KROGER] },
  { hz: 464_550_000, candidates: [DICKS] },         // Yellow Dot — regional Dick's/retail
  // ── MURS / VHF "color dots" — very shared; the chain whose use is iconic
  //    leads. (Walmart's 154.570 runs tone-free; the area filter still gates.)
  { hz: 154_570_000, candidates: [WALMART, LOWES, MENARDS] }, // Blue Dot
  { hz: 154_600_000, candidates: [SAMS, WALMART] },           // Green Dot
  { hz: 151_820_000, candidates: [WALMART] },                 // Walmart loss prevention
  { hz: 151_880_000, candidates: [WALMART] },
  { hz: 151_940_000, candidates: [WALMART] },
];

/** Normalize a business name for comparison: lowercase, strip everything but
 *  letters/digits, so "DICK'S Sporting Goods" → "dickssportinggoods" and the
 *  match token "dicks" is a clean substring. */
function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Does a Places result name genuinely correspond to this chain? */
export function matchesChain(resultName: string, chain: BusinessChain): boolean {
  const n = norm(resultName);
  return n.length > 0 && chain.match.some((t) => n.includes(norm(t)));
}

/** Candidate chains for a frequency, within tolerance of a known channel. */
export function candidatesFor(freqHz: number, toleranceHz: number): BusinessChain[] {
  const entry = BUSINESS_FREQS.find((e) => Math.abs(e.hz - freqHz) <= toleranceHz);
  return entry?.candidates ?? [];
}
