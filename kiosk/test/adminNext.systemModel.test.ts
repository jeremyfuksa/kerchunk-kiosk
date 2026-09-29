import { describe, it, expect } from "vitest";
import type { Config } from "../src/backend/config/schema.js";
import {
  sparkPoints, vitals, uptimeText, verdictView, alertsView, withMaps, mapsState, unlockSnapshot,
  SYSTEM_ACTION_COPY, TEST_ALERTS, TEMP_WARN_C, type SystemSnapshot,
} from "../src/frontend/admin-next/systemModel.js";

const now = {
  ts: 1, cpuPct: 34, helperCpuPct: 20, helperRssMb: 60, load1: 1, memUsedPct: 41, backendRssMb: 90,
  tempC: 58, throttled: false, diskFreeMb: 194_560, openCount: 3,
};
const snap = (o: Partial<SystemSnapshot> = {}): SystemSnapshot => ({
  now, ring: [{ ...now, cpuPct: 30, tempC: 57 }, now], alerts: [], safetyMode: false,
  health: { verdict: "healthy", reason: "Scanning normally." }, coreCount: 8, ...o,
});

describe("sparkPoints", () => {
  it("scales values into W×H, nulls sit on the floor, one value spans the width", () => {
    expect(sparkPoints([0, 50, 100], 100, 100, 20)).toBe("0.0,20.0 50.0,10.0 100.0,0.0");
    expect(sparkPoints([null, 200], 100, 100, 20)).toBe("0.0,20.0 100.0,0.0");
    expect(sparkPoints([], 100)).toBe("");
  });
});

describe("vitals", () => {
  it("formats the four main vitals and the secondary lines", () => {
    const v = vitals(snap())!;
    expect(v.main.map((m) => [m.id, m.label, m.value, m.hot])).toEqual([
      ["temp", "Temperature", "58°C", false],
      ["cpu", "CPU", "34%", false],
      ["helper", "DSP helper", "0.2 of 8 cores", false],
      ["disk", "Disk free", "190 GB", false],
    ]);
    expect(v.main[0]!.spark).toBe(sparkPoints([57, 58], 100));
    expect(v.main[3]!.spark).toBeNull();
    expect(v.secondary).toEqual(["RAM 41% · backend 90 MB", "3 channels open"]);
  });
  it("marks hot vitals and says 'throttled'", () => {
    const hot = { ...now, tempC: TEMP_WARN_C, throttled: true, cpuPct: 90, helperCpuPct: 700, diskFreeMb: 1024, memUsedPct: 95, openCount: 1 };
    const v = vitals(snap({ now: hot }))!;
    expect(v.main.map((m) => m.hot)).toEqual([true, true, true, true]);
    expect(v.main[0]!.value).toBe(`${TEMP_WARN_C}°C · throttled`);
    expect(v.main[3]!.value).toBe("1.0 GB");
    expect(v.secondary[0]).toBe("RAM 95% · backend 90 MB — high");
    expect(v.secondary[1]).toBe("1 channel open");
  });
  it("degrades missing readings to dashes, and returns null with no sample", () => {
    const bare = { ...now, tempC: null, helperCpuPct: null, helperRssMb: null, diskFreeMb: null, throttled: null };
    const v = vitals(snap({ now: bare }))!;
    expect(v.main.map((m) => m.value)).toEqual(["—", "34%", "Not running", "—"]);
    expect(v.main.some((m) => m.hot)).toBe(false);
    expect(vitals(snap({ now: null }))).toBeNull();
  });
});

describe("uptimeText", () => {
  it("reads days/hours/minutes", () => {
    const t = 10_000_000_000;
    expect(uptimeText(null, t)).toBe("");
    expect(uptimeText(t - 30_000, t)).toBe("up less than a minute");
    expect(uptimeText(t - 5 * 60_000, t)).toBe("up 5 min");
    expect(uptimeText(t - (3 * 3600 + 20 * 60) * 1000, t)).toBe("up 3 h 20 min");
    expect(uptimeText(t - (3 * 86400 + 4 * 3600) * 1000, t)).toBe("up 3 d 4 h");
  });
});

