import type { WebSocket } from "ws";
import type { EngineEvent } from "./engine/ScannerEngine.js";

interface Sendable { readyState: number; OPEN: number; send(data: string): void; }

export class WsHub {
  private clients = new Set<Sendable>();

  add(ws: Sendable): void { this.clients.add(ws); }
  remove(ws: Sendable): void { this.clients.delete(ws); }

  broadcast(event: EngineEvent): void {
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
