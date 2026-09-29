import { describe, it, expect } from "vitest";
import type { Bank, Channel } from "../src/backend/config/schema.js";
import {
  matchesQuery, chipsFor, validChip, visibleChannels, CHIP_ALL, CHIP_ARCHIVED, bankChip,
  rowMeta, channelName, lcdMeta, suggestionSummary, pendingDiscoveries, suppressedDiscoveries,
  hitsText, guessLine, milesBetween, discoveryNote, draftFromDiscovery, emptyDraft, parseMhz, parseTags,
  parseSite, toneValue, toneFromValue, newChannelBody, siteLocation, bankRule, profileText,
  bankFromForm, profileFromForm, withProfile, bankToggles, bulkPatch, signalSeries, defaultMode,
  resolveDetail, detailFieldsToPatch, lockoutSnapshot, restoreDiscovery,
  type Discovery,
} from "../src/frontend/admin/libraryModel.js";
import { ago } from "../src/frontend/admin/time.js";

const ch = (o: Partial<Channel> & { id: string; freq: number }): Channel =>
  ({ alphaTag: "", mode: "nfm", enabled: true, ...o });
const air: Bank = { id: "bk_air", name: "Air", enabled: true, tags: ["air"] };
const uhf: Bank = { id: "bk_uhf", name: "UHF", enabled: true, band: "uhf" };
const A = ch({ id: "a", freq: 118_400_000, alphaTag: "KC Approach", mode: "am", tags: ["air"], location: { city: "Kansas City", state: "MO", source: "rr" } });
const B = ch({ id: "b", freq: 462_562_500, alphaTag: "GMRS 1" });
const C = ch({ id: "c", freq: 151_820_000, alphaTag: "Walmart", enabled: false });

describe("search", () => {
  it("matches name, MHz text, raw Hz and tags, case-insensitively", () => {
    expect(matchesQuery(A, "approach")).toBe(true);
    expect(matchesQuery(A, "118.4")).toBe(true);
    expect(matchesQuery(A, "118400000")).toBe(true);
    expect(matchesQuery(A, "AIR")).toBe(true);
    expect(matchesQuery(A, "rail")).toBe(false);
    expect(matchesQuery(A, "   ")).toBe(true);
  });
});

describe("chips", () => {
  it("counts tracked channels per bank and shows Archived only when any", () => {
    expect(chipsFor([A, B, C], [air, uhf])).toEqual([
      { id: CHIP_ALL, label: "All", count: 2 },
      { id: bankChip("bk_air"), label: "Air", count: 1 },
      { id: bankChip("bk_uhf"), label: "UHF", count: 1 },
      { id: CHIP_ARCHIVED, label: "Archived", count: 1 },
    ]);
    expect(chipsFor([A, B], []).map((c) => c.id)).toEqual([CHIP_ALL]);
  });
  it("falls back to All for a chip that no longer exists", () => {
    const chips = chipsFor([A, B], [air]);
    expect(validChip(bankChip("bk_gone"), chips)).toBe(CHIP_ALL);
    expect(validChip(CHIP_ARCHIVED, chips)).toBe(CHIP_ALL);
    expect(validChip(bankChip("bk_air"), chips)).toBe(bankChip("bk_air"));
  });
  it("filters by chip, then query, sorted by frequency", () => {
    expect(visibleChannels([B, A, C], [air], { chip: CHIP_ALL, query: "" }).map((c) => c.id)).toEqual(["a", "b"]);
    expect(visibleChannels([B, A, C], [air], { chip: bankChip("bk_air"), query: "" }).map((c) => c.id)).toEqual(["a"]);
    expect(visibleChannels([B, A, C], [air], { chip: CHIP_ARCHIVED, query: "" }).map((c) => c.id)).toEqual(["c"]);
    expect(visibleChannels([B, A, C], [air], { chip: CHIP_ALL, query: "gmrs" }).map((c) => c.id)).toEqual(["b"]);
  });
});

describe("row text", () => {
  it("names, meta and LCD meta", () => {
    expect(channelName(A)).toBe("KC Approach");
    expect(channelName(ch({ id: "x", freq: 146_520_000, alphaTag: "  " }))).toBe("146.5200 MHz");
    expect(rowMeta(A)).toBe("118.4000 · AM · Kansas City, MO");
    expect(rowMeta(B)).toBe("462.5625 · NFM");
    expect(lcdMeta(A)).toBe("AM · air · Kansas City, MO");
  });
});

