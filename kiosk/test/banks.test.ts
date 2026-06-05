import { describe, it, expect } from "vitest";
import { bandFor, matchesBank, isScannable, isAudible, profileFor } from "../src/backend/config/banks.js";
import type { Channel, Bank } from "../src/backend/config/schema.js";

function ch(freq: number, over: Partial<Channel> = {}): Channel {
  return { id: `c${freq}`, freq, alphaTag: String(freq), mode: "nfm", enabled: true, ...over };
}
function bank(over: Partial<Bank>): Bank {
  return { id: "b1", name: "Test", enabled: true, ...over };
}

describe("bandFor", () => {
  it("classifies the classic ranges", () => {
    expect(bandFor(27_185_000)).toBe("hf");      // CB 19
    expect(bandFor(146_790_000)).toBe("vhf");    // 2m
    expect(bandFor(162_550_000)).toBe("vhf");    // NOAA
    expect(bandFor(464_275_000)).toBe("uhf");    // WoF
    expect(bandFor(851_012_500)).toBe("uhf");    // 800 trunking
    expect(bandFor(1_240_000_000)).toBe("shf");  // 23cm
  });
});

describe("matchesBank", () => {
  it("band-only banks match by derived band", () => {
    expect(matchesBank(ch(146_790_000), bank({ band: "vhf" }))).toBe(true);
    expect(matchesBank(ch(464_275_000), bank({ band: "vhf" }))).toBe(false);
  });

  it("tag banks match any shared tag", () => {
    const c = ch(123_450_000, { tags: ["air", "kci"] });
    expect(matchesBank(c, bank({ tags: ["air"] }))).toBe(true);
    expect(matchesBank(c, bank({ tags: ["rail"] }))).toBe(false);
    expect(matchesBank(ch(123_450_000), bank({ tags: ["air"] }))).toBe(false); // untagged
  });

  it("band AND tags must both hold when both are set", () => {
    const c = ch(123_450_000, { tags: ["air"] });
    expect(matchesBank(c, bank({ band: "vhf", tags: ["air"] }))).toBe(true);
    expect(matchesBank(c, bank({ band: "uhf", tags: ["air"] }))).toBe(false);
  });

  it("a predicate-less bank matches everything (master switch)", () => {
    expect(matchesBank(ch(1_000_000), bank({}))).toBe(true);
  });
});

describe("isScannable (off-wins)", () => {
  const banks: Bank[] = [
    bank({ id: "vhf", name: "VHF", band: "vhf", enabled: true }),
    bank({ id: "air", name: "Air", tags: ["air"], enabled: false }),
  ];

  it("a channel in only enabled banks scans", () => {
    expect(isScannable(ch(146_790_000), banks)).toBe(true);
  });

  it("ANY matching disabled bank mutes the channel — off wins", () => {
    expect(isScannable(ch(123_450_000, { tags: ["air"] }), banks)).toBe(false);
  });

  it("channel.enabled still gates first", () => {
    expect(isScannable(ch(146_790_000, { enabled: false }), banks)).toBe(false);
  });

  it("no banks configured = enabled channels scan (v1 behavior unchanged)", () => {
    expect(isScannable(ch(146_790_000), [])).toBe(true);
  });
});

describe("isAudible (hear vs see)", () => {
  const banks: Bank[] = [
    bank({ id: "vhf", name: "VHF", band: "vhf", enabled: true }),
    bank({ id: "rail", name: "Rail", tags: ["rail"], enabled: true, audible: false }), // SEE
  ];

  it("default channels are audible", () => {
    expect(isAudible(ch(146_790_000), banks)).toBe(true);
  });

  it("a see-only channel never owns the speaker", () => {
    expect(isAudible(ch(146_790_000, { audible: false }), banks)).toBe(false);
  });

  it("a SEE bank mutes every channel it matches — mute wins", () => {
    expect(isAudible(ch(160_650_000, { tags: ["rail"] }), banks)).toBe(false);
  });

  it("a SEE bank's channels still scan (visible in history)", () => {
    expect(isScannable(ch(160_650_000, { tags: ["rail"] }), banks)).toBe(true);
  });
});

describe("profileFor — per-bank scan profiles (Idea 7)", () => {
  const ch = { id: "c1", freq: 160_650_000, alphaTag: "BNSF Road", mode: "nfm" as const, enabled: true, tags: ["rail"] };
  it("inherits the first matching enabled bank's knobs, field-wise", () => {
    const banks = [
      { id: "b1", name: "Rail", enabled: true, tags: ["rail"], hangMs: 4000 },
      { id: "b2", name: "VHF", enabled: true, band: "vhf" as const, hangMs: 9999, dwellWeight: 2 },
    ];
    // hangMs from Rail (first match wins); dwellWeight falls through to VHF.
    expect(profileFor(ch, banks)).toEqual({ hangMs: 4000, dwellWeight: 2 });
  });
  it("disabled banks contribute nothing; no match = empty (global defaults)", () => {
    expect(profileFor(ch, [{ id: "b1", name: "Rail", enabled: false, tags: ["rail"], hangMs: 4000 }])).toEqual({});
    expect(profileFor(ch, [{ id: "b3", name: "Air", enabled: true, tags: ["air"], openAboveFloorDb: 6 }])).toEqual({});
  });
});
