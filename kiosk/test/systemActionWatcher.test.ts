import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SystemActionWatcher, type SystemActionPhase } from "../src/frontend/lib/systemActionWatcher.js";

// A probe stand-in: scripted per-tick so a test can say "up, up, down, down, up".
function scriptedProbe(script: Array<number | null>): () => Promise<{ startedAt?: number }> {
  let i = 0;
  return () => {
    const step = script[Math.min(i, script.length - 1)];
    i += 1;
    if (step === null) return Promise.reject(new Error("fetch failed"));
    return Promise.resolve({ startedAt: step });
  };
}

// Fake timers only advance the clock; the probe resolves on the microtask
// queue, so each poll needs a tick of real await to settle.
async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

describe("SystemActionWatcher", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("reports pending immediately, then down, then back across a restart", async () => {
    const phases: SystemActionPhase[] = [];
    const w = new SystemActionWatcher({
      probe: scriptedProbe([null, null, 2000]),
      baselineStartedAt: 1000,
      onPhase: (p) => phases.push(p),
      pollMs: 100,
      downPollMs: 100,
      timeoutMs: 10_000,
    });
    w.start();
    expect(phases).toEqual(["pending"]);
    await advance(100);
    expect(phases).toEqual(["pending", "down"]);
    await advance(100); // still down — "down" is announced once, not per poll
    expect(phases).toEqual(["pending", "down"]);
    await advance(100);
    expect(phases).toEqual(["pending", "down", "back"]);
  });

  it("detects a restart it never saw go down, via a changed startedAt", async () => {
    // The whole restart fits between two polls: every probe succeeds, but the
    // backend answering is a different process than the one we asked.
    const phases: SystemActionPhase[] = [];
    const w = new SystemActionWatcher({
      probe: scriptedProbe([1000, 2000]),
      baselineStartedAt: 1000,
      onPhase: (p) => phases.push(p),
      pollMs: 100,
      timeoutMs: 10_000,
    });
    w.start();
    await advance(100);
    expect(phases).toEqual(["pending"]);
    await advance(100);
    expect(phases).toEqual(["pending", "back"]);
  });

  it("reports unchanged when the same backend keeps answering past the timeout", async () => {
    // sudo failed / the unit never went down: the UI must return to normal
    // rather than sit on "Restarting backend…" forever.
    const phases: SystemActionPhase[] = [];
    const w = new SystemActionWatcher({
      probe: scriptedProbe([1000]),
      baselineStartedAt: 1000,
      onPhase: (p) => phases.push(p),
      pollMs: 100,
      timeoutMs: 250,
    });
    w.start();
    await advance(200);
    expect(phases).toEqual(["pending"]);
    await advance(100);
    expect(phases).toEqual(["pending", "unchanged"]);
  });

  it("stops polling once the backend is back", async () => {
    let calls = 0;
    const w = new SystemActionWatcher({
      probe: () => { calls += 1; return Promise.resolve({ startedAt: 2000 }); },
      baselineStartedAt: 1000,
      onPhase: () => {},
      pollMs: 100,
      timeoutMs: 10_000,
    });
    w.start();
    await advance(100);
    expect(calls).toBe(1);
    await advance(1000);
    expect(calls).toBe(1);
  });

  it("keeps watching a powered-off appliance so it recovers when it returns", async () => {
    // Shut down: the backend may never come back, but if the operator presses
    // the power button the admin must un-stick itself.
    const phases: SystemActionPhase[] = [];
    const w = new SystemActionWatcher({
      probe: scriptedProbe([null, null, null, null, 2000]),
      baselineStartedAt: 1000,
      onPhase: (p) => phases.push(p),
      pollMs: 100,
      downPollMs: 500,
      timeoutMs: 250,
    });
    w.start();
    await advance(100);
    expect(phases).toEqual(["pending", "down"]);
    await advance(1500); // well past timeoutMs — a down backend never "times out"
    expect(phases).toEqual(["pending", "down"]);
    await advance(500);
    expect(phases).toEqual(["pending", "down", "back"]);
  });

  it("ignores a network blip: the same instance answering is not a restart", async () => {
    const phases: SystemActionPhase[] = [];
    const w = new SystemActionWatcher({
      probe: scriptedProbe([null, 1000, 1000, 1000]),
      baselineStartedAt: 1000,
      onPhase: (p) => phases.push(p),
      pollMs: 100,
      downPollMs: 100,
      timeoutMs: 10_000,
    });
    w.start();
    await advance(100);
    expect(phases).toEqual(["pending", "down"]);
    // Not "back" — same process. And the status returns to pending rather than
    // leaving the operator reading "…is down" about a backend that is up.
    await advance(100);
    expect(phases).toEqual(["pending", "down", "pending"]);
    await advance(200);
    expect(phases).toEqual(["pending", "down", "pending"]);
  });

  it("falls back to down→up edge detection when the backend reports no startedAt", async () => {
    const phases: SystemActionPhase[] = [];
    const w = new SystemActionWatcher({
      probe: (() => {
        const script: Array<"down" | "up"> = ["down", "up"];
        let i = 0;
        return () => {
          const step = script[Math.min(i, script.length - 1)]!;
          i += 1;
          return step === "down" ? Promise.reject(new Error("down")) : Promise.resolve({});
        };
      })(),
      onPhase: (p) => phases.push(p),
      pollMs: 100,
      downPollMs: 100,
      timeoutMs: 10_000,
    });
    w.start();
    await advance(100);
    await advance(100);
    expect(phases).toEqual(["pending", "down", "back"]);
  });

  it("treats a hung probe as down instead of stalling the loop", async () => {
    // A reboot makes the whole host unreachable: a fetch to a dead host can sit
    // in SYN-retry for ~2 minutes. Without its own timeout the watcher would
    // stop polling and miss the appliance coming back.
    const phases: SystemActionPhase[] = [];
    let calls = 0;
    const w = new SystemActionWatcher({
      probe: (signal) => {
        calls += 1;
        // Hangs forever unless the watcher aborts it.
        return new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")));
        });
      },
      baselineStartedAt: 1000,
      onPhase: (p) => phases.push(p),
      pollMs: 100,
      downPollMs: 100,
      probeTimeoutMs: 50,
    });
    w.start();
    await advance(150); // 100 ms poll + 50 ms probe timeout
    expect(phases).toEqual(["pending", "down"]);
    await advance(300); // and it keeps polling rather than sitting on the hang
    expect(calls).toBeGreaterThan(1);
  });

  it("passes the probe an abort signal so a dead socket is actually cancelled", async () => {
    let aborted = false;
    const w = new SystemActionWatcher({
      probe: (signal) => new Promise(() => { signal.addEventListener("abort", () => { aborted = true; }); }),
      onPhase: () => {},
      pollMs: 100,
      downPollMs: 100,
      probeTimeoutMs: 50,
    });
    w.start();
    await advance(150);
    expect(aborted).toBe(true);
    w.stop();
  });

  it("stop() cancels an in-flight watch", async () => {
    let calls = 0;
    const w = new SystemActionWatcher({
      probe: () => { calls += 1; return Promise.reject(new Error("down")); },
      onPhase: () => {},
      pollMs: 100,
      downPollMs: 100,
    });
    w.start();
    await advance(100);
    expect(calls).toBe(1);
    w.stop();
    await advance(1000);
    expect(calls).toBe(1);
  });
});