describe("suggestions", () => {
  it("summarises duplicates (extra rows) and archive ideas, or null", () => {
    const dup = { freq: 1, channels: [{ channel: A, completeness: 3 }, { channel: A, completeness: 1 }] };
    const rec = { id: "c", freq: 2, alphaTag: "x", audible: true };
    expect(suggestionSummary([dup], [rec, rec])).toBe("3 suggestions: 1 duplicate, 2 to archive");
    expect(suggestionSummary([], [rec])).toBe("1 suggestion: 1 to archive");
    expect(suggestionSummary([], [])).toBeNull();
  });
});

describe("discoveries", () => {
  const now = 10_000_000;
  const d1: Discovery = { id: "cc_1", freq: 462_562_500, alphaTag: "Close Call 462.5625", ts: now - 60_000, hitCount: 18, lastSeenAt: now - 180_000 };
  const d2: Discovery = { id: "cc_2", freq: 151_820_000, alphaTag: "Walmart", ts: now - 30_000, mode: "DMR", location: { lat: 39.11, lon: -94.6, city: "Kansas City", source: "places" } };
  const d3: Discovery = { id: "cc_3", freq: 453_275_000, alphaTag: "x", ts: now, suppressedAt: now, suppressionReason: "Likely repeated noise" };
  it("splits pending (newest first) from suppressed", () => {
    expect(pendingDiscoveries({ discoveries: [d1, d2, d3] }).map((d) => d.id)).toEqual(["cc_2", "cc_1"]);
    expect(suppressedDiscoveries({ discoveries: [d1, d2, d3] }).map((d) => d.id)).toEqual(["cc_3"]);
    expect(pendingDiscoveries({})).toEqual([]);
  });
  it("says how often and how recently", () => {
    expect(hitsText(d1, now)).toBe("18× · heard 3 min ago");
    expect(hitsText(d2, now)).toBe("1× · heard just now");
  });
  it("guesses from name, service, place and distance", () => {
    expect(guessLine(d1)).toBe("GMRS/FRS");
    expect(guessLine(d2, { lat: 39.1, lon: -94.58 })).toMatch(/^Likely Walmart · .+ · Kansas City · 1\.\d mi$/);
    expect(guessLine({ id: "z", freq: 5_000_000_000, alphaTag: "", ts: 0 })).toBe("Unidentified");
  });
  it("distance is great-circle miles", () => {
    expect(milesBetween({ lat: 39, lon: -94 }, { lat: 39, lon: -94 })).toBe(0);
    expect(milesBetween({ lat: 39, lon: -94 }, { lat: 40, lon: -94 })).toBeCloseTo(69.1, 0);
  });
  it("notes digital and data-only discoveries", () => {
    expect(discoveryNote(d2)).toBe("DMR — digital, can't be played here");
    expect(discoveryNote({ ...d1, audible: false })).toBe("Data or paging — added as a silent channel");
    expect(discoveryNote(d1)).toBe("");
  });
  it("drafts a silent channel with the airband AM rule", () => {
    expect(draftFromDiscovery(d1)).toEqual({ freq: 462_562_500, alphaTag: "", mode: "nfm", audible: false, tags: [] });
    expect(draftFromDiscovery({ ...d2, mode: "FM" })).toMatchObject({ alphaTag: "Walmart", mode: "fm", location: d2.location });
    expect(draftFromDiscovery({ id: "q", freq: 120_000_000, alphaTag: "", ts: 0 }).mode).toBe("am");
    expect(defaultMode(462_000_000)).toBe("nfm");
    expect(emptyDraft({ freq: 121_800_000, tag: "air" })).toEqual({ freq: 121_800_000, alphaTag: "", mode: "am", audible: true, tags: ["air"] });
    expect(emptyDraft()).toEqual({ freq: null, alphaTag: "", mode: "nfm", audible: true, tags: [] });
  });
});

