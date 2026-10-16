import { describe, it, expect } from "vitest";
import { FakeEngine } from "../src/backend/engine/FakeEngine.js";
import { withEventSource } from "../src/backend/fernsdr/withEventSource.js";
import { forwardEngineEvents } from "../src/backend/fernsdr/forwardEngineEvents.js";
import type { EngineListener, EngineEvent } from "../src/backend/engine/ScannerEngine.js";

describe("forwardEngineEvents", () => {
  it("a CB active event reaches the WS broadcast and the activity log", () => {
    const engine = new FakeEngine();
    const ls = new Set<EngineListener>();
    const cb = { on: (l: EngineListener) => ls.add(l), off: (l: EngineListener) => ls.delete(l) };
    const sent: EngineEvent[] = [];
    const logged: any[] = [];
    forwardEngineEvents(withEventSource(engine, cb), { broadcast: (e) => sent.push(e) }, { add: (e) => logged.push(e) });
    const ev: EngineEvent = { type: "active", channel: { id: "cb_19", freq: 27185000, alphaTag: "CB 19 · Highway", mode: "am", enabled: true, tags: ["cb"] }, freq: 27185000, ts: 5 };
    for (const l of ls) l(ev);
    expect(sent).toContain(ev);
    expect(logged).toEqual([{ freq: 27185000, alphaTag: "CB 19 · Highway", ts: 5 }]);
    engine.emitActive({ id: "x", freq: 1, alphaTag: "X", mode: "nfm", enabled: true });
    expect(logged).toHaveLength(2);
  });
});
