import { describe, it, expect } from "vitest";
import { groupChannels } from "../src/backend/engine/grouping.js";
import type { Channel } from "../src/backend/config/schema.js";

function ch(freq: number, over: Partial<Channel> = {}): Channel {
  return { id: `c${freq}`, freq, alphaTag: String(freq), mode: "nfm", enabled: true, ...over };
}
const WINDOW = 2_000_000;

describe("groupChannels", () => {
  it("clusters the operator's 6 channels into VHF / UHF-444 / UHF-464", () => {
    const groups = groupChannels(
      [ch(146_790_000), ch(147_330_000), ch(444_275_000), ch(464_175_000), ch(464_275_000), ch(464_425_000)],
      WINDOW,
    );
    expect(groups.map((g) => g.channels.map((c) => c.freq))).toEqual([
      [146_790_000, 147_330_000],
      [444_275_000],
      [464_175_000, 464_275_000, 464_425_000],
    ]);
  });

  it("centers each group between its min and max channel", () => {
    const [g] = groupChannels([ch(146_790_000), ch(147_330_000)], WINDOW);
    expect(g!.centerHz).toBe((146_790_000 + 147_330_000) / 2);
  });

  it("every channel sits within ±window/2 of its group center", () => {
    for (const g of groupChannels(
      [ch(146_790_000), ch(147_330_000), ch(148_700_000), ch(464_175_000)], WINDOW)) {
      for (const c of g.channels) {
        expect(Math.abs(c.freq - g.centerHz)).toBeLessThanOrEqual(WINDOW / 2);
      }
    }
  });

  it("a channel beyond the window starts a new group", () => {
    // 3 MHz apart > 2 MHz window
    const groups = groupChannels([ch(146_000_000), ch(149_000_000)], WINDOW);
    expect(groups).toHaveLength(2);
  });

  it("ignores disabled channels", () => {
    const groups = groupChannels([ch(146_790_000), ch(464_175_000, { enabled: false })], WINDOW);
    expect(groups).toHaveLength(1);
  });

  it("returns [] for no enabled channels", () => {
    expect(groupChannels([], WINDOW)).toEqual([]);
  });

  it("is deterministic regardless of input order", () => {
    const a = groupChannels([ch(464_175_000), ch(146_790_000), ch(464_425_000)], WINDOW);
    const b = groupChannels([ch(146_790_000), ch(464_425_000), ch(464_175_000)], WINDOW);
    expect(a).toEqual(b);
  });
});

describe("maxPerGroup cap", () => {
  it("splits a cluster larger than maxPerGroup instead of dropping channels", () => {
    // 9 channels inside one window (GMRS 15-22 + a 464 business channel).
    const freqs = [462_550_000, 462_575_000, 462_600_000, 462_625_000,
                   462_650_000, 462_675_000, 462_700_000, 462_725_000, 464_275_000];
    const groups = groupChannels(freqs.map((f) => ch(f)), WINDOW, 8);
    expect(groups.map((g) => g.channels.length)).toEqual([8, 1]);
    // Nothing dropped.
    expect(groups.flatMap((g) => g.channels.map((c) => c.freq)).sort()).toEqual([...freqs].sort());
  });

  it("defaults to no cap", () => {
    const freqs = [462_550_000, 462_575_000, 462_600_000, 462_625_000,
                   462_650_000, 462_675_000, 462_700_000, 462_725_000, 464_275_000];
    const groups = groupChannels(freqs.map((f) => ch(f)), WINDOW);
    expect(groups).toHaveLength(1);
  });

  it("capped groups still respect the window and stay deterministic", () => {
    const freqs = [146_000_000, 146_100_000, 146_200_000, 146_300_000];
    const groups = groupChannels(freqs.map((f) => ch(f)), WINDOW, 2);
    expect(groups.map((g) => g.channels.length)).toEqual([2, 2]);
    for (const g of groups) {
      for (const c of g.channels) {
        expect(Math.abs(c.freq - g.centerHz)).toBeLessThanOrEqual(WINDOW / 2);
      }
    }
  });
});
