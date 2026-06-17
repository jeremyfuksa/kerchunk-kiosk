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

  it("attaches per-transmission RF strength to the active history row", () => {
    const h = make();
    h.record({ ts: 1000, kind: "active", channelId: "c1", freq: 1, alphaTag: "x" });
    h.setRf("c1", -17.4);
    h.release("c1", 2000);
    expect(h.query({})[0]!.rfDb).toBe(-17.4);
  });

  it("attaches RF to the OPEN transmission, not a channel's last-closed one", () => {
    // rf events fire DURING a transmission, so they must hit the open row.
    // After a channel's first transmission closes, lastClosed lingers — the
    // second transmission's RF must not bleed back onto the first row.
    const h = make();
    h.record({ ts: 1000, kind: "active", channelId: "c1", freq: 1, alphaTag: "x" });
    h.setRf("c1", -10);
    h.release("c1", 2000);
    h.record({ ts: 3000, kind: "active", channelId: "c1", freq: 1, alphaTag: "x" });
    h.setRf("c1", -20);
    h.release("c1", 4000);
    const rows = h.query({}); // desc by ts: [second, first]
    expect(rows[0]!.ts).toBe(3000);
    expect(rows[0]!.rfDb).toBe(-20);
    expect(rows[1]!.ts).toBe(1000);
    expect(rows[1]!.rfDb).toBe(-10);
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

describe("sites() — distinct transmitter sites for the map's antenna layer", () => {
  it("groups located events by site with names, counts, last-heard", () => {
    const h = make();
    h.record({ ts: 1, kind: "active", channelId: "a", freq: 1, alphaTag: "WoF Maint", lat: 39.17, lon: -94.48 });
    h.record({ ts: 5, kind: "active", channelId: "b", freq: 2, alphaTag: "WoF Security", lat: 39.17, lon: -94.48 });
    h.record({ ts: 3, kind: "active", channelId: "c", freq: 3, alphaTag: "W0TE", lat: 39.3, lon: -94.4 });
    h.record({ ts: 4, kind: "active", channelId: "d", freq: 4, alphaTag: "no fix" }); // unlocated: excluded
    const sites = h.sites();
    expect(sites).toHaveLength(2);
    const wof = sites.find((s) => s.lat === 39.17)!;
    expect(wof.hits).toBe(2);
    expect(wof.lastTs).toBe(5);
    expect(wof.names).toContain("WoF Maint");
    expect(wof.names).toContain("WoF Security");
    // freq = the site's MOST RECENT hit (ts=5 -> freq 2), so the map can derive
    // the service pin from it when no located config channel seeded the site.
    expect(wof.freq).toBe(2);
  });
});

describe("stats() — aggregates for Insights (Idea 9)", () => {
  function seed(h: HistoryStore): void {
    // two channels, tags, durations, one discovery, spread over hours
    h.record({ ts: 3_600_000 * 1, kind: "active", channelId: "a", freq: 464275000, alphaTag: "WoF Maint", tags: ["business"] });
    h.release("a", 3_600_000 * 1 + 8000);
    h.record({ ts: 3_600_000 * 1 + 60_000, kind: "active", channelId: "a", freq: 464275000, alphaTag: "WoF Maint", tags: ["business"] });
    h.release("a", 3_600_000 * 1 + 64_000);
    h.record({ ts: 3_600_000 * 2, kind: "active", channelId: "b", freq: 146790000, alphaTag: "W0TE", tags: ["ham"] });
    h.release("b", 3_600_000 * 2 + 3000);
    h.record({ ts: 3_600_000 * 2 + 10, kind: "closecall", channelId: "cc", freq: 462887500, alphaTag: "Close Call" });
  }

  it("totals, top channels with airtime, discoveries", () => {
    const h = make(); seed(h);
    const s = h.stats(0);
    expect(s.totalHits).toBe(4); // 3 actives + 1 closecall
    expect(s.discoveries).toBe(1);
    expect(s.topChannels[0]).toMatchObject({ alphaTag: "WoF Maint", hits: 2, airtimeMs: 12000 });
    expect(s.topChannels[1]).toMatchObject({ alphaTag: "W0TE", hits: 1, airtimeMs: 3000 });
  });

  it("aggregates by tag and by band", () => {
    const h = make(); seed(h);
    const s = h.stats(0);
    expect(s.byTag.find((t) => t.tag === "business")?.hits).toBe(2);
    expect(s.byTag.find((t) => t.tag === "ham")?.hits).toBe(1);
    expect(s.byBand.find((b) => b.band === "uhf")?.hits).toBe(3); // WoF x2 + closecall
    expect(s.byBand.find((b) => b.band === "vhf")?.hits).toBe(1);
  });

  it("activity clock buckets by hour and respects since", () => {
    const h = make(); seed(h);
    const s = h.stats(0);
    expect(s.byHour).toHaveLength(24);
    expect(s.byHour.reduce((a, b) => a + b, 0)).toBe(4);
    const recent = h.stats(3_600_000 * 2 - 1);
    expect(recent.totalHits).toBe(2);
  });
});

describe("alert rows (ROADMAP Idea 6)", () => {
  it("filters by kind and keeps alert rows out of aggregates", () => {
    const h = make();
    h.record({ ts: 1000, kind: "active", channelId: "c1", freq: CH.freq, alphaTag: CH.alphaTag, tags: CH.tags, lat: 39.17, lon: -94.48 });
    h.record({ ts: 1001, kind: "alert", channelId: "c1", freq: CH.freq, alphaTag: CH.alphaTag, tags: CH.tags, lat: 39.17, lon: -94.48 });
    expect(h.query({ kind: "alert" }).map((r) => r.kind)).toEqual(["alert"]);
    expect(h.query({}).length).toBe(2);
    // The alert row annotates the active row — it must not double-count.
    expect(h.stats(0).totalHits).toBe(1);
    expect(h.stats(0).byTag).toEqual([{ tag: "business", hits: 1 }]);
    expect(h.sites()[0]?.hits).toBe(1);
  });

  it("deleteAlert removes only that alert row and reports whether it hit", () => {
    const h = make();
    h.record({ ts: 1000, kind: "alert", channelId: "c1", freq: 1, alphaTag: "A" });
    h.record({ ts: 2000, kind: "alert", channelId: "c2", freq: 2, alphaTag: "B" });
    const id = h.query({ kind: "alert", freq: 1 })[0]!.id;
    expect(h.deleteAlert(id)).toBe(true);
    expect(h.query({ kind: "alert" }).map((r) => r.alphaTag)).toEqual(["B"]);
    expect(h.deleteAlert(id)).toBe(false); // already gone
  });

  it("deleteAlert refuses to delete a non-alert (active/closecall) row", () => {
    const h = make();
    h.record({ ts: 1000, kind: "active", channelId: "c1", freq: 1, alphaTag: "A" });
    const id = h.query({})[0]!.id;
    expect(h.deleteAlert(id)).toBe(false);
    expect(h.query({})).toHaveLength(1); // the active hit row survives
  });

  it("clearAlerts wipes every alert row, returns the count, and spares hits", () => {
    const h = make();
    h.record({ ts: 1000, kind: "active", channelId: "c1", freq: 1, alphaTag: "A" });
    h.record({ ts: 1001, kind: "alert", channelId: "c1", freq: 1, alphaTag: "A" });
    h.record({ ts: 2000, kind: "closecall", channelId: "cc", freq: 2, alphaTag: "CC" });
    h.record({ ts: 2001, kind: "alert", channelId: "cc", freq: 2, alphaTag: "CC" });
    expect(h.clearAlerts()).toBe(2);
    expect(h.query({ kind: "alert" })).toHaveLength(0);
    expect(h.query({}).map((r) => r.kind).sort()).toEqual(["active", "closecall"]);
    expect(h.clearAlerts()).toBe(0); // nothing left to clear
  });
});
