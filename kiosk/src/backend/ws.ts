import type { WebSocket } from "ws";
import type { EngineEvent } from "./engine/ScannerEngine.js";

interface Sendable { readyState: number; OPEN: number; send(data: string): void; }

export class WsHub {
  private clients = new Set<Sendable>();
  // Last now-playing-relevant event, replayed to clients that connect
  // mid-transmission. "active" fires only on the open TRANSITION — a channel
  // that holds open for hours (NOAA) emits nothing new, so without replay a
  // freshly-loaded dashboard says "scanning..." while audio is playing.
  // Once "audible" events flow (wideband engine), they own the slot: active
  // means "a channel opened", audible means "this is what the speaker plays".
  private lastNowPlaying: EngineEvent | null = null;
  private audibleSeen = false;
  // Last non-empty aircraft snapshot, replayed to late clients so a reconnecting
  // kiosk isn't blank for one poll interval. A separate slot from lastNowPlaying
  // so aircraft never interact with the now-playing replay reset.
  private lastAircraft: EngineEvent | null = null;

  add(ws: Sendable): void {
    this.clients.add(ws);
    if (this.lastNowPlaying && ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(this.lastNowPlaying));
    }
    if (this.lastAircraft && ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(this.lastAircraft));
    }
  }
  remove(ws: Sendable): void { this.clients.delete(ws); }

  broadcast(event: EngineEvent): void {
    if (event.type === "audible") {
      this.audibleSeen = true;
      this.lastNowPlaying = event.channel ? event : null;
    } else if (event.type === "active") {
      if (!this.audibleSeen) this.lastNowPlaying = event;
    } else if (event.type === "idle") {
      if (!this.audibleSeen) this.lastNowPlaying = null;
    } else if (event.type === "aircraft") {
      // An empty snapshot means "no aircraft" — clear the replay so a late
      // client doesn't get stale planes.
      this.lastAircraft = event.targets.length ? event : null;
    } else if (event.type === "status") {
      this.lastNowPlaying = null;
      this.audibleSeen = false;
    }
    const data = JSON.stringify(event);
    for (const ws of this.clients) {
      if (ws.readyState === ws.OPEN) ws.send(data);
    }
  }

  attach(ws: WebSocket): void {
    this.add(ws as unknown as Sendable);
    ws.on("close", () => this.remove(ws as unknown as Sendable));
  }
}
