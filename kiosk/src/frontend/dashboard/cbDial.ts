// CB wall (spec 2026-10-14 "the dial"): the pure model behind the CB stage.
// No DOM, no fetch — dashboard.ts folds WS events and one history backfill in,
// and cbView.ts draws from it.
import type { EngineEvent } from "../../backend/engine/ScannerEngine.js";
import { CB_FREQ_HZ, cbNumberForFreq } from "../../backend/config/cb.js";

export interface CbHeard { n: number; ts: number; durationMs: number | null }
export interface CbState {
  /** Channel number → when it was last heard (the close time once released). */
  lastHeard: Readonly<Record<number, number>>;
  /** Transmissions, newest first. */
  log: readonly CbHeard[];
  /** Open transmissions by engine channel id. */
  open: Readonly<Record<string, { n: number; ts: number }>>;
}
export const CB_EMPTY: CbState = { lastHeard: {}, log: [], open: {} };
/** A /api/history row, as far as the dial cares. */
export interface CbHistoryRow { ts: number; freq: number; kind?: string; durationMs?: number | null }

const LOG_CAP = 50;

export function cbNumberForId(channelId: string): number | null {
  const m = /^cb_(\d{1,2})$/.exec(channelId);
  const n = m ? Number(m[1]) : NaN;
  return n >= 1 && n <= 40 ? n : null;
}

// Dial ends: the band edges plus half a channel, so 1 and 40 sit off the rim.
const DIAL_LO = (CB_FREQ_HZ[1] ?? 26_965_000) - 5_000;
const DIAL_HI = (CB_FREQ_HZ[40] ?? 27_405_000) + 5_000;

/** Position across the dial, 0–1, at true frequency spacing (23 lands
 *  between 25 and 26, as it does on the air). */
export function dialX(freqHz: number): number {
  return Math.min(1, Math.max(0, (freqHz - DIAL_LO) / (DIAL_HI - DIAL_LO)));
}

export type FadeStep = 0 | 1 | 2 | 3 | 4;

/** 4 = just heard … 1 = nearly faded, 0 = plain. A step drops at each
 *  fadeStepsMin mark (display.cb.fadeStepsMin, minutes, ascending). */
export function tickStep(lastHeard: number | undefined, now: number, fadeStepsMin: readonly number[]): FadeStep {
  if (lastHeard === undefined) return 0;
  const ageMin = (now - lastHeard) / 60_000;
  for (let i = 0; i < 4; i++) if (ageMin < (fadeStepsMin[i] ?? 0)) return (4 - i) as FadeStep;
  return 0;
}

export function cbReduce(s: CbState, ev: EngineEvent): CbState {
  if (ev.type === "active") {
    const n = cbNumberForId(ev.channel.id);
    if (n === null) return s;
    return {
      lastHeard: { ...s.lastHeard, [n]: ev.ts },
      log: [{ n, ts: ev.ts, durationMs: null }, ...s.log].slice(0, LOG_CAP),
      open: { ...s.open, [ev.channel.id]: { n, ts: ev.ts } },
    };
  }
  if (ev.type === "release") {
    const o = s.open[ev.channelId];
    if (!o) return s;
    const open = { ...s.open };
    delete open[ev.channelId];
    return {
      lastHeard: { ...s.lastHeard, [o.n]: ev.ts },
      log: s.log.map((r) => (r.n === o.n && r.ts === o.ts ? { ...r, durationMs: ev.ts - o.ts } : r)),
      open,
    };
  }
  // An engine state change (restart, a retune into another mode) ends every
  // transmission without release events — never leave a row stuck on "now".
  if (ev.type === "status") return Object.keys(s.open).length ? { ...s, open: {} } : s;
  return s;
}

/** Fold a /api/history?tag=cb backfill in: rows dedupe against what the live
 *  feed already logged (same channel + open time). */
export function cbSeed(s: CbState, rows: readonly CbHistoryRow[]): CbState {
  const seen = new Set(s.log.map((r) => `${r.n}:${r.ts}`));
  const lastHeard: Record<number, number> = { ...s.lastHeard };
  const add: CbHeard[] = [];
  for (const r of rows) {
    if (r.kind !== undefined && r.kind !== "active") continue;
    const n = cbNumberForFreq(r.freq);
    if (n === null || seen.has(`${n}:${r.ts}`)) continue;
    seen.add(`${n}:${r.ts}`);
    const durationMs = typeof r.durationMs === "number" ? r.durationMs : null;
    add.push({ n, ts: r.ts, durationMs });
    const end = r.ts + (durationMs ?? 0);
    if ((lastHeard[n] ?? -Infinity) < end) lastHeard[n] = end;
  }
  if (add.length === 0) return s;
  return { ...s, lastHeard, log: [...s.log, ...add].sort((a, b) => b.ts - a.ts).slice(0, LOG_CAP) };
}
