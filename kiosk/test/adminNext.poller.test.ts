import { describe, it, expect } from "vitest";
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
});
