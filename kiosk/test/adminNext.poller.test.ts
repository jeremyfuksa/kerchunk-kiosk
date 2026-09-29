import { describe, it, expect, vi, afterEach } from "vitest";
import { Poller } from "../src/frontend/admin-next/poller.js";

function harness() {
  let t = 0;
  const log: string[] = [];
  const p = new Poller({ now: () => t, hidden: () => false });
  return { p, log, advance: (ms: number) => { t += ms; } };
}

describe("Poller", () => {
  it("runs due polls in registration order, one at a time", async () => {
    const { p, log } = harness();
    let inFlight = 0; let maxInFlight = 0;
    const mk = (name: string) => async () => {
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve(); log.push(name); inFlight--;
    };
    p.add({ name: "a", run: mk("a"), everyMs: 1000 });
    p.add({ name: "b", run: mk("b"), everyMs: 1000 });
    await p.tick("radio");
    expect(log).toEqual(["a", "b"]);
    expect(maxInFlight).toBe(1);
  });
  it("respects cadence and tab filters", async () => {
    const { p, log, advance } = harness();
    p.add({ name: "every", run: async () => { log.push("every"); }, everyMs: 1000 });
    p.add({ name: "sys", run: async () => { log.push("sys"); }, everyMs: 1000, tabs: ["system"] });
    await p.tick("radio");
    advance(500); await p.tick("radio");
    advance(600); await p.tick("system");
    expect(log).toEqual(["every", "every", "sys"]);
  });
  it("makeDue forces a tab's polls to run now", async () => {
    const { p, log } = harness();
    p.add({ name: "a", run: async () => { log.push("a"); }, everyMs: 60_000 });
    await p.tick("radio");
    p.makeDue("radio");
    await p.tick("radio");
    expect(log).toEqual(["a", "a"]);
  });
  it("does not overlap ticks and swallows run errors", async () => {
    const { p, log } = harness();
    p.add({ name: "boom", run: async () => { throw new Error("x"); }, everyMs: 1 });
    p.add({ name: "ok", run: async () => { log.push("ok"); }, everyMs: 1 });
    await Promise.all([p.tick("radio"), p.tick("radio")]);
    expect(log).toEqual(["ok"]);
  });
  it("skips when hidden or when() is false", async () => {
    let hidden = true; const log: string[] = [];
    const p = new Poller({ now: () => 0, hidden: () => hidden });
    p.add({ name: "a", run: async () => { log.push("a"); }, everyMs: 1 });
    p.add({ name: "b", run: async () => { log.push("b"); }, everyMs: 1, when: () => false });
    await p.tick("radio"); hidden = false; await p.tick("radio");
    expect(log).toEqual(["a"]);
  });

  describe("start", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    });

    it("a second start() is a no-op", async () => {
      vi.useFakeTimers();
      const addEventListener = vi.fn();
      vi.stubGlobal("document", { hidden: false, addEventListener });
      const p = new Poller({ hidden: () => false });
      let count = 0;
      p.add({ name: "a", run: async () => { count++; }, everyMs: 1 });
      const getTab = () => "radio" as const;
      p.start(getTab, 1000);
      p.start(getTab, 1000);
      await vi.advanceTimersByTimeAsync(1000);
      expect(count).toBe(1);
      expect(addEventListener).toHaveBeenCalledTimes(1);
    });
  });
});

describe("Poller.run (write lane)", () => {
  it("waits for an in-flight poll pass, and the next pass waits for it", async () => {
    const log: string[] = [];
    let release!: () => void;
    const p = new Poller({ now: () => 0, hidden: () => false });
    p.add({ name: "slow", everyMs: 0, run: () => new Promise<void>((r) => { log.push("poll:start"); release = () => { log.push("poll:end"); r(); }; }) });
    const pass = p.tick("radio");
    await Promise.resolve();
    const write = p.run(async () => { log.push("write"); return 7; });
    await Promise.resolve();
    expect(log).toEqual(["poll:start"]);
    release();
    await expect(write).resolves.toBe(7);
    await pass;
    expect(log).toEqual(["poll:start", "poll:end", "write"]);
  });
  it("a rejected run rejects its caller but not the lane", async () => {
    const p = new Poller({ now: () => 0, hidden: () => false });
    await expect(p.run(async () => { throw new Error("nope"); })).rejects.toThrow("nope");
    await expect(p.run(async () => "ok")).resolves.toBe("ok");
  });
  it("runs queued writes in order, one at a time", async () => {
    const p = new Poller({ now: () => 0, hidden: () => false });
    let inFlight = 0; let max = 0; const order: number[] = [];
    const w = (n: number) => p.run(async () => { inFlight++; max = Math.max(max, inFlight); await Promise.resolve(); order.push(n); inFlight--; });
    await Promise.all([w(1), w(2), w(3)]);
    expect(order).toEqual([1, 2, 3]);
    expect(max).toBe(1);
  });
});
