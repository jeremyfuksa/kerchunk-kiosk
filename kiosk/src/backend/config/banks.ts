import type { Channel, Bank } from "./schema.js";

// Banks (ROADMAP Idea 1): named groups the operator toggles as a unit.
// Two orthogonal axes, per the roadmap's recommended model:
//  - band: a frequency RANGE, derived from freq — never stored, never wrong;
//  - tags: operator-applied SERVICE labels ("air", "rail", "ham").
// A bank is a predicate over both. Semantics are OFF-WINS: a channel matched
// by ANY disabled bank is muted, however many enabled banks also match — the
// point of a bank is bulk-silencing, so off must be decisive.

export type BandName = "hf" | "vhf" | "uhf" | "shf";

export function bandFor(freqHz: number): BandName {
  if (freqHz < 30_000_000) return "hf";
  if (freqHz < 300_000_000) return "vhf";
  if (freqHz < 1_000_000_000) return "uhf";
  return "shf";
}

export function matchesBank(channel: Channel, bank: Bank): boolean {
  if (bank.band && bandFor(channel.freq) !== bank.band) return false;
  if (bank.tags && bank.tags.length > 0) {
    if (!channel.tags?.some((t) => bank.tags!.includes(t))) return false;
  }
  return true; // predicate-less bank = master switch over everything
}

export function isScannable(channel: Channel, banks: Bank[]): boolean {
  if (!channel.enabled) return false;
  return !banks.some((b) => !b.enabled && matchesBank(channel, b));
}

// Hear-vs-see: may this channel own the SPEAKER? Mute-wins, mirroring
// isScannable's off-wins — a SEE bank silences everything it matches, however
// the channel itself is set. (Scanning is unaffected: see = demodulated and
// logged, just never audible.)
export function isAudible(channel: Channel, banks: Bank[]): boolean {
  if (channel.audible === false) return false;
  return !banks.some((b) => b.enabled && b.audible === false && matchesBank(channel, b));
}

// Per-bank scan profiles (ROADMAP Idea 7). Field-wise FIRST-MATCH-WINS in
// config order, enabled banks only — predictable and documentable, no
// cleverness. Disabled banks contribute nothing (their channels aren't
// scanned anyway unless another bank covers them).
export interface BankProfile {
  openAboveFloorDb?: number;
  noiseQuietDb?: number;
  hangMs?: number;
  dwellWeight?: number;
}

const PROFILE_KEYS = ["openAboveFloorDb", "noiseQuietDb", "hangMs", "dwellWeight"] as const;

export function profileFor(channel: Channel, banks: Bank[]): BankProfile {
  const out: BankProfile = {};
  for (const b of banks) {
    if (!b.enabled || !matchesBank(channel, b)) continue;
    for (const k of PROFILE_KEYS) {
      if (out[k] === undefined && b[k] !== undefined) out[k] = b[k];
    }
  }
  return out;
}
