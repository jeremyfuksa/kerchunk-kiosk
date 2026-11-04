import { describe, it, expect } from "vitest";
import { isUtility, parseAoki, parseEibi, parseEibiReadme, parseHfcc, parseHfccSites, ScheduleDb, seasonCode } from "../src/backend/hf/schedule.js";

const EIBI = [
  "kHz:75;Time(UTC):93;Days:59;ITU:49;Station:201;Lng:49;Target:62;Remarks:135;P:35;Start:60;Stop:60;",
  "9395;1130-1200;;SVK;Radio Slovakia Int.;E;ENA;/USA-o;1;;",
  "5845;1430-1500;Mo-Fr;G;BBC;K;FE;/UZB;0;;",
  "1467;1530-1545;13567;IND;Trans World Radio;PS;AFG;/KGZ;1;;",
  "6000;2300-0100;Sa;USA;Wrap Radio;E;NAm;a;1;;",
  "7000;0000-2400;;J;Gone Radio;J;As;;8;;",
  "7100;0000-2400;;J;Utility;-CW;As;;91;;",
  "7200;0000-2400;;D;Dated Radio;D;Eu;;6;0111;3011;",
  "bad line",
].join("\r\n");
const README = `
   I) Language codes.
   E     English: North America, Britain (1500m)
   K     Korean: Korea (80m)
   II) Country codes.
   G     United Kingdom of Great Britain
   SVK   Slovakia
   USA   United States of America
   UZB   Uzbekistan
   III) Target-area codes.
   ENA   Eastern North America
   IV) Transmitter site codes.
   USA: a-Andrews AFB, MD 38N48'39"-76W52'01"
   o-Okeechobee, FL 27N27-80W56
   CHN: Beijing 39N54-116E23 except:
   L-Lingshi "725" 36N52-111E40
   a-Baoji 34N30-107E10
   UZB: Tashkent 41N13-69E09 except:
   ct-Cape Town 33S41-18E42
   V) Sources
`;
const AOKI_HEAD = "FRE   STATION                         UTC       Su-W-Sa Language             Pow Azi Location                ADM L/L             Remark";
const AOKI = [
  "B26 Shortwave Frequecy List  October 31 2026,  0900 UTC   Day 1 = Sunday",
  AOKI_HEAD,
  " 9395 WRMI Blues Radio Intl           0000-0030    4    English              100 355 Okeechobee6             USA 272726N0805559W RMI a26",
  "11955 NHK WORLD RADIO JAPAN           2155-0100 1234567 Japanese             300 290 Ibaragi-Koga-Yamata     J   361024N1394923E NHK b26",
  " 5900 R.TAIWAN INT.                   1700-1730 .234567 Russian               50  30 Kostinbrod(Sofia)       BUL 424833N0231113E RTI a26",
].join("\r\n");
const HFCC = [
  ";FREQ STRT STOP CIRAF ZONES                    LOC POWR AZIMUTH SLW ANT DAYS    FDATE  TDATE MOD AFRQ LANGUAGE   ADM BRC FMO REQ#",
  " 9395 0000 2400 3,4,9                          RMI  100 355       0 805 1234567 251026 280327 D       EngSpa     USA RMI FCC  1368",
  " 5985 0230 0330 40                             DHA  250 35        0 803 1234567 251026 280327 D 16000 Fas        UAE ADM ADM   879",
  " 5990 0230 0330 40                             DHA  250 35        0 803 1234567 251026 280327 N 16000 Fas        UAE ADM ADM   880",
].join("\r\n");
const SITES = ["; 5-Aug-2026 SITE.TXT REFERENCE TABLE", "DHA Dhabayya                       UAE 24N11 054E14", "ROB Rohrbach                       D   48N36 011E33"].join("\r\n");

// 2026-11-02 is a Monday.
const utc = (d: number, h: number, m = 0) => Date.UTC(2026, 10, d, h, m);
const home = { lat: 39.1, lon: -94.58 };
const db = (o: { eibi?: string; aoki?: string; hfcc?: string } = {}) => new ScheduleDb({
  eibi: parseEibi(o.eibi ?? EIBI), readme: parseEibiReadme(README), aoki: parseAoki(o.aoki ?? AOKI),
  hfcc: parseHfcc(o.hfcc ?? HFCC), hfccSites: parseHfccSites(SITES), home,
});

