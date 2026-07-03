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

describe("WsHub state replay on connect", () => {
  const ch = { id: "c1", freq: 162550000, alphaTag: "WX1", mode: "nfm" as const, enabled: true };

  it("replays the last active event to a client that connects mid-transmission", () => {
    // A channel that opened BEFORE the page loaded emits no new event for
    // hours (NOAA holds open) — without replay the dashboard says
    // "scanning..." while audio is clearly playing.
    const hub = new WsHub();
    hub.broadcast({ type: "active", channel: ch, freq: ch.freq, ts: 1 });
    const late = fakeClient();
    hub.add(late);
    expect(late.send).toHaveBeenCalledWith(
      JSON.stringify({ type: "active", channel: ch, freq: ch.freq, ts: 1 }),
    );
  });

  it("does not replay once idle superseded the active", () => {
    const hub = new WsHub();
    hub.broadcast({ type: "active", channel: ch, freq: ch.freq, ts: 1 });
    hub.broadcast({ type: "idle", ts: 2 });
    const late = fakeClient();
    hub.add(late);
    expect(late.send).not.toHaveBeenCalled();
  });

  it("replays nothing when no traffic has happened yet", () => {
    const hub = new WsHub();
    const late = fakeClient();
    hub.add(late);
    expect(late.send).not.toHaveBeenCalled();
  });

  it("clears the replay when the stored channel releases before any audible", () => {
    // Pre-audible: A opens, then A releases while another channel is still up
    // (so no "idle" fires). A late client must not be told A is still playing.
    const hub = new WsHub();
    hub.broadcast({ type: "active", channel: ch, freq: ch.freq, ts: 1 });
    hub.broadcast({ type: "release", channelId: ch.id, ts: 2 });
    const late = fakeClient();
    hub.add(late);
    expect(late.send).not.toHaveBeenCalled();
  });
});

describe("WsHub replay prefers audible", () => {
  const wof = { id: "wof", freq: 464275000, alphaTag: "WoF", mode: "nfm" as const, enabled: true };
  const gmrs = { id: "g22", freq: 462725000, alphaTag: "G22", mode: "nfm" as const, enabled: true };

  it("replays the audible owner, not the most recent open", () => {
    const hub = new WsHub();
    hub.broadcast({ type: "active", channel: wof, freq: wof.freq, ts: 1 });
    hub.broadcast({ type: "audible", channel: wof, ts: 1 });
    hub.broadcast({ type: "active", channel: gmrs, freq: gmrs.freq, ts: 2 });
    const late = fakeClient();
    hub.add(late);
    expect(late.send).toHaveBeenCalledTimes(1);
    expect(JSON.parse(late.send.mock.calls[0][0]).channel.id).toBe("wof");
  });

  it("audible null clears the replay", () => {
    const hub = new WsHub();
    hub.broadcast({ type: "audible", channel: wof, ts: 1 });
    hub.broadcast({ type: "audible", channel: null, ts: 2 });
    const late = fakeClient();
    hub.add(late);
    expect(late.send).not.toHaveBeenCalled();
  });
});

describe("WsHub aircraft replay", () => {
  const targets = [
    { hex: "abc123", callsign: "N99HV", lat: 39.0, lon: -95.2, heading: 155 },
  ];

  it("replays the last non-empty aircraft snapshot to a late client", () => {
    const hub = new WsHub();
    hub.broadcast({ type: "aircraft", targets, ts: 7 });
    const late = fakeClient();
    hub.add(late);
    expect(late.send).toHaveBeenCalledWith(
      JSON.stringify({ type: "aircraft", targets, ts: 7 }),
    );
  });

  it("an empty aircraft snapshot clears the replay", () => {
    const hub = new WsHub();
    hub.broadcast({ type: "aircraft", targets, ts: 7 });
    hub.broadcast({ type: "aircraft", targets: [], ts: 8 });
    const late = fakeClient();
    hub.add(late);
    expect(late.send).not.toHaveBeenCalled();
  });

  it("aircraft replay is independent of now-playing replay", () => {
    const hub = new WsHub();
    const ch = { id: "c1", freq: 162550000, alphaTag: "WX1", mode: "nfm" as const, enabled: true };
    hub.broadcast({ type: "active", channel: ch, freq: ch.freq, ts: 1 });
    hub.broadcast({ type: "aircraft", targets, ts: 2 });
    const late = fakeClient();
    hub.add(late);
    // Both the active (now-playing) and the aircraft snapshot replay.
    expect(late.send).toHaveBeenCalledTimes(2);
  });
});
