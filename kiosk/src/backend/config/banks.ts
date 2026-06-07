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
  if (bank.loHz !== undefined && channel.freq < bank.loHz) return false;
  if (bank.hiHz !== undefined && channel.freq > bank.hiHz) return false;
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

// ── US service allocations (operator: label what KIND of hit a Close Call
// is from frequency alone — and expose when one is a true OUTBAND oddity).
// Coarse on purpose: a triage label, not a band plan.
const ALLOCATIONS: Array<{ lo: number; hi: number; svc: string }> = [
  { lo: 118_000_000, hi: 137_000_000, svc: "air" },
  { lo: 144_000_000, hi: 148_000_000, svc: "ham 2m" },
  { lo: 156_000_000, hi: 157_450_000, svc: "marine" },
  { lo: 159_810_000, hi: 161_565_000, svc: "rail" },
  { lo: 161_600_000, hi: 162_025_000, svc: "marine" },
  { lo: 162_400_000, hi: 162_550_000, svc: "NOAA wx" },
  { lo: 148_000_000, hi: 174_000_000, svc: "VHF biz/PS" },   // after the carve-outs above
  { lo: 222_000_000, hi: 225_000_000, svc: "ham 1.25m" },
  { lo: 420_000_000, hi: 450_000_000, svc: "ham 70cm" },
  { lo: 462_537_500, hi: 462_737_500, svc: "GMRS/FRS" },
  { lo: 467_537_500, hi: 467_737_500, svc: "GMRS/FRS" },
  { lo: 450_000_000, hi: 470_000_000, svc: "UHF biz/PS" },   // after GMRS carve-outs
  { lo: 470_000_000, hi: 512_000_000, svc: "T-band" },
  { lo: 764_000_000, hi: 776_000_000, svc: "700 PS" },
  { lo: 794_000_000, hi: 806_000_000, svc: "700 PS" },
  { lo: 806_000_000, hi: 824_000_000, svc: "800 trunked" },
  { lo: 851_000_000, hi: 869_000_000, svc: "800 trunked" },
  { lo: 929_000_000, hi: 932_000_000, svc: "paging" },
  { lo: 896_000_000, hi: 940_000_000, svc: "900 biz" },
];

/** Rough service for a frequency; undefined = a true outband hit. */
export function serviceFor(freqHz: number): string | undefined {
  // First match wins — specific carve-outs precede their parent ranges.
  return ALLOCATIONS.find((a) => freqHz >= a.lo && freqHz <= a.hi)?.svc;
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
