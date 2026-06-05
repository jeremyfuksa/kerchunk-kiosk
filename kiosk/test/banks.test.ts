import { describe, it, expect } from "vitest";
import { bandFor, matchesBank, isScannable, isAudible, profileFor, serviceFor, spectrumLabelFor } from "../src/backend/config/banks.js";
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

describe("serviceFor — allocation labels for Close Calls", () => {
  it("labels the local RF landscape", () => {
    expect(serviceFor(127_500_000)).toBe("air");
    expect(serviceFor(146_790_000)).toBe("ham 2m");
    expect(serviceFor(160_650_000)).toBe("rail");
    expect(serviceFor(162_550_000)).toBe("NOAA wx");
    expect(serviceFor(154_130_000)).toBe("VHF biz/PS");
    expect(serviceFor(443_775_000)).toBe("ham 70cm");
    expect(serviceFor(462_675_000)).toBe("GMRS/FRS");
    expect(serviceFor(464_275_000)).toBe("UHF biz/PS");
    expect(serviceFor(930_000_000)).toBe("paging");
  });
  it("a true outband hit gets no label", () => {
    expect(serviceFor(180_000_000)).toBeUndefined();
    expect(serviceFor(1_000_000_000)).toBeUndefined();
  });
});

describe("frequency-range bank predicates", () => {
  const ch2m = { id: "a", freq: 146_790_000, alphaTag: "W0TE", mode: "nfm" as const, enabled: true };
  it("loHz/hiHz bound the bank; outside = no match", () => {
    const m2 = { id: "b1", name: "2m", enabled: true, loHz: 144_000_000, hiHz: 148_000_000 };
    expect(matchesBank(ch2m, m2)).toBe(true);
    expect(matchesBank({ ...ch2m, freq: 154_130_000 }, m2)).toBe(false);
  });
  it("range composes with tags (both must hold)", () => {
    const b = { id: "b2", name: "VHF rail", enabled: true, loHz: 159_810_000, hiHz: 161_565_000, tags: ["rail"] };
    expect(matchesBank({ ...ch2m, freq: 160_650_000, tags: ["rail"] }, b)).toBe(true);
    expect(matchesBank({ ...ch2m, freq: 160_650_000 }, b)).toBe(false);
  });
});

describe("spectrumLabelFor — the kiosk's tuned-window chip", () => {
  it("names the slices; falls back to the coarse band", () => {
    expect(spectrumLabelFor(127_000_000)).toBe("AIRBAND");
    expect(spectrumLabelFor(146_790_000)).toBe("2M");
    expect(spectrumLabelFor(160_650_000)).toBe("VHF-HI");
    expect(spectrumLabelFor(443_775_000)).toBe("70CM");
    expect(spectrumLabelFor(462_675_000)).toBe("UHF-T");
    expect(spectrumLabelFor(180_000_000)).toBe("VHF");  // outband fallback
  });
});
