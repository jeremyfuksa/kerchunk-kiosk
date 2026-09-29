import { describe, it, expect, vi } from "vitest";
import { ReconnectingWs } from "../src/frontend/lib/wsClient.js";

class FakeSocket {
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  static instances: FakeSocket[] = [];
  constructor(public url: string) { FakeSocket.instances.push(this); }
  close() { this.onclose?.(); }
  open() { this.onopen?.(); }
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
    vi.advanceTimersByTime(11); // first backoff window is ≤ baseMs
    expect(FakeSocket.instances.length).toBe(2);
    vi.useRealTimers();
  });

  it("calls onOpen on the first open and on every reconnect", () => {
    FakeSocket.instances = [];
    vi.useFakeTimers();
    let opens = 0;
    const r = new ReconnectingWs("ws://x/ws", () => {}, { SocketImpl: FakeSocket as any, reconnectMs: 10, onOpen: () => { opens++; } });
    r.connect();
    expect(opens).toBe(0);
    FakeSocket.instances[0]!.open();
    expect(opens).toBe(1);
    FakeSocket.instances[0]!.close();
    vi.advanceTimersByTime(11);
    FakeSocket.instances[1]!.open();
    expect(opens).toBe(2);
    vi.useRealTimers();
  });

  it("works without onOpen (existing callers)", () => {
    FakeSocket.instances = [];
    const r = new ReconnectingWs("ws://x/ws", () => {}, { SocketImpl: FakeSocket as any });
    r.connect();
    expect(() => FakeSocket.instances[0]!.open()).not.toThrow();
  });

  it("keeps reconnecting with a capped backoff, and resets after a good open", () => {
    FakeSocket.instances = [];
    vi.useFakeTimers();
    const r = new ReconnectingWs("ws://x/ws", () => {}, {
      SocketImpl: FakeSocket as any, reconnectMs: 10, maxReconnectMs: 100,
    });
    r.connect();
    for (let i = 0; i < 5; i++) {
      FakeSocket.instances.at(-1)!.close();
      vi.advanceTimersByTime(100); // ≥ cap → the reconnect always fires
    }
    expect(FakeSocket.instances.length).toBe(6); // initial + 5 reconnects, never gives up

    // A successful open resets the backoff: the next close reconnects within baseMs again.
    FakeSocket.instances.at(-1)!.open();
    FakeSocket.instances.at(-1)!.close();
    vi.advanceTimersByTime(11);
    expect(FakeSocket.instances.length).toBe(7);
    vi.useRealTimers();
  });
});
