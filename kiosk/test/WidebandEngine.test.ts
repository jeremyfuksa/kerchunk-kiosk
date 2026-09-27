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

  it("helper txstat => one JSONL line (t + freqHz added), never an EngineEvent", async () => {
    const path = tmpFile("txstats.jsonl");
    const { engine, events } = makeEngine({
      FAKE_WB_SCRIPT: [
        `{"ev":"txstat","id":"${VHF_A.id}","mode":"fm","opened":true,"polls":57,"quietP10":-21.5,"quietP50":-18.2,"quietP90":-12.0,"aboveFloorP50":19.4}`,
        `{"ev":"txstat","id":"cc_463562500","mode":"fm","opened":false,"polls":12,"aboveFloorP50":11.1}`,
        `{"ev":"txstat","id":"nope","mode":"am","opened":false,"polls":30,"quietP50":-2.5,"quietP10":-3,"quietP90":-1,"aboveFloorP50":9.5}`,
      ].join("\n"),
    }, { txStatsPath: path });
    await engine.start(cfg([VHF_A, VHF_B]));
    await waitFor(() => lines(path).length >= 3, 2000);
    await engine.stop();
    await engine.flushTxStats();
    const recs = lines(path).map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(recs).toHaveLength(3);
    expect(recs[0]).toMatchObject({
      id: VHF_A.id, freqHz: VHF_A.freq, mode: "fm", opened: true, polls: 57,
      quietP10: -21.5, quietP50: -18.2, quietP90: -12.0, aboveFloorP50: 19.4,
    });
    expect(Number.isNaN(Date.parse(recs[0]!.t as string))).toBe(false);
    expect(recs[1]).toMatchObject({ id: "cc_463562500", freqHz: 463_562_500, opened: false });
    expect(recs[1]).not.toHaveProperty("quietP50");
    expect(recs[2]).toMatchObject({ id: "nope", mode: "am" });
    expect(recs[2]).not.toHaveProperty("freqHz");              // unknown id: no freq
    expect(events.some((e) => (e.type as string) === "txstat")).toBe(false);
  });

  it("txstat without txStatsPath is ignored", async () => {
    const { engine, events } = makeEngine({
      FAKE_WB_SCRIPT: `{"ev":"txstat","id":"${VHF_A.id}","mode":"fm","opened":true,"polls":20}`,
    });
    await engine.start(cfg([VHF_A]));
    await new Promise((r) => setTimeout(r, 200));
    await engine.stop();
    expect(events.some((e) => (e.type as string) === "txstat")).toBe(false);
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

  it("backs off exponentially between failed respawns", async () => {
    // A helper that can't open its device died and respawned ~1.4x/sec for two
    // and a half minutes on the appliance (weather SDR absent at boot). On a
    // box running close to its thermal trip, a 1 Hz respawn loop is a real
    // hazard, not just log spam.
    const logs: string[] = [];
    const { engine } = makeEngine(
      { FAKE_WB_MODE: "nodevice" },
      { restartDelayMs: 20, maxRestartDelayMs: 500, log: (m: string) => logs.push(m) },
    );
    await engine.start(cfg([VHF_A]));
    const delays = () => logs
      .map((m) => /respawn in (\d+)ms/.exec(m))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => Number(m[1]));
    await waitFor(() => delays().length >= 4, 3000);
    await engine.stop();
    const d = delays();
    expect(d.length).toBeGreaterThanOrEqual(4);
    // Strictly increasing until the cap — 20, 40, 80, 160...
    expect(d[1]).toBeGreaterThan(d[0]!);
    expect(d[2]).toBeGreaterThan(d[1]!);
    expect(d[3]).toBeGreaterThan(d[2]!);
  });

  it("caps the backoff so a long-absent device still gets retried", async () => {
    // Backoff must not grow unbounded: an SDR the operator replugs an hour
    // later has to be picked up without a manual service restart.
    const logs: string[] = [];
    const { engine } = makeEngine(
      { FAKE_WB_MODE: "nodevice" },
      { restartDelayMs: 20, maxRestartDelayMs: 60, log: (m: string) => logs.push(m) },
    );
    await engine.start(cfg([VHF_A]));
    const delays = () => logs
      .map((m) => /respawn in (\d+)ms/.exec(m))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => Number(m[1]));
    await waitFor(() => delays().length >= 5, 3000);
    await engine.stop();
    expect(Math.max(...delays())).toBeLessThanOrEqual(60);
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

  describe("helper args + liveness watchdogs", () => {
    it("forwards nativeQuietDb as --quiet-db; sends no retired lane-plan/detect args", async () => {
      const args = tmpFile("args");
      const { engine } = makeEngine({ FAKE_WB_ARGS_FILE: args });
      await engine.start(cfg([VHF_A, VHF_B], { nativeQuietDb: -7.5 }));
      await waitFor(() => lines(args).length >= 1, 1000);
      await engine.stop();
      const a = lines(args)[0] ?? "";
      expect(a).toContain("--quiet-db -7.5");
      expect(a).not.toContain("--detect-via");
      expect(a).not.toContain("--lane-modes");
    });

    it("always passes --rate and --lanes: defaults 2.5 Msps / 32, config knobs, option overrides", async () => {
      const spawnArgs = async (c: ScanConfig, over: Record<string, unknown> = {}) => {
        const args = tmpFile("args");
        const { engine } = makeEngine({ FAKE_WB_ARGS_FILE: args }, over);
        await engine.start(c);
        await waitFor(() => lines(args).length >= 1, 1000);
        await engine.stop();
        return lines(args)[0] ?? "";
      };
      const d = await spawnArgs(cfg([VHF_A]));
      expect(d).toContain("--rate 2500000");
      expect(d).toContain("--lanes 32");
      const k = await spawnArgs(cfg([VHF_A], { lanesPerGroup: 32, sampleRateHz: 2_000_000 }));
      expect(k).toContain("--rate 2000000");
      expect(k).toContain("--lanes 32");
      // The weather radio pins its own rate + lanes regardless of the scan knobs.
      const wx = await spawnArgs(cfg([VHF_A], { lanesPerGroup: 32, sampleRateHz: 2_000_000 }),
        { sampleRateHz: 250_000, lanes: 2 });
      expect(wx).toContain("--rate 250000");
      expect(wx).toContain("--lanes 2");
      expect(wx).not.toContain("--rate 2000000");
    });

    it("groups at lanesPerGroup: 30 channels in 1 MHz = 1 group at the default 32 lanes, 3 groups at 12", async () => {
      const thirty = Array.from({ length: 30 }, (_, i) => ch(146_000_000 + i * 30_000));
      const groupsSeen = async (lanesPerGroup?: number) => {
        const tunes = tmpFile("tunes");
        const { engine } = makeEngine({ FAKE_WB_TUNES_FILE: tunes }, { groupDwellMs: 40 });
        await engine.start(cfg(thirty, lanesPerGroup === undefined ? {} : { lanesPerGroup }));
        await waitFor(() => lines(tunes).length >= 6, 2000);
        await engine.stop();
        const ts = lines(tunes).map((l) => JSON.parse(l) as { centerHz: number; channels: unknown[] });
        return { centers: new Set(ts.map((t) => t.centerHz)).size, sizes: ts.map((t) => t.channels.length) };
      };
      const wide = await groupsSeen();
      expect(wide.centers).toBe(1);
      expect(wide.sizes[0]).toBe(30);
      const narrow = await groupsSeen(12);
      expect(narrow.centers).toBe(3);
      expect(Math.max(...narrow.sizes)).toBe(12);
    });

    it("forwards nativeAmGainDb as --am-gain-db; omits it when unset", async () => {
      const args = tmpFile("args");
      const { engine } = makeEngine({ FAKE_WB_ARGS_FILE: args });
      await engine.start(cfg([VHF_A], { nativeAmGainDb: -6 }));
      await waitFor(() => lines(args).length >= 1, 1000);
      await engine.stop();
      expect(lines(args)[0] ?? "").toContain("--am-gain-db -6");
      const plainArgs = tmpFile("args");
      const plain = makeEngine({ FAKE_WB_ARGS_FILE: plainArgs });
      await plain.engine.start(cfg([VHF_A]));
      await waitFor(() => lines(plainArgs).length >= 1, 1000);
      await plain.engine.stop();
      expect(lines(plainArgs)[0] ?? "").not.toContain("--am-gain-db");
    });

    it("forwards fmAudioLpfHz as --audio-lpf-hz; omits it when unset", async () => {
      const args = tmpFile("args");
      const { engine } = makeEngine({ FAKE_WB_ARGS_FILE: args });
      await engine.start(cfg([VHF_A], { fmAudioLpfHz: 3500 }));
      await waitFor(() => lines(args).length >= 1, 1000);
      await engine.stop();
      expect(lines(args)[0] ?? "").toContain("--audio-lpf-hz 3500");
      const plainArgs = tmpFile("args");
      const plain = makeEngine({ FAKE_WB_ARGS_FILE: plainArgs });
      await plain.engine.start(cfg([VHF_A]));
      await waitFor(() => lines(plainArgs).length >= 1, 1000);
      await plain.engine.stop();
      expect(lines(plainArgs)[0] ?? "").not.toContain("--audio-lpf-hz");
    });

    it("forwards speaker AGC/limiter knobs as flags; omits unset ones", async () => {
      const args = tmpFile("args");
      const { engine } = makeEngine({ FAKE_WB_ARGS_FILE: args });
      await engine.start(cfg([VHF_A], { speakerAgc: {
        agcTargetDb: -20, agcMaxGainDb: 12, agcMinGainDb: -10, agcAttackMs: 5,
        agcReleaseMs: 800, agcHoldBelowDb: -60, limiterCeiling: 0.6, limiterReleaseMs: 80,
      } }));
      await waitFor(() => lines(args).length >= 1, 1000);
      await engine.stop();
      const a = lines(args)[0] ?? "";
      for (const f of ["--agc-target-db -20", "--agc-max-gain-db 12", "--agc-min-gain-db -10",
        "--agc-attack-ms 5", "--agc-release-ms 800", "--agc-hold-below-db -60",
        "--limiter-ceiling 0.6", "--limiter-release-ms 80"]) expect(a).toContain(f);
      const partArgs = tmpFile("args");
      const part = makeEngine({ FAKE_WB_ARGS_FILE: partArgs });
      await part.engine.start(cfg([VHF_A], { speakerAgc: { agcReleaseMs: 600 } }));
      await waitFor(() => lines(partArgs).length >= 1, 1000);
      await part.engine.stop();
      const p = lines(partArgs)[0] ?? "";
      expect(p).toContain("--agc-release-ms 600");
      expect(p).not.toContain("--agc-target-db");
      expect(p).not.toContain("--limiter-ceiling");
      // The weather helper's config never carries speakerAgc: no AGC flags at all.
      const wxArgs = tmpFile("args");
      const wx = makeEngine({ FAKE_WB_ARGS_FILE: wxArgs });
      await wx.engine.start(cfg([VHF_A]));
      await waitFor(() => lines(wxArgs).length >= 1, 1000);
      await wx.engine.stop();
      expect(lines(wxArgs)[0] ?? "").not.toMatch(/--agc-|--limiter-/);
    });

    it("omits --quiet-db entirely when nativeQuietDb is unset (helper default applies)", async () => {
      const args = tmpFile("args");
      const { engine } = makeEngine({ FAKE_WB_ARGS_FILE: args });
      await engine.start(cfg([VHF_A]));
      await waitFor(() => lines(args).length >= 1, 1000);
      await engine.stop();
      expect(lines(args)[0] ?? "").not.toContain("--quiet-db");
    });

    it("retune never respawns for a topology change (lane slots fit every group)", async () => {
      const args = tmpFile("args");
      const tunes = tmpFile("tunes");
      const { engine } = makeEngine({ FAKE_WB_ARGS_FILE: args, FAKE_WB_TUNES_FILE: tunes }, { groupDwellMs: 60_000 });
      await engine.start(cfg([VHF_A]));
      await waitFor(() => lines(tunes).length >= 1, 1000);
      // More channels + an AM lane: the spawned lane slots just re-point.
      const many = Array.from({ length: 10 }, (_, i) => ch(146_000_000 + i * 25_000, i === 3 ? { mode: "am" } : {}));
      await engine.retune(cfg(many));
      await waitFor(() => lines(tunes).length >= 2, 1000);
      await engine.stop();
      expect(lines(args)).toHaveLength(1);
      expect(lines(tunes).length).toBeGreaterThanOrEqual(2);
    });

    it("journals the reason for a FIRST (soft-path) unexpected exit", async () => {
      const logs: string[] = [];
      const { engine } = makeEngine({ FAKE_WB_MODE: "noready" }, { readyTimeoutMs: 150, log: (m: string) => logs.push(m) });
      await engine.start(cfg([VHF_A]));
      await waitFor(() => logs.some((l) => l.startsWith("[wideband]") && l.includes('no "ready" within')), 2000);
      await engine.stop();
      expect(logs.some((l) => l.startsWith("[wideband]") && l.includes('no "ready" within'))).toBe(true);
    });

    it("respawns when the helper never says ready (ready watchdog)", async () => {
      const args = tmpFile("args");
      const { engine } = makeEngine({ FAKE_WB_ARGS_FILE: args, FAKE_WB_MODE: "noready" }, { readyTimeoutMs: 200 });
      await engine.start(cfg([VHF_A]));
      const respawned = await waitFor(() => lines(args).length >= 2, 3000);
      await engine.stop();
      expect(respawned).toBe(true);
    });

    it("keeps the helper's real stderr on a ready-watchdog trip (NO_DEVICE diagnosis survives)", async () => {
      // Regression: watchdogFire used to overwrite lastStderrLine with its own
      // synthetic "no ready within..." reason, losing the helper's real stderr
      // (e.g. "failed to open RTL-SDR...") -- the operator's only diagnostic,
      // and also what the NO_DEVICE classifier regex matches against.
      const args = tmpFile("args");
      const { engine, events } = makeEngine(
        {
          FAKE_WB_ARGS_FILE: args,
          FAKE_WB_MODE: "noready",
          FAKE_WB_STDERR: "RuntimeError: failed to open RTL-SDR (serial KIOSK01): busy",
        },
        { readyTimeoutMs: 100, restartDelayMs: 50 },
      );
      await engine.start(cfg([VHF_A]));
      // Escalation (handleUnexpectedExit): failure #1 is a soft status:starting;
      // only a SECOND consecutive failure (still wedged before ready) emits the
      // hard "error" event that carries the reason text.
      await waitFor(() => lines(args).length >= 2, 3000);
      const gotError = await waitFor(
        () => events.some((e) => e.type === "error" && e.code === "NO_DEVICE"),
        3000,
      );
      await engine.stop();
      expect(gotError).toBe(true);
      const err = events.find((e) => e.type === "error" && e.code === "NO_DEVICE");
      const message = err && err.type === "error" ? err.message : "";
      expect(message).toContain('no "ready" within');
      expect(message).toContain("failed to open");
    });

    it("respawns when the helper goes silent after ready (silence watchdog); reason names the silence", async () => {
      const args = tmpFile("args");
      const { engine, events } = makeEngine(
        { FAKE_WB_ARGS_FILE: args, FAKE_WB_MODE: "silent" },
        { silenceTimeoutMs: 200, restartDelayMs: 50 },
      );
      await engine.start(cfg([VHF_A]));
      const respawned = await waitFor(() => lines(args).length >= 2, 3000);
      // Escalation: the first silence trip is a soft respawn; only the SECOND
      // consecutive one (still silent after respawn) emits the hard error
      // that carries the reason text.
      await waitFor(() => lines(args).length >= 3, 5000);
      const gotError = await waitFor(
        () => events.some((e) => e.type === "error" && e.message.includes("helper silent for")),
        3000,
      );
      await engine.stop();
      expect(respawned).toBe(true);
      expect(gotError).toBe(true);
    });

    it("a helper that only emits log lines still trips the silence watchdog (log doesn't count as liveness)", async () => {
      const args = tmpFile("args");
      // Never says anything but "log" after ready — a wedged DSP thread that
      // can still write heartbeat log lines. Spaced well inside
      // silenceTimeoutMs so a naive "any line re-arms" implementation would
      // never trip, but the total run outlasts silenceTimeoutMs so the
      // watchdog must still fire on genuine non-log silence.
      const script = [
        `{"ev":"log","msg":"heartbeat"}`,
        "sleep:60",
        `{"ev":"log","msg":"heartbeat"}`,
        "sleep:60",
        `{"ev":"log","msg":"heartbeat"}`,
        "sleep:60",
        `{"ev":"log","msg":"heartbeat"}`,
      ].join("\n");
      const { engine, events } = makeEngine(
        { FAKE_WB_ARGS_FILE: args, FAKE_WB_SCRIPT: script },
        { silenceTimeoutMs: 150, restartDelayMs: 50 },
      );
      await engine.start(cfg([VHF_A]));
      const respawned = await waitFor(() => lines(args).length >= 2, 3000);
      // Escalation (as in the plain-silence test above): the first trip is a
      // soft respawn, only the second consecutive one emits the hard error.
      await waitFor(() => lines(args).length >= 3, 5000);
      const gotError = await waitFor(
        () => events.some((e) => e.type === "error" && e.message.includes("helper silent for")),
        3000,
      );
      await engine.stop();
      expect(respawned).toBe(true);
      expect(gotError).toBe(true);
    });

  });

  it("forwards helper log events, rate-limited", async () => {
    const logs: string[] = [];
    const script = Array.from({ length: 15 }, (_, i) => `{"ev":"log","msg":"m${i}"}`).join("\n");
    const { engine } = makeEngine({ FAKE_WB_SCRIPT: script }, { log: (m: string) => logs.push(m), groupDwellMs: 60_000 });
    await engine.start(cfg([VHF_A]));
    await waitFor(() => logs.filter((l) => l.startsWith("[helper] m")).length >= 10, 2000);
    await new Promise((r) => setTimeout(r, 200));
    await engine.stop();
    const helperLines = logs.filter((l) => l.startsWith("[helper] m"));
    expect(helperLines).toHaveLength(10);                 // burst cap
    expect(helperLines[0]).toBe("[helper] m0");
  });

  it("flushes a pending log-suppression summary on stop (killChild), not just on the next window", async () => {
    const logs: string[] = [];
    const script = Array.from({ length: 15 }, (_, i) => `{"ev":"log","msg":"m${i}"}`).join("\n");
    const { engine } = makeEngine({ FAKE_WB_SCRIPT: script }, { log: (m: string) => logs.push(m), groupDwellMs: 60_000 });
    await engine.start(cfg([VHF_A]));
    await waitFor(() => logs.filter((l) => l.startsWith("[helper] m")).length >= 10, 2000);
    await engine.stop();
    expect(logs).toContain("[helper] 5 more log lines suppressed");
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

describe("per-channel leveler retired", () => {
  it("tune sends no levelDb, even for a config still carrying levelTrimDb", async () => {
    const tunes = tmpFile("tunes");
    const { engine } = makeEngine({ FAKE_WB_TUNES_FILE: tunes });
    await engine.start(cfg([{ ...VHF_A, levelTrimDb: -8.5 } as typeof VHF_A, VHF_B]));
    await waitFor(() => lines(tunes).length >= 1, 1000);
    await engine.stop();
    const first = JSON.parse(lines(tunes)[0]!);
    for (const c of first.channels) expect(c).not.toHaveProperty("levelDb");
  });

  it("a stray helper level event is ignored (not surfaced)", async () => {
    const { engine, events } = makeEngine({
      FAKE_WB_SCRIPT: `{"ev":"level","id":"${VHF_A.id}","db":-6.3}`,
    });
    await engine.start(cfg([VHF_A, VHF_B]));
    await new Promise((r) => setTimeout(r, 200));
    await engine.stop();
    expect(events.some((e) => (e as { type: string }).type === "level")).toBe(false);
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

describe("CTCSS tone squelch passthrough", () => {
  it("tune carries ctcssHz only on toned channels", async () => {
    const tunes = tmpFile("tunes");
    const { engine } = makeEngine({ FAKE_WB_TUNES_FILE: tunes });
    await engine.start(cfg([{ ...VHF_A, ctcssHz: 100.0 }, VHF_B]));
    await waitFor(() => lines(tunes).length >= 1, 1000);
    await engine.stop();
    const first = JSON.parse(lines(tunes)[0]!);
    expect(first.channels[0].ctcssHz).toBe(100.0);
    expect(first.channels[1]).not.toHaveProperty("ctcssHz");
  });

  it("helper tone => tone EngineEvent", async () => {
    const { engine, events } = makeEngine({
      FAKE_WB_SCRIPT: `{"ev":"tone","id":"${VHF_A.id}","ctcssHz":151.4}`,
    });
    await engine.start(cfg([VHF_A, VHF_B]));
    await waitFor(() => events.some((e) => e.type === "tone"), 1000);
    await engine.stop();
    const tone = events.find((e) => e.type === "tone");
    expect(tone && tone.type === "tone" && [tone.channelId, tone.ctcssHz]).toEqual([VHF_A.id, 151.4]);
  });
});

describe("retune (re-point vs respawn)", () => {
  // Three channels within one 2 MHz window => a single 3-channel group.
  const A = ch(146_790_000);            // slot 0
  const B = ch(147_330_000);            // slot 1
  const C = ch(147_900_000);            // slot 2 (SAME lane)

  it("re-points (no respawn) for a same-shape edit (rename)", async () => {
    const args = tmpFile("args");
    const tunes = tmpFile("tunes");
    const { engine } = makeEngine({ FAKE_WB_ARGS_FILE: args, FAKE_WB_TUNES_FILE: tunes });
    await engine.start(cfg([A, B]));
    await waitFor(() => lines(tunes).length >= 1, 1000);
    const tunesBefore = lines(tunes).length;
    await engine.retune(cfg([{ ...A, alphaTag: "renamed" }, B])); // same shape
    await waitFor(() => lines(tunes).length > tunesBefore, 1000);
    await engine.stop();
    expect(lines(args)).toHaveLength(1);                   // ONE helper, never respawned
  });

  it("re-points for a SMALLER config (the weather break-in: one NFM channel)", async () => {
    const args = tmpFile("args");
    const tunes = tmpFile("tunes");
    const { engine } = makeEngine({ FAKE_WB_ARGS_FILE: args, FAKE_WB_TUNES_FILE: tunes });
    await engine.start(cfg([A, B, C]));
    await waitFor(() => lines(tunes).length >= 1, 1000);
    await engine.retune(cfg([ch(162_550_000)]));
    await waitFor(() => lines(tunes).length >= 2, 1000);
    await engine.stop();
    expect(lines(args)).toHaveLength(1);
  });

  it("re-points (no respawn) when an added channel grows the group — slots fit every group", async () => {
    const args = tmpFile("args");
    const tunes = tmpFile("tunes");
    const { engine } = makeEngine({ FAKE_WB_ARGS_FILE: args, FAKE_WB_TUNES_FILE: tunes });
    await engine.start(cfg([A, B]));
    await waitFor(() => lines(tunes).length >= 1, 1000);
    await engine.retune(cfg([A, B, C]));                   // one group of 3
    await waitFor(() => lines(tunes).length >= 2, 1000);
    await engine.stop();
    expect(lines(args)).toHaveLength(1);
    const last = JSON.parse(lines(tunes).at(-1) ?? "{}") as { channels?: unknown[] };
    expect(last.channels).toHaveLength(3);                 // the new channel rides the re-point
  });

  it("re-points (no respawn) when an edit switches a channel to AM", async () => {
    const args = tmpFile("args");
    const tunes = tmpFile("tunes");
    const { engine } = makeEngine({ FAKE_WB_ARGS_FILE: args, FAKE_WB_TUNES_FILE: tunes });
    await engine.start(cfg([A, B, C]));
    await waitFor(() => lines(tunes).length >= 1, 1000);
    await engine.retune(cfg([A, { ...B, mode: "am" }, C]));
    await waitFor(() => lines(tunes).length >= 2, 1000);
    await engine.stop();
    expect(lines(args)).toHaveLength(1);
    expect(lines(tunes).at(-1)).toContain('"mode":"am"');
  });

  it("respawns when lanesPerGroup or sampleRateHz changes (spawn-time args); re-points when unchanged", async () => {
    const args = tmpFile("args");
    const tunes = tmpFile("tunes");
    const { engine } = makeEngine({ FAKE_WB_ARGS_FILE: args, FAKE_WB_TUNES_FILE: tunes }, { groupDwellMs: 60_000 });
    await engine.start(cfg([A, B], { lanesPerGroup: 16 }));
    await waitFor(() => lines(tunes).length >= 1, 1000);
    await engine.retune(cfg([A, B, C], { lanesPerGroup: 16 }));    // same shape: re-point
    await waitFor(() => lines(tunes).length >= 2, 1000);
    expect(lines(args)).toHaveLength(1);
    await engine.retune(cfg([A, B, C], { lanesPerGroup: 24 }));
    await waitFor(() => lines(args).length >= 2, 1000);
    expect(lines(args)).toHaveLength(2);
    expect(lines(args)[1]).toContain("--lanes 24");
    await engine.retune(cfg([A, B, C], { lanesPerGroup: 24, sampleRateHz: 2_200_000 }));
    await waitFor(() => lines(args).length >= 3, 1000);
    await engine.stop();
    expect(lines(args)).toHaveLength(3);
    expect(lines(args)[2]).toContain("--rate 2200000");
  });

  it("tears the helper down (releases the SDR) when the last channel is deleted", async () => {
    const args = tmpFile("args");
    const { engine } = makeEngine({ FAKE_WB_ARGS_FILE: args });
    await engine.start(cfg([A]));                          // 1 helper
    await waitFor(() => lines(args).length >= 1, 1000);
    await engine.retune(cfg([]));                          // empty: must NOT re-point onto nothing
    // No new helper spawned for the empty set (start() with zero groups runs
    // with no helper at all — see start()'s early return)...
    expect(lines(args).length).toBe(1);
    // ...and the prior helper was released: a later real config must SPAWN
    // afresh (if it were still alive, retune would have re-pointed it instead).
    await engine.retune(cfg([A]));
    await waitFor(() => lines(args).length >= 2, 2000);
    await engine.stop();
    expect(lines(args).length).toBe(2);
  });
});

describe("PCM tee gating", () => {
  it("builds the PCM tee when only close call recording is on", async () => {
    const args = tmpFile("args");
    const { engine } = makeEngine({ FAKE_WB_ARGS_FILE: args });
    await engine.start(cfg([VHF_A], { recordCloseCalls: true }));
    await waitFor(() => lines(args).length >= 1, 1000);
    await engine.stop();
    expect(lines(args)[0]).toContain("--audio-fd");
  });

  it("does not build the PCM tee when neither remote listening nor recording is on", async () => {
    const args = tmpFile("args");
    const { engine } = makeEngine({ FAKE_WB_ARGS_FILE: args });
    await engine.start(cfg([VHF_A]));
    await waitFor(() => lines(args).length >= 1, 1000);
    await engine.stop();
    expect(lines(args)[0]).not.toContain("--audio-fd");
  });
});
