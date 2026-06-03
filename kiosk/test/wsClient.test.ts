import { describe, it, expect, vi } from "vitest";
import { ReconnectingWs } from "../src/frontend/lib/wsClient.js";

class FakeSocket {
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  static instances: FakeSocket[] = [];
  constructor(public url: string) { FakeSocket.instances.push(this); }
  close() { this.onclose?.(); }
}

describe("ReconnectingWs", () => {
  it("delivers parsed messages to the handler", () => {
    FakeSocket.instances = [];
    const got: any[] = [];
    const r = new ReconnectingWs("ws://x/ws", (m) => got.push(m), { SocketImpl: FakeSocket as any, reconnectMs: 1 });
    r.connect();
    const sock = FakeSocket.instances[0]!;
    sock.onmessage?.({ data: JSON.stringify({ type: "idle", ts: 1 }) });
    expect(got).toEqual([{ type: "idle", ts: 1 }]);
  });

  it("reconnects after a close", () => {
    FakeSocket.instances = [];
    vi.useFakeTimers();
    const r = new ReconnectingWs("ws://x/ws", () => {}, { SocketImpl: FakeSocket as any, reconnectMs: 10 });
    r.connect();
    FakeSocket.instances[0]!.close();
    vi.advanceTimersByTime(11);
    expect(FakeSocket.instances.length).toBe(2);
    vi.useRealTimers();
  });
});
