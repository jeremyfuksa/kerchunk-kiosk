// Scan-scheduling math for WidebandEngine's group-hop timer. Pure (no timers,
// no I/O) so the formulas are unit-testable headless; the engine's dwell timer
// stays the one scheduler and calls into these.

/** config.scan.autoDwell — activity-weighted dwell (all fields optional). */
export interface AutoDwellConfig {
  enabled?: boolean;
  /** Half-life of the per-group activity count, minutes. */
  halfLifeMin?: number;
  /** Factor floor for an idle group (<= 1). */
  minFactor?: number;
  /** Factor ceiling for a busy group (>= 1). */
  maxFactor?: number;
}

export const AUTO_DWELL_DEFAULTS = {
  enabled: true,
  halfLifeMin: 30,
  minFactor: 0.5,
  maxFactor: 2.0,
} as const;

/** Prior, in transmissions, added to every group's activity before comparing.
 *  Keeps a cold start (all zero) at exactly 1.0 and damps the first few opens:
 *  one open in a 10-group scan lifts that group to (1+1)/(0.1+1) = 1.8x, not
 *  straight to maxFactor. */
export const ACTIVITY_PRIOR = 1;

/** Absolute floor for an auto-shortened dwell. After a hop a lane needs
 *  ~0.6 s (retune settle + 500 ms warm-up + an open poll) before it can even
 *  open, so a sub-second dwell is mostly deaf. Only ever limits the SHRINK:
 *  a base dwell configured below this is honored as-is. */
export const MIN_AUTO_DWELL_MS = 1000;

export function resolveAutoDwell(c: AutoDwellConfig | undefined): Required<AutoDwellConfig> {
  return {
    enabled: c?.enabled ?? AUTO_DWELL_DEFAULTS.enabled,
    halfLifeMin: c?.halfLifeMin ?? AUTO_DWELL_DEFAULTS.halfLifeMin,
    minFactor: c?.minFactor ?? AUTO_DWELL_DEFAULTS.minFactor,
    maxFactor: c?.maxFactor ?? AUTO_DWELL_DEFAULTS.maxFactor,
  };
}

/**
 * Exponentially-decayed count of opens (transmissions) per group key. Each
 * open adds 1; the total halves every half-life. Stored as (value, at) and
 * decayed lazily on read, so there is no per-tick work. In memory only — a
 * backend restart starts cold (every factor 1.0).
 */
export class ActivityTracker {
  private readonly counts = new Map<string, { value: number; at: number }>();

  record(key: string, now: number, halfLifeMs: number): void {
    this.counts.set(key, { value: this.value(key, now, halfLifeMs) + 1, at: now });
  }

  value(key: string, now: number, halfLifeMs: number): number {
    const e = this.counts.get(key);
    if (!e) return 0;
    const dt = Math.max(0, now - e.at);
    return e.value * 2 ** (-dt / halfLifeMs);
  }

  clear(): void { this.counts.clear(); }
}

/**
 * Dwell factor for one group:
 *
 *   factor = clamp((a_g + k) / (mean_a + k), minFactor, maxFactor)
 *
 * a_g = the group's decayed open count, mean_a = the mean over all groups in
 * the rotation, k = ACTIVITY_PRIOR. A group at the average gets 1.0; busier
 * groups stretch toward maxFactor, idle ones shrink toward minFactor.
 */
export function dwellFactor(a: number, mean: number, minFactor: number, maxFactor: number): number {
  const raw = (a + ACTIVITY_PRIOR) / (mean + ACTIVITY_PRIOR);
  return Math.min(maxFactor, Math.max(minFactor, raw));
}

/** base x factor, never shrunk below MIN_AUTO_DWELL_MS (or below the base
 *  itself, when the base is already shorter than that floor). */
export function scaledDwellMs(baseMs: number, factor: number): number {
  return Math.max(baseMs * factor, Math.min(baseMs, MIN_AUTO_DWELL_MS));
}

/** config.scan.priorityRevisit — peek at priority channels' groups between
 *  normal dwells (hardware-scanner "priority scan"). */
export interface PriorityRevisitConfig {
  enabled?: boolean;
  /** Dwell on non-priority groups between two revisits, ms. */
  everyMs?: number;
  /** How long one revisit looks at the priority group, ms. */
  lookMs?: number;
}

export const PRIORITY_REVISIT_DEFAULTS = {
  enabled: true,
  everyMs: 8000,   // peek cost ~0.7 s look + ~0.6 s re-warm per peek: ~15% of scan time at 8 s (~25% at 4 s)
  // A hop costs ~23-35 ms of retune settle + WARMUP_MS 500 before a lane may
  // open + one OPEN_POLLS window (100 ms): ~0.64 s until a carrier that is
  // already up can open. 700 ms covers that with a little margin; anything
  // shorter is a deaf look.
  lookMs: 700,
} as const;

export function resolvePriorityRevisit(c: PriorityRevisitConfig | undefined): Required<PriorityRevisitConfig> {
  return {
    enabled: c?.enabled ?? PRIORITY_REVISIT_DEFAULTS.enabled,
    everyMs: c?.everyMs ?? PRIORITY_REVISIT_DEFAULTS.everyMs,
    lookMs: c?.lookMs ?? PRIORITY_REVISIT_DEFAULTS.lookMs,
  };
}

/** Round-robin pick over the priority groups: returns the group to visit and
 *  the advanced cursor, or null when there is none. */
export function nextRevisitTarget(targets: number[], cursor: number): { index: number; cursor: number } | null {
  if (targets.length === 0) return null;
  const index = targets[cursor % targets.length]!;
  return { index, cursor: (cursor + 1) % targets.length };
}

/** config.scan.visualHold — muted channels earn scan time for the map
 *  (spec 2026-10-03 visual hold). A muted open holds its window for up to
 *  maxMs of continuous hold; the speaker stays silent. */
export interface VisualHoldConfig {
  enabled?: boolean;
  /** Ceiling on ONE continuous visual hold, ms. Audible holds keep maxHoldMs. */
  maxMs?: number;
  /** Muted opens also count toward autoDwell activity. */
  creditDwell?: boolean;
}

export const VISUAL_HOLD_DEFAULTS = {
  enabled: true,
  maxMs: 15_000, // a typical rail / business / WOF transmission is 9-12 s
  creditDwell: true,
} as const;

export function resolveVisualHold(c: VisualHoldConfig | undefined): Required<VisualHoldConfig> {
  return {
    enabled: c?.enabled ?? VISUAL_HOLD_DEFAULTS.enabled,
    maxMs: c?.maxMs ?? VISUAL_HOLD_DEFAULTS.maxMs,
    creditDwell: c?.creditDwell ?? VISUAL_HOLD_DEFAULTS.creditDwell,
  };
}
