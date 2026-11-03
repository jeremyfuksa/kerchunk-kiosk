// Who may be on a frequency right now (spec 2026-11-02-hf-mode). EiBi and Aoki decide; HFCC lines are
// registrations, so they only enrich. Everything here is a likely name, never a confirmed one.
import type { Candidate } from "./receptionLog.js";

const ALL_DAYS = 0b1111111;   // bit 0 = Sunday
const DAY = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
const JOIN_KHZ = 0.6;         // a schedule line is the same broadcast within this
const RASTER_KHZ = 2.5;       // survey carriers are snapped to a 5 kHz raster

interface Slot { khz: number; start: number; end: number; days: number }
export interface EibiRow extends Slot {
  station: string; itu: string; language: string; hostItu: string; siteCode: string;
  from?: number; to?: number;   // month*100+day, persistence-6 rows
}
export interface AokiRow extends Slot { station: string; language: string; powerKw?: number; site: string; itu: string; lat?: number; lon?: number }
export interface HfccRow extends Slot { siteCode: string; powerKw?: number; itu: string }
export interface Site { name: string; lat: number; lon: number }
export interface EibiReadme { languages: Map<string, string>; countries: Map<string, string>; sites: Map<string, Site> }

const lastSunday = (y: number, m: number): number => {
  const d = new Date(Date.UTC(y, m + 1, 0));
  return Date.UTC(y, m, d.getUTCDate() - d.getUTCDay());
};

/** "b26" for the broadcast season containing this date. Winter keeps the year it started in. */
export function seasonCode(d: Date): string {
  const y = d.getUTCFullYear();
  const t = d.getTime();
  const code = (s: string, yr: number) => `${s}${String(yr % 100).padStart(2, "0")}`;
  if (t < lastSunday(y, 2)) return code("b", y - 1);
  return t < lastSunday(y, 9) ? code("a", y) : code("b", y);
}

const hhmm = (s: string): number => Number(s.slice(0, 2)) * 60 + Number(s.slice(2, 4));

function eibiDays(raw: string): number {
  const s = raw.trim();
  if (!s) return ALL_DAYS;
  if (/^[1-7]+$/.test(s)) {   // EiBi's digits start on Monday
    let m = 0;
    for (const c of s) m |= 1 << (Number(c) % 7);
    return m;
  }
  const range = /^(Mo|Tu|We|Th|Fr|Sa|Su)-(Mo|Tu|We|Th|Fr|Sa|Su)$/.exec(s);
  if (range) {
    let m = 0;
    for (let d = DAY.indexOf(range[1]!); ; d = (d + 1) % 7) {
      m |= 1 << d;
      if (d === DAY.indexOf(range[2]!)) return m;
    }
  }
  // Mo,We / SaSu / 1.Sa / 1WeFr: every weekday named. Flags (irr, alt, 15Sep) name none: any day.
  let m = 0;
  for (const name of s.match(/Mo|Tu|We|Th|Fr|Sa|Su/g) ?? []) m |= 1 << DAY.indexOf(name);
  return m || ALL_DAYS;
}

export function parseEibi(csv: string): EibiRow[] {
  const out: EibiRow[] = [];
  for (const line of csv.split(/\r?\n/)) {
    if (!/^\d/.test(line)) continue;
    const f = line.split(";");
    const time = /^(\d{4})-(\d{4})$/.exec((f[1] ?? "").trim());
    const persistence = Number(f[8] ?? 0);
    if (!time || persistence === 8 || persistence >= 90) continue;
    const site = /^\/([A-Z]+)(?:-(\S+))?$/.exec((f[7] ?? "").trim());
    const dated = persistence === 6 && /^\d{4}$/.test(f[9] ?? "") && /^\d{4}$/.test(f[10] ?? "");
    const ddmm = (v: string) => Number(v.slice(2, 4)) * 100 + Number(v.slice(0, 2));
    out.push({
      khz: Number(f[0]), start: hhmm(time[1]!), end: hhmm(time[2]!), days: eibiDays(f[2] ?? ""),
      station: (f[4] ?? "").trim(), itu: (f[3] ?? "").trim(), language: (f[5] ?? "").trim(),
      hostItu: site ? site[1]! : (f[3] ?? "").trim(), siteCode: site ? site[2] ?? "" : (f[7] ?? "").trim(),
      ...(dated ? { from: ddmm(f[9]!), to: ddmm(f[10]!) } : {}),
    });
  }
  return out;
}

