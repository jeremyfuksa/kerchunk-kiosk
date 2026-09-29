import { describe, it, expect } from "vitest";
import { durationLabel, PAUSE_S } from "../src/frontend/admin/radio.js";

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
