// GOES-R GLM object keys on NOAA's public S3 buckets:
//   GLM-L2-LCFA/<yyyy>/<ddd>/<hh>/OR_GLM-L2-LCFA_G19_s<yyyydddhhmmsst>_e<…>_c<…>.nc
// Keys sort lexicographically in time order within the product, which is what
// lets the feed list with start-after instead of tracking a seen-set.
export const GLM_PRODUCT = "GLM-L2-LCFA";

const pad = (n: number, w: number): string => String(n).padStart(w, "0");
const DAY_MS = 86_400_000, HOUR_MS = 3_600_000;

function dayOfYear(d: Date): number {
  return Math.floor((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - Date.UTC(d.getUTCFullYear(), 0, 1)) / DAY_MS) + 1;
}

/** yyyydddhhmmss + tenths, the format inside _s/_e/_c. */
export function stamp(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}${pad(dayOfYear(d), 3)}${pad(d.getUTCHours(), 2)}${pad(d.getUTCMinutes(), 2)}`
    + `${pad(d.getUTCSeconds(), 2)}${Math.floor(d.getUTCMilliseconds() / 100)}`;
}

export function hourPrefix(ms: number): string {
  const d = new Date(ms);
  return `${GLM_PRODUCT}/${d.getUTCFullYear()}/${pad(dayOfYear(d), 3)}/${pad(d.getUTCHours(), 2)}/`;
}

/** Hour prefixes covering [from, to], oldest first. */
export function hourPrefixes(from: number, to: number): string[] {
  const out: string[] = [];
  for (let h = Math.floor(from / HOUR_MS) * HOUR_MS; h <= to; h += HOUR_MS) out.push(hourPrefix(h));
  return out;
}

/** A key prefix that sorts just before any file starting at/after `ms`. */
export function keyFloor(ms: number, sat: number): string {
  return `${hourPrefix(ms)}OR_${GLM_PRODUCT}_G${sat}_s${stamp(ms)}`;
}

const STAMPS = /_s(\d{4})(\d{3})(\d{2})(\d{2})(\d{2})(\d)_e(\d{4})(\d{3})(\d{2})(\d{2})(\d{2})(\d)_/;
const toMs = (p: string[]): number =>
  Date.UTC(Number(p[0]), 0, 1) + (Number(p[1]) - 1) * DAY_MS + Number(p[2]) * HOUR_MS
  + Number(p[3]) * 60_000 + Number(p[4]) * 1000 + Number(p[5]) * 100;

export function keyTimes(key: string): { start: number; end: number } | null {
  const m = STAMPS.exec(key);
  if (!m) return null;
  const g = m.slice(1);
  return { start: toMs(g.slice(0, 6)), end: toMs(g.slice(6, 12)) };
}

const unxml = (s: string): string => s.replace(/&quot;/g, "\"").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/** S3 ListObjectsV2 XML → keys + continuation token (null when complete). */
export function parseListing(xml: string): { keys: string[]; next: string | null } {
  const keys = [...xml.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => unxml(m[1]!));
  const tok = /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(xml)?.[1];
  const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
  return { keys, next: truncated && tok ? unxml(tok) : null };
}
