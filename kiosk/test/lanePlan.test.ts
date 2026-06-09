import { describe, it, expect } from "vitest";
import { computeLanePlan } from "../src/backend/engine/lanePlan.js";
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
});
