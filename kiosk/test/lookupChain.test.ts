import { describe, it, expect } from "vitest";
import { composeLookups, normalizeMode } from "../src/backend/lookup.js";

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


describe("normalizeMode", () => {
  it("translates source dialects to ours (FMN -> NFM) and uppercases", () => {
    expect(normalizeMode("FMN")).toBe("NFM");
    expect(normalizeMode("fmn")).toBe("NFM");
    expect(normalizeMode("DMR")).toBe("DMR");
    expect(normalizeMode("p25")).toBe("P25");
  });
});


describe("mode inference from identified names", () => {
  it("fills a missing mode from system-name tokens (RR trunked rows have nil mode)", async () => {
    const provider = { lookup: async () => ({ tag: "MotoNet CP+ (DMR) Site 013 KCI" }) };
    const hit = await composeLookups([provider]).lookup(463737500);
    expect(hit?.mode).toBe("DMR");
  });

  it("recognizes LTR and P25 tokens; leaves unhinted names alone", async () => {
    const ltr = await composeLookups([{ lookup: async () => ({ tag: "KC Wireless (LTR) Site 010" }) }]).lookup(1);
    expect(ltr?.mode).toBe("LTR");
    const plain = await composeLookups([{ lookup: async () => ({ tag: "Unigard Security" }) }]).lookup(1);
    expect(plain?.mode).toBeUndefined();
  });

  it("never overrides a mode the source actually provided", async () => {
    const hit = await composeLookups([{ lookup: async () => ({ tag: "Something (DMR)", mode: "NFM" }) }]).lookup(1);
    expect(hit?.mode).toBe("NFM");
  });
});
