// EiBi's ITU codes for the shortwave countries, to the map's ISO codes. A code not listed just
// leaves the country untinted: the transmitter dot still shows.
const ITU_ISO: Readonly<Record<string, string>> = {
  AFG: "AF", AFS: "ZA", AGL: "AO", ALB: "AL", ALG: "DZ", ARG: "AR", ARM: "AM", ARS: "SA", ASC: "SH", ATA: "AQ", AUS: "AU", AUT: "AT", AZE: "AZ",
  B: "BR", BEL: "BE", BGD: "BD", BIH: "BA", BLR: "BY", BOL: "BO", BOT: "BW", BUL: "BG", CAN: "CA", CHL: "CL", CHN: "CN", CLM: "CO", CTR: "CR", CUB: "CU", CVA: "VA", CZE: "CZ",
  D: "DE", DNK: "DK", E: "ES", EGY: "EG", EQA: "EC", EST: "EE", ETH: "ET", F: "FR", FIN: "FI", G: "GB", GAB: "GA", GEO: "GE", GHA: "GH", GRC: "GR", GUF: "GF", GUM: "GU", GUY: "GY",
  HNG: "HU", HOL: "NL", HRV: "HR", HWA: "US", I: "IT", IND: "IN", INS: "ID", IRL: "IE", IRN: "IR", IRQ: "IQ", ISL: "IS", ISR: "IL", J: "JP", JOR: "JO",
  KAZ: "KZ", KEN: "KE", KGZ: "KG", KOR: "KR", KRE: "KP", KWT: "KW", LAO: "LA", LBN: "LB", LBY: "LY", LTU: "LT", LUX: "LU", LVA: "LV", MDA: "MD", MDG: "MG", MEX: "MX", MLA: "MY", MLI: "ML", MNG: "MN", MOZ: "MZ", MRA: "MP", MRC: "MA", MTN: "MR",
  NGR: "NE", NIG: "NG", NOR: "NO", NPL: "NP", NZL: "NZ", OMA: "OM", PAK: "PK", PHL: "PH", PNG: "PG", POL: "PL", POR: "PT", PRU: "PE", PRG: "PY", ROU: "RO", RRW: "RW", RUS: "RU",
  S: "SE", SDN: "SD", SNG: "SG", SOM: "SO", SRB: "RS", SRL: "LK", SUI: "CH", SVK: "SK", SVN: "SI", SWZ: "SZ", SYR: "SY", TCH: "TD", THA: "TH", TJK: "TJ", TKM: "TM", TUN: "TN", TUR: "TR", TWN: "TW", TZA: "TZ",
  UAE: "AE", UGA: "UG", UKR: "UA", URG: "UY", USA: "US", UZB: "UZ", VEN: "VE", VTN: "VN", YEM: "YE", ZMB: "ZM", ZWE: "ZW",
};

export function ituToIso2(itu: string | undefined): string | null {
  return itu ? ITU_ISO[itu] ?? null : null;
}

export function countrySelector(iso: string): string {
  return `path[id="${iso}"]`;
}
