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

/** Can a helper ALREADY spawned for `spawned` correctly run `newGroups` by a
 *  live re-point (`tune`) alone — no respawn? The channelizer's lane COUNT and
 *  per-lane demod paths are fixed at spawn; the tune command only re-assigns
 *  channels to those existing lanes (positionally, slot 0..n). So re-pointing is
 *  safe iff the new config needs no MORE lanes than were built and every slot's
 *  required demod path (FM/AM) already exists on that spawned lane. An empty set
 *  never fits (the helper must be torn down to release the SDR, not re-pointed).
 *  When this returns false, the caller must respawn (stop()+start()). */
export function planFits(spawned: LanePlan, newGroups: ChannelGroup[], maxChans: number): boolean {
  const biggest = newGroups.reduce((m, g) => Math.max(m, g.channels.length), 0);
  const need = Math.min(maxChans, biggest);
  if (need === 0) return false;            // no channels: tear down, don't re-point
  if (need > spawned.laneCount) return false;
  for (let i = 0; i < need; i++) {
    let fm = false, am = false;
    for (const g of newGroups) {
      const c = g.channels[i];
      if (!c) continue;
      if (isFm(c.mode)) fm = true;
      if (isAm(c.mode)) am = true;
    }
    const lane = spawned.perLane[i];
    if (!lane) return false;
    if (fm && !lane.fm) return false;      // needs an FM path this lane lacks
    if (am && !lane.am) return false;      // needs an AM path this lane lacks
  }
  return true;
}

/** Serialize a plan to helper CLI args: --lanes N --lane-modes <mask>.
 *  Mask is one char/lane: f=FM-only, a=AM-only, b=both. */
export function lanePlanArgs(plan: LanePlan): string[] {
  const mask = plan.perLane
    .map((m) => (m.fm && m.am ? "b" : m.am ? "a" : "f"))
    .join("");
  return ["--lanes", String(plan.laneCount), "--lane-modes", mask];
}
