// Pure transmission + smoke lifecycle for Weather Glass, event-paced
// (specs 2026-10-02 event pacing + glass smoke). key-up → eased grow → STILL
// hold (brightness follows the audible channel's signal, quantised and
// rate-limited) → release dissolves the rim over RELEASE_MS and births a
// smoke PUFF. A puff drifts downwind with the current wind (a wind change
// turns it where it is, so a plume bends), stretches,
// and dims over smokeLifeMs, sampled on ONE shared smokeStepMs tick so any
// number of puffs costs one redraw per tick. A release within puffMergeMs of
// the site's newest puff re-feeds it (birth kept), so a hot site streams a
// trail. Every frame says how it will change (continuous / nextChangeAt).
import {
  MAX_FRONTS, MAX_PUFFS, easeOutCubic, fadeProgress,
  type Rgb, type Front, type Puff, type GlassFrame,
} from "./glassMath.js";
import type { Wind } from "../lib/wind.js";

export interface GlassSite { key: string; lat: number; lng: number; color: Rgb }
export interface GlassTimings {
  growMs: number; releaseMs: number; ttlMs: number;
  /** Max held-rim brightness steps per second (display.glass.holdFps). */
  holdFps: number;
  /** Brightness levels for a held rim (display.glass.signalSteps). */
  signalSteps: number;
  /** A puff's life (display.glass.smokeLifeMs). */
  smokeLifeMs: number;
  /** The shared smoke tick (display.glass.smokeStepMs). */
  smokeStepMs: number;
  /** Drift over a full life per mph, px at 1080 tall (display.glass.smokePxPerMph). */
  smokePxPerMph: number;
  /** A release within this of the site's newest puff's birth re-feeds it. */
  puffMergeMs: number;
}

export const RELEASE_MS = 1500;
// Rim brightness window for the audible channel's `signal` telemetry.
export const SIGNAL_FLOOR_DBFS = -45;
export const SIGNAL_CEIL_DBFS = -10;
export const MIN_BRIGHT = 0.15;
export const DEFAULT_BRIGHT = 0.6;   // open channels without signal telemetry

/** Afterglow weight by hits in the window — the old blip ramp's 1..6 cap. */
export function rampStrength(hits: number): number {
  return 0.5 + (0.5 * Math.min(Math.max(hits, 0), 6)) / 6;
}

/** dBFS → one of `steps` brightness levels over the window, floored at MIN_BRIGHT. */
export function signalLevel(dbfs: number, steps: number): number {
  const k = Math.min(1, Math.max(0, (dbfs - SIGNAL_FLOOR_DBFS) / (SIGNAL_CEIL_DBFS - SIGNAL_FLOOR_DBFS)));
  const n = Math.max(1, steps - 1);
  return Math.max(MIN_BRIGHT, Math.round(k * n) / n);
}

/** Puffs step on ONE absolute grid: every puff changes on the same tick, so
 *  N puffs cost one redraw per tick, not N. The latest tick at or before `now`. */
export function gridTick(now: number, stepMs: number): number {
  return Math.floor(now / stepMs) * stepMs;
}

/** The first grid tick strictly after `now` (float guard included). */
function nextTick(now: number, stepMs: number): number {
  let t = gridTick(now, stepMs) + stepMs;
  while (t <= now) t += stepMs;
  return t;
}

/** A puff's shape at life fraction k: radius multipliers and dim. Calm air
 *  spreads evenly; wind stretches along more than across. */
export function puffShape(k: number, windy: boolean): { along: number; cross: number; dim: number } {
  const c = Math.min(1, Math.max(0, k));
  const dim = (1 - c) * (1 - c);
  if (!windy) { const r = 1 + 1.2 * Math.sqrt(c); return { along: r, cross: r, dim }; }
  return { along: 1 + 1.6 * c, cross: 1 + 0.8 * Math.sqrt(c), dim };
}

/** Stable 0..1 seed per puff (FNV-1a of key@born). */
export function puffSeed(key: string, born: number): number {
  const s = `${key}@${born}`;
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) / 4294967296;
}

/** Downwind unit vector [east, north] for a compass "toward" bearing. */
export function windDir(towardDeg: number): [number, number] {
  const r = (towardDeg * Math.PI) / 180;
  return [Math.sin(r), Math.cos(r)];
}

