// The boot-time engine subscription: every event (scanner helper or CB
// source) goes to the WS hub; `active` ones also land in the activity log
// (/api/logs). `onTuned` lets index.ts bring weather up after first tune.
import type { EngineEvent, EngineListener } from "../engine/ScannerEngine.js";

export function forwardEngineEvents(
  source: { on(l: EngineListener): void },
  wsHub: { broadcast(ev: EngineEvent): void },
  activityLog: { add(e: { freq: number; alphaTag: string; ts: number }): void },
  onTuned?: () => void,
): void {
  source.on((ev: EngineEvent) => {
    if (ev.type === "active") {
      activityLog.add({ freq: ev.freq, alphaTag: ev.channel.alphaTag, ts: ev.ts });
    }
    if (ev.type === "tuned") onTuned?.();
    wsHub.broadcast(ev);
  });
}
