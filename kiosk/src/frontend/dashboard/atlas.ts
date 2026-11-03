// What the Atlas draws from the night's log and the current station (spec 2026-11-03-hf-atlas). Pure.
import { greatCircle, robinson, type LatLon } from "./robinson.js";

/** Longest wave to shortest: red through to violet. */
export const HF_BANDS_ORDER = ["120m", "90m", "75m", "60m", "49m", "41m", "31m", "25m", "22m", "19m", "16m", "15m", "13m"] as const;
const LIVE_TEAL = "var(--kc-glass)";
const PATH_SEGMENTS = 120;

export interface AtlasRow { freqHz: number; band: string; peakDb: number; onSpeaker: boolean; lat?: number | null; lon?: number | null; playedTs?: number | null }
/** A station on the speaker that has a place on the map. */
export interface HitKey { hz: number; lat: number; lon: number; band: string }
export type HitChange = "none" | "start" | "end" | "replace";
export interface AtlasDot { x: number; y: number; r: number; opacity: number }
export interface AtlasTrace { key: string; color: string; segments: string[]; level: number }
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

export interface MapPoint { x: number; y: number }

/** The great circle in map units, one run per side of the antimeridian, from the first point to the second. */
export function tracePoints(from: LatLon, to: LatLon): MapPoint[][] {
  const out: MapPoint[][] = [[]];
  let prev: LatLon | null = null;
  for (const p of greatCircle(from, to, PATH_SEGMENTS)) {
    if (prev !== null && Math.abs(p.lon - prev.lon) > 180) out.push([]);
    out.at(-1)!.push(robinson(p.lat, p.lon));
    prev = p;
  }
  return out;
}

export function tracePath(from: LatLon, to: LatLon): string[] {
  return tracePoints(from, to).map((run) => `M${run.map((p) => `${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join("L")}`);
}

/** Steps from full brightness to gone. Small enough that no single step can be seen. */
export const TRACE_STEPS = 12;

/** 0 is full brightness and TRACE_STEPS is gone. */
export function traceLevel(ageMs: number, fadeMs: number): number {
  return Math.min(TRACE_STEPS, Math.max(0, Math.floor((ageMs / fadeMs) * TRACE_STEPS)));
}

export function atlasTraces(rows: readonly AtlasRow[], home: LatLon, live: HitKey | null, now: number, fadeMs: number): AtlasTrace[] {
  const liveKey = live ? `${siteKey(live.lat, live.lon)}|${live.band}` : null;
  const newest = new Map<string, { row: AtlasRow & { lat: number; lon: number }; playedTs: number }>();
  for (const r of rows) {
    if (!r.onSpeaker || !located(r)) continue;
    const key = `${siteKey(r.lat, r.lon)}|${r.band}`;
    if (key === liveKey) continue;
    const playedTs = r.playedTs ?? 0;
    const had = newest.get(key);
    if (!had || playedTs > had.playedTs) newest.set(key, { row: r, playedTs });
  }
  const out: AtlasTrace[] = [];
  for (const [key, { row, playedTs }] of newest) {
    const level = traceLevel(now - playedTs, fadeMs);
    if (level < TRACE_STEPS) out.push({ key, color: bandColor(row.band), segments: tracePath({ lat: row.lat, lon: row.lon }, home), level });
  }
  return out;
}

const TRACE_STROKE = 'fill="none" stroke-width="2.6" stroke-linecap="round"';
const TRACE_AREA = 'x="-100" y="-100" width="2200" height="1300"';

/** Each age fades as one group, so a site heard on seven bands, or the hub at home, stays as faint as a single trace.
 *  Across ages, each dimmer group is cut away under every brighter one, so the brightest wins and nothing adds up. */
export function tracesSvg(traces: readonly AtlasTrace[], opacity: number): string {
  const levels = [...new Set(traces.map((t) => t.level))].sort((a, b) => a - b);
  let brighter = "";
  let out = "";
  for (const level of levels) {
    const ds = traces.filter((t) => t.level === level).flatMap((t) => t.segments.map((d) => ({ d, color: t.color })));
    const faded = Number((opacity * (1 - level / TRACE_STEPS)).toFixed(3));
    const cut = brighter
      ? `<mask id="hfTraceAge${level}" maskUnits="userSpaceOnUse" ${TRACE_AREA}><rect ${TRACE_AREA} fill="#fff"/><g ${TRACE_STROKE} stroke="#000">${brighter}</g></mask>`
      : "";
    const paths = ds.map(({ d, color }) => `<path d="${d}" stroke="${color}"/>`).join("");
    out += `${cut}<g opacity="${faded}" ${TRACE_STROKE}${cut ? ` mask="url(#hfTraceAge${level})"` : ""}>${paths}</g>`;
    brighter += ds.map(({ d }) => `<path d="${d}"/>`).join("");
  }
  return out;
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

export type HitAction = HitChange | "hold";

/** `known` is false until the wall has seen one status since it entered the stage: nothing to animate from. */
export function hitAction(known: boolean, prev: HitKey | null, next: HitKey | null): HitAction {
  if (!known) return next ? "hold" : "none";
  return hitChange(prev, next);
}

const easeInOut = (t: number): number => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

/** stroke-dashoffset steps per path (1 = hidden, 0 = drawn) for one eased line across all of them, in order. */
export function lineKeyframes(lengths: readonly number[], steps: number): number[][] {
  const total = lengths.reduce((a, b) => a + b, 0);
  let start = 0;
  return lengths.map((len) => {
    const from = start;
    start += len;
    return Array.from({ length: steps + 1 }, (_, k) => {
      const done = easeInOut(k / steps) * total;
      return 1 - Math.max(0, Math.min(1, (done - from) / len));
    });
  });
}

const PULSE_OPACITY = 0.9;
const PULSE_FADE = 0.08;   // of the trip, at each end

/** Keyframes for a dot travelling the path: transform and opacity only, so the compositor can run it alone. */
export function pulseFrames(runs: readonly MapPoint[][], toPx: (p: MapPoint) => MapPoint): Array<{ offset: number; opacity: number; transform: string }> {
  const seglen = (run: readonly MapPoint[], i: number): number => Math.hypot(run[i]!.x - run[i - 1]!.x, run[i]!.y - run[i - 1]!.y);
  const total = runs.reduce((sum, run) => sum + run.slice(1).reduce((n, _, i) => n + seglen(run, i + 1), 0), 0) || 1;
  const frames: Array<{ offset: number; opacity: number; transform: string }> = [];
  let done = 0;
  runs.forEach((run, r) => {
    run.forEach((p, i) => {
      if (i > 0) done += seglen(run, i);
      const offset = Math.min(1, done / total);
      const atJump = (r > 0 && i === 0) || (r < runs.length - 1 && i === run.length - 1);
      const opacity = atJump ? 0 : PULSE_OPACITY * Math.min(1, offset / PULSE_FADE, (1 - offset) / PULSE_FADE);
      const px = toPx(p);
      frames.push({ offset, opacity, transform: `translate(${px.x.toFixed(1)}px,${px.y.toFixed(1)}px)` });
    });
  });
  return frames;
}