interface LiveFront {
  id: string; site: GlassSite; radiusM: number; born: number; until: number;
  bright: number; brightAt: number; pending: number | null; releasedAt: number | null;
}
// A puff drifts in legs: `off` is where earlier winds already carried it, and
// the current `wind` has carried it on since `legAt`. A wind change banks the
// leg so live smoke turns where it is instead of jumping.
interface LivePuff {
  site: GlassSite; radiusM: number; born: number; strength0: number; seed: number;
  wind: Wind | null; legAt: number; off: [number, number]; heading: [number, number] | null;
}
interface SiteState { hits: number }

export class GlassState {
  private readonly fronts = new Map<string, LiveFront>();
  private readonly sites = new Map<string, SiteState>();
  private readonly puffs: LivePuff[] = [];
  private wind: Wind | null = null;
  private readonly gapMs: number;

  constructor(private readonly t: GlassTimings) {
    this.gapMs = 1000 / Math.max(1, t.holdFps);
  }

  keyUp(id: string, site: GlassSite, radiusM: number, now: number): void {
    const existing = this.fronts.get(id);
    if (existing && existing.releasedAt === null) { existing.until = now + this.t.ttlMs; return; }
    this.fronts.set(id, {
      id, site, radiusM, born: now, until: now + this.t.ttlMs,
      bright: DEFAULT_BRIGHT, brightAt: -Infinity, pending: null, releasedAt: null,
    });
    const s = this.sites.get(site.key);
    if (s) s.hits++;
    else this.sites.set(site.key, { hits: 1 });
    if (this.fronts.size > MAX_FRONTS) {
      const oldest = [...this.fronts.values()].sort((a, b) => a.born - b.born)[0];
      if (oldest) this.fronts.delete(oldest.id);
    }
  }

  rearm(id: string, now: number): void {
    const f = this.fronts.get(id);
    if (f && f.releasedAt === null) f.until = now + this.t.ttlMs;
  }

  /** When the scene needs a redraw for this signal (review I2): `now` when
   *  the visible brightness changed now; the holdFps window's end when the
   *  change is parked (frame() applies it then); null when nothing changes. */
  signal(id: string, dbfs: number, now: number): number | null {
    const f = this.fronts.get(id);
    if (!f || f.releasedAt !== null) return null;
    const lvl = signalLevel(dbfs, this.t.signalSteps);
    if (lvl === f.bright) { f.pending = null; return null; }
    if (now - f.brightAt >= this.gapMs) {
      f.bright = lvl; f.brightAt = now; f.pending = null;
      return now;
    }
    f.pending = lvl;
    return f.brightAt + this.gapMs;
  }

  release(id: string, now: number): void {
    const f = this.fronts.get(id);
    if (!f || f.releasedAt !== null) return;
    f.releasedAt = now;
    f.pending = null;
    this.birth(f.site, f.radiusM, now);
  }

  releaseAll(now: number): void {
    for (const id of this.fronts.keys()) this.release(id, now);
  }

  /** The current wind (lib/wind.ts); 0 mph counts as calm. Live puffs bank
   *  their drift at the current tick and carry on with the new wind. */
  setWind(w: Wind | null, now: number): void {
    this.wind = w && w.mph > 0 ? w : null;
    const tick = gridTick(now, this.t.smokeStepMs);
    for (const p of this.puffs) {
      const [e, n] = this.legDrift(p, tick);
      p.off = [p.off[0] + e, p.off[1] + n];
      p.legAt = Math.max(p.legAt, tick);
      p.wind = this.wind;
      if (this.wind) p.heading = windDir(this.wind.towardDeg);
    }
  }

  /** Drift along the current leg at `tick`, px at 1080 tall. */
  private legDrift(p: LivePuff, tick: number): [number, number] {
    const w = p.wind;
    if (!w) return [0, 0];
    const d = (Math.max(0, tick - p.legAt) / this.t.smokeLifeMs) * this.t.smokePxPerMph * w.mph;
    const [e, n] = windDir(w.towardDeg);
    return [e * d, n * d];
  }

  /** History backfill: a puff born at the row's real ts, already part-aged. */
  seedPuff(site: GlassSite, radiusM: number, ts: number, now: number): void {
    if (now - ts >= this.t.smokeLifeMs) return;
    const s = this.sites.get(site.key);
    if (s) s.hits++;
    else this.sites.set(site.key, { hits: 1 });
    this.birth(site, radiusM, ts);
  }

  /** Seed a history backfill. /api/history returns rows newest-first, but a
   *  release only merges into its site's NEWEST puff, so rows must be replayed
   *  oldest-first or a busy site seeds ~2× the puffs with its hit ramp
   *  reversed (final review I1). `radiusFor(key, hits)` is asked after the
   *  hit is counted, like a live key-up. */
  seedPuffs(rows: readonly { site: GlassSite; ts: number }[], now: number, radiusFor: (key: string, hits: number) => number): void {
    for (const r of [...rows].sort((a, b) => a.ts - b.ts)) {
      this.seedPuff(r.site, radiusFor(r.site.key, this.hits(r.site.key) + 1), r.ts, now);
    }
  }

