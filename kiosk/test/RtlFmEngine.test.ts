import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { join } from "node:path";
import { chmodSync, mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { RtlFmEngine, defaultSink } from "../src/backend/engine/RtlFmEngine.js";
import type { ScanConfig, EngineEvent } from "../src/backend/engine/ScannerEngine.js";
import type { Channel } from "../src/backend/config/schema.js";

const LOUD = join(__dirname, "fakes", "fake-rtl_fm-loud.sh");
const SILENT = join(__dirname, "fakes", "fake-rtl_fm-silent.sh");
const CRASH = join(__dirname, "fakes", "fake-rtl_fm-crash.sh");
const NODEVICE = join(__dirname, "fakes", "fake-rtl_fm-nodevice.sh");
const SINK = join(__dirname, "fakes", "fake-sink.sh");

beforeAll(() => {
  chmodSync(LOUD, 0o755);
  chmodSync(SILENT, 0o755);
  chmodSync(CRASH, 0o755);
  chmodSync(NODEVICE, 0o755);
  chmodSync(SINK, 0o755);
});

function ch(over: Partial<Channel> = {}): Channel {
  return { id: "c1", freq: 145130000, alphaTag: "TEST", mode: "nfm", enabled: true, ...over };
}

function cfg(channels: Channel[], over: Partial<ScanConfig> = {}): ScanConfig {
  return { channels, sampleRate: 12000, squelchLevel: 150, dwellMs: 2000, gain: "auto", audioSink: "test", ...over };
}

const TIMING = { openThreshold: 2000, hangMs: 200, hopIntervalMs: 150, autoRestart: false };

describe("RtlFmEngine hop interval default", () => {
  it("defaults to a gentle hop interval (>=2000ms) so the SDR isn't re-opened many times/sec", () => {
    // Each hop fully kills + respawns rtl_fm, which re-opens the USB device.
    // A tiny default (the old 400ms) re-opens the dongle ~2.5x/sec and wedges it
    // off the USB bus (write_reg -7 / error -71). The default must be gentle.
    const e = new RtlFmEngine();
    expect(e.hopIntervalMs).toBeGreaterThanOrEqual(2000);
  });

  it("still honors an explicit hopIntervalMs", () => {
    const e = new RtlFmEngine({ hopIntervalMs: 150 });
    expect(e.hopIntervalMs).toBe(150);
  });
});

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

describe("defaultSink", () => {
  it("derives aplay's playback rate from the configured sample rate", () => {
    // The sink must play raw PCM at the same rate rtl_fm produces it, or audio
    // pitch and the energy threshold drift. Rate must track config, not a constant.
    const argv = defaultSink(12000);
    expect(argv[0]).toBe("aplay");
    expect(argv).toContain("S16_LE");
    expect(argv[argv.indexOf("-r") + 1]).toBe("12000");
    const a22 = defaultSink(22050);
    expect(a22[a22.indexOf("-r") + 1]).toBe("22050");
  });

  it("requests a generous buffer so the bursty Node audio tap doesn't underrun", () => {
    const argv = defaultSink(12000);
    expect(argv.some((a) => a.startsWith("--buffer-time="))).toBe(true);
    expect(argv.some((a) => a.startsWith("--period-time="))).toBe(true);
  });

  it("routes to the configured device with -D when one is given", () => {
    const argv = defaultSink(12000, "hdmi:CARD=vc4hdmi1");
    const di = argv.indexOf("-D");
    expect(di).toBeGreaterThanOrEqual(0);
    expect(argv[di + 1]).toBe("hdmi:CARD=vc4hdmi1");
    // Rate assertion still holds with a device present.
    const ri = argv.indexOf("-r");
    expect(argv[ri + 1]).toBe("12000");
  });

  it("omits -D when no device is given (default playback device)", () => {
    expect(defaultSink(12000)).not.toContain("-D");
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

      // Poll for the second spawn rather than asserting after a fixed sleep:
      // on a loaded Pi the hop timer + process spawn can lag well past a fixed
      // window, which made the old fixed-800ms-then-count check flake.
      const countSpawns = () =>
        existsSync(argsFile)
          ? readFileSync(argsFile, "utf8").trim().split("\n").filter(Boolean).length
          : 0;
      const hopped = await waitFor(() => countSpawns() > 1, 4000);

      expect(e.state).toBe("running");
      expect(events.some((ev) => ev.type === "active")).toBe(false);
      // Hopped at least twice (silence never holds a channel).
      expect(hopped).toBe(true);
      expect(countSpawns()).toBeGreaterThan(1);
    } finally {
      delete process.env.FAKE_RTL_ARGS_FILE;
    }
  });
});

