import { describe, it, expect } from "vitest";
import { glance, UNREACHABLE_TEXT, worseVerdict } from "../src/frontend/admin/verdict.js";

const alert = (severity: "attention" | "severe", title: string) => ({ id: "t", severity, title, message: "", help: "" });

describe("worseVerdict", () => {
  it("passes health through when there are no alerts", () => {
    expect(worseVerdict({ verdict: "healthy", reason: "Scanning normally." }, [])).toEqual({ verdict: "healthy", text: "Scanning normally." });
  });
  it("an alert can only make it worse, and names the reason", () => {
    expect(worseVerdict({ verdict: "healthy", reason: "ok" }, [alert("attention", "Running hot")])).toEqual({ verdict: "stressed", text: "Running hot" });
    expect(worseVerdict({ verdict: "stressed", reason: "busy" }, [alert("severe", "Overheating")])).toEqual({ verdict: "trouble", text: "Overheating" });
  });
  it("never reads calmer than health", () => {
    expect(worseVerdict({ verdict: "trouble", reason: "helper down" }, [alert("attention", "x")])).toEqual({ verdict: "trouble", text: "helper down" });
  });
});

describe("glance", () => {
  const health = { verdict: "healthy" as const, reason: "Scanning normally." };
  it("adds the temperature from the same response", () => {
    expect(glance({ health, alerts: [], now: { tempC: 62.6 } })).toEqual({ verdict: "healthy", text: "Scanning normally · 63°C" });
  });
  it("omits the temperature when it is null or missing", () => {
    expect(glance({ health, alerts: [], now: { tempC: null } })).toEqual({ verdict: "healthy", text: "Scanning normally" });
    expect(glance({ health, alerts: [] })).toEqual({ verdict: "healthy", text: "Scanning normally" });
  });
  it("keeps the alert-escalation rule", () => {
    expect(glance({ health, alerts: [alert("severe", "Overheating")], now: { tempC: 89 } })).toEqual({ verdict: "trouble", text: "Overheating · 89°C" });
  });
  it("no response reads unknown, never a stale healthy", () => {
    expect(glance(null)).toEqual({ verdict: "unknown", text: UNREACHABLE_TEXT });
  });
  it("a body without health reads unknown, never stale-healthy", () => {
    expect(glance({} as never).verdict).toBe("unknown");
    expect(glance({ health: {} } as never).verdict).toBe("unknown");
  });
});
