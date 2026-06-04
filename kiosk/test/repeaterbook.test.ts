import { describe, it, expect, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RepeaterBook } from "../src/backend/repeaterbook.js";

const EXPORT = {
  count: 2,
  results: [
    { Callsign: "W0ABC", Frequency: "145.130", "Nearest City": "Olathe", State: "Kansas", PL: "88.5", Lat: "38.8814", Long: "-94.8191" },
    { Callsign: "WQXX123", Frequency: "462.675", "Nearest City": "Kansas City", State: "Missouri", PL: "141.3", Lat: "39.0997", Long: "-94.5786" },
  ],
};

function make(fetcher = vi.fn()) {
  const dir = mkdtempSync(join(tmpdir(), "rb-"));
  const rb = new RepeaterBook({
    userAgent: "Kerchunk/1.0 (test)",
    states: ["Kansas", "Missouri"],
    cacheDir: dir,
    fetcher,
  });
  return { rb, fetcher, dir };
}

describe("RepeaterBook", () => {
  it("finds a repeater by output frequency and formats a tag", async () => {
    const { rb, fetcher } = make(vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => EXPORT }));
    const hit = await rb.lookup(145130000);
    expect(hit?.callsign).toBe("W0ABC");
    expect(hit?.tag).toBe("W0ABC Olathe KS · PL 88.5");
    // identifies itself with the registered UA
    expect(fetcher.mock.calls[0][1].headers["User-Agent"]).toBe("Kerchunk/1.0 (test)");
  });

  it("matches within ±2.5 kHz (raster rounding tolerance)", async () => {
    const { rb } = make(vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => EXPORT }));
    expect((await rb.lookup(462676000))?.callsign).toBe("WQXX123");
    expect(await rb.lookup(462700000)).toBeNull();
  });

  it("caches state exports — a second lookup does not refetch", async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => EXPORT });
    const { rb } = make(fetcher);
    await rb.lookup(145130000);
    const calls = fetcher.mock.calls.length; // one per state
    await rb.lookup(462675000);
    expect(fetcher.mock.calls.length).toBe(calls);
  });

  it("returns null gracefully on HTTP failure (e.g. UA not yet approved)", async () => {
    const { rb } = make(vi.fn().mockResolvedValue({ ok: false, status: 403, json: async () => ({}) }));
    expect(await rb.lookup(145130000)).toBeNull();
  });
});

describe("bearer token (March 2026 policy)", () => {
  it("sends Authorization when a token is configured", async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => EXPORT });
    const dir = mkdtempSync(join(tmpdir(), "rb-"));
    const rb = new RepeaterBook({
      userAgent: "Kerchunk/1.0 (test)", apiToken: "app_abc123",
      states: ["Kansas"], cacheDir: dir, fetcher,
    });
    await rb.lookup(145130000);
    expect(fetcher.mock.calls[0][1].headers["Authorization"]).toBe("Bearer app_abc123");
  });
});


describe("location capture", () => {
  it("returns lat/lon/city/state from the export record", async () => {
    const { rb } = make(vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => EXPORT }));
    const hit = await rb.lookup(145130000);
    expect(hit?.location).toEqual({
      lat: 38.8814, lon: -94.8191, city: "Olathe", state: "KS", source: "repeaterbook",
    });
  });
});
