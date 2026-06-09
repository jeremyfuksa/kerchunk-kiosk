// The single source of the frequency-uniqueness rule. Pure — no I/O.
// Two non-GMRS channels on one frequency are a duplicate; GMRS/FRS is shared
// channelized spectrum, so same-freq GMRS rows are legitimate and exempt.
import { serviceFor } from "./banks.js";
import type { Channel } from "./schema.js";

export interface DuplicateSet {
  freq: number;
  /** Rows on this freq, richest first (completeness desc, then id asc). */
  channels: Array<{ channel: Channel; completeness: number }>;
}

/** GMRS/FRS membership, derived from frequency (not tags). */
export function isGmrs(freqHz: number): boolean {
  return serviceFor(freqHz) === "GMRS/FRS";
}

/** Two channels collide: same freq and neither is GMRS. */
export function collides(a: Channel, b: Channel): boolean {
  return a.freq === b.freq && !isGmrs(a.freq) && !isGmrs(b.freq);
}

/** "Richest row" score — which row survives a cleanup. Location is weighted
 *  double: it's the most expensive field to re-derive (geocoding/lookup). */
export function completeness(c: Channel): number {
  let s = 0;
  if (c.location?.lat !== undefined && c.location?.lon !== undefined) s += 2;
  if (c.tags && c.tags.length > 0) s += 1;
  if (c.priority === true) s += 1;
  if (c.alert === true) s += 1;
  if (c.levelTrimDb !== undefined || c.rfDb !== undefined) s += 1;
  return s;
}

/** Non-GMRS frequencies with 2+ rows, each set ranked richest-first. */
export function findDuplicateSets(channels: Channel[]): DuplicateSet[] {
  const byFreq = new Map<number, Channel[]>();
  for (const c of channels) {
    if (isGmrs(c.freq)) continue; // exempt — never a duplicate
    const list = byFreq.get(c.freq) ?? [];
    list.push(c);
    byFreq.set(c.freq, list);
  }
  const sets: DuplicateSet[] = [];
  for (const [freq, list] of byFreq) {
    if (list.length < 2) continue;
    const ranked = list
      .map((channel) => ({ channel, completeness: completeness(channel) }))
      .sort((x, y) => y.completeness - x.completeness || (x.channel.id < y.channel.id ? -1 : 1));
    sets.push({ freq, channels: ranked });
  }
  return sets.sort((a, b) => a.freq - b.freq);
}