describe("RtlFmEngine hold/dwell", () => {
  it("holds on a loud channel: exactly one active event and no hop over several intervals", async () => {
    const argsFile = join(mkdtempSync(join(tmpdir(), "rtlfm-")), "args.log");
    process.env.FAKE_RTL_ARGS_FILE = argsFile;
    try {
      const c = ch({ id: "loud1", freq: 145130000 });
      const e = new RtlFmEngine({ rtlFmCmd: LOUD, sinkCmd: null, ...TIMING });
      active = e;
      const events: EngineEvent[] = [];
      e.on((ev) => events.push(ev));
      await e.start(cfg([c]));

      // First wait until the channel is actually held open. Polling (rather than
      // asserting after a fixed sleep) tolerates spawn/PCM latency under load,
      // which is what made the fixed-window version flaky on the Pi.
      const opened = await waitFor(() => events.some((ev) => ev.type === "active"), 3000);
      expect(opened).toBe(true);

      // Now hold for several hop intervals and assert the invariant: while a
      // signal holds the channel, the engine must NOT hop or re-emit active.
      await new Promise((r) => setTimeout(r, TIMING.hopIntervalMs * 3 + 100));

      const activeCount = events.filter((ev) => ev.type === "active").length;
      expect(activeCount).toBe(1);

      // No hop while holding: rtl_fm should have been spawned exactly once.
      const spawns = existsSync(argsFile)
        ? readFileSync(argsFile, "utf8").trim().split("\n").filter(Boolean).length
        : 0;
      expect(spawns).toBe(1);
    } finally {
      delete process.env.FAKE_RTL_ARGS_FILE;
    }
  });
});

