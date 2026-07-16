import { describe, it, expect } from "vitest";
import { computeLanePlan, lanePlanArgs, planFits } from "../src/backend/engine/lanePlan.js";
import type { ChannelGroup } from "../src/backend/engine/grouping.js";
import type { Channel } from "../src/backend/config/schema.js";

const ch = (freq: number, mode: Channel["mode"]): Channel =>
  ({ id: `c${freq}`, freq, alphaTag: "T", mode, enabled: true });
const group = (...cs: Channel[]): ChannelGroup => ({ centerHz: cs[0]!.freq, channels: cs });

describe("computeLanePlan", () => {
  it("laneCount = max group size, capped at maxChans", () => {
    const plan = computeLanePlan([
      group(ch(146e6, "nfm"), ch(147e6, "nfm")),
      group(ch(150e6, "nfm"), ch(151e6, "nfm"), ch(152e6, "nfm")),
    ], 12);
    expect(plan.laneCount).toBe(3);
  });

  it("caps laneCount at maxChans even if a group is larger", () => {
    const big = group(...Array.from({ length: 20 }, (_, i) => ch(146e6 + i * 1e5, "nfm")));
    expect(computeLanePlan([big], 12).laneCount).toBe(12);
  });

  it("a pure-FM config builds FM-only on every pruned slot; SAME lane keeps both", () => {
    const plan = computeLanePlan([group(ch(146e6, "nfm"), ch(147e6, "fm"))], 12);
    expect(plan.laneCount).toBe(2);
    expect(plan.perLane[0]).toEqual({ fm: true, am: false });
    expect(plan.perLane[1]).toEqual({ fm: true, am: true }); // last lane = SAME, both
  });

  it("per-slot mode union is POSITIONAL across groups", () => {
    const plan = computeLanePlan([
      group(ch(146e6, "nfm"), ch(147e6, "nfm")),
      group(ch(120e6, "am")),
    ], 12);
    expect(plan.laneCount).toBe(2);
    expect(plan.perLane[0]).toEqual({ fm: true, am: true });  // slot0: nfm(A)+am(B)
    expect(plan.perLane[1]).toEqual({ fm: true, am: true });  // slot1 = SAME lane
  });

  it("an AM-only low slot (3+ lanes so it isn't the SAME lane) builds AM-only", () => {
    const plan = computeLanePlan([
      group(ch(120e6, "am"), ch(146e6, "nfm"), ch(147e6, "nfm")),
    ], 12);
    expect(plan.laneCount).toBe(3);
    expect(plan.perLane[0]).toEqual({ fm: false, am: true });
    expect(plan.perLane[1]).toEqual({ fm: true, am: false });
    expect(plan.perLane[2]).toEqual({ fm: true, am: true }); // SAME lane
  });

  it("no groups → a single SAME lane (both paths), never zero", () => {
    const plan = computeLanePlan([], 12);
    expect(plan.laneCount).toBe(1);
    expect(plan.perLane[0]).toEqual({ fm: true, am: true });
  });

  it("a slot whose only mode is unrecognized defaults to FM (not dead air)", () => {
    // Force an out-of-enum mode via cast to exercise the defensive fallback.
    const weird = { id: "cx", freq: 200e6, alphaTag: "X", mode: "usb" as Channel["mode"], enabled: true };
    // 2-lane plan so slot 0 is NOT the SAME lane (slot 1 is). Slot 0 = the weird channel,
    // slot 1 = a normal nfm so the group has 2 channels and laneCount is 2.
    const plan = computeLanePlan([group(weird, ch(146e6, "nfm"))], 12);
    expect(plan.laneCount).toBe(2);
    expect(plan.perLane[0]).toEqual({ fm: true, am: false }); // unrecognized → FM fallback
    expect(plan.perLane[1]).toEqual({ fm: true, am: true });  // slot 1 = SAME lane
  });
});

describe("lanePlanArgs", () => {
  it("emits --lanes and a per-lane mode mask (f/a/b)", () => {
    const plan = { laneCount: 3, perLane: [
      { fm: true, am: false }, { fm: false, am: true }, { fm: true, am: true },
    ]};
    expect(lanePlanArgs(plan)).toEqual(["--lanes", "3", "--lane-modes", "fab"]);
  });
});

