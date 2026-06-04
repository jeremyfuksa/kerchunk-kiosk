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
