import { describe, it, expect } from "vitest";
import { isGmrs, collides, completeness, findDuplicateSets } from "../src/backend/config/channelDedup.js";
import type { Channel } from "../src/backend/config/schema.js";

const ch = (over: Partial<Channel>): Channel => ({
  id: "ch_x", freq: 146_520_000, alphaTag: "T", mode: "nfm", enabled: true, ...over,
});

describe("isGmrs", () => {
  it("is true inside the GMRS allocation, false just outside", () => {
    expect(isGmrs(462_550_000)).toBe(true);
    expect(isGmrs(467_600_000)).toBe(true);
    expect(isGmrs(146_520_000)).toBe(false);
    expect(isGmrs(462_500_000)).toBe(false); // below the 462.5375 edge
  });
});

describe("collides", () => {
  it("two non-GMRS channels on the same freq collide", () => {
    expect(collides(ch({ id: "a" }), ch({ id: "b" }))).toBe(true);
  });
  it("different freqs do not collide", () => {
    expect(collides(ch({ id: "a", freq: 146_520_000 }), ch({ id: "b", freq: 146_550_000 }))).toBe(false);
  });
  it("two GMRS channels on the same freq do NOT collide (shared spectrum)", () => {
    expect(collides(ch({ id: "a", freq: 462_550_000 }), ch({ id: "b", freq: 462_550_000 }))).toBe(false);
  });
});

describe("completeness", () => {
  it("scores location highest, sums the other filled fields", () => {
    const bare = ch({});
    const rich = ch({
      location: { lat: 39, lon: -94 }, tags: ["ham"], priority: true, alert: true, rfDb: -40,
    });
    expect(completeness(bare)).toBe(0);
    expect(completeness(rich)).toBe(6); // 2 loc + 1 tags + 1 prio + 1 alert + 1 telemetry
  });
});

describe("findDuplicateSets", () => {
  it("returns only freqs with 2+ non-GMRS rows, richest first, GMRS excluded", () => {
    const a = ch({ id: "a", freq: 146_520_000 });
    const b = ch({ id: "b", freq: 146_520_000, location: { lat: 1, lon: 2 } });
    const lone = ch({ id: "c", freq: 147_000_000 });
    const g1 = ch({ id: "g1", freq: 462_550_000 });
    const g2 = ch({ id: "g2", freq: 462_550_000 });
    const sets = findDuplicateSets([a, b, lone, g1, g2]);
    expect(sets).toHaveLength(1);
    expect(sets[0]!.freq).toBe(146_520_000);
    expect(sets[0]!.channels.map((x) => x.channel.id)).toEqual(["b", "a"]); // richest first
  });

  it("breaks completeness ties by lowest id", () => {
    const z = ch({ id: "z", freq: 150_000_000 });
    const a = ch({ id: "a", freq: 150_000_000 });
    const sets = findDuplicateSets([z, a]);
    expect(sets[0]!.channels.map((x) => x.channel.id)).toEqual(["a", "z"]);
  });
});
