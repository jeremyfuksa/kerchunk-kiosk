import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { join } from "node:path";
import { chmodSync, mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { RtlFmEngine } from "../src/backend/engine/RtlFmEngine.js";
import type { ScanConfig, EngineEvent } from "../src/backend/engine/ScannerEngine.js";
import type { Channel } from "../src/backend/config/schema.js";

const LOUD = join(__dirname, "fakes", "fake-rtl_fm-loud.sh");
const SILENT = join(__dirname, "fakes", "fake-rtl_fm-silent.sh");

beforeAll(() => {
  chmodSync(LOUD, 0o755);
  chmodSync(SILENT, 0o755);
});

function ch(over: Partial<Channel> = {}): Channel {
  return { id: "c1", freq: 145130000, alphaTag: "TEST", mode: "nfm", enabled: true, ...over };
}

function cfg(channels: Channel[], over: Partial<ScanConfig> = {}): ScanConfig {
  return { channels, sampleRate: 12000, squelchLevel: 150, gain: "auto", audioSink: "test", ...over };
}

const TIMING = { openThreshold: 2000, hangMs: 200, hopIntervalMs: 150, autoRestart: false };

// Collect events while running `fn`, then stop the engine and resolve.
async function collect(
  engine: RtlFmEngine,
  ms: number,
): Promise<EngineEvent[]> {
  const events: EngineEvent[] = [];
  engine.on((ev) => events.push(ev));
  await new Promise((r) => setTimeout(r, ms));
  return events;
}

// Poll for a predicate to become true, up to `timeoutMs`.
async function waitFor(pred: () => boolean, timeoutMs: number, stepMs = 25): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return pred();
}

let active: RtlFmEngine | null = null;
afterEach(async () => {
  if (active) {
    await active.stop();
    active = null;
  }
  await new Promise((r) => setTimeout(r, 50));
});

describe("RtlFmEngine.buildArgs", () => {
  it("produces single-channel argv with -l 0 and -t 5, gain omitted when auto", () => {
    const e = new RtlFmEngine({ rtlFmCmd: LOUD, sinkCmd: null, ...TIMING });
    const c = ch({ freq: 154000000 });
    const args = e.buildArgs(c, cfg([c], { gain: "auto" }));
    expect(args).toEqual([
      "-f", "154000000", "-M", "fm", "-s", "12000", "-l", "0", "-t", "5", "-",
    ]);
    expect(args).not.toContain("-g");
  });

  it("includes -g 30 when gain is 30", () => {
    const e = new RtlFmEngine({ rtlFmCmd: LOUD, sinkCmd: null, ...TIMING });
    const c = ch();
    const args = e.buildArgs(c, cfg([c], { gain: 30 }));
    const gi = args.indexOf("-g");
    expect(gi).toBeGreaterThanOrEqual(0);
    expect(args[gi + 1]).toBe("30");
    // -g still appears before the trailing "-"
    expect(args[args.length - 1]).toBe("-");
  });
});

describe("RtlFmEngine signal detection", () => {
  it("emits active (with matching channel/freq) and signal for a loud channel", async () => {
    const c = ch({ id: "loud1", freq: 145130000 });
    const e = new RtlFmEngine({ rtlFmCmd: LOUD, sinkCmd: null, ...TIMING });
    active = e;
    const events: EngineEvent[] = [];
    e.on((ev) => events.push(ev));
    await e.start(cfg([c]));

    const got = await waitFor(() => events.some((ev) => ev.type === "active"), 1500);
    expect(got).toBe(true);

    const activeEv = events.find((ev) => ev.type === "active");
    expect(activeEv && activeEv.type === "active" && activeEv.freq).toBe(c.freq);
    expect(activeEv && activeEv.type === "active" && activeEv.channel.id).toBe(c.id);

    expect(events.some((ev) => ev.type === "signal")).toBe(true);
  });
});

describe("RtlFmEngine hopping", () => {
  it("hops across enabled channels on silence (rtl_fm spawned more than once) and never goes active", async () => {
    const argsFile = join(mkdtempSync(join(tmpdir(), "rtlfm-")), "args.log");
    process.env.FAKE_RTL_ARGS_FILE = argsFile;
    try {
      const c1 = ch({ id: "a", freq: 145000000 });
      const c2 = ch({ id: "b", freq: 146000000 });
      const e = new RtlFmEngine({ rtlFmCmd: SILENT, sinkCmd: null, ...TIMING });
      active = e;
      const events: EngineEvent[] = [];
      e.on((ev) => events.push(ev));
      await e.start(cfg([c1, c2]));

      await new Promise((r) => setTimeout(r, 800));

      expect(e.state).toBe("running");
      expect(events.some((ev) => ev.type === "active")).toBe(false);

      // Count spawns by reading the argv log; should have hopped at least twice.
      const spawns = existsSync(argsFile)
        ? readFileSync(argsFile, "utf8").trim().split("\n").filter(Boolean).length
        : 0;
      expect(spawns).toBeGreaterThan(1);
    } finally {
      delete process.env.FAKE_RTL_ARGS_FILE;
    }
  });
});

describe("RtlFmEngine lifecycle", () => {
  it("with zero enabled channels goes running with no active events", async () => {
    const e = new RtlFmEngine({ rtlFmCmd: LOUD, sinkCmd: null, ...TIMING });
    active = e;
    const events = await collect(e, 0);
    await e.start(cfg([ch({ enabled: false })]));
    expect(e.state).toBe("running");
    await new Promise((r) => setTimeout(r, 300));
    expect(events.some((ev) => ev.type === "active")).toBe(false);
    await e.stop();
    active = null;
    expect(e.state).toBe("stopped");
  });

  it("stop() kills the child, state stopped, status:stopped emitted", async () => {
    const c = ch({ id: "loud1" });
    const e = new RtlFmEngine({ rtlFmCmd: LOUD, sinkCmd: null, ...TIMING });
    const events: EngineEvent[] = [];
    e.on((ev) => events.push(ev));
    await e.start(cfg([c]));
    await new Promise((r) => setTimeout(r, 200));
    await e.stop();
    expect(e.state).toBe("stopped");
    expect(events.some((ev) => ev.type === "status" && ev.state === "stopped")).toBe(true);
  });
});
