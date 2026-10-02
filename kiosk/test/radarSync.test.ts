import { describe, it, expect, vi } from "vitest";
import { RadarSync, type RadarMeta } from "../src/frontend/map/radarSync.js";

const meta = (scanTime: number, over: Partial<RadarMeta> = {}): RadarMeta => ({
  scanTime, fetchedAt: scanTime, bounds: { n: 40, s: 39, e: -94, w: -95 }, width: 2, height: 2, stale: false, ...over,
});

function make(metas: Array<RadarMeta | null>, t = 1_000_000) {
  let i = 0;
  const deps = {
    fetchMeta: vi.fn(async () => metas[Math.min(i++, metas.length - 1)] ?? null),
    fetchFrame: vi.fn(async () => new Uint8Array([1, 2, 3, 4])),
    onFrame: vi.fn(),
    onStale: vi.fn(),
    staleMs: 1_200_000,
    now: () => t,
  };
  return { sync: new RadarSync(deps), deps, setNow: (n: number) => { t = n; } };
}

describe("RadarSync", () => {
  it("fetches the frame once per new scanTime (missed WS events are covered by polling)", async () => {
    const { sync, deps } = make([meta(900_000), meta(900_000), meta(950_000)]);
    await sync.poll(); await sync.poll(); await sync.poll();
    expect(deps.fetchFrame).toHaveBeenCalledTimes(2);
    expect(deps.onFrame.mock.calls.map(([f]) => f.meta.scanTime)).toEqual([900_000, 950_000]);
  });

  it("drops a frame whose length doesn't match the meta and retries next poll", async () => {
    const { sync, deps } = make([meta(900_000, { width: 3 }), meta(900_000)]);
    await sync.poll();
    expect(deps.onFrame).not.toHaveBeenCalled();
    await sync.poll();
    expect(deps.onFrame).toHaveBeenCalledTimes(1);
  });

  it("a concurrent poll does not double-fetch", async () => {
    const { sync, deps } = make([meta(900_000)]);
    await Promise.all([sync.poll(), sync.poll()]);
    expect(deps.fetchFrame).toHaveBeenCalledTimes(1);
  });

  it("404/503/network errors are quiet no-ops", async () => {
    const { sync, deps } = make([null]);
    deps.fetchMeta.mockRejectedValueOnce(new Error("offline"));
    await sync.poll();
    await sync.poll();
    expect(deps.onFrame).not.toHaveBeenCalled();
    expect(deps.onStale).not.toHaveBeenCalled();
  });

  it("reports stale from the server flag or from local age, only on change", async () => {
    const { sync, deps, setNow } = make([meta(900_000)], 1_000_000);
    await sync.poll();
    expect(deps.onStale).not.toHaveBeenCalled();
    setNow(900_000 + 1_200_001);
    sync.checkStale();
    sync.checkStale();
    expect(deps.onStale.mock.calls).toEqual([[true]]);
  });

  it("server-flagged stale fires immediately", async () => {
    const { sync, deps } = make([meta(900_000, { stale: true })]);
    await sync.poll();
    expect(deps.onStale.mock.calls).toEqual([[true]]);
  });
});
