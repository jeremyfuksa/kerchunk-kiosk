import { describe, it, expect } from "vitest";
import { createIdleLoop } from "../src/frontend/lib/idleLoop.js";

// A controllable scheduler: frames queue up and run only when flushed.
function fakeScheduler() {
  let q: Array<() => void> = [];
  return {
    schedule: (cb: () => void) => { q.push(cb); },
    flush: () => { const s = q; q = []; s.forEach((fn) => fn()); },
    pending: () => q.length,
  };
}

describe("createIdleLoop", () => {
  it("wake() starts the loop and tick runs on the next frame", () => {
    const s = fakeScheduler();
    let ticks = 0;
    const loop = createIdleLoop({ tick: () => { ticks++; return false; }, schedule: s.schedule });
    expect(loop.running).toBe(false);
    loop.wake();
    expect(loop.running).toBe(true);
    expect(ticks).toBe(0);     // not yet — scheduled, not run
    s.flush();
    expect(ticks).toBe(1);
  });

  it("keeps scheduling while tick returns true, suspends when it returns false", () => {
    const s = fakeScheduler();
    let ticks = 0;
    const loop = createIdleLoop({ tick: () => { ticks++; return ticks < 3; }, schedule: s.schedule });
    loop.wake();
    s.flush(); // tick 1 -> true -> reschedules
    expect(loop.running).toBe(true);
    expect(s.pending()).toBe(1);
    s.flush(); // tick 2 -> true -> reschedules
    s.flush(); // tick 3 -> false -> suspends
    expect(ticks).toBe(3);
    expect(loop.running).toBe(false);
    expect(s.pending()).toBe(0);
  });

  it("wake() while running is a no-op (no double scheduling)", () => {
    const s = fakeScheduler();
    const loop = createIdleLoop({ tick: () => true, schedule: s.schedule });
    loop.wake();
    expect(s.pending()).toBe(1);
    loop.wake();
    expect(s.pending()).toBe(1); // still one
  });

  it("wake() after suspension resumes the loop", () => {
    const s = fakeScheduler();
    let cont = false;
    const loop = createIdleLoop({ tick: () => cont, schedule: s.schedule });
    loop.wake(); s.flush();          // tick -> false -> suspended
    expect(loop.running).toBe(false);
    cont = true;
    loop.wake();                     // resume
    expect(loop.running).toBe(true);
    expect(s.pending()).toBe(1);
  });

  it("stop() suspends and prevents further wake()", () => {
    const s = fakeScheduler();
    const loop = createIdleLoop({ tick: () => true, schedule: s.schedule });
    loop.wake();
    loop.stop();
    expect(loop.running).toBe(false);
    loop.wake();
    expect(loop.running).toBe(false);
    expect(s.pending()).toBe(1); // one inert frame remains from wake(); stop() prevented any new scheduling
  });
});
