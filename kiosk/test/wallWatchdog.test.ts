import { describe, it, expect } from "vitest";
import { WallWatchdog, isLoopback, wallWatchdogSchema, type WallWatchdogSettings } from "../src/backend/wallWatchdog.js";

const SETTINGS: WallWatchdogSettings = { enabled: true, staleMs: 60_000, graceMs: 120_000, maxBackoffMs: 480_000 };

function rig(opts: { active?: boolean; settings?: Partial<WallWatchdogSettings> } = {}) {
  let t = 0;
  let active = opts.active ?? true;
  const restarts: number[] = [];
  const logs: string[] = [];
  const wd = new WallWatchdog({
    getSettings: () => ({ ...SETTINGS, ...opts.settings }),
    isDisplayActive: async () => active,
    restartDisplay: async () => { restarts.push(t); },
    now: () => t,
    log: (m) => logs.push(m),
  });
  return {
    wd, restarts, logs,
    at: (ms: number) => { t = ms; },
    setActive: (a: boolean) => { active = a; },
  };
}

describe("WallWatchdog", () => {
  it("leaves a wall that keeps beating alone", async () => {
    const r = rig();
    for (let ms = 0; ms <= 600_000; ms += 15_000) {
      r.at(ms);
      r.wd.beat();
      await r.wd.check();
    }
    expect(r.restarts).toEqual([]);
  });

  it("gives a fresh backend the grace window before the first beat is due", async () => {
    const r = rig();
    r.at(119_000); await r.wd.check();
    expect(r.restarts).toEqual([]);
    r.at(120_000); await r.wd.check();
    expect(r.restarts).toEqual([120_000]);
  });

  it("restarts the display once the beats stop for staleMs", async () => {
    const r = rig();
    r.at(200_000); r.wd.beat();
    r.at(259_000); await r.wd.check();
    expect(r.restarts).toEqual([]);
    r.at(261_000); await r.wd.check();
    expect(r.restarts).toEqual([261_000]);
    expect(r.logs.join("\n")).toMatch(/stale.*restarting kerchunk-display/);
  });

  it("backs off between restarts that don't bring the page back, capped", async () => {
    const r = rig();
    r.at(200_000); r.wd.beat();
    const restartsAt: number[] = [];
    for (let ms = 261_000; ms <= 3_000_000; ms += 1_000) {
      r.at(ms);
      await r.wd.check();
    }
    restartsAt.push(...r.restarts);
    const gaps = restartsAt.slice(1).map((t, i) => t - restartsAt[i]!);
    // grace, then doubling, then pinned at maxBackoffMs.
    expect(gaps.slice(0, 4)).toEqual([120_000, 240_000, 480_000, 480_000]);
  });

  it("a beat after a restart resets the backoff", async () => {
    const r = rig();
    r.at(200_000); r.wd.beat();
    r.at(261_000); await r.wd.check();          // restart #1, hold 120 s
    r.at(381_000); await r.wd.check();          // restart #2, hold 240 s
    expect(r.restarts).toEqual([261_000, 381_000]);
    r.at(400_000); r.wd.beat();                 // page came back
    r.at(461_000); await r.wd.check();          // stale again
    r.at(581_000); await r.wd.check();          // next one is 120 s later, not 240
    expect(r.restarts).toEqual([261_000, 381_000, 461_000, 581_000]);
  });

  it("never starts a display the operator stopped", async () => {
    const r = rig({ active: false });
    r.at(500_000); await r.wd.check();
    r.at(900_000); await r.wd.check();
    expect(r.restarts).toEqual([]);
    r.setActive(true);
    r.at(901_000); await r.wd.check();
    expect(r.restarts).toEqual([901_000]);
  });

  it("does nothing when disabled", async () => {
    const r = rig({ settings: { enabled: false } });
    r.at(10_000_000); await r.wd.check();
    expect(r.restarts).toEqual([]);
  });

  it("doesn't overlap checks while one is in flight", async () => {
    let answer!: (active: boolean) => void;
    let probes = 0;
    let restarts = 0;
    let t = 0;
    const wd = new WallWatchdog({
      getSettings: () => SETTINGS,
      isDisplayActive: () => { probes++; return new Promise<boolean>((res) => { answer = res; }); },
      restartDisplay: async () => { restarts++; },
      now: () => t,
      log: () => {},
    });
    t = 1_000_000;
    const first = wd.check();   // parks on the systemctl probe
    await wd.check();           // must not probe or restart a second time
    answer(true);
    await first;
    expect({ probes, restarts }).toEqual({ probes: 1, restarts: 1 });
  });
});

describe("wallWatchdogSchema", () => {
  it("fills every knob from an empty block", () => {
    expect(wallWatchdogSchema.parse({})).toEqual({ enabled: true, staleMs: 60_000, graceMs: 120_000, maxBackoffMs: 1_800_000 });
  });
});

describe("isLoopback", () => {
  it("accepts only the local machine", () => {
    expect(isLoopback("127.0.0.1")).toBe(true);
    expect(isLoopback("::1")).toBe(true);
    expect(isLoopback("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopback("100.101.102.103")).toBe(false);
    expect(isLoopback(undefined)).toBe(false);
  });
});
