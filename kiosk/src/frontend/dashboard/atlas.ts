// What the Atlas draws from the night's log and the current station (spec 2026-11-03-hf-atlas). Pure.
import { greatCircle, robinson, type LatLon } from "./robinson.js";

/** Longest wave to shortest: red through to violet. */
export const HF_BANDS_ORDER = ["120m", "90m", "75m", "60m", "49m", "41m", "31m", "25m", "22m", "19m", "16m", "15m", "13m"] as const;
const LIVE_TEAL = "var(--kc-glass)";
const PATH_SEGMENTS = 120;

export interface AtlasRow { freqHz: number; band: string; peakDb: number; onSpeaker: boolean; lat?: number | null; lon?: number | null }
/** A station on the speaker that has a place on the map. */
export interface HitKey { hz: number; lat: number; lon: number; band: string }
export type HitChange = "none" | "start" | "end" | "replace";
export interface AtlasDot { x: number; y: number; r: number; opacity: number }
export interface AtlasTrace { key: string; color: string; segments: string[] }
export interface LegendEntry { label: string; color: string; lit: boolean; live: boolean }

export function bandColor(band: string | null): string {
  const i = HF_BANDS_ORDER.indexOf(band as typeof HF_BANDS_ORDER[number]);
  return i < 0 ? LIVE_TEAL : `oklch(.8 .14 ${20 + 23 * i})`;
}

const siteKey = (lat: number, lon: number): string => `${lat.toFixed(2)},${lon.toFixed(2)}`;

function located<T extends { lat?: number | null; lon?: number | null }>(r: T): r is T & { lat: number; lon: number } {
  return typeof r.lat === "number" && typeof r.lon === "number";
}

export function atlasDots(rows: readonly AtlasRow[]): AtlasDot[] {
  const best = new Map<string, { lat: number; lon: number; db: number }>();
  for (const r of rows) {
    if (!located(r)) continue;
    const k = siteKey(r.lat, r.lon);
    const had = best.get(k);
    if (!had || r.peakDb > had.db) best.set(k, { lat: r.lat, lon: r.lon, db: r.peakDb });
  }
  return [...best.values()].map((s) => {
    const { x, y } = robinson(s.lat, s.lon);
    const db = Math.min(s.db, 50);
    return { x, y, r: 3 + db / 12, opacity: 0.25 + db / 90 };
  });
}

/** One SVG path per side of the antimeridian, from the first point to the second. */
export function tracePath(from: LatLon, to: LatLon): string[] {
  const out: string[] = [];
  let d = "";
  let prev: LatLon | null = null;
  for (const p of greatCircle(from, to, PATH_SEGMENTS)) {
    if (prev !== null && Math.abs(p.lon - prev.lon) > 180) { out.push(d); d = ""; }
    const { x, y } = robinson(p.lat, p.lon);
    d += `${d ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`;
    prev = p;
  }
  out.push(d);
  return out;
}

export function atlasTraces(rows: readonly AtlasRow[], home: LatLon, live: HitKey | null): AtlasTrace[] {
  const liveKey = live ? `${siteKey(live.lat, live.lon)}|${live.band}` : null;
  const out = new Map<string, AtlasTrace>();
  for (const r of rows) {
    if (!r.onSpeaker || !located(r)) continue;
    const key = `${siteKey(r.lat, r.lon)}|${r.band}`;
    if (key === liveKey || out.has(key)) continue;
    out.set(key, { key, color: bandColor(r.band), segments: tracePath({ lat: r.lat, lon: r.lon }, home) });
  }
  return [...out.values()];
}

export function legend(rows: readonly AtlasRow[], liveBand: string | null): LegendEntry[] {
  const traced = new Set(rows.filter((r) => r.onSpeaker && located(r)).map((r) => r.band));
  return HF_BANDS_ORDER.map((b) => ({ label: b.slice(0, -1), color: bandColor(b), lit: traced.has(b), live: b === liveBand }));
}

export function hitChange(prev: HitKey | null, next: HitKey | null): HitChange {
  if (!prev) return next ? "start" : "none";
  if (!next) return "end";
  return prev.hz === next.hz && prev.lat === next.lat && prev.lon === next.lon ? "none" : "replace";
}
