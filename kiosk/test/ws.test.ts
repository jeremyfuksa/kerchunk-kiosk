import { describe, it, expect, vi } from "vitest";
import { WsHub } from "../src/backend/ws.js";

function fakeClient() {
  return { readyState: 1, OPEN: 1, send: vi.fn() } as any;
}

describe("WsHub", () => {
  it("broadcasts a JSON-serialised event to all open clients", () => {
    const hub = new WsHub();
    const a = fakeClient(), b = fakeClient();
    hub.add(a); hub.add(b);
    hub.broadcast({ type: "idle", ts: 5 });
    expect(a.send).toHaveBeenCalledWith(JSON.stringify({ type: "idle", ts: 5 }));
    expect(b.send).toHaveBeenCalledWith(JSON.stringify({ type: "idle", ts: 5 }));
  });

  it("skips clients that are not open", () => {
    const hub = new WsHub();
    const closed = fakeClient(); closed.readyState = 3;
    hub.add(closed);
    hub.broadcast({ type: "idle", ts: 1 });
    expect(closed.send).not.toHaveBeenCalled();
  });

  it("drops a client on remove", () => {
    const hub = new WsHub();
    const a = fakeClient();
    hub.add(a); hub.remove(a);
    hub.broadcast({ type: "idle", ts: 1 });
    expect(a.send).not.toHaveBeenCalled();
  });
});
