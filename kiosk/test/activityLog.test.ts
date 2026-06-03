import { describe, it, expect } from "vitest";
import { ActivityLog } from "../src/backend/activityLog.js";

describe("ActivityLog", () => {
  it("stores entries newest-first", () => {
    const log = new ActivityLog(3);
    log.add({ freq: 1, alphaTag: "a", ts: 100 });
    log.add({ freq: 2, alphaTag: "b", ts: 200 });
    expect(log.entries().map((e) => e.freq)).toEqual([2, 1]);
  });

  it("caps at capacity, dropping oldest", () => {
    const log = new ActivityLog(2);
    log.add({ freq: 1, alphaTag: "a", ts: 1 });
    log.add({ freq: 2, alphaTag: "b", ts: 2 });
    log.add({ freq: 3, alphaTag: "c", ts: 3 });
    expect(log.entries().map((e) => e.freq)).toEqual([3, 2]);
  });

  it("returns a copy (caller cannot mutate internals)", () => {
    const log = new ActivityLog(2);
    log.add({ freq: 1, alphaTag: "a", ts: 1 });
    log.entries().push({ freq: 9, alphaTag: "x", ts: 9 });
    expect(log.entries().length).toBe(1);
  });
});
