import { describe, it, expect } from "vitest";
import { heldTxRadius } from "../src/frontend/map/txRing.js";

describe("heldTxRadius", () => {
  const geo = 2;

  it("prefers FCC coverage, then the co-located blip radius, then the default", () => {
    const tx = { key: "39.1,-94.5" } as { key: string; radiusM?: number };
    const coverage = new Map([["39.1,-94.5", 12_000]]);
    expect(heldTxRadius(tx, coverage, 5_000, geo)).toBe(12_000);
    const tx2 = { key: "x" } as { key: string; radiusM?: number };
    expect(heldTxRadius(tx2, new Map(), 5_000, geo)).toBe(5_000);
    const tx3 = { key: "x" } as { key: string; radiusM?: number };
    expect(heldTxRadius(tx3, new Map(), undefined, geo)).toBe(7_500 * geo);
  });

  it("latches on first resolve: the ring must not pop when the blip expires mid-hold", () => {
    // A continuous carrier (NOAA-style, >60s) re-arms the ring on every
    // `signal`, but the co-located blip's ts is set once — it expires and is
    // pruned from `circles` at 60s. The held ring's radius source vanishing
    // must NOT resize the ring: the first resolved radius sticks.
    const tx = { key: "x" } as { key: string; radiusM?: number };
    expect(heldTxRadius(tx, new Map(), 4_375, geo)).toBe(4_375); // blip alive
    expect(heldTxRadius(tx, new Map(), undefined, geo)).toBe(4_375); // blip pruned: no pop
  });

  it("a new transmission (fresh entry) re-resolves from scratch", () => {
    const tx = { key: "x" } as { key: string; radiusM?: number };
    heldTxRadius(tx, new Map(), 4_375, geo);
    const fresh = { key: "x" } as { key: string; radiusM?: number };
    expect(heldTxRadius(fresh, new Map(), undefined, geo)).toBe(7_500 * geo);
  });
});
