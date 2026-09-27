// The 104 standard DCS (Digital-Coded Squelch) codes — the one TS copy,
// shared by the config schema and the admin channel drawer. Mirrors
// kerchunk-dsp's DCS_CODES (native/src/dcs.hpp); keep the two in step.
//
// A channel stores a code as "023N" / "023I": three octal digits plus the
// polarity (N = normal, I = inverted). On air every inverted code is
// identical to some normal code (023I == 047N — the standard inversion-pair
// table), so the helper reports what it hears in that normal form; dcsAlias()
// names the twin so the drawer can show both.
export const DCS_CODES = [
  "023", "025", "026", "031", "032", "036", "043", "047", "051", "053", "054", "065", "071", "072", "073",
  "074", "114", "115", "116", "122", "125", "131", "132", "134", "143", "145", "152", "155", "156", "162",
  "165", "172", "174", "205", "212", "223", "225", "226", "243", "244", "245", "246", "251", "252", "255",
  "261", "263", "265", "266", "271", "274", "306", "311", "315", "325", "331", "332", "343", "346", "351",
  "356", "364", "365", "371", "411", "412", "413", "423", "431", "432", "445", "446", "452", "454", "455",
  "462", "464", "465", "466", "503", "506", "516", "523", "526", "532", "546", "565", "606", "612", "624",
  "627", "631", "632", "654", "662", "664", "703", "712", "723", "731", "732", "734", "743", "754",
] as const;

const CODE_SET = new Set<string>(DCS_CODES);

/** True for "NNN" + "N"|"I" where NNN is one of the 104 standard codes. */
export function isDcsCode(s: string): boolean {
  return /^[0-7]{3}[NI]$/.test(s) && CODE_SET.has(s.slice(0, 3));
}

const MASK = 0x7fffff;

// The 23-bit on-air word (bit i = i-th bit sent): 9 code bits, then 0,0,1,
// then 11 Golay(23,12) parity bits — the same LFSR as native/src/dcs.cpp
// (UV-K5 firmware layout; 023N = 0x763813).
export function dcsWord(code: string): number {
  let data = parseInt(code.slice(0, 3), 8) | 0x800;
  let w = data;
  for (let i = 0; i < 12; i++) {
    w <<= 1;
    if (w & 0x1000) w ^= 0x08ea;
  }
  data |= (w & 0x0ffe) << 11;
  return code[3] === "I" ? data ^ MASK : data;
}

/** The standard code in the other polarity that is identical on air
 *  ("023I" -> "047N", "047N" -> "023I"), or undefined for a non-code. */
export function dcsAlias(code: string): string | undefined {
  if (!isDcsCode(code)) return undefined;
  const flip = code[3] === "N" ? "I" : "N";
  const rot = new Set<number>();
  let w = dcsWord(code);
  for (let i = 0; i < 23; i++) {
    rot.add(w);
    w = ((w >>> 1) | ((w & 1) << 22)) & MASK;
  }
  return DCS_CODES.map((c) => c + flip).find((c) => c !== code && rot.has(dcsWord(c)));
}
