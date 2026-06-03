import { describe, it, expect, vi } from "vitest";
import { FakeEngine } from "../src/backend/engine/FakeEngine.js";
import type { ScanConfig, EngineEvent } from "../src/backend/engine/ScannerEngine.js";

const cfg: ScanConfig = {
  channels: [{ id: "c1", freq: 145130000, alphaTag: "KC0KW", mode: "nfm", enabled: true }],
  sampleRate: 12000, squelchLevel: 150, dwellMs: 2000, gain: "auto", audioSink: "test",
};

describe("FakeEngine", () => {
  it("emits a status=running event on start", async () => {
    const e = new FakeEngine();
    const events: EngineEvent[] = [];
    e.on((ev) => events.push(ev));
    await e.start(cfg);
    expect(e.state).toBe("running");
    expect(events.some((ev) => ev.type === "status" && ev.state === "running")).toBe(true);
  });

  it("can emit a scripted active event", async () => {
    const e = new FakeEngine();
    const fn = vi.fn();
    e.on(fn);
    await e.start(cfg);
    e.emitActive(cfg.channels[0]!);
    expect(fn).toHaveBeenCalledWith(expect.objectContaining({ type: "active" }));
  });

  it("emits status=stopped on stop", async () => {
    const e = new FakeEngine();
    await e.start(cfg);
    await e.stop();
    expect(e.state).toBe("stopped");
  });
});
