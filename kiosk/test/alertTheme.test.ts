import { describe, it, expect } from "vitest";
import { alertTheme } from "../src/frontend/dashboard/alertTheme.js";

describe("alertTheme — severity tier", () => {
  it("a …WARNING is the loud 'warning' tier", () => {
    expect(alertTheme("TORNADO WARNING").tier).toBe("warning");
    expect(alertTheme("FLASH FLOOD WARNING").tier).toBe("warning");
  });
  it("a …WATCH is the calmer 'watch' tier", () => {
    expect(alertTheme("TORNADO WATCH").tier).toBe("watch");
    expect(alertTheme("SEVERE THUNDERSTORM WATCH").tier).toBe("watch");
  });
  it("a …STATEMENT is the subdued 'statement' tier", () => {
    expect(alertTheme("SEVERE WEATHER STATEMENT").tier).toBe("statement");
  });
  it("required tests read as subdued, never as a warning", () => {
    expect(alertTheme("REQUIRED WEEKLY TEST").tier).toBe("statement");
    expect(alertTheme("NATIONAL PERIODIC TEST").tier).toBe("statement");
  });
  it("an EAN-style emergency with no WATCH/STATEMENT word is a warning", () => {
    expect(alertTheme("EMERGENCY ACTION NOTIFICATION").tier).toBe("warning");
  });
});

describe("alertTheme — storm kind (color/icon selector)", () => {
  const cases: Array<[string, string]> = [
    ["TORNADO WARNING", "tornado"],
    ["TORNADO WATCH", "tornado"],
    ["SEVERE THUNDERSTORM WARNING", "severe"],
    ["SEVERE WEATHER STATEMENT", "severe"],
    ["FLASH FLOOD WARNING", "flood"],
    ["FLOOD WARNING", "flood"],
    ["WINTER STORM WARNING", "winter"],
    ["BLIZZARD WARNING", "winter"],
    ["ICE STORM WARNING", "winter"],
    ["HIGH WIND WARNING", "wind"],
    ["EXTREME WIND WARNING", "wind"],
    ["DUST STORM WARNING", "wind"],
    ["HURRICANE WARNING", "tropical"],
    ["TROPICAL STORM WARNING", "tropical"],
    ["FIRE WARNING", "fire"],
    ["CIVIL DANGER WARNING", "civil"],
    ["EVACUATION IMMEDIATE", "civil"],
    ["CHILD ABDUCTION EMERGENCY", "civil"],
    ["REQUIRED MONTHLY TEST", "test"],
  ];
  for (const [name, kind] of cases) {
    it(`${name} → ${kind}`, () => {
      expect(alertTheme(name).kind).toBe(kind);
    });
  }
  it("an unrecognized channel alert falls back to the default kind", () => {
    expect(alertTheme("MUTUAL AID DISPATCH").kind).toBe("default");
  });
});

describe("alertTheme — icon", () => {
  it("every theme carries a non-empty inline SVG icon", () => {
    for (const name of ["TORNADO WARNING", "FLOOD WARNING", "FIRE WARNING", "MUTUAL AID"]) {
      const icon = alertTheme(name).icon;
      expect(typeof icon).toBe("string");
      expect(icon).toContain("<svg");
    }
  });
});