/** 38N48'39" or 27N27. */
function coord(deg: string, hemi: string, min: string, sec?: string): number {
  const v = Number(deg) + Number(min) / 60 + Number(sec ?? 0) / 3600;
  return hemi === "S" || hemi === "W" ? -v : v;
}
const COORDS = /(\d{1,3})([NS])(\d{2})(?:'(\d{2})")?-(\d{1,3})([EW])(\d{2})(?:'(\d{2})")?/;

export function parseEibiReadme(text: string): EibiReadme {
  const languages = new Map<string, string>();
  const countries = new Map<string, string>();
  const sites = new Map<string, Site>();
  let section = "";
  let itu = "";
  const addSite = (code: string, body: string): void => {
    const m = COORDS.exec(body);
    if (!m) return;
    sites.set(`${itu}-${code}`, {
      name: body.slice(0, m.index).trim().replace(/[,:]$/, ""),
      lat: coord(m[1]!, m[2]!, m[3]!, m[4]), lon: coord(m[5]!, m[6]!, m[7]!, m[8]),
    });
  };
  for (const raw of text.split(/\r?\n/)) {
    const head = /^\s*(I|II|III|IV|V|VI)\)\s/.exec(raw);
    if (head) { section = head[1]!; continue; }
    if (section === "I" || section === "II") {
      const m = /^\s*([A-Za-z]{1,4})\s{2,}(.+?)\s*$/.exec(raw);
      if (!m) continue;
      if (section === "I") languages.set(m[1]!, m[2]!.split(/[:(]/)[0]!.trim());
      else countries.set(m[1]!, m[2]!.trim());
    } else if (section === "IV") {
      let line = raw.trim();
      const country = /^([A-Z]{1,3}):\s*(.*)$/.exec(line);
      if (country) { itu = country[1]!; line = country[2]!; }
      if (!itu || !line) continue;
      const coded = /^([a-z0-9]{1,3})-(.+)$/.exec(line);
      if (coded) addSite(coded[1]!, coded[2]!);
      else addSite("", line);
    }
  }
  return { languages, countries, sites };
}

function aokiCoords(s: string): { lat: number; lon: number } | null {
  const m = /^(\d{2})(\d{2})(\d{2})([NS])(\d{3})(\d{2})(\d{2})([EW])/.exec(s);
  return m ? { lat: coord(m[1]!, m[4]!, m[2]!, m[3]), lon: coord(m[5]!, m[8]!, m[6]!, m[7]) } : null;
}

function aokiDays(field: string): number {
  let m = 0;
  for (const c of field) if (/[1-7]/.test(c)) m |= 1 << (Number(c) - 1);   // Aoki's day 1 is Sunday
  return m || ALL_DAYS;
}

export function parseAoki(text: string): AokiRow[] {
  const lines = text.split(/\r?\n/);
  const header = lines.findIndex((l) => l.startsWith("FRE"));
  if (header < 0) return [];
  const h = lines[header]!;
  const at = (name: string) => h.indexOf(name);
  const [station, utc, days, lang, pow, azi, loc, adm, ll, rem] =
    [at("STATION"), at("UTC"), at("Su-W-Sa"), at("Language"), at("Pow"), at("Azi"), at("Location"), at("ADM"), at("L/L"), at("Remark")] as [number, number, number, number, number, number, number, number, number, number];
  const out: AokiRow[] = [];
  for (const l of lines.slice(header + 1)) {
    const khz = Number(l.slice(0, station).replace("*", ""));
    const time = /^(\d{4})-(\d{4})/.exec(l.slice(utc, days));
    if (!khz || !time) continue;
    const c = aokiCoords(l.slice(ll, rem).trim());
    const kw = Number(l.slice(pow - 3, azi).trim());
    out.push({
      khz, start: hhmm(time[1]!), end: hhmm(time[2]!), days: aokiDays(l.slice(days, lang)),
      station: l.slice(station, utc).trim(), language: l.slice(lang, pow - 3).trim().replace(/\/$/, ""),
      ...(kw > 0 ? { powerKw: kw } : {}), site: l.slice(loc, adm).trim(), itu: l.slice(adm, ll).trim(), ...(c ?? {}),
    });
  }
  return out;
}

export function parseHfcc(text: string): HfccRow[] {
  const out: HfccRow[] = [];
  for (const l of text.split(/\r?\n/)) {
    if (l.startsWith(";") || l[94] !== "D") continue;   // D = AM
    const khz = Number(l.slice(0, 5));
    if (!khz) continue;
    const kw = Number(l.slice(51, 55));
    out.push({
      khz, start: hhmm(l.slice(6, 10)), end: hhmm(l.slice(11, 15)), days: aokiDays(l.slice(72, 79)),
      siteCode: l.slice(47, 50).trim(), ...(kw > 0 ? { powerKw: kw } : {}), itu: l.slice(113, 116).trim(),
    });
  }
  return out;
}

export function parseHfccSites(text: string): Map<string, Site> {
  const out = new Map<string, Site>();
  for (const l of text.split(/\r?\n/)) {
    if (l.startsWith(";")) continue;
    const lat = /^(\d{2})([NS])(\d{2})$/.exec(l.slice(39, 44));
    const lon = /^(\d{3})([EW])(\d{2})$/.exec(l.slice(45, 51));
    if (!lat || !lon) continue;
    out.set(l.slice(0, 3).trim(), { name: l.slice(4, 34).trim(), lat: coord(lat[1]!, lat[2]!, lat[3]!), lon: coord(lon[1]!, lon[2]!, lon[3]!) });
  }
  return out;
}

function distanceKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const r = Math.PI / 180;
  const h = Math.sin(((b.lat - a.lat) * r) / 2) ** 2
    + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(((b.lon - a.lon) * r) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

/** Is the slot on air? A slot past midnight belongs to the day it started. */
function onAir(s: Slot, minute: number, dow: number): boolean {
  const today = (s.days >> dow) & 1;
  const yesterday = (s.days >> ((dow + 6) % 7)) & 1;
  if (s.end > s.start) return !!today && minute >= s.start && minute < s.end;
  if (s.end === s.start) return !!today;
  return (!!today && minute >= s.start) || (!!yesterday && minute < s.end);
}

/** Not a broadcast: EiBi marks these with a "-" language or names the mode in the station. */
export function isUtility(c: { station: string; language?: string }): boolean {
  return !!c.language?.startsWith("-") || /\b(USB|LSB|FSK|CW|RTTY|Fax|Meteo|Volmet|DGPS|STANAG)\b/i.test(c.station);
}

export interface ScheduleData {
  eibi: EibiRow[]; readme: EibiReadme; aoki: AokiRow[]; hfcc: HfccRow[]; hfccSites: Map<string, Site>;
  home: { lat: number; lon: number };
}

function byKhz<T extends Slot>(rows: readonly T[]): Map<number, T[]> {
  const m = new Map<number, T[]>();
  for (const r of rows) {
    const k = Math.round(r.khz);
    const list = m.get(k);
    if (list) list.push(r); else m.set(k, [r]);
  }
  return m;
}

export class ScheduleDb {
  private readonly eibi: Map<number, EibiRow[]>;
  private readonly aoki: Map<number, AokiRow[]>;
  private readonly hfcc: Map<number, HfccRow[]>;

  constructor(private readonly data: ScheduleData) {
    this.eibi = byKhz(data.eibi);
    this.aoki = byKhz(data.aoki);
    this.hfcc = byKhz(data.hfcc);
  }

  private near<T extends Slot>(index: Map<number, T[]>, khz: number, span: number, minute: number, dow: number): T[] {
    const out: T[] = [];
    for (let k = Math.floor(khz - span); k <= Math.ceil(khz + span); k++) {
      for (const r of index.get(k) ?? []) {
        if (Math.abs(r.khz - khz) <= span && onAir(r, minute, dow)) out.push(r);
      }
    }
    return out;
  }

  /** Likely stations for a surveyed carrier, likeliest first. */
  candidates(hz: number, ts: number): Candidate[] {
    const d = new Date(ts);
    const minute = d.getUTCHours() * 60 + d.getUTCMinutes();
    const dow = d.getUTCDay();
    const today = (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
    const khz = hz / 1000;
    const { readme, hfccSites } = this.data;
    const eibi = this.near(this.eibi, khz, RASTER_KHZ, minute, dow).filter((r) =>
      r.from === undefined || r.to === undefined
      || (r.from <= r.to ? today >= r.from && today <= r.to : today >= r.from || today <= r.to));
    const out = new Map<string, Candidate>();
    for (const r of eibi) {
      if (out.has(r.station)) continue;
      const aoki = this.near(this.aoki, r.khz, JOIN_KHZ, minute, dow)[0];
      const hfcc = this.near(this.hfcc, r.khz, JOIN_KHZ, minute, dow)[0];
      const named = readme.sites.get(`${r.hostItu}-${r.siteCode}`) ?? (r.hostItu !== r.itu || r.siteCode ? undefined : readme.sites.get(`${r.itu}-`));
      const hfccSite = hfcc ? hfccSites.get(hfcc.siteCode) : undefined;
      const place = named
        ?? (aoki?.lat !== undefined && aoki.lon !== undefined ? { name: aoki.site, lat: aoki.lat, lon: aoki.lon } : undefined)
        ?? hfccSite;
      const power = aoki?.powerKw ?? hfcc?.powerKw;
      out.set(r.station, this.finish({
        station: r.station, itu: r.hostItu, country: readme.countries.get(r.itu) ?? r.itu,
        language: readme.languages.get(r.language) ?? r.language,
        ...(power !== undefined ? { powerKw: power } : {}),
      }, place));
    }
    for (const r of this.near(this.aoki, khz, RASTER_KHZ, minute, dow)) {
      // Aoki names a station only where EiBi has nothing on this slot.
      if (eibi.length > 0 || out.has(r.station)) continue;
      out.set(r.station, this.finish({
        station: r.station, itu: r.itu, country: readme.countries.get(r.itu) ?? r.itu, language: r.language,
        ...(r.powerKw !== undefined ? { powerKw: r.powerKw } : {}),
      }, r.lat !== undefined && r.lon !== undefined ? { name: r.site, lat: r.lat, lon: r.lon } : undefined));
    }
    const rank = (c: Candidate): number => (isUtility(c) ? 1 : 0);
    return [...out.values()].sort((a, b) => rank(a) - rank(b) || (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity));
  }

  private finish(c: Candidate, place: Site | undefined): Candidate {
    return place
      ? { ...c, site: place.name, lat: place.lat, lon: place.lon, distanceKm: Math.round(distanceKm(this.data.home, place)) }
      : c;
  }
}