describe("form parsing", () => {
  it("MHz → Hz, or a plain error", () => {
    expect(parseMhz(" 146.52 ")).toBe(146_520_000);
    expect(parseMhz("462.5625")).toBe(462_562_500);
    for (const bad of ["", "abc", "0", "-1"]) expect(() => parseMhz(bad)).toThrow("Enter the frequency in MHz, like 146.5200");
  });
  it("tags: trimmed, deduped, empties dropped", () => {
    expect(parseTags(" air, rail ,,air ")).toEqual(["air", "rail"]);
    expect(parseTags("")).toEqual([]);
  });
  it("site: blank clears, lat/lon validated", () => {
    expect(parseSite("  ")).toBeNull();
    expect(parseSite("39.1755, -94.4861")).toEqual({ lat: 39.1755, lon: -94.4861 });
    for (const bad of ["39.1", "91, 0", "0, 181", "a, b", "1,2,3", "39.1,", ", -94"]) expect(() => parseSite(bad)).toThrow("Site must be 'lat, lon'");
  });
  it("site → location: keeps lookup fields, clears coordinates on blank", () => {
    const loc = { lat: 1, lon: 2, city: "X", source: "rr" };
    expect(siteLocation(loc, { lat: 3, lon: 4 })).toEqual({ lat: 3, lon: 4, city: "X", source: "operator" });
    expect(siteLocation(loc, null)).toEqual({ city: "X", source: "rr" });
    expect(siteLocation(undefined, null)).toBeUndefined();
  });
  it("tone select value ↔ channel fields", () => {
    expect(toneValue({})).toBe("");
    expect(toneValue({ ctcssHz: 100 })).toBe("100.0");
    expect(toneValue({ dcsCode: "023N" })).toBe("dcs:023N");
    expect(toneFromValue("")).toEqual({ ctcssHz: null, dcsCode: null });
    expect(toneFromValue("100.0")).toEqual({ ctcssHz: 100, dcsCode: null });
    expect(toneFromValue("dcs:023I")).toEqual({ ctcssHz: null, dcsCode: "023I" });
  });
  it("new channel body carries only set fields", () => {
    expect(newChannelBody({ freq: 1, alphaTag: " A ", mode: "fm", audible: true, tags: [] })).toEqual(
      { freq: 1, alphaTag: "A", mode: "fm", enabled: true, audible: true });
    const loc = { lat: 1, lon: 2, source: "places" };
    expect(newChannelBody({ freq: 1, alphaTag: "", mode: "nfm", audible: false, tags: ["air"], location: loc })).toEqual(
      { freq: 1, alphaTag: "", mode: "nfm", enabled: true, audible: false, tags: ["air"], location: loc });
  });
});

describe("banks", () => {
  it("describes the rule and the profile", () => {
    expect(bankRule(air)).toBe("Tagged air");
    expect(bankRule(uhf)).toBe("UHF band");
    expect(bankRule({ id: "r", name: "2m", enabled: true, loHz: 144_000_000, hiHz: 148_000_000 })).toBe("144–148 MHz");
    expect(bankRule({ id: "e", name: "Everything", enabled: true })).toBe("Every channel");
    expect(profileText({ ...air, openAboveFloorDb: 6, hangMs: 2000, dwellWeight: 2 })).toBe("Opens at 6 dB · hang 2 s · dwell ×2");
    expect(profileText(air)).toBe("");
  });
  it("builds a bank from the form, or throws a plain error", () => {
    expect(bankFromForm({ name: " Air ", band: "", lo: "", hi: "", tags: "air" }, "bk_1"))
      .toEqual({ id: "bk_1", name: "Air", enabled: true, tags: ["air"] });
    expect(bankFromForm({ name: "2m", band: "vhf", lo: "144", hi: "148", tags: "" }, "bk_2"))
      .toEqual({ id: "bk_2", name: "2m", enabled: true, band: "vhf", loHz: 144_000_000, hiHz: 148_000_000 });
    expect(() => bankFromForm({ name: " ", band: "", lo: "", hi: "", tags: "" }, "x")).toThrow("Give the bank a name");
    expect(() => bankFromForm({ name: "a", band: "", lo: "x", hi: "", tags: "" }, "x")).toThrow("From must be in MHz");
    expect(() => bankFromForm({ name: "a", band: "", lo: "148", hi: "144", tags: "" }, "x")).toThrow("To must be above From");
  });
  it("parses a profile (blank = global) and applies it", () => {
    expect(profileFromForm({ open: "", hang: "", dwell: "" })).toEqual({});
    expect(profileFromForm({ open: "6", hang: "1500", dwell: "0.5" })).toEqual({ openAboveFloorDb: 6, hangMs: 1500, dwellWeight: 0.5 });
    expect(() => profileFromForm({ open: "0", hang: "", dwell: "" })).toThrow("Squelch open must be a number above 0");
    expect(() => profileFromForm({ open: "", hang: "x", dwell: "" })).toThrow("Hang time must be a number above 0");
    expect(withProfile({ ...air, hangMs: 9 }, { dwellWeight: 2 })).toEqual({ ...air, dwellWeight: 2 });
  });
  it("offers toggles only where a tag change flips membership", () => {
    const vhfAir: Bank = { id: "bk_va", name: "VHF air", enabled: true, band: "vhf", tags: ["air"] };
    const t = bankToggles(B, [air, uhf, vhfAir]);
    expect(t).toEqual([
      { id: "bk_air", name: "Air", member: false, next: ["air"] },
      { id: "bk_uhf", name: "UHF", member: true, next: null },
      { id: "bk_va", name: "VHF air", member: false, next: null }, // B is UHF: a tag can't make it a member
    ]);
    expect(bankToggles(A, [air])).toEqual([{ id: "bk_air", name: "Air", member: true, next: [] }]);
  });
  it("bulk patch snapshots exactly what it changed", () => {
    const { channels, before } = bulkPatch([A, B, C], air, { enabled: true, audible: false });
    expect(channels.find((c) => c.id === "a")).toMatchObject({ enabled: true, audible: false });
    expect(channels.find((c) => c.id === "b")).toBe(B);
    expect([...before.entries()]).toEqual([["a", { enabled: true, audible: undefined }]]);
  });
});

