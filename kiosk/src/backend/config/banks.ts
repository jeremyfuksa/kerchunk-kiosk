import type { Channel, Bank } from "./schema.js";
import { familyFor, serviceFor, type Family } from "./family.js";

// serviceFor moved to family.ts (it feeds familyFor); re-exported so existing
// importers keep working.
export { serviceFor } from "./family.js";

// Banks (ROADMAP Idea 1): named channel collections.
// Two orthogonal axes, per the roadmap's recommended model:
//  - band: a frequency RANGE, derived from freq — never stored, never wrong;
//  - tags: operator-applied SERVICE labels ("air", "rail", "ham").
// A bank is a predicate over both. Channel state is authoritative: bank
// controls in the admin apply explicit bulk edits instead of hidden runtime
// overrides, so overlapping collections can never produce surprising results.

export type BandName = "hf" | "vhf" | "uhf" | "shf";

export function bandFor(freqHz: number): BandName {
  if (freqHz < 30_000_000) return "hf";
  if (freqHz < 300_000_000) return "vhf";
  if (freqHz < 1_000_000_000) return "uhf";
  return "shf";
}

export function matchesBank(channel: Channel, bank: Bank): boolean {
  if (bank.band && bandFor(channel.freq) !== bank.band) return false;
  if (bank.loHz !== undefined && channel.freq < bank.loHz) return false;
  if (bank.hiHz !== undefined && channel.freq > bank.hiHz) return false;
  if (bank.tags && bank.tags.length > 0) {
    if (!channel.tags?.some((t) => bank.tags!.includes(t))) return false;
  }
  return true; // predicate-less bank = master switch over everything
}

export function isScannable(channel: Channel, _banks: Bank[]): boolean {
  return channel.enabled;
}

// May this tracked channel own the speaker? The channel's own audible:false
// always silences. With an audibleFamilies list (spec 2026-10-13), a channel
// whose family isn't listed is silent too — except weather, always heard.
// No list = the legacy per-channel rule (absent audible stays true).
export function isAudible(channel: Channel, _banks: Bank[], audibleFamilies?: readonly Family[]): boolean {
  if (channel.audible === false) return false;
  if (!audibleFamilies) return true;
  const fam = familyFor(channel.freq, channel.tags);
  return fam === "weather" || audibleFamilies.includes(fam);
}

// Per-bank scan profiles (ROADMAP Idea 7). Field-wise FIRST-MATCH-WINS in
// config order — predictable and documentable, no cleverness. The legacy
// bank enabled/audible fields do not affect membership or channel state.
export interface BankProfile {
  openAboveFloorDb?: number;
  hangMs?: number;
  dwellWeight?: number;
}

const PROFILE_KEYS = ["openAboveFloorDb", "hangMs", "dwellWeight"] as const;

export function profileFor(channel: Channel, banks: Bank[]): BankProfile {
  const out: BankProfile = {};
  for (const b of banks) {
    if (!matchesBank(channel, b)) continue;
    for (const k of PROFILE_KEYS) {
      if (out[k] === undefined && b[k] !== undefined) out[k] = b[k];
    }
  }
  return out;
}

// Spectrum slice names for the kiosk's tuned-window chip — INFORMATION,
// not control (the operator killed the toggle-able spectrum masters: every
// real toggle is by service; raw-spectrum kills were only ever a trap).
const SPECTRUM: Array<{ lo: number; hi: number; name: string }> = [
  { lo: 118_000_000, hi: 137_000_000, name: "AIRBAND" },
  { lo: 144_000_000, hi: 148_000_000, name: "2M" },
  { lo: 148_000_000, hi: 174_000_000, name: "VHF-HI" },
  { lo: 222_000_000, hi: 225_000_000, name: "1.25M" },
  { lo: 420_000_000, hi: 450_000_000, name: "70CM" },
  { lo: 450_000_000, hi: 470_000_000, name: "UHF-T" },
  { lo: 470_000_000, hi: 512_000_000, name: "T-BAND" },
  { lo: 764_000_000, hi: 806_000_000, name: "700" },
  { lo: 806_000_000, hi: 869_000_000, name: "800" },
  { lo: 896_000_000, hi: 940_000_000, name: "900" },
];

export function spectrumLabelFor(freqHz: number): string {
  return SPECTRUM.find((b) => freqHz >= b.lo && freqHz <= b.hi)?.name
    ?? bandFor(freqHz).toUpperCase();
}

// The unified Channels page (spec 2026-06-06): banks as structure. A
// channel's HOME is its first matching bank — the same config-order
// precedence profileFor() uses, so "first match" means one thing
// everywhere. Channels matching no bank land in a trailing Unbanked
// group (bank: null); empty banks still render so they can be found
// and deleted.
// Unbanked channels come out frequency-sorted too — same single pass.
export interface BankGroup {
  bank: Bank | null;
  channels: Channel[];
}

export function groupChannelsByBank(channels: Channel[], banks: Bank[]): BankGroup[] {
  const groups: BankGroup[] = banks.map((b) => ({ bank: b, channels: [] }));
  const unbanked: Channel[] = [];
  for (const c of [...channels].sort((a, b) => a.freq - b.freq)) {
    const home = groups.find((g) => matchesBank(c, g.bank!));
    if (home) home.channels.push(c);
    else unbanked.push(c);
  }
  if (unbanked.length > 0) groups.push({ bank: null, channels: unbanked });
  return groups;
}
