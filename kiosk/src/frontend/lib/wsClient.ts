import type { EngineEvent } from "../../backend/engine/ScannerEngine.js";

interface Opts { SocketImpl?: typeof WebSocket; reconnectMs?: number; }

export class ReconnectingWs {
  private readonly SocketImpl: typeof WebSocket;
  private readonly reconnectMs: number;
  private sock?: WebSocket;

  constructor(
    private readonly url: string,
    private readonly onEvent: (e: EngineEvent) => void,
    opts: Opts = {},
  ) {
    this.SocketImpl = opts.SocketImpl ?? WebSocket;
    this.reconnectMs = opts.reconnectMs ?? 2000;
  }

  connect(): void {
    const sock = new this.SocketImpl(this.url);
    this.sock = sock;
    sock.onmessage = (e: MessageEvent) => {
      try { this.onEvent(JSON.parse(e.data) as EngineEvent); } catch { /* ignore */ }
    };
    sock.onclose = () => { setTimeout(() => this.connect(), this.reconnectMs); };
  }
}
