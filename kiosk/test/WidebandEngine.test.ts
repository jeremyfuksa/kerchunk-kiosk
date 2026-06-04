import { describe, it, expect, beforeAll } from "vitest";
import { join } from "node:path";
import { chmodSync, mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { WidebandEngine } from "../src/backend/engine/WidebandEngine.js";
import type { ScanConfig, EngineEvent } from "../src/backend/engine/ScannerEngine.js";
import type { Channel } from "../src/backend/config/schema.js";

const FAKE = join(__dirname, "fakes", "fake-wideband-helper.sh");

beforeAll(() => {
  chmodSync(FAKE, 0o755);
});

function ch(freq: number, over: Partial<Channel> = {}): Channel {
  return { id: `c${freq}`, freq, alphaTag: String(freq), mode: "nfm", enabled: true, ...over };
}

// Two groups ~300 MHz apart (VHF pair + one UHF), the operator's real shape.
const VHF_A = ch(146_790_000);
const VHF_B = ch(147_330_000);
const UHF = ch(464_175_000);

function cfg(channels: Channel[], over: Partial<ScanConfig> = {}): ScanConfig {
  return {
    channels, sampleRate: 12000, squelchLevel: 1800, dwellMs: 2000,
    gain: "auto", audioSink: "test-sink", windowBandwidthHz: 2_000_000, ...over,
  };
}

function tmpFile(name: string): string {
  return join(mkdtempSync(join(tmpdir(), "wb-")), name);
}

function lines(file: string): string[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter((l) => l.length > 0);
}

async function waitFor(pred: () => boolean, timeoutMs: number, stepMs = 25): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return pred();
}

function makeEngine(env: Record<string, string>, over: Record<string, unknown> = {}) {
  const events: EngineEvent[] = [];
  const engine = new WidebandEngine({
    helperCmd: [FAKE],
    helperEnv: env,
    restartDelayMs: 50,
    groupDwellMs: 100,
    ...over,
  });
  engine.on((ev) => events.push(ev));
  return { engine, events };
}

