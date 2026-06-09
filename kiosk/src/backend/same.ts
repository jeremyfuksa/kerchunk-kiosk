// SAME / EAS header parsing (ROADMAP Idea 11).
//
// The header rides the NWR voice channel as an AFSK burst; multimon-ng
// decodes it to text and the helper forwards lines as "same" events:
//   EAS: ZCZC-WXR-TOR-029047-029095+0030-1561800-KEAX/NWS-
//   EAS: NNNN                                     (end of message)
// ORG-EEE-PSSCCC(-PSSCCC...)+TTTT-JJJHHMM-LLLLLLLL

export interface SameHeader {
  org: string;            // WXR (NWS), CIV, EAS, PEP
  event: string;          // TOR, SVR, FFW, ...
  eventName: string;      // human label
  fips: string[];         // PSSCCC codes as sent (P = county subdivision)
  purgeMinutes: number;
  sender: string;         // KEAX/NWS
  raw: string;
}

// The codes a metro scanner will actually meet, plus the national set.
const EVENT_NAMES: Record<string, string> = {
  TOR: "TORNADO WARNING", TOA: "TORNADO WATCH",
  SVR: "SEVERE THUNDERSTORM WARNING", SVA: "SEVERE THUNDERSTORM WATCH",
  SVS: "SEVERE WEATHER STATEMENT",
  FFW: "FLASH FLOOD WARNING", FFA: "FLASH FLOOD WATCH",
  FLW: "FLOOD WARNING", FLA: "FLOOD WATCH",
  WSW: "WINTER STORM WARNING", WSA: "WINTER STORM WATCH",
  BZW: "BLIZZARD WARNING", ISW: "ICE STORM WARNING",
  HWW: "HIGH WIND WARNING", HWA: "HIGH WIND WATCH",
  EWW: "EXTREME WIND WARNING",
  HUW: "HURRICANE WARNING", TRW: "TROPICAL STORM WARNING",
  DSW: "DUST STORM WARNING",
  CAE: "CHILD ABDUCTION EMERGENCY", CDW: "CIVIL DANGER WARNING",
  CEM: "CIVIL EMERGENCY MESSAGE", EQW: "EARTHQUAKE WARNING",
  EVI: "EVACUATION IMMEDIATE", FRW: "FIRE WARNING",
  HMW: "HAZARDOUS MATERIALS WARNING", LEW: "LAW ENFORCEMENT WARNING",
  NUW: "NUCLEAR POWER PLANT WARNING", RHW: "RADIOLOGICAL HAZARD WARNING",
  SPW: "SHELTER IN PLACE WARNING", VOW: "VOLCANO WARNING",
  EAN: "EMERGENCY ACTION NOTIFICATION", NIC: "NATIONAL INFORMATION CENTER",
  RWT: "REQUIRED WEEKLY TEST", RMT: "REQUIRED MONTHLY TEST",
  DMO: "PRACTICE/DEMO", NPT: "NATIONAL PERIODIC TEST",
};

const HEADER_RE = /ZCZC-(\w{3})-(\w{3})((?:-\d{6})+)\+(\d{4})-(\d{7})-([\w/ ]+?)-?\s*$/;

export function parseSame(line: string): SameHeader | null {
  const m = HEADER_RE.exec(line);
  if (!m) return null;
  const [, org, event, fipsBlob, tttt, , sender] = m;
  return {
    org: org!,
    event: event!,
    eventName: EVENT_NAMES[event!] ?? event!,
    fips: fipsBlob!.split("-").filter(Boolean),
    // TTTT is HHMM duration
    purgeMinutes: Number(tttt!.slice(0, 2)) * 60 + Number(tttt!.slice(2)),
    sender: sender!.trim(),
    raw: line,
  };
}

export function isEom(line: string): boolean {
  return /\bNNNN\b/.test(line);
}

/**
 * Does the alert cover the operator? Configured codes may be 5-digit county
 * FIPS (SSCCC) or full 6-digit SAME codes (PSSCCC, P = part-of-county).
 * No configured codes = everything matches (the operator hasn't scoped yet).
 */
export function fipsMatch(alertFips: string[], configured: string[] | undefined): boolean {
  if (!configured || configured.length === 0) return true;
  const want = new Set(configured.map((c) => c.trim()).filter(Boolean));
  return alertFips.some((f) => want.has(f) || want.has(f.slice(1)));
}

/** Tests are routine; real warnings are not. */
export function isTest(event: string): boolean {
  return ["RWT", "RMT", "DMO", "NPT"].includes(event);
}

// SAME PSSCCC county codes → short names for the operator's region (the KEAX
// County Warning Area + KC metro). Keyed on the 5-digit SSCCC (state+county);
// the leading part-of-county digit is dropped so subdivision codes (1/2/3…)
// resolve to the whole-county name. Kansas metro names that collide with a
// Missouri county are suffixed " KS" — the operator's home counties are all
// Missouri, so the common case stays bare.
const COUNTY_NAMES: Record<string, string> = {
  // Missouri (29)
  "29047": "Clay", "29165": "Platte", "29095": "Jackson",
  "29037": "Cass", "29107": "Lafayette", "29177": "Ray",
  "29049": "Clinton", "29025": "Caldwell", "29021": "Buchanan",
  "29003": "Andrew", "29063": "DeKalb", "29033": "Carroll",
  "29101": "Johnson", "29195": "Saline", "29159": "Pettis",
  "29083": "Henry", "29013": "Bates", "29015": "Benton",
  "29185": "St. Clair", "29117": "Livingston", "29061": "Daviess",
  "29087": "Holt", "29005": "Atchison", "29147": "Nodaway",
  "29075": "Gentry", "29079": "Grundy", "29129": "Mercer",
  "29227": "Worth", "29115": "Linn", "29211": "Sullivan",
  // Kansas (20)
  "20091": "Johnson KS", "20209": "Wyandotte", "20103": "Leavenworth",
  "20045": "Douglas KS", "20121": "Miami", "20059": "Franklin KS",
  "20087": "Jefferson KS", "20107": "Linn KS", "20139": "Osage KS",
  "20005": "Atchison KS", "20013": "Brown", "20043": "Doniphan",
  "20131": "Nemaha",
};

/**
 * County names for an alert banner. Shows the COVERED counties (those matching
 * the operator's configured filter) so a 15-county warning reads as the two or
 * three that matter; with no filter set, shows all of them. Codes outside the
 * table fall back to the raw 6-digit code so the banner is never blank, and
 * names are de-duplicated (split subdivisions of one county collapse to one).
 */
export function fipsNames(alertFips: string[], configured?: string[] | null): string {
  const want = configured && configured.length
    ? new Set(configured.map((c) => c.trim()).filter(Boolean))
    : null;
  const covered = want
    ? alertFips.filter((f) => want.has(f) || want.has(f.slice(1)))
    : alertFips;
  const codes = covered.length ? covered : alertFips;
  const names = codes.map((f) => COUNTY_NAMES[f.slice(1)] ?? f);
  return [...new Set(names)].join(", ");
}