describe("planFits (re-point vs respawn decision)", () => {
  // A helper spawned for two 3-channel FM groups: 3 lanes, slots f/f/b.
  const spawned = computeLanePlan([
    group(ch(146e6, "nfm"), ch(147e6, "nfm"), ch(147.5e6, "nfm")),
  ], 12);

  it("fits when the new config uses no more lanes than spawned (metadata edit)", () => {
    const same = [group(ch(146e6, "nfm"), ch(147e6, "nfm"), ch(147.5e6, "nfm"))];
    expect(planFits(spawned, same, 12)).toBe(true);
  });

  it("fits a SMALLER config — the weather break-in (one NFM channel) re-points", () => {
    expect(planFits(spawned, [group(ch(162.55e6, "nfm"))], 12)).toBe(true);
  });

  it("does NOT fit when a group grows past the spawned lane count (added channel)", () => {
    const bigger = [group(
      ch(146e6, "nfm"), ch(147e6, "nfm"), ch(147.5e6, "nfm"), ch(147.9e6, "nfm"),
    )];
    expect(planFits(spawned, bigger, 12)).toBe(false); // needs 4 lanes, spawned 3
  });

  it("does NOT fit when a slot needs an AM path the spawned lane lacks", () => {
    // slot 1 (middle freq) becomes AM; spawned lane 1 was FM-only.
    const amMid = [group(ch(146e6, "nfm"), ch(147e6, "am"), ch(147.5e6, "nfm"))];
    expect(planFits(spawned, amMid, 12)).toBe(false);
  });

  it("does NOT fit an empty channel set (tear down, never re-point)", () => {
    expect(planFits(spawned, [], 12)).toBe(false);
  });

  it("AM still fits a lane built with an AM path (b = both)", () => {
    // spawn with AM in slot 0 so lane 0 carries the AM path.
    const amSpawn = computeLanePlan([group(ch(120e6, "am"), ch(146e6, "nfm"), ch(147e6, "nfm"))], 12);
    expect(planFits(amSpawn, [group(ch(118e6, "am"), ch(146e6, "nfm"))], 12)).toBe(true);
  });
});

// ── Background (SAME/weather) channel compaction ────────────────────────────
// The helper's tune() does NOT assign channels to lanes by frequency-sorted
// position when a background channel is present: it pins the background
// channel to the last built lane and compacts the remaining regular channels
// into the earlier slots. The plan must mirror that assignment, or an AM
// channel grouped with the injected wx_same can land on an FM-only lane —
// open, detect, and produce silence.
describe("lane planning with a background channel", () => {
  const bg = (freq: number): Channel & { background: true } =>
    ({ ...ch(freq, "nfm"), background: true });

  it("plans modes by the helper's compacted assignment, not sorted position", () => {
    // freq-sorted: [nfm 161.5, wx_same(bg) 162.45, am 162.9]
    // helper: regs compacted -> slot0=nfm, slot1=AM; bg -> last lane (2).
    const plan = computeLanePlan([group(ch(161.5e6, "nfm"), bg(162.45e6), ch(162.9e6, "am"))], 12);
    expect(plan.laneCount).toBe(3);
    expect(plan.perLane[0]).toEqual({ fm: true, am: false });
    expect(plan.perLane[1]).toEqual({ fm: false, am: true }); // the AM channel really lands here
    expect(plan.perLane[2]).toEqual({ fm: true, am: true });  // SAME lane
  });

  it("planFits judges slots by the compacted assignment too", () => {
    const groups = [group(ch(161.5e6, "nfm"), bg(162.45e6), ch(162.9e6, "am"))];
    // A helper spawned from the OLD (mis-indexed) plan: slot 1 FM-only.
    const spawned = { laneCount: 3, perLane: [
      { fm: true, am: false }, { fm: true, am: false }, { fm: true, am: true },
    ]};
    // The AM channel actually runs on slot 1, which lacks an AM path.
    expect(planFits(spawned, groups, 12)).toBe(false);
  });
});
