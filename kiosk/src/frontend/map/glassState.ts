// Pure transmission/afterglow lifecycle for Weather Glass, event-paced
// (spec 2026-10-02). key-up → eased grow → STILL hold (brightness follows the
// audible channel's signal, quantised + rate-limited) → release dissolves the
// rim over RELEASE_MS while the site's afterglow fades in fadeSteps steps.
// Every frame also says how it will change (continuous / nextChangeAt) so the
// layer redraws only when something visibly moves. Replaces BlipField + txRing.
import {
  MAX_FRONTS, MAX_GLOWS, easeOutCubic, fadeProgress,
  type Rgb, type Front, type Glow, type GlassFrame,
} from "./glassMath.js";

export interface GlassSite { key: string; lat: number; lng: number; color: Rgb }
export interface GlassTimings {
  growMs: number; releaseMs: number; glowLifetimeMs: number; ttlMs: number;
  /** Max held-rim brightness steps per second (display.glass.holdFps). */
  holdFps: number;
  /** Brightness levels for a held rim (display.glass.signalSteps). */
  signalSteps: number;
  /** Visible steps across an afterglow's life (display.glass.fadeSteps). */
  fadeSteps: number;
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

/** Afterglows step on ONE absolute grid (review I1): every glow changes on
 *  the same tick, so N glows cost fadeSteps redraws per lifetime, not
 *  N × fadeSteps. The latest tick at or before `now`. */
export function gridTick(now: number, lifeMs: number, steps: number): number {
  const step = lifeMs / steps;
  return Math.floor(now / step) * step;
}

/** A glow's remaining strength (1 → 0), its age sampled at the latest grid
 *  tick; 0 once that age reaches the lifetime. */
export function fadeAt(start: number, now: number, lifeMs: number, steps: number): number {
  const age = Math.max(0, gridTick(now, lifeMs, steps) - start);
  return age >= lifeMs ? 0 : 1 - age / lifeMs;
}

/** The first grid tick strictly after `now` (float guard included). */
function nextTick(now: number, lifeMs: number, steps: number): number {
  const step = lifeMs / steps;
  let t = gridTick(now, lifeMs, steps) + step;
  while (t <= now) t += step;
  return t;
}

interface LiveFront {
  id: string; site: GlassSite; radiusM: number; born: number; until: number;
  bright: number; brightAt: number; pending: number | null; releasedAt: number | null;
}
interface SiteState { site: GlassSite; radiusM: number; hits: number; glowStart: number | null }

export class GlassState {
  private readonly fronts = new Map<string, LiveFront>();
  private readonly sites = new Map<string, SiteState>();
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
    if (s) { s.hits++; s.radiusM = radiusM; s.site = site; }
    else this.sites.set(site.key, { site, radiusM, hits: 1, glowStart: null });
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
    const s = this.sites.get(f.site.key);
    if (s) s.glowStart = now;
  }

  releaseAll(now: number): void {
    for (const id of this.fronts.keys()) this.release(id, now);
  }

  seedGlow(site: GlassSite, radiusM: number, ts: number, now: number): void {
    if (now - ts >= this.t.glowLifetimeMs) return;
    const s = this.sites.get(site.key);
    if (s) { s.hits++; s.glowStart = Math.max(s.glowStart ?? ts, ts); s.radiusM = radiusM; }
    else this.sites.set(site.key, { site, radiusM, hits: 1, glowStart: ts });
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
    const liveKeys = new Set([...this.fronts.values()].map((f) => f.site.key));
    const glows: Glow[] = [];
    const life = this.t.glowLifetimeMs;
    for (const [key, s] of this.sites) {
      const fade = s.glowStart === null ? 0 : fadeAt(s.glowStart, now, life, this.t.fadeSteps);
      if (fade <= 0) {
        s.glowStart = null;
        if (!liveKeys.has(key)) this.sites.delete(key);   // window over: hits reset
        continue;
      }
      glows.push({
        key, lat: s.site.lat, lng: s.site.lng, radiusM: s.radiusM, color: s.site.color,
        strength: rampStrength(s.hits) * fade,
      });
    }
    if (glows.length) next = Math.min(next, nextTick(now, life, this.t.fadeSteps));
    glows.sort((a, b) => b.strength - a.strength);
    return {
      fronts, glows: glows.slice(0, MAX_GLOWS), growing, continuous,
      nextChangeAt: Number.isFinite(next) ? next : null,
    };
  }
}
