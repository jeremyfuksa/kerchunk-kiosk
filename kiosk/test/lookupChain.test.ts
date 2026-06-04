import { describe, it, expect } from "vitest";
import { composeLookups } from "../src/backend/lookup.js";

describe("composeLookups", () => {
  it("returns the first provider's hit and skips the rest", async () => {
    const a = { lookup: async () => ({ tag: "from-A" }) };
    const b = { lookup: async () => ({ tag: "from-B" }) };
    const chain = composeLookups([a, b]);
    expect((await chain.lookup(1))?.tag).toBe("from-A");
  });

  it("falls through misses and failures to the next provider", async () => {
    const miss = { lookup: async () => null };
    const boom = { lookup: async () => { throw new Error("offline"); } };
    const b = { lookup: async () => ({ tag: "from-B" }) };
    expect((await composeLookups([miss, boom, b]).lookup(1))?.tag).toBe("from-B");
    expect(await composeLookups([miss]).lookup(1)).toBeNull();
  });
});