describe("analytics", () => {
  it("summarises active rows and scales the signal line", () => {
    const rows = [
      { ts: 3, durationMs: 2000, rfDb: -10, alphaTag: "x" },
      { ts: 2, durationMs: null, rfDb: null, alphaTag: "x" },
      { ts: 1, durationMs: 1000, rfDb: -20, alphaTag: "x" },
    ];
    const s = signalSeries(rows, 100, 50);
    expect(s.active).toHaveLength(2);
    expect(s.airtimeMs).toBe(3000);
    expect(s.samples).toBe(2);
    expect(s.min).toBe(-22);
    expect(s.max).toBe(-8);
    expect(s.points).toBe("0.0,42.9 100.0,7.1");
    expect(signalSeries([], 100, 50).points).toBe("");
  });
});

describe("ago", () => {
  it("is relative, then a date", () => {
    expect(ago(1_000_000, 1_000_000 + 30_000)).toBe("just now");
    expect(ago(0, 5 * 60_000)).toBe("5 min ago");
    expect(ago(0, 3 * 3_600_000)).toBe("3 h ago");
  });
});

describe("resolveDetail", () => {
  const disc: Discovery = { id: "cc_1", freq: 462_562_500, alphaTag: "Close Call 462.5625", ts: 1 };
  const data = { channels: [A, B, C], cfg: { discoveries: [disc] } };
  it("finds a channel by id, or says it's gone", () => {
    expect(resolveDetail({ kind: "ch", id: "a" }, data)).toEqual({ kind: "edit", channel: A });
    expect(resolveDetail({ kind: "ch", id: "zz" }, data)).toEqual({ kind: "gone", message: "This channel is no longer in the library." });
  });
  it("by frequency prefers a tracked channel, else offers to add it", () => {
    const twin = ch({ id: "a2", freq: A.freq, enabled: false });
    expect(resolveDetail({ kind: "hz", hz: A.freq }, { ...data, channels: [twin, A] })).toEqual({ kind: "edit", channel: A });
    expect(resolveDetail({ kind: "hz", hz: 121_800_000 }, data)).toEqual({ kind: "add", draft: emptyDraft({ freq: 121_800_000 }) });
  });
  it("by frequency with no channel offers the newest pending discovery there", () => {
    const hz = 151_820_000;
    const old: Discovery = { id: "cc_old", freq: hz, alphaTag: "Close Call 151.8200", ts: 10 };
    const fresh: Discovery = { id: "cc_new", freq: hz, alphaTag: "Walmart ops", ts: 20 };
    const hidden: Discovery = { id: "cc_sup", freq: hz, alphaTag: "Hidden", ts: 30, suppressedAt: 31 };
    const cfg = { discoveries: [old, hidden, fresh] };
    expect(resolveDetail({ kind: "hz", hz }, { channels: [A], cfg }))
      .toEqual({ kind: "add", draft: draftFromDiscovery(fresh), from: fresh });
    // Only a suppressed one there: a blank add, not the suppressed row.
    expect(resolveDetail({ kind: "hz", hz }, { channels: [A], cfg: { discoveries: [hidden] } }))
      .toEqual({ kind: "add", draft: emptyDraft({ freq: hz }) });
    // A channel at the frequency still wins over a discovery.
    const at = ch({ id: "z", freq: hz });
    expect(resolveDetail({ kind: "hz", hz }, { channels: [at], cfg })).toEqual({ kind: "edit", channel: at });
  });
  it("add: blank, tagged, or from a discovery that may be gone", () => {
    expect(resolveDetail({ kind: "add" }, data)).toEqual({ kind: "add", draft: emptyDraft() });
    expect(resolveDetail({ kind: "add", tag: "air" }, data)).toEqual({ kind: "add", draft: emptyDraft({ tag: "air" }) });
    expect(resolveDetail({ kind: "add", from: "cc_1" }, data)).toEqual({ kind: "add", draft: draftFromDiscovery(disc), from: disc });
    expect(resolveDetail({ kind: "add", from: "cc_x" }, data)).toEqual({
      kind: "gone", message: "That discovery was already added, dismissed or locked out." });
  });
});

