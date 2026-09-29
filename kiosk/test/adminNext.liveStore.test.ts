import { describe, it, expect } from "vitest";
import { LiveStore } from "../src/frontend/admin-next/liveStore.js";

// connect()/toggleStream() touch browser globals (WebSocket, Audio, location)
// that don't exist under the node test environment — covered by the
// on-hardware/screenshot proof instead. requestResync() and the initial
// flag are pure state, so they're covered here.
describe("LiveStore resync flag", () => {
  it("starts pending (bootstrap needs one /api/status fetch)", () => {
    const live = new LiveStore();
    expect(live.resyncPending).toBe(true);
  });
  it("requestResync sets the flag back on", () => {
    const live = new LiveStore();
    live.resyncPending = false;
    live.requestResync();
    expect(live.resyncPending).toBe(true);
  });
});