describe("verdictView and alertsView", () => {
  it("labels the verdict, worse of health and alerts, or unknown", () => {
    expect(verdictView(snap())).toEqual({ verdict: "healthy", label: "Healthy", reason: "Scanning normally." });
    const severe = { id: "t", severity: "severe" as const, title: "Overheating", message: "m", help: "h" };
    expect(verdictView(snap({ alerts: [severe] }))).toEqual({ verdict: "trouble", label: "Trouble", reason: "Overheating" });
    expect(verdictView(snap({ health: { verdict: "stressed", reason: "Busy." } }))).toMatchObject({ label: "Degraded" });
    expect(verdictView(null)).toEqual({ verdict: "unknown", label: "Unknown", reason: "Can't reach the radio" });
  });
  it("falls back to unknown when health.verdict isn't a recognized value", () => {
    const weird = snap({ health: { verdict: "bogus" as never, reason: "Odd reading." } });
    expect(verdictView(weird)).toEqual({ verdict: "unknown", label: "Unknown", reason: "Odd reading." });
    const noReason = snap({ health: { verdict: "bogus" as never, reason: "" } });
    expect(verdictView(noReason)).toEqual({ verdict: "unknown", label: "Unknown", reason: "Can't reach the radio" });
  });
  it("lists alerts, severe first, and flags protection only in safety mode", () => {
    const a = { id: "a", severity: "attention" as const, title: "A", message: "", help: "" };
    const s = { id: "s", severity: "severe" as const, title: "S", message: "", help: "" };
    expect(alertsView(snap({ alerts: [a, s] })).alerts.map((x) => x.id)).toEqual(["s", "a"]);
    expect(alertsView(snap()).protection).toBe(false);
    expect(alertsView(snap({ safetyMode: true })).protection).toBe(true);
  });
});

describe("maps", () => {
  const base = { display: { weatherLat: 39, weatherLon: -94, googleMapsApiKey: "AIzaOLD" } } as unknown as Config;
  it("sets, trims and clears the key and Map ID", () => {
    expect(withMaps(base, " AIzaNEW ", "").display).toEqual({ weatherLat: 39, weatherLon: -94, googleMapsApiKey: "AIzaNEW" });
    expect(withMaps(base, "", " vec1 ").display).toEqual({ weatherLat: 39, weatherLon: -94, googleMapsMapId: "vec1" });
    expect(base.display!.googleMapsApiKey).toBe("AIzaOLD"); // input not mutated
  });
  it("refuses without a display block", () => {
    expect(() => withMaps({} as Config, "k", "")).toThrow("Set a weather location first — the map needs coordinates.");
    const bare = {} as Config;
    expect(withMaps(bare, "", "")).toBe(bare); // unchanged ⇒ the same object, so the caller skips the PUT
  });
  it("says whether a key is set", () => {
    expect(mapsState(base)).toBe("connected");
    expect(mapsState({} as Config)).toBe("not set");
  });
});

describe("unlockSnapshot", () => {
  it("records each channel's enabled flag at the frequency", () => {
    const cfg = { channels: [
      { id: "a", freq: 5, enabled: false }, { id: "b", freq: 5, enabled: true }, { id: "c", freq: 6, enabled: false },
    ] } as unknown as Config;
    expect([...unlockSnapshot(cfg, 5).enabled.entries()]).toEqual([["a", false], ["b", true]]);
  });
});

describe("copy", () => {
  it("names the three power actions and warns about scanning", () => {
    expect(Object.keys(SYSTEM_ACTION_COPY)).toEqual(["restart", "reboot", "poweroff"]);
    expect(SYSTEM_ACTION_COPY.restart.confirmLabel).toBe("Restart radio");
    expect(SYSTEM_ACTION_COPY.poweroff.message).toContain("power button");
    expect(TEST_ALERTS[0]).toBe("TORNADO WARNING");
  });
});