describe("detailFieldsToPatch", () => {
  it("repaints only changed fields the operator isn't touching", () => {
    const next = { ...A, alphaTag: "New name", audible: false, mode: "fm" as const, priority: true };
    expect(detailFieldsToPatch(A, next, { focused: null, dirty: new Set(), inflight: new Set() }).sort())
      .toEqual(["audible", "mode", "name", "priority"]);
    expect(detailFieldsToPatch(A, next, { focused: "name", dirty: new Set(["mode"]), inflight: new Set(["audible"]) }))
      .toEqual(["priority"]);
    expect(detailFieldsToPatch(A, A, { focused: null, dirty: new Set(), inflight: new Set() })).toEqual([]);
  });
});

describe("lockoutSnapshot", () => {
  it("captures dropped discoveries and prior enabled flags at the frequency", () => {
    const cfg = { version: 1, scan: {}, audio: {}, channels: [A, { ...C, freq: A.freq }], discoveries: [{ id: "d", freq: A.freq, alphaTag: "", ts: 0 }] } as unknown as import("../src/backend/config/schema.js").Config;
    const s = lockoutSnapshot(cfg, A.freq);
    expect(s.discoveries.map((d) => d.id)).toEqual(["d"]);
    expect([...s.enabled.entries()]).toEqual([["a", true], ["c", false]]);
    expect(s.wasLocked).toBe(false);
  });
  it("remembers a frequency that was already locked out, so Undo keeps it locked", () => {
    const cfg = { version: 1, scan: { lockoutHz: [A.freq] }, audio: {}, channels: [A] } as unknown as import("../src/backend/config/schema.js").Config;
    expect(lockoutSnapshot(cfg, A.freq).wasLocked).toBe(true);
    expect(lockoutSnapshot(cfg, B.freq).wasLocked).toBe(false);
  });
});

describe("restoreDiscovery", () => {
  it("clears all suppression bookkeeping, not just the suppressed flag", () => {
    // The server re-suppresses on hitCount >= 6 once suppressedAt is cleared,
    // so a restore that leaves hitCount intact gets undone on the next hit.
    const restored = restoreDiscovery({
      id: "cc_1", freq: 462887500, alphaTag: "Close Call 462.8875", ts: 1,
      hitCount: 9, lastSeenAt: 123, suppressedAt: 456, suppressionReason: "Likely repeated noise",
    });
    expect(restored.suppressedAt).toBeUndefined();
    expect(restored.suppressionReason).toBeUndefined();
    expect(restored.hitCount).toBeUndefined();
    expect(restored.lastSeenAt).toBeUndefined();
    expect(restored.id).toBe("cc_1"); // identity + other fields preserved
    expect(restored.freq).toBe(462887500);
  });
});