describe("seasonCode", () => {
  it("is A from the last Sunday of March, B from the last Sunday of October", () => {
    expect(seasonCode(new Date(Date.UTC(2026, 10, 2)))).toBe("b26");
    expect(seasonCode(new Date(Date.UTC(2026, 9, 24)))).toBe("a26");
    expect(seasonCode(new Date(Date.UTC(2026, 9, 25)))).toBe("b26");
    expect(seasonCode(new Date(Date.UTC(2027, 0, 15)))).toBe("b26");
    expect(seasonCode(new Date(Date.UTC(2027, 2, 27)))).toBe("b26");
    expect(seasonCode(new Date(Date.UTC(2027, 2, 28)))).toBe("a27");
  });
});

describe("parsers", () => {
  it("EiBi drops inactive and utility rows and junk lines", () => {
    const e = parseEibi(EIBI);
    expect(e.map((r) => r.khz)).toEqual([9395, 5845, 1467, 6000, 7200]);
    expect(e[0]).toMatchObject({ station: "Radio Slovakia Int.", itu: "SVK", language: "E", hostItu: "USA", siteCode: "o", start: 690, end: 720 });
  });
  it("EiBi README gives languages, countries and sites", () => {
    const r = parseEibiReadme(README);
    expect(r.languages.get("K")).toBe("Korean");
    expect(r.countries.get("SVK")).toBe("Slovakia");
    expect(r.sites.get("USA-o")?.name).toBe("Okeechobee, FL");
    expect(r.sites.get("USA-o")?.lat).toBeCloseTo(27.45, 2);
    expect(r.sites.get("USA-a")?.lon).toBeCloseTo(-(76 + 52 / 60 + 1 / 3600), 3);
    expect(r.sites.get("UZB-")?.name).toBe("Tashkent");
    expect(r.sites.get("UZB-ct")?.lat).toBeCloseTo(-33.683, 2);
    expect(r.sites.get("CHN-")?.name).toBe("Beijing");   // an uppercase code isn't the default site
    expect(r.sites.get("CHN-L")?.name).toBe('Lingshi "725"');
  });
  it("Aoki reads fixed columns; day 1 is Sunday", () => {
    const a = parseAoki(AOKI);
    expect(a).toHaveLength(3);
    expect(a[0]).toMatchObject({ khz: 9395, station: "WRMI Blues Radio Intl", start: 0, end: 30, language: "English", powerKw: 100, site: "Okeechobee6", itu: "USA" });
    expect(a[0]!.lat).toBeCloseTo(27.4572, 3);
    expect(a[0]!.lon).toBeCloseTo(-80.9331, 3);
    expect(a[0]!.days).toBe(1 << 3);          // "   4" = Wednesday
    expect(a[2]!.days).toBe(0b1111110);       // ".234567" = not Sunday
  });
  it("HFCC keeps AM rows only", () => {
    const h = parseHfcc(HFCC);
    expect(h.map((r) => r.khz)).toEqual([9395, 5985]);
    expect(h[0]).toMatchObject({ siteCode: "RMI", powerKw: 100, start: 0, end: 1440, itu: "USA" });
  });
  it("HFCC sites read degrees and minutes", () => {
    const s = parseHfccSites(SITES);
    expect(s.get("DHA")?.name).toBe("Dhabayya");
    expect(s.get("DHA")?.lat).toBeCloseTo(24.183, 2);
    expect(s.get("ROB")?.lon).toBeCloseTo(11.55, 2);
  });
});

