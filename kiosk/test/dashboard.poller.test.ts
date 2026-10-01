import { describe, it, expect } from "vitest";
import { createPoller } from "../src/frontend/dashboard/poller.js";

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("dashboard poller (one request at a time — the appliance deadlocks on 2+)", () => {
  it("runs due polls one after another, never overlapping", async () => {
    let now = 0; let inFlight = 0; let maxInFlight = 0; const order: string[] = [];
    const p = createPoller(() => now);
    const job = (name: string) => async () => { inFlight++; maxInFlight = Math.max(maxInFlight, inFlight); order.push(name); await flush(); inFlight--; };
    p.poll("a", job("a"), 5_000); p.poll("b", job("b"), 10_000);
    await p.tick();
    expect(order).toEqual(["a", "b"]);
    expect(maxInFlight).toBe(1);
  });
  it("respects cadence", async () => {
    let now = 0; let runs = 0;
    const p = createPoller(() => now);
    p.poll("a", async () => { runs++; }, 5_000);
    await p.tick(); now = 1_000; await p.tick(); now = 6_000; await p.tick();
    expect(runs).toBe(2);
  });
  it("request(name) makes the next tick run it early — through the queue, not out of band", async () => {
    let now = 0; let runs = 0;
    const p = createPoller(() => now);
    p.poll("status", async () => { runs++; }, 5_000);
    await p.tick(); now = 1_000;
    p.request("status");
    expect(runs).toBe(1);          // not run synchronously
    await p.tick();
    expect(runs).toBe(2);
  });
  it("a tick while one is running is skipped", async () => {
    let now = 0; let runs = 0; let release!: () => void;
    const p = createPoller(() => now);
    p.poll("a", () => new Promise<void>((r) => { runs++; release = r; }), 0);
    const first = p.tick(); await p.tick();
    release(); await first;
    expect(runs).toBe(1);
  });
  it("a failing poll doesn't stop the rest", async () => {
    let ok = 0;
    const p = createPoller(() => 0);
    p.poll("bad", async () => { throw new Error("x"); }, 0);
    p.poll("good", async () => { ok++; }, 0);
    await p.tick();
    expect(ok).toBe(1);
  });
});
