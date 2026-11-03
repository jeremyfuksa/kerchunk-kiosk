import { describe, it, expect, vi, afterEach } from "vitest";
import { reloadOnMapFailure, MAP_RETRY_MS } from "../src/frontend/dashboard/mapRetry.js";

afterEach(() => { vi.useRealTimers(); });

describe("reloadOnMapFailure", () => {
  it("reloads the page after a delay when the map fails to load", async () => {
    vi.useFakeTimers();
    const reload = vi.fn();
    await reloadOnMapFailure(Promise.reject(new Error("maps script failed")), reload);
    expect(reload).not.toHaveBeenCalled();
    vi.advanceTimersByTime(MAP_RETRY_MS);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("doesn't reload when the map mounted, or when no key is configured", async () => {
    vi.useFakeTimers();
    const reload = vi.fn();
    await reloadOnMapFailure(Promise.resolve({}), reload);
    await reloadOnMapFailure(Promise.resolve(null), reload);
    vi.advanceTimersByTime(MAP_RETRY_MS * 2);
    expect(reload).not.toHaveBeenCalled();
  });
});
