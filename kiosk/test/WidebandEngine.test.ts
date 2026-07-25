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

  it("offsets the tune center off the channel (single-channel weather radio)", async () => {
    const tunes = tmpFile("tunes");
    const wx = ch(162_550_000);
    const { engine } = makeEngine({ FAKE_WB_TUNES_FILE: tunes }, { centerOffsetHz: 60_000 });
    await engine.start(cfg([wx]));
    await waitFor(() => lines(tunes).length >= 1, 1000);
    await engine.stop();
    const first = JSON.parse(lines(tunes)[0]!);
    // RTL tunes 60 kHz above the channel so 162.55 sits off the DC spike...
    expect(first.centerHz).toBe(162_550_000 + 60_000);
    // ...while the channel freq is unchanged (the helper derives a -60 kHz lane offset).
    expect(first.channels[0].freqHz).toBe(162_550_000);
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
    const { engine, events } = makeEngine({
      FAKE_WB_TUNES_FILE: tunes,
      FAKE_WB_SCRIPT: `{"ev":"open","id":"${VHF_A.id}","db":-10}`, // opens, never closes
    });
    await engine.start(cfg([VHF_A, VHF_B, UHF]));
    // Hold-through engages once the engine PROCESSES the open (which also emits
    // a "signal" carrying the open's db). Gate on that instead of a fixed sleep,
    // so the assertion never races the fake helper's open-event latency against
    // the dwell. ("active" is group-scoped and may not fire if a hop already
    // happened, so it's unreliable here; "signal" fires on any open.)
    const sawOpen = await waitFor(() => events.some((e) => e.type === "signal"), 1000);
    expect(sawOpen).toBe(true);
    const tunesAtHold = lines(tunes).length;
    await new Promise((r) => setTimeout(r, 400)); // 4x the dwell — ample chance to (wrongly) hop
    await engine.stop();
    expect(lines(tunes)).toHaveLength(tunesAtHold); // held: no further hop while open
  });

  it("an open on an INAUDIBLE channel does not hold the rotation", async () => {
    // The muted-business-channel wedge: a 463 MHz lane the operator has muted
    // read open continuously and parked the scanner for the whole max-hold cap,
    // producing minutes of silence that sound like a lockup. A channel nobody
    // can hear has no claim on the radio.
    const tunes = tmpFile("tunes");
    const muted = ch(146_790_000, { audible: false });
    const { engine, events } = makeEngine({
      FAKE_WB_TUNES_FILE: tunes,
      FAKE_WB_SCRIPT: `{"ev":"open","id":"${muted.id}","db":-10}`, // opens, never closes
    });
    await engine.start(cfg([muted, VHF_B, UHF]));
    const sawOpen = await waitFor(() => events.some((e) => e.type === "signal"), 1000);
    expect(sawOpen).toBe(true);
    const tunesAtOpen = lines(tunes).length;
    // Default maxHoldMs is 180 s — if the mute is ignored, nothing hops here.
    const hopped = await waitFor(() => lines(tunes).length > tunesAtOpen, 2000);
    await engine.stop();
    expect(hopped).toBe(true);
  });

  it("holds when an audible channel is open alongside a muted one", async () => {
    const tunes = tmpFile("tunes");
    const muted = ch(146_790_000, { audible: false });
    const { engine, events } = makeEngine({
      FAKE_WB_TUNES_FILE: tunes,
      FAKE_WB_SCRIPT: [
        `{"ev":"open","id":"${muted.id}","db":-10}`,
        `{"ev":"open","id":"${VHF_B.id}","db":-10}`,
      ].join("\n"),
    });
    await engine.start(cfg([muted, VHF_B, UHF]));
    const sawBoth = await waitFor(
      () => events.filter((e) => e.type === "signal").length >= 2, 1000);
    expect(sawBoth).toBe(true);
    const tunesAtHold = lines(tunes).length;
    await new Promise((r) => setTimeout(r, 400)); // 4x the dwell
    await engine.stop();
    expect(lines(tunes)).toHaveLength(tunesAtHold); // the audible open still holds
  });

  it("an unknown (Close Call) open still holds — CC hits are audible", async () => {
    const tunes = tmpFile("tunes");
    const { engine, events } = makeEngine({
      FAKE_WB_TUNES_FILE: tunes,
      FAKE_WB_SCRIPT: `{"ev":"open","id":"cc_463562500","db":-10}`,
    });
    await engine.start(cfg([VHF_A, VHF_B, UHF]));
    const sawOpen = await waitFor(() => events.some((e) => e.type === "signal"), 1000);
    expect(sawOpen).toBe(true);
    const tunesAtHold = lines(tunes).length;
    await new Promise((r) => setTimeout(r, 400));
    await engine.stop();
    expect(lines(tunes)).toHaveLength(tunesAtHold);
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

  it("max-hold cap: forces a hop past a lane stuck open past maxHoldMs", async () => {
    const tunes = tmpFile("tunes");
    const logs: string[] = [];
    const { engine, events } = makeEngine(
      {
        FAKE_WB_TUNES_FILE: tunes,
        FAKE_WB_SCRIPT: `{"ev":"open","id":"${VHF_A.id}","db":-10}`, // opens, never closes (dropped close)
      },
      { maxHoldMs: 300, log: (m: string) => logs.push(m) },
    );
    await engine.start(cfg([VHF_A, VHF_B, UHF]));
    const sawOpen = await waitFor(() => events.some((e) => e.type === "signal"), 1000);
    expect(sawOpen).toBe(true);
    const tunesAtHold = lines(tunes).length;
    // Past the cap: hold-through must give up on the stuck lane so the sweep resumes.
    const resumed = await waitFor(() => lines(tunes).length > tunesAtHold, 2000);
    await engine.stop();
    expect(resumed).toBe(true);
    expect(logs.some((m) => m.includes("max-hold"))).toBe(true);
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
    await waitFor(() => events.some((e) => e.type === "error"), 3000);
    await engine.stop();
    const err = events.find((e) => e.type === "error");
    expect(err && err.type === "error" && err.code).toBe("HELPER_EXITED");
    expect(lines(args).length).toBeGreaterThanOrEqual(2);
  });

  it("the FIRST exit is a soft restart (status starting), error only on repeat", async () => {
    // Operator-reported: a rapid bank toggle shows a scary red error for a
    // race that self-heals in ~1s. One failed spawn is expected during
    // reconfiguration; only repetition means something is wrong.
    const args = tmpFile("args");
    const { engine, events } = makeEngine(
      { FAKE_WB_ARGS_FILE: args, FAKE_WB_MODE: "crash" },
      { autoRestart: true },
    );
    await engine.start(cfg([VHF_A]));
    await waitFor(() => events.some((e) => e.type === "error"), 3000);
    await engine.stop();
    const firstErrorIdx = events.findIndex((e) => e.type === "error");
    // a soft status:starting precedes the first hard error
    const before = events.slice(0, firstErrorIdx);
    expect(before.some((e) => e.type === "status" && e.state === "starting")).toBe(true);
    // and the error only fired once a SECOND spawn attempt had failed
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

  it("a crash during warm-up cancels the settle timer — no stale warmup:ready", async () => {
    // The helper says 'ready' (arming the 1.5s warm-up settle timer) then dies
    // 100ms later. The timer must be cancelled on teardown, or it fires a false
    // 'ready' while no helper is live — clearing the kiosk overlay early and
    // marking the box warmed mid-restart.
    const { engine, events } = makeEngine(
      { FAKE_WB_MODE: "crash" },
      { autoRestart: false },
    );
    await engine.start(cfg([VHF_A]));
    await waitFor(() => events.some((e) => e.type === "error"), 2000);
    // Wait past the 1.5s settle: a leaked timer would have fired by now.
    await new Promise((r) => setTimeout(r, 1700));
    await engine.stop();
    const warmups = events.filter((e) => e.type === "warmup");
    // The timer was armed (the first tune emitted warmup:tuned)...
    expect(warmups.some((e) => e.type === "warmup" && e.phase === "tuned")).toBe(true);
    // ...but the crash cancelled it, so 'ready' must never have fired.
    expect(warmups.some((e) => e.type === "warmup" && e.phase === "ready")).toBe(false);
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

describe("mode passthrough", () => {
  it("tune carries each channel's demod mode (AM airband vs NFM)", async () => {
    const tunes = tmpFile("tunes");
    const { engine } = makeEngine({ FAKE_WB_TUNES_FILE: tunes });
    await engine.start(cfg([{ ...VHF_A, mode: "am" }, VHF_B]));
    await waitFor(() => lines(tunes).length >= 1, 1000);
    await engine.stop();
    const first = JSON.parse(lines(tunes)[0]!);
    expect(first.channels.map((c: { mode: string }) => c.mode)).toEqual(["am", "nfm"]);
  });
});

describe("priority passthrough", () => {
  it("tune carries each channel's priority flag", async () => {
    const tunes = tmpFile("tunes");
    const { engine } = makeEngine({ FAKE_WB_TUNES_FILE: tunes });
    await engine.start(cfg([{ ...VHF_A, priority: true }, VHF_B]));
    await waitFor(() => lines(tunes).length >= 1, 1000);
    await engine.stop();
    const first = JSON.parse(lines(tunes)[0]!);
    expect(first.channels.map((c: { priority: boolean }) => c.priority)).toEqual([true, false]);
  });
});

describe("monitor mode passthrough", () => {
  it("tune carries monitor: true so the helper holds the channel open unsquelched", async () => {
    const tunes = tmpFile("tunes");
    const { engine } = makeEngine({ FAKE_WB_TUNES_FILE: tunes });
    await engine.start({ ...cfg([VHF_A]), monitor: true });
    await waitFor(() => lines(tunes).length >= 1, 1000);
    await engine.stop();
    expect(JSON.parse(lines(tunes)[0]!).monitor).toBe(true);
  });
});

describe("overlapping teardown (bank-toggle race)", () => {
  it("a helper that ignores quit is SIGKILLed even when a second teardown overlaps", async () => {
    // Operator-replicated: all banks off -> new bank on (rapid stop/start
    // cycles). The old per-class kill timer could be CANCELLED by the next
    // teardown, leaving a wedged helper holding the device forever.
    const pids = tmpFile("pids");
    const { engine } = makeEngine({ FAKE_WB_PID_FILE: pids, FAKE_WB_MODE: "wedge" });
    await engine.start(cfg([VHF_A, VHF_B]));
    await waitFor(() => lines(pids).length >= 1, 1000);
    const pid = Number(lines(pids)[0]);
    await engine.stop();   // schedules the grace SIGKILL
    await engine.stop();   // second teardown — used to cancel that SIGKILL
    const dead = await waitFor(() => {
      try { process.kill(pid, 0); return false; } catch { return true; }
    }, 2000);
    expect(dead).toBe(true);
  });
});

describe("close call", () => {
  it("helper closecall surfaces as a closecall EngineEvent", async () => {
    const { engine, events } = makeEngine({
      FAKE_WB_SCRIPT: `{"ev":"closecall","freqHz":462887500}`,
    });
    await engine.start(cfg([VHF_A, VHF_B]));
    await waitFor(() => events.some((e) => e.type === "closecall"), 1000);
    await engine.stop();
    const cc = events.find((e) => e.type === "closecall");
    expect(cc && cc.type === "closecall" && cc.freqHz).toBe(462887500);
  });

  it("a cc lane opening yields an active event with a synthesized CLOSE CALL channel", async () => {
    const { engine, events } = makeEngine({
      FAKE_WB_SCRIPT: [
        `{"ev":"closecall","freqHz":462887500}`,
        `{"ev":"open","id":"cc_462887500","db":-5}`,
        `{"ev":"audible","id":"cc_462887500"}`,
      ].join("\n"),
    });
    await engine.start(cfg([VHF_A, VHF_B]));
    await waitFor(() => events.some((e) => e.type === "active"), 1000);
    await engine.stop();
    const active = events.find((e) => e.type === "active");
    expect(active && active.type === "active" && active.channel.alphaTag).toBe("CLOSE CALL");
    expect(active && active.type === "active" && active.freq).toBe(462887500);
    const audible = events.find((e) => e.type === "audible");
    expect(audible && audible.type === "audible" && audible.channel?.freq).toBe(462887500);
  });

  it("tune carries knownHz (all config channels) and the closeCall switch", async () => {
    const tunes = tmpFile("tunes");
    const { engine } = makeEngine({ FAKE_WB_TUNES_FILE: tunes });
    await engine.start(cfg([VHF_A, VHF_B, { ...UHF, enabled: false }], { closeCall: true, closeCallDb: 15 }));
    await waitFor(() => lines(tunes).length >= 1, 1000);
    await engine.stop();
    const first = JSON.parse(lines(tunes)[0]!);
    expect(first.closeCall).toBe(true);
    expect(first.closeCallDb).toBe(15);
    // knownHz includes DISABLED channels too — they must not re-trigger.
    expect(first.knownHz).toContain(UHF.freq);
    expect(first.knownHz).toContain(VHF_A.freq);
  });
});

describe("skip + lockout", () => {
  it("knownHz includes locked-out frequencies so they never re-trigger", async () => {
    const tunes = tmpFile("tunes");
    const { engine } = makeEngine({ FAKE_WB_TUNES_FILE: tunes });
    await engine.start(cfg([VHF_A, VHF_B], { lockoutHz: [462887500] }));
    await waitFor(() => lines(tunes).length >= 1, 1000);
    await engine.stop();
    expect(JSON.parse(lines(tunes)[0]!).knownHz).toContain(462887500);
  });

  it("skip() sends the skip command to the helper", async () => {
    const cmds = tmpFile("cmds");
    const { engine } = makeEngine({ FAKE_WB_CMDS_FILE: cmds });
    await engine.start(cfg([VHF_A, VHF_B]));
    await waitFor(() => lines(cmds).some((l) => l.includes('"cmd":"tune"')), 1000);
    engine.skip();
    const got = await waitFor(() => lines(cmds).some((l) => l.includes('"cmd":"skip"')), 1000);
    await engine.stop();
    expect(got).toBe(true);
  });

  it("skip(holdoffSeconds) carries the holdoff — temp lockout is a long skip", async () => {
    const cmds = tmpFile("cmds");
    const { engine } = makeEngine({ FAKE_WB_CMDS_FILE: cmds });
    await engine.start(cfg([VHF_A, VHF_B]));
    await waitFor(() => lines(cmds).some((l) => l.includes('"cmd":"tune"')), 1000);
    engine.skip(1800);
    const got = await waitFor(() => lines(cmds).some((l) =>
      l.includes('"cmd":"skip"') && l.includes('"holdoffS":1800')), 1000);
    await engine.stop();
    expect(got).toBe(true);
  });
});

describe("leveler trim persistence", () => {
  it("tune seeds each channel's levelDb from config (trims survive hops/restarts)", async () => {
    const tunes = tmpFile("tunes");
    const { engine } = makeEngine({ FAKE_WB_TUNES_FILE: tunes });
    await engine.start(cfg([{ ...VHF_A, levelTrimDb: -8.5 }, VHF_B]));
    await waitFor(() => lines(tunes).length >= 1, 1000);
    await engine.stop();
    const first = JSON.parse(lines(tunes)[0]!);
    expect(first.channels.map((c: { levelDb: number }) => c.levelDb)).toEqual([-8.5, 0]);
  });

  it("helper level events surface as level EngineEvents", async () => {
    const { engine, events } = makeEngine({
      FAKE_WB_SCRIPT: `{"ev":"level","id":"${VHF_A.id}","db":-6.3}`,
    });
    await engine.start(cfg([VHF_A, VHF_B]));
    await waitFor(() => events.some((e) => e.type === "level"), 1000);
    await engine.stop();
    const lv = events.find((e) => e.type === "level");
    expect(lv && lv.type === "level" && lv.channelId).toBe(VHF_A.id);
    expect(lv && lv.type === "level" && lv.db).toBe(-6.3);
  });
});

describe("hear-vs-see passthrough", () => {
  it("tune carries each channel's audible flag", async () => {
    const tunes = tmpFile("tunes");
    const { engine } = makeEngine({ FAKE_WB_TUNES_FILE: tunes });
    await engine.start(cfg([{ ...VHF_A, audible: false }, VHF_B]));
    await waitFor(() => lines(tunes).length >= 1, 1000);
    await engine.stop();
    const first = JSON.parse(lines(tunes)[0]!);
    expect(first.channels.map((c: { audible: boolean }) => c.audible)).toEqual([false, true]);
  });
});

describe("retune fit-check (re-point vs respawn)", () => {
  // Three channels within one 2 MHz window => a single 3-channel group.
  const A = ch(146_790_000);            // slot 0
  const B = ch(147_330_000);            // slot 1
  const C = ch(147_900_000);            // slot 2 (SAME lane)

  it("re-points (no respawn) when the new config fits the spawned lanes", async () => {
    const args = tmpFile("args");
    const tunes = tmpFile("tunes");
    const { engine } = makeEngine({ FAKE_WB_ARGS_FILE: args, FAKE_WB_TUNES_FILE: tunes });
    await engine.start(cfg([A, B]));                       // 2 lanes
    await waitFor(() => lines(tunes).length >= 1, 1000);
    const tunesBefore = lines(tunes).length;
    await engine.retune(cfg([{ ...A, alphaTag: "renamed" }, B])); // same shape: fits
    await waitFor(() => lines(tunes).length > tunesBefore, 1000);
    await engine.stop();
    expect(lines(args)).toHaveLength(1);                   // ONE helper, never respawned
  });

  it("re-points for a SMALLER config (the weather break-in: one NFM channel)", async () => {
    const args = tmpFile("args");
    const tunes = tmpFile("tunes");
    const { engine } = makeEngine({ FAKE_WB_ARGS_FILE: args, FAKE_WB_TUNES_FILE: tunes });
    await engine.start(cfg([A, B, C]));                    // 3 lanes
    await waitFor(() => lines(tunes).length >= 1, 1000);
    await engine.retune(cfg([ch(162_550_000)]));           // 1 lane <= 3: fits
    await waitFor(() => lines(tunes).length >= 2, 1000);
    await engine.stop();
    expect(lines(args)).toHaveLength(1);
  });

  it("RESPAWNS when an added channel needs more lanes than were spawned", async () => {
    const args = tmpFile("args");
    const { engine } = makeEngine({ FAKE_WB_ARGS_FILE: args });
    await engine.start(cfg([A, B]));                       // spawned 2 lanes
    await waitFor(() => lines(args).length >= 1, 1000);
    await engine.retune(cfg([A, B, C]));                   // one group of 3 => needs 3 lanes
    await waitFor(() => lines(args).length >= 2, 2000);    // had to respawn
    await engine.stop();
    expect(lines(args).length).toBe(2);
    expect(lines(args)[1]).toContain("--lanes 3");         // respawned with the bigger plan
  });

  it("RESPAWNS when an edit needs an AM path a spawned lane lacks", async () => {
    const args = tmpFile("args");
    const { engine } = makeEngine({ FAKE_WB_ARGS_FILE: args });
    await engine.start(cfg([A, B, C]));                    // 3 FM lanes (slots f f b)
    await waitFor(() => lines(args).length >= 1, 1000);
    await engine.retune(cfg([A, { ...B, mode: "am" }, C])); // slot 1 now AM; lane 1 was FM-only
    await waitFor(() => lines(args).length >= 2, 2000);
    await engine.stop();
    expect(lines(args).length).toBe(2);
  });

  it("tears the helper down (releases the SDR) when the last channel is deleted", async () => {
    const args = tmpFile("args");
    const { engine } = makeEngine({ FAKE_WB_ARGS_FILE: args });
    await engine.start(cfg([A]));                          // 1 helper
    await waitFor(() => lines(args).length >= 1, 1000);
    await engine.retune(cfg([]));                          // empty: must NOT re-point onto nothing
    // No new helper spawned for the empty set...
    expect(lines(args).length).toBe(1);
    // ...and the prior helper was released: a later real config must SPAWN
    // afresh (if it were still alive, retune would have re-pointed it instead).
    await engine.retune(cfg([A]));
    await waitFor(() => lines(args).length >= 2, 2000);
    await engine.stop();
    expect(lines(args).length).toBe(2);
  });
});
