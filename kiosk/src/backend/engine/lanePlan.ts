// Pure lane plan for the wideband helper (spec 2026-06-09): size the channelizer
// to the config instead of a fixed MAX_CHANS, and build only each lane's needed
// demod path. Channel→lane assignment is POSITIONAL (helper packs group.channels
// into slots 0..n), so a slot's mode set is the union over groups of the mode at
// that position. The LAST built lane is the SAME/weather lane — it always keeps
// both paths (decoder tap lives there; excluded from type-pruning to bound risk).
import type { ChannelGroup } from "./grouping.js";

export interface LaneMode { fm: boolean; am: boolean; }
export interface LanePlan {
  laneCount: number;
  /** Per-slot demod paths to build, index 0..laneCount-1. */
  perLane: LaneMode[];
}

const isAm = (mode: string): boolean => mode === "am";
const isFm = (mode: string): boolean => mode === "fm" || mode === "nfm";

export function computeLanePlan(groups: ChannelGroup[], maxChans: number): LanePlan {
  const biggest = groups.reduce((m, g) => Math.max(m, g.channels.length), 0);
  const laneCount = Math.max(1, Math.min(maxChans, biggest));
  const sameLane = laneCount - 1;

  const perLane: LaneMode[] = [];
  for (let i = 0; i < laneCount; i++) {
    if (i === sameLane) {
      perLane.push({ fm: true, am: true });
      continue;
    }
    let fm = false, am = false;
    for (const g of groups) {
      const c = g.channels[i];
      if (!c) continue;
      if (isFm(c.mode)) fm = true;
      if (isAm(c.mode)) am = true;
    }
    if (!fm && !am) fm = true;
    perLane.push({ fm, am });
  }
  return { laneCount, perLane };
}
