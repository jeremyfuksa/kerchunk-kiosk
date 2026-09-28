import { describe, it, expect, vi, afterEach } from "vitest";
import { api } from "../src/frontend/lib/api.js";
import type { Config } from "../src/backend/config/schema.js";

afterEach(() => { vi.unstubAllGlobals(); });

describe("api error text", () => {
  it("appends the first zod issue to a 400", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      error: "invalid config",
      issues: [{ path: ["scan", "windowBandwidthHz"], message: "windowBandwidthHz 2500000 exceeds sampleRateHz 2500000 minus 50000 (edge channels can't be placed)" }],
    }), { status: 400 })));
    await expect(api.putConfig({} as Config)).rejects.toThrow(
      "invalid config: scan.windowBandwidthHz — windowBandwidthHz 2500000 exceeds sampleRateHz 2500000 minus 50000 (edge channels can't be placed)");
  });

  it("keeps a plain error unchanged", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "stale config" }), { status: 409 })));
    await expect(api.putConfig({} as Config)).rejects.toThrow(/^stale config$/);
  });
});