describe("RtlFmEngine auto-restart", () => {
  it("on rtl_fm crash emits RTL_EXITED and respawns the SAME channel", async () => {
    const argsFile = join(mkdtempSync(join(tmpdir(), "rtlfm-")), "args.log");
    process.env.FAKE_RTL_ARGS_FILE = argsFile;
    try {
      const c = ch({ id: "crash1", freq: 145130000 });
      const e = new RtlFmEngine({
        rtlFmCmd: CRASH, sinkCmd: null,
        openThreshold: 2000, hangMs: 200, hopIntervalMs: 150,
        autoRestart: true, restartDelayMs: 80,
      });
      active = e;
      const events: EngineEvent[] = [];
      e.on((ev) => events.push(ev));
      await e.start(cfg([c]));

      // Give a generous window for at least one crash + restart cycle.
      await waitFor(
        () =>
          events.some((ev) => ev.type === "error" && ev.code === "RTL_EXITED") &&
          (existsSync(argsFile)
            ? readFileSync(argsFile, "utf8").trim().split("\n").filter(Boolean).length
            : 0) > 1,
        1200,
      );

      // (a) RTL_EXITED error emitted.
      expect(
        events.some((ev) => ev.type === "error" && ev.code === "RTL_EXITED"),
      ).toBe(true);

      // (b) same channel respawned: more than one spawn recorded.
      const lines = existsSync(argsFile)
        ? readFileSync(argsFile, "utf8").trim().split("\n").filter(Boolean)
        : [];
      expect(lines.length).toBeGreaterThan(1);
      // All spawns target the same frequency (same channel).
      expect(lines.every((l) => l.includes(String(c.freq)))).toBe(true);
    } finally {
      delete process.env.FAKE_RTL_ARGS_FILE;
    }
  });

  it("does not leak the sink across restarts: sink starts == rtl_fm spawns", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rtlfm-"));
    const argsFile = join(dir, "args.log");
    const sinkFile = join(dir, "sink.log");
    process.env.FAKE_RTL_ARGS_FILE = argsFile;
    process.env.FAKE_SINK_FILE = sinkFile;
    try {
      const c = ch({ id: "crash1", freq: 145130000 });
      const e = new RtlFmEngine({
        rtlFmCmd: CRASH, sinkCmd: [SINK],
        openThreshold: 2000, hangMs: 200, hopIntervalMs: 150,
        autoRestart: true, restartDelayMs: 80,
      });
      active = e;
      const events: EngineEvent[] = [];
      e.on((ev) => events.push(ev));
      await e.start(cfg([c]));

      const countSpawns = () =>
        existsSync(argsFile)
          ? readFileSync(argsFile, "utf8").trim().split("\n").filter(Boolean).length
          : 0;
      const readSinkPids = () =>
        existsSync(sinkFile)
          ? readFileSync(sinkFile, "utf8")
              .trim()
              .split("\n")
              .filter(Boolean)
              .map((l) => Number(l.replace(/^start\s+/, "")))
              .filter((n) => Number.isFinite(n) && n > 0)
          : [];

      // Drive the crash/restart loop until it has respawned at least twice.
      // Poll for the spawn count rather than sleeping a fixed window: under CPU
      // contention (full suite / loaded Pi) the crash-respawn cycle lags well
      // past any fixed wall-clock guess, which is what made the old
      // setTimeout(350)-then-count check flake.
      const restarted = await waitFor(() => countSpawns() > 1, 4000);
      await e.stop();
      active = null;

      // Allow killed sinks to flush their exit; give a moment for fs writes.
      await new Promise((r) => setTimeout(r, 150));

      // spawnForChannel starts a sink BEFORE rtl_fm, so the engine issues at most
      // one sink spawn per rtl_fm spawn (=> sinkPids <= spawns + 1; the +1
      // tolerates a final sink started after the last rtl_fm args line). We do
      // NOT assert a lower bound: under the fast crash/restart cycle
      // (restartDelayMs is tiny) killChildren() can SIGKILL a freshly-spawned
      // sink before its shell reaches the line that logs "start $$", so a sink
      // can legitimately exist without ever appearing in the log. The invariant
      // this test actually guards is "no sink leaks across restarts", asserted
      // below: every sink that DID log must be dead after stop().
      const spawns = countSpawns();
      const sinkPids = readSinkPids();

      expect(restarted).toBe(true);
      expect(spawns).toBeGreaterThan(1);
      expect(sinkPids.length).toBeLessThanOrEqual(spawns + 1);

      // No orphans: every sink the engine ever started must be dead now. Before
      // the fix, handleUnexpectedExit overwrote this.sink without killing the
      // previous one, so prior sinks stayed alive (kill -0 succeeds) => leak.
      const aliveAfterStop = sinkPids.filter((pid) => {
        try { process.kill(pid, 0); return true; } catch { return false; }
      });
      expect(aliveAfterStop).toEqual([]);
      expect(e.state).toBe("stopped");
    } finally {
      delete process.env.FAKE_RTL_ARGS_FILE;
      delete process.env.FAKE_SINK_FILE;
    }
  });
});

describe("RtlFmEngine device errors", () => {
  it("surfaces a NO_DEVICE error (with the rtl_fm stderr reason) when the dongle is missing", async () => {
    const c = ch({ id: "nodev", freq: 145130000 });
    const e = new RtlFmEngine({ rtlFmCmd: NODEVICE, sinkCmd: null, ...TIMING });
    active = e;
    const events: EngineEvent[] = [];
    e.on((ev) => events.push(ev));
    await e.start(cfg([c]));

    const got = await waitFor(
      () => events.some((ev) => ev.type === "error" && ev.code === "NO_DEVICE"),
      1500,
    );
    expect(got).toBe(true);

    const errEv = events.find((ev) => ev.type === "error" && ev.code === "NO_DEVICE");
    expect(errEv && errEv.type === "error" && errEv.message).toContain(
      "No supported devices found",
    );
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
