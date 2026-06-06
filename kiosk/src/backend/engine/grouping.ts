import type { Channel } from "../config/schema.js";

export interface ChannelGroup<T extends Channel = Channel> {
  /** Front-end tune frequency for this group (Hz). */
  centerHz: number;
  /** Enabled channels in this group, ascending by freq. */
  channels: T[];
}

// Greedy interval clustering: sort enabled channels ascending, start a new
// group whenever the span (current freq - group's lowest freq) would exceed
// the usable window, OR the group is full (maxPerGroup — the DSP helper has a
// fixed number of channelizer lanes; splitting beats silently truncating).
// Center = midpoint of the group's min/max, so every member is within
// ±window/2 by construction. Deterministic, no device I/O.
export function groupChannels<T extends Channel>(
  channels: T[],
  windowHz: number,
  maxPerGroup: number = Infinity,
): Array<ChannelGroup<T>> {
  const enabled = channels.filter((c) => c.enabled).sort((a, b) => a.freq - b.freq);
  const groups: Array<ChannelGroup<T>> = [];
  let current: T[] = [];

  for (const c of enabled) {
    if (current.length > 0
        && (c.freq - current[0]!.freq > windowHz || current.length >= maxPerGroup)) {
      groups.push(toGroup(current));
      current = [];
    }
    current.push(c);
  }
  if (current.length > 0) groups.push(toGroup(current));
  return groups;
}

function toGroup<T extends Channel>(channels: T[]): ChannelGroup<T> {
  const lo = channels[0]!.freq;
  const hi = channels[channels.length - 1]!.freq;
  return { centerHz: (lo + hi) / 2, channels };
}

// Close Call band-sweep (ROADMAP stretch, phase 2 of the CC spec): when
// configured, the scanner spends one stop per rotation parked on an EMPTY
// window inside the operator's sweep ranges, letting the CC FFT hunt for
// activity away from every programmed channel. Centers step across each
// range; windows already covered by a real group are skipped (the FFT
// watches those every cycle anyway).
export function sweepCenters(
  ranges: Array<{ loHz: number; hiHz: number }>,
  windowHz: number,
  groups: ChannelGroup[],
): number[] {
  const out: number[] = [];
  for (const r of ranges) {
    if (r.hiHz <= r.loHz) continue;
    for (let c = r.loHz + windowHz / 2; c - windowHz / 2 < r.hiHz; c += windowHz) {
      const covered = groups.some((g) => Math.abs(g.centerHz - c) < windowHz / 2);
      if (!covered) out.push(Math.round(c));
    }
  }
  return out;
}