describe("ScheduleDb.candidates", () => {
  const names = (hz: number, ts: number, d = db()) => d.candidates(hz, ts).map((c) => c.station);

  it("matches frequency and UTC time", () => {
    expect(names(9_395_000, utc(2, 11, 45))).toContain("Radio Slovakia Int.");
    expect(names(9_395_000, utc(2, 12, 30))).not.toContain("Radio Slovakia Int.");
    expect(names(9_400_000, utc(2, 11, 45))).toEqual([]);
  });

  it("uses the 5 kHz raster: a nearby channel still matches, two away doesn't", () => {
    const d = db({ eibi: "9393;1100-1200;;SVK;Near;E;x;;1;;", aoki: "", hfcc: "" });
    expect(names(9_395_000, utc(2, 11, 30), d)).toEqual(["Near"]);
    expect(names(9_400_000, utc(2, 11, 30), d)).toEqual([]);
  });

  it("EiBi digit days start on Monday; names work too", () => {
    expect(names(5_845_000, utc(2, 14, 45))).toEqual(["BBC"]);        // Monday, Mo-Fr
    expect(names(5_845_000, utc(7, 14, 45))).toEqual([]);             // Saturday
    expect(names(1_467_000, utc(2, 15, 35))).toEqual(["Trans World Radio"]);   // 1=Monday
    expect(names(1_467_000, utc(3, 15, 35))).toEqual([]);             // Tuesday isn't in 13567
  });

  it("a slot past midnight belongs to the day it started", () => {
    expect(names(6_000_000, utc(7, 23, 30))).toEqual(["Wrap Radio"]);
    expect(names(6_000_000, utc(8, 0, 30))).toEqual(["Wrap Radio"]);   // Sunday morning, started Saturday
    expect(names(6_000_000, utc(9, 0, 30))).toEqual([]);
  });

  it("respects a dated row's window", () => {
    expect(names(7_200_000, utc(2, 12))).toEqual(["Dated Radio"]);
    const d = db({ eibi: "7200;0000-2400;;D;Dated Radio;D;Eu;;6;0112;3112;", aoki: "", hfcc: "" });
    expect(names(7_200_000, utc(2, 12), d)).toEqual([]);
  });

  describe("date windows and special days", () => {
    const one = (row: string) => db({ eibi: row, aoki: "", hfcc: "" });
    const on = (row: string, ts: number) => names(7_200_000, ts, one(row)).length > 0;

    it("any EiBi row with dates has a window, whatever its persistence and any suffix on the stop", () => {
      expect(on("7200;0000-2400;;CAN;Summer;E;NAm;;1;0107;3110", utc(2, 12))).toBe(false);
      expect(on("7200;0000-2400;;CAN;Summer;E;NAm;;1;0107;2012", utc(2, 12))).toBe(true);
      expect(on("7200;0000-2400;;CAN;Summer;E;NAm;;1;0107;3110[0923]", utc(2, 12))).toBe(false);
      expect(on("7200;0000-2400;;CAN;Summer;E;NAm;;1;0107;3107f", utc(2, 12))).toBe(false);
      expect(on("7200;0000-2400;;CAN;Winter;E;NAm;;1;0110;3103[0923]", utc(2, 12))).toBe(true);
    });

    it("an ordinal day is that weekday of the month, not every one", () => {
      expect(on("7200;0000-2400;1.Sa;D;First;D;Eu;;1;;", utc(7, 12))).toBe(true);
      expect(on("7200;0000-2400;1.Sa;D;First;D;Eu;;1;;", utc(14, 12))).toBe(false);
      expect(on("7200;0000-2400;2.Su;D;Second;D;Eu;;1;;", utc(1, 12))).toBe(false);
      expect(on("7200;0000-2400;2.Su;D;Second;D;Eu;;1;;", utc(8, 12))).toBe(true);
    });

    it("Last7 is the last Sunday of the month", () => {
      expect(on("7200;0000-2400;Last7;D;Last;D;Eu;;1;;", utc(29, 12))).toBe(true);
      expect(on("7200;0000-2400;Last7;D;Last;D;Eu;;1;;", utc(22, 12))).toBe(false);
      expect(on("7200;0000-2400;Last7;D;Last;D;Eu;;1;;", utc(28, 12))).toBe(false);
    });

    it("a date in the days column is that date, inside a wider window", () => {
      const row = "7200;1430-1500;22Nov;D;SM Radio;D;Eu;;6;2810;2211";
      expect(on(row, utc(22, 14, 45))).toBe(true);
      expect(on(row, utc(15, 14, 45))).toBe(false);
    });

    it("a slot past midnight keeps the date it started on", () => {
      const row = "7200;2300-0100;1.Sa;D;Late;D;Eu;;1;;";
      expect(on(row, utc(8, 0, 30))).toBe(true);    // Sunday the 8th, from the 1st Saturday
      expect(on(row, utc(15, 0, 30))).toBe(false);  // Sunday the 15th, from the 2nd
      const closing = "7200;2300-0100;;D;Late;D;Eu;;1;0101;3110";
      expect(on(closing, Date.UTC(2026, 10, 1, 0, 30))).toBe(true);   // started on 31 Oct
      expect(on(closing, Date.UTC(2026, 10, 1, 23, 30))).toBe(false);
    });

    it("an HFCC row outside its dates adds nothing, and its years count", () => {
      const hfcc = (from: string, to: string) => ` 5985 0000 2400 40                             DHA  250 35        0 803 1234567 ${from} ${to} D 16000 Fas        UAE ADM ADM   879`;
      const power = (from: string, to: string, ts: number) =>
        db({ eibi: "5985;0000-2400;;UAE;Dh;E;x;;1;;", aoki: "", hfcc: hfcc(from, to) }).candidates(5_985_000, ts)[0]?.powerKw;
      expect(power("011226", "241226", utc(2, 12))).toBeUndefined();
      expect(power("011126", "241226", utc(2, 12))).toBe(250);
      expect(power("251026", "280327", Date.UTC(2027, 1, 15))).toBe(250);
      expect(power("251026", "280327", Date.UTC(2027, 5, 15))).toBeUndefined();
    });
  });

  it("HFCC alone never adds a station", () => {
    expect(names(5_985_000, utc(2, 3))).toEqual([]);
  });

  it("Aoki alone adds a station, EiBi stays first", () => {
    expect(names(11_955_000, utc(2, 22))).toEqual(["NHK WORLD RADIO JAPAN"]);
    const d = db({ eibi: "11955;2100-0100;;J;Radio Japan;J;x;;1;;" });
    expect(names(11_955_000, utc(2, 22), d)).toEqual(["Radio Japan"]);
  });

  it("enriches: site from EiBi's table, power from Aoki or HFCC, names from the README, distance from home", () => {
    const eibi = "9395;0000-0030;;USA;Blues;E;NAm;o;1;;";
    const [c] = db({ eibi }).candidates(9_395_000, utc(4, 0, 15));
    expect(c).toMatchObject({ station: "Blues", country: "United States of America", language: "English", site: "Okeechobee, FL", powerKw: 100, itu: "USA" });
    expect(c!.lat).toBeCloseTo(27.45, 2);
    expect(c!.distanceKm).toBeGreaterThan(1700);
    expect(c!.distanceKm).toBeLessThan(1900);
  });

  it("a relay's label names the country it transmits from, beside that site", () => {
    const [c] = db({ aoki: "", hfcc: "" }).candidates(9_395_000, utc(2, 11, 45));
    expect(c).toMatchObject({ station: "Radio Slovakia Int.", site: "Okeechobee, FL", itu: "USA", country: "United States of America" });
  });

  it("falls back to Aoki coordinates, then HFCC's site table", () => {
    const [a] = db({ eibi: "9395;0000-0030;;USA;Blues;E;NAm;;1;;" }).candidates(9_395_000, utc(4, 0, 15));
    expect(a!.site).toBe("Okeechobee6");
    expect(a!.lat).toBeCloseTo(27.457, 2);
    const [h] = db({ eibi: "5985;0230-0330;;UAE;Dh;E;x;;1;;", aoki: "" }).candidates(5_985_000, utc(2, 3));
    expect(h!.site).toBe("Dhabayya");
    expect(h!.powerKw).toBe(250);
  });

  describe("enrichment joins the same transmitter, not just the frequency", () => {
    const NHK = AOKI.split("\r\n")[3]!.replace("11955", " 9395").replace("2155-0100", "0000-0030");
    const aoki = [AOKI.split("\r\n")[1], NHK, AOKI.split("\r\n")[2]].join("\r\n");   // NHK is first on 9395

    it("takes power from the row at the named site, not the first on the frequency", () => {
      const [c] = db({ eibi: "9395;0000-0030;;USA;Blues;E;NAm;o;1;;", aoki, hfcc: "" }).candidates(9_395_000, utc(4, 0, 15));
      expect(c).toMatchObject({ site: "Okeechobee, FL", powerKw: 100 });
    });

    it("with no named site, takes the row in the transmitter's country", () => {
      const [c] = db({ eibi: "9395;0000-0030;;USA;Blues;E;NAm;;1;;", aoki, hfcc: "" }).candidates(9_395_000, utc(4, 0, 15));
      expect(c).toMatchObject({ site: "Okeechobee6", powerKw: 100 });
    });

    it("another country's row on the frequency adds nothing", () => {
      const [a] = db({ eibi: "9395;0000-0030;;SVK;Bratislava;E;Eu;;1;;", hfcc: "" }).candidates(9_395_000, utc(4, 0, 15));
      expect(a).not.toHaveProperty("site");
      expect(a).not.toHaveProperty("powerKw");
      const [h] = db({ eibi: "5985;0230-0330;;SVK;Bratislava;E;Eu;;1;;", aoki: "" }).candidates(5_985_000, utc(2, 3));
      expect(h).not.toHaveProperty("site");
      expect(h).not.toHaveProperty("powerKw");
    });

    it("a site's coordinates beat the country code: lists file a territory under its administrator", () => {
      const readme = "IV) Transmitter site codes.\n   GUM: Agat 13N20-144E39\n";
      const hfcc = parseHfcc(" 9395 0000 2400 3,4,9                          AGT  100 355       0 805 1234567 251026 280327 D       EngSpa     USA RMI FCC  1368");
      const d = new ScheduleDb({
        eibi: parseEibi("9395;0000-2400;;GUM;Guam;E;As;;1;;"), readme: parseEibiReadme(readme), aoki: [], hfcc,
        hfccSites: new Map([["AGT", { name: "Agat", lat: 13.34, lon: 144.65 }]]), home,
      });
      expect(d.candidates(9_395_000, utc(2, 12))[0]?.powerKw).toBe(100);
    });
  });

  it("broadcasters rank ahead of utility stations, then the nearest first", () => {
    const eibi = [
      "7435;0000-2400;;KOR;Seoul Meteo Fax;-MF;x;;1;;",
      "7435;0000-2400;;G;Far Broadcast;E;x;;1;;",
      "7435;0000-2400;;USA;Near Broadcast;E;x;o;1;;",
    ].join("\n");
    const readme = "IV) Transmitter site codes.\n   USA: o-Okeechobee 27N27-80W56\n   G: London 51N30-00W07\n   KOR: Seoul 37N34-126E58\n";
    const d = new ScheduleDb({ eibi: parseEibi(eibi), readme: parseEibiReadme(readme), aoki: [], hfcc: [], hfccSites: new Map(), home });
    expect(d.candidates(7_435_000, utc(2, 12)).map((c) => c.station)).toEqual(["Near Broadcast", "Far Broadcast", "Seoul Meteo Fax"]);
  });

  it("utility stations are recognised by mode as well as by language code", () => {
    expect(isUtility({ station: "FUE French Navy USB/FSK", language: "French" })).toBe(true);
    expect(isUtility({ station: "HLL Seoul Meteo Fax", language: "-MF" })).toBe(true);
    expect(isUtility({ station: "Voice of Turkey", language: "Turkish" })).toBe(false);
    const eibi = "3910;0000-2400;;F;FUE French Navy USB/FSK;F;x;;1;;\n3910;0000-2400;;G;Far Broadcast;E;x;;1;;";
    const d = db({ eibi, aoki: "", hfcc: "" });
    expect(d.candidates(3_910_000, utc(2, 12)).map((c) => c.station)).toEqual(["Far Broadcast", "FUE French Navy USB/FSK"]);
  });

  it("an empty database matches nothing", () => {
    const d = new ScheduleDb({ eibi: [], readme: parseEibiReadme(""), aoki: [], hfcc: [], hfccSites: new Map(), home });
    expect(d.candidates(9_395_000, utc(2, 12))).toEqual([]);
  });
});
