import type { EngineEvent } from "../../backend/engine/ScannerEngine.js";

interface Opts { SocketImpl?: typeof WebSocket; reconnectMs?: number; maxReconnectMs?: number; }

export class ReconnectingWs {
  private readonly SocketImpl: typeof WebSocket;
  private readonly baseMs: number;
  private readonly maxMs: number;
  private attempt = 0;
  private sock?: WebSocket;

  constructor(
    private readonly url: string,
    private readonly onEvent: (e: EngineEvent) => void,
    opts: Opts = {},
  ) {
    this.SocketImpl = opts.SocketImpl ?? WebSocket;
    this.baseMs = opts.reconnectMs ?? 2000;
    this.maxMs = opts.maxReconnectMs ?? 30_000;
  }

  connect(): void {
    const sock = new this.SocketImpl(this.url);
    this.sock = sock;
    // A good connection resets the backoff so the NEXT outage starts fast again.
    sock.onopen = () => { this.attempt = 0; };
    sock.onmessage = (e: MessageEvent) => {
      try { this.onEvent(JSON.parse(e.data) as EngineEvent); } catch { /* ignore */ }
    };
    sock.onclose = () => {
      // Exponential backoff with jitter, capped. Several pages each hold a
      // socket; a fixed 2 s retry means every page hammers the backend in
      // lockstep during an outage and reconnects in a thundering herd on
      // restart. Delay = 50–100% of the (capped) exponential window.
      const window = Math.min(this.maxMs, this.baseMs * 2 ** this.attempt);
      this.attempt++;
      const delay = window * 0.5 + Math.random() * window * 0.5;
      setTimeout(() => this.connect(), delay);
    };
  }
}
