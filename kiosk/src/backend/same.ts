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
