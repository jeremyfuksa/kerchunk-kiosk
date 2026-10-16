// Merge a second event source (CbNet) into the engine the server listens
// to, so every engine.on(...) consumer — history, WS, glass, alerts — sees
// CB events without knowing where they came from.
import type { ScannerEngine, EngineListener } from "../engine/ScannerEngine.js";

export function withEventSource(engine: ScannerEngine, extra?: { on(l: EngineListener): void; off(l: EngineListener): void }): ScannerEngine {
  if (!extra) return engine;
  return new Proxy(engine, {
    get(target, prop) {
      if (prop === "on") return (l: EngineListener) => { target.on(l); extra.on(l); };
      if (prop === "off") return (l: EngineListener) => { target.off(l); extra.off(l); };
      const v = Reflect.get(target, prop, target);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}