describe("WidebandEngine", () => {
  it("spawns the helper ONCE and group-hops by tune commands, never respawning", async () => {
    const args = tmpFile("args");
    const tunes = tmpFile("tunes");
    const { engine } = makeEngine({ FAKE_WB_ARGS_FILE: args, FAKE_WB_TUNES_FILE: tunes });
    await engine.start(cfg([VHF_A, VHF_B, UHF]));
    await waitFor(() => lines(tunes).length >= 3, 2000);
    await engine.stop();
    // The no-thrash regression: many hops, exactly one helper process ever.
    expect(lines(args)).toHaveLength(1);
    expect(lines(tunes).length).toBeGreaterThanOrEqual(3);
  });

  it("first tune carries the group's channels and midpoint center", async () => {
    const tunes = tmpFile("tunes");
    const { engine } = makeEngine({ FAKE_WB_TUNES_FILE: tunes });
    await engine.start(cfg([VHF_A, VHF_B, UHF]));
    await waitFor(() => lines(tunes).length >= 1, 1000);
    await engine.stop();
    const first = JSON.parse(lines(tunes)[0]!);
    expect(first.centerHz).toBe((146_790_000 + 147_330_000) / 2);
    expect(first.channels.map((c: { id: string }) => c.id)).toEqual([VHF_A.id, VHF_B.id]);
    expect(first.channels.map((c: { freqHz: number }) => c.freqHz)).toEqual([VHF_A.freq, VHF_B.freq]);
  });

  it("helper open => active (full Channel) + signal", async () => {
    const { engine, events } = makeEngine({
      FAKE_WB_SCRIPT: `{"ev":"open","id":"${VHF_A.id}","db":-12}`,
    });
    await engine.start(cfg([VHF_A, VHF_B]));
    await waitFor(() => events.some((e) => e.type === "active"), 1000);
    await engine.stop();
    const active = events.find((e) => e.type === "active");
    expect(active && active.type === "active" && active.channel).toEqual(VHF_A);
    expect(events.some((e) => e.type === "signal")).toBe(true);
  });

  it("helper close of the last open channel => idle", async () => {
    const { engine, events } = makeEngine({
      FAKE_WB_SCRIPT: [
        `{"ev":"open","id":"${VHF_A.id}","db":-12}`,
        "sleep:100",
        `{"ev":"close","id":"${VHF_A.id}"}`,
      ].join("\n"),
    });
    await engine.start(cfg([VHF_A, VHF_B]));
    await waitFor(() => events.some((e) => e.type === "idle"), 1000);
    await engine.stop();
    const types = events.map((e) => e.type);
    expect(types.indexOf("idle")).toBeGreaterThan(types.indexOf("active"));
  });

  it("hold-through: never tunes away while a channel is open", async () => {
    const tunes = tmpFile("tunes");
    const { engine } = makeEngine({
      FAKE_WB_TUNES_FILE: tunes,
      FAKE_WB_SCRIPT: `{"ev":"open","id":"${VHF_A.id}","db":-10}`, // opens, never closes
    });
    await engine.start(cfg([VHF_A, VHF_B, UHF]));
    await new Promise((r) => setTimeout(r, 400)); // 4x the dwell
    await engine.stop();
    expect(lines(tunes)).toHaveLength(1);
  });

  it("resumes hopping after the held channel closes", async () => {
    const tunes = tmpFile("tunes");
    const { engine } = makeEngine({
      FAKE_WB_TUNES_FILE: tunes,
      FAKE_WB_SCRIPT: [
        `{"ev":"open","id":"${VHF_A.id}","db":-10}`,
        "sleep:150",
        `{"ev":"close","id":"${VHF_A.id}"}`,
      ].join("\n"),
    });
    await engine.start(cfg([VHF_A, VHF_B, UHF]));
    const hopped = await waitFor(() => lines(tunes).length >= 2, 2000);
    await engine.stop();
    expect(hopped).toBe(true);
  });

  it("a single group never hops", async () => {
    const tunes = tmpFile("tunes");
    const { engine } = makeEngine({ FAKE_WB_TUNES_FILE: tunes });
    await engine.start(cfg([VHF_A, VHF_B])); // one group
    await new Promise((r) => setTimeout(r, 400));
    await engine.stop();
    expect(lines(tunes)).toHaveLength(1);
  });

  it("zero enabled channels => running with no helper", async () => {
    const args = tmpFile("args");
    const { engine } = makeEngine({ FAKE_WB_ARGS_FILE: args });
    await engine.start(cfg([ch(146_790_000, { enabled: false })]));
    expect(engine.state).toBe("running");
    await new Promise((r) => setTimeout(r, 100));
    await engine.stop();
    expect(lines(args)).toHaveLength(0);
  });

  it("helper crash => HELPER_EXITED error, then respawn after the delay", async () => {
    const args = tmpFile("args");
    const { engine, events } = makeEngine(
      { FAKE_WB_ARGS_FILE: args, FAKE_WB_MODE: "crash" },
      { autoRestart: true },
    );
    await engine.start(cfg([VHF_A]));
    await waitFor(() => lines(args).length >= 2, 2000);
    await engine.stop();
    const err = events.find((e) => e.type === "error");
    expect(err && err.type === "error" && err.code).toBe("HELPER_EXITED");
    expect(lines(args).length).toBeGreaterThanOrEqual(2);
  });

  it("device-open failure => NO_DEVICE error code", async () => {
    const { engine, events } = makeEngine(
      { FAKE_WB_MODE: "nodevice" },
      { autoRestart: false },
    );
    await engine.start(cfg([VHF_A]));
    await waitFor(() => events.some((e) => e.type === "error"), 1000);
    await engine.stop();
    const err = events.find((e) => e.type === "error");
    expect(err && err.type === "error" && err.code).toBe("NO_DEVICE");
  });

  it("stop() leaves no helper process behind", async () => {
    const pids = tmpFile("pids");
    const { engine } = makeEngine({ FAKE_WB_PID_FILE: pids });
    await engine.start(cfg([VHF_A, VHF_B]));
    await waitFor(() => lines(pids).length >= 1, 1000);
    await engine.stop();
    const dead = await waitFor(
      () => lines(pids).every((pid) => {
        try { process.kill(Number(pid), 0); return false; } catch { return true; }
      }),
      1000,
    );
    expect(dead).toBe(true);
  });
});

describe("audible passthrough", () => {
  it("helper audible events surface as audible EngineEvents with the full channel", async () => {
    const { engine, events } = makeEngine({
      FAKE_WB_SCRIPT: [
        `{"ev":"open","id":"${VHF_A.id}","db":-12}`,
        `{"ev":"audible","id":"${VHF_A.id}"}`,
        "sleep:100",
        `{"ev":"audible","id":null}`,
      ].join("\n"),
    });
    await engine.start(cfg([VHF_A, VHF_B]));
    await waitFor(() => events.filter((e) => e.type === "audible").length >= 2, 1500);
    await engine.stop();
    const audibles = events.filter((e) => e.type === "audible") as Array<{ type: "audible"; channel: unknown }>;
    expect((audibles[0]!.channel as { id: string }).id).toBe(VHF_A.id);
    expect(audibles[1]!.channel).toBeNull();
  });
});