  private birth(site: GlassSite, radiusM: number, at: number): void {
    const strength0 = rampStrength(this.sites.get(site.key)?.hits ?? 1);
    let newest: LivePuff | undefined;
    for (const p of this.puffs) if (p.site.key === site.key && (!newest || p.born > newest.born)) newest = p;
    if (newest && Math.abs(at - newest.born) < this.t.puffMergeMs) {
      // Re-feed: thicker, birth KEPT — restarting the age would pin a hot
      // site's smoke at the source forever (no trail).
      newest.strength0 = strength0; newest.radiusM = radiusM; newest.site = site;
      return;
    }
    const w = this.wind;
    this.puffs.push({
      site, radiusM, born: at, strength0, seed: puffSeed(site.key, at),
      wind: w, legAt: at, off: [0, 0], heading: w ? windDir(w.towardDeg) : null,
    });
    if (this.puffs.length > MAX_PUFFS) this.dropWeakest(at);
  }

  private dropWeakest(at: number): void {
    let wi = 0, ws = Infinity;
    this.puffs.forEach((p, i) => {
      const v = p.strength0 * puffShape((at - p.born) / this.t.smokeLifeMs, p.heading !== null).dim;
      if (v < ws) { ws = v; wi = i; }
    });
    this.puffs.splice(wi, 1);
  }

  hits(key: string): number {
    return this.sites.get(key)?.hits ?? 0;
  }

  /** Open (unreleased) transmissions. */
  liveCount(): number {
    let n = 0;
    for (const f of this.fronts.values()) if (f.releasedAt === null) n++;
    return n;
  }

  frame(now: number): GlassFrame {
    const fronts: Front[] = [];
    let growing = false, continuous = false;
    let next = Infinity;
    for (const f of [...this.fronts.values()]) {
      if (f.releasedAt === null && now >= f.until) this.release(f.id, f.until);   // a missed release
      if (f.pending !== null && now >= f.brightAt + this.gapMs) {
        f.bright = f.pending; f.brightAt = now; f.pending = null;
      }
      const releasing = f.releasedAt === null ? 0 : fadeProgress(f.releasedAt, now, this.t.releaseMs);
      if (releasing >= 1) { this.fronts.delete(f.id); continue; }
      const p = fadeProgress(f.born, now, this.t.growMs);
      if (p < 1) { growing = true; continuous = true; }
      if (f.releasedAt !== null) continuous = true;                       // dissolving
      if (f.releasedAt === null) {
        next = Math.min(next, f.until);
        if (f.pending !== null) next = Math.min(next, f.brightAt + this.gapMs);
      }
      fronts.push({
        id: f.id, key: f.site.key, lat: f.site.lat, lng: f.site.lng, radiusM: f.radiusM, color: f.site.color,
        ageMs: now - f.born, grow: easeOutCubic(p), bright: f.bright, releasing,
      });
    }
    const life = this.t.smokeLifeMs, stepMs = this.t.smokeStepMs;
    const tick = gridTick(now, stepMs);
    const puffs: Puff[] = [];
    for (let i = this.puffs.length - 1; i >= 0; i--) {
      const p = this.puffs[i]!;
      const k = Math.max(0, tick - p.born) / life;
      if (k >= 1) { this.puffs.splice(i, 1); continue; }
      const sh = puffShape(k, p.heading !== null);
      const [e, n] = this.legDrift(p, tick);
      puffs.push({
        key: p.site.key, lat: p.site.lat, lng: p.site.lng, radiusM: p.radiusM, color: p.site.color,
        strength: p.strength0 * sh.dim,
        dir: p.heading ?? [0, 0],
        drift: [p.off[0] + e, p.off[1] + n],
        along: sh.along, cross: sh.cross, seed: p.seed,
      });
    }
    const alive = new Set<string>([...this.fronts.values()].map((f) => f.site.key));
    for (const p of this.puffs) alive.add(p.site.key);
    for (const key of [...this.sites.keys()]) if (!alive.has(key)) this.sites.delete(key);   // window over: hits reset
    if (this.puffs.length) next = Math.min(next, nextTick(now, stepMs));
    puffs.sort((a, b) => b.strength - a.strength);
    return {
      fronts, puffs, step: Math.round(tick / stepMs), growing, continuous,
      nextChangeAt: Number.isFinite(next) ? next : null,
    };
  }
}
