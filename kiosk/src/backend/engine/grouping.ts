import type { Channel } from "../config/schema.js";

export interface ChannelGroup {
  /** Front-end tune frequency for this group (Hz). */
  centerHz: number;
  /** Enabled channels in this group, ascending by freq. */
  channels: Channel[];
}

// Greedy interval clustering: sort enabled channels ascending, start a new
// group whenever the span (current freq - group's lowest freq) would exceed
// the usable window, OR the group is full (maxPerGroup — the DSP helper has a
// fixed number of channelizer lanes; splitting beats silently truncating).
// Center = midpoint of the group's min/max, so every member is within
// ±window/2 by construction. Deterministic, no device I/O.
export function groupChannels(
  channels: Channel[],
  windowHz: number,
  maxPerGroup: number = Infinity,
): ChannelGroup[] {
  const enabled = channels.filter((c) => c.enabled).sort((a, b) => a.freq - b.freq);
  const groups: ChannelGroup[] = [];
  let current: Channel[] = [];

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

function toGroup(channels: Channel[]): ChannelGroup {
  const lo = channels[0]!.freq;
  const hi = channels[channels.length - 1]!.freq;
  return { centerHz: (lo + hi) / 2, channels };
}
