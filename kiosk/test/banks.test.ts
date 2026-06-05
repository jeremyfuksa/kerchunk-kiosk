import { describe, it, expect } from "vitest";
import { bandFor, matchesBank, isScannable } from "../src/backend/config/banks.js";
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
