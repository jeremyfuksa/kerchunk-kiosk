import { describe, it, expect } from "vitest";
import { LiveStore } from "../src/frontend/admin/liveStore.js";

// connect()/toggleStream() touch browser globals (WebSocket, Audio, location)
// that don't exist under the node test environment — covered by the
// on-hardware/screenshot proof instead. requestResync() and the initial
// flag are pure state, so they're covered here.
describe("LiveStore resync flag", () => {
  it("starts pending (bootstrap needs one /api/status fetch)", () => {
    const live = new LiveStore();
    expect(live.resyncPending).toBe(true);
  });
  it("a WS (re)open drops what's playing and queues a resync", () => {
    const live = new LiveStore();
    live.set({ nowPlaying: { freq: 1, alphaTag: "A" }, audibleDriven: true });
    live.resyncPending = false;
    const seen: Array<unknown> = [];
    live.subscribe((s) => seen.push(s.nowPlaying));
    live.onSocketOpen();
    expect(live.state.nowPlaying).toBeNull();
    expect(live.state.audibleDriven).toBe(false);
    expect(live.resyncPending).toBe(true);
    expect(seen.at(-1)).toBeNull(); // subscribers repainted
  });
  it("status is due on a pending resync or after the minimum cadence", () => {
    const live = new LiveStore();
    expect(live.statusDue(0, 60_000)).toBe(true); // bootstrap
    live.resyncPending = false; live.statusAt = 1_000;
    expect(live.statusDue(30_000, 60_000)).toBe(false);
    expect(live.statusDue(61_000, 60_000)).toBe(true);
    live.requestResync();
    expect(live.statusDue(2_000, 60_000)).toBe(true);
  });
  it("requestResync sets the flag back on", () => {
    const live = new LiveStore();
    live.resyncPending = false;
    live.requestResync();
    expect(live.resyncPending).toBe(true);
  });
});
