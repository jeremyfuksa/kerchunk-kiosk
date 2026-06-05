import { describe, it, expect, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MyGmrs } from "../src/backend/mygmrs.js";

const ITEMS = { success: true, info: { total: 3 }, items: [
  { ID: 1, Name: "Eastern Independence", Location: "Independence", State: "MO", Frequency: "462.550", Status: "Online", Latitude: 39.0723, Longitude: -94.3102 },
  { ID: 2, Name: "OLATHE 550", Location: "Olathe", State: "KS", Frequency: "462.550", Status: "Online", Latitude: 38.9032, Longitude: -94.7994 },
  { ID: 3, Name: "Dead 575", Location: "Nowhere", State: "MO", Frequency: "462.575", Status: "Offline", Latitude: 39.2, Longitude: -94.5 },
] };

function make() {
  const fetcher = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ITEMS });
  const g = new MyGmrs({
    states: ["Missouri", "Kansas"], home: { lat: 39.2915, lon: -94.4953 },
    userAgent: "Kerchunk/1.0 (test)", cacheDir: mkdtempSync(join(tmpdir(), "gm-")), fetcher,
  });
  return { g, fetcher };
}

describe("MyGmrs", () => {
  it("matches a repeater output by frequency, NEAREST to home wins", async () => {
    const { g } = make();
    const hit = await g.lookup(462550000);
    expect(hit?.tag).toBe("Eastern Independence · Independence, MO");
    expect(hit?.mode).toBe("FM");
    expect(hit?.location).toMatchObject({ lat: 39.0723, lon: -94.3102, source: "mygmrs" });
  });

  it("skips offline machines and misses cleanly", async () => {
    const { g } = make();
    expect(await g.lookup(462575000)).toBeNull(); // only an Offline candidate
    expect(await g.lookup(146790000)).toBeNull(); // not GMRS
  });

  it("caches per state and identifies with the UA", async () => {
    const { g, fetcher } = make();
    await g.lookup(462550000);
    const n = fetcher.mock.calls.length;
    await g.lookup(462650000);
    expect(fetcher.mock.calls.length).toBe(n);
    expect(fetcher.mock.calls[0][1].headers["User-Agent"]).toBe("Kerchunk/1.0 (test)");
  });
});
