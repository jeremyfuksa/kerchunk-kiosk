import { describe, it, expect } from "vitest";
import { HistoryStore } from "../src/backend/history.js";

function make(over: { retentionDays?: number } = {}) {
  return new HistoryStore({ path: ":memory:", ...over });
}
const CH = {
  id: "c1", freq: 464275000, alphaTag: "WoF Maint", mode: "nfm" as const,
  enabled: true, tags: ["business"],
  location: { lat: 39.17, lon: -94.48, city: "KC", state: "MO", source: "radioreference" },
};

describe("HistoryStore", () => {
  it("records an opening with band/tags/location and reads it back", () => {
    const h = make();
    h.record({ ts: 1000, kind: "active", channelId: CH.id, freq: CH.freq, alphaTag: CH.alphaTag, mode: CH.mode, tags: CH.tags, lat: CH.location.lat, lon: CH.location.lon });
    const rows = h.query({});
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      ts: 1000, kind: "active", freq: 464275000, alphaTag: "WoF Maint",
      band: "uhf", tags: ["business"], lat: 39.17, lon: -94.48, durationMs: null,
    });
  });

  it("release() pairs with the open row and records duration", () => {
    const h = make();
    h.record({ ts: 1000, kind: "active", channelId: "c1", freq: 1, alphaTag: "x" });
    h.release("c1", 4500);
    expect(h.query({})[0]!.durationMs).toBe(3500);
    h.release("c1", 9999); // no open row left: no-op
    expect(h.query({})[0]!.durationMs).toBe(3500);
  });

  it("query filters by since/tag/freq and respects limit + desc order", () => {
    const h = make();
    h.record({ ts: 1, kind: "active", channelId: "a", freq: 100, alphaTag: "A", tags: ["rail"] });
    h.record({ ts: 2, kind: "active", channelId: "b", freq: 200, alphaTag: "B", tags: ["air"] });
    h.record({ ts: 3, kind: "closecall", channelId: "cc", freq: 300, alphaTag: "CC" });
    expect(h.query({ sinceMs: 2 }).map((r) => r.ts)).toEqual([3, 2]);
    expect(h.query({ tag: "rail" })).toHaveLength(1);
    expect(h.query({ freq: 200 })[0]!.alphaTag).toBe("B");
    expect(h.query({ limit: 1 })[0]!.ts).toBe(3);
  });

  it("retention prunes rows older than the window", () => {
    const h = make({ retentionDays: 30 });
    const now = Date.now();
    h.record({ ts: now - 40 * 86400_000, kind: "active", channelId: "old", freq: 1, alphaTag: "old" });
    h.record({ ts: now, kind: "active", channelId: "new", freq: 2, alphaTag: "new" });
    h.prune();
    const rows = h.query({});
    expect(rows).toHaveLength(1);
    expect(rows[0]!.alphaTag).toBe("new");
  });
});
