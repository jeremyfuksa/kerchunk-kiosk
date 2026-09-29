import { describe, it, expect } from "vitest";
import { durationLabel, migrateInsightHours, PAUSE_S } from "../src/frontend/admin/radio.js";

describe("Pause key label", () => {
  it("is derived from PAUSE_S", () => {
    expect(PAUSE_S).toBe(1800);
    expect(durationLabel(PAUSE_S)).toBe("30 min");
  });
  it("formats hours and minutes", () => {
    expect(durationLabel(3600)).toBe("1 h");
    expect(durationLabel(5400)).toBe("1 h 30 min");
    expect(durationLabel(600)).toBe("10 min");
  });
});

describe("migrateInsightHours", () => {
  function store(initial: Record<string, string> = {}) {
    const data = new Map(Object.entries(initial));
    return {
      data,
      get: (k: string) => data.get(k) ?? null,
      set: (k: string, v: string) => { data.set(k, v); },
      remove: (k: string) => { data.delete(k); },
    };
  }

  it("defaults to 24 when neither key exists", () => {
    const s = store();
    expect(migrateInsightHours(s.get, s.set, s.remove)).toBe(24);
  });

  it("uses the new key when already present, untouched", () => {
    const s = store({ "kerchunk.admin.insightHours": "6" });
    expect(migrateInsightHours(s.get, s.set, s.remove)).toBe(6);
    expect(s.data.size).toBe(1);
  });

  it("migrates the old admin-next key once: writes new, drops old", () => {
    const s = store({ "kerchunk.adminNext.insightHours": "12" });
    expect(migrateInsightHours(s.get, s.set, s.remove)).toBe(12);
    expect(s.data.get("kerchunk.admin.insightHours")).toBe("12");
    expect(s.data.has("kerchunk.adminNext.insightHours")).toBe(false);
  });

  it("prefers the new key over a stale old one", () => {
    const s = store({ "kerchunk.admin.insightHours": "6", "kerchunk.adminNext.insightHours": "12" });
    expect(migrateInsightHours(s.get, s.set, s.remove)).toBe(6);
    expect(s.data.get("kerchunk.adminNext.insightHours")).toBe("12");
  });
});
