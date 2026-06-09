import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BusinessGuess } from "../src/backend/businessGuess.js";
import { candidatesFor, matchesChain } from "../src/backend/businessFreqs.js";

const QTH = { lat: 39.2915, lon: -94.4953 }; // Liberty / KC North

// A Places API (New) searchText response with one place.
function place(name: string, lat: number, lon: number, addr = "1 Main St, Liberty, MO 64068, USA") {
  return { json: async () => ({ places: [{ displayName: { text: name }, formattedAddress: addr, location: { latitude: lat, longitude: lon } }] }) };
}
const emptyPlaces = { json: async () => ({ places: [] }) };

function withDir<T>(fn: (dir: string) => Promise<T> | T): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "bizg-"));
  return Promise.resolve(fn(dir)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

describe("business frequency table", () => {
  it("maps a distinctive channel to a single chain", () => {
    expect(candidatesFor(467_762_500, 2500).map((c) => c.name)).toEqual(["Home Depot"]);
  });
  it("absorbs Close Call jitter within tolerance but not the next channel", () => {
    expect(candidatesFor(467_761_000, 2500).map((c) => c.name)).toEqual(["Home Depot"]);
    expect(candidatesFor(467_750_000, 2500)).toEqual([]); // 12.5 kHz away → no match
  });
  it("a shared Star channel carries several ordered candidates", () => {
    expect(candidatesFor(467_850_000, 2500).map((c) => c.name)).toContain("Dick's Sporting Goods");
    expect(candidatesFor(467_850_000, 2500).length).toBeGreaterThan(1);
  });
  it("name-match rejects a fuzzy non-chain result", () => {
    const kroger = candidatesFor(467_925_000, 2500).find((c) => c.name === "Kroger")!;
    expect(matchesChain("Jomac Foods Inc", kroger)).toBe(false); // the KC-Kroger trap
    expect(matchesChain("Kroger Marketplace", kroger)).toBe(true);
  });
});

describe("BusinessGuess provider", () => {
  it("guesses the in-area chain and pins the real store, tagged (likely)", () => withDir(async (dir) => {
    const g = new BusinessGuess({ apiKey: "k", home: QTH, cacheDir: dir,
      fetcher: async () => place("The Home Depot", 39.2479, -94.4576) });
    const hit = await g.lookup(467_762_500);
    expect(hit?.tag).toBe("Home Depot (likely)");
    expect(hit?.location?.lat).toBeCloseTo(39.2479, 3);
    expect(hit?.location?.city).toBe("Liberty");
    expect(hit?.location?.source).toBe("google-places");
  }));

  it("rejects a fuzzy Places result (Kroger → Jomac Foods) and returns null", () => withDir(async (dir) => {
    const g = new BusinessGuess({ apiKey: "k", home: QTH, cacheDir: dir,
      fetcher: async () => place("Jomac Foods Inc", 39.17, -94.52) });
    expect(await g.lookup(467_925_000)).toBeNull(); // 467.925 candidates: Dick's, Kroger — neither name returned
  }));

  it("rejects an in-name match that is too far away", () => withDir(async (dir) => {
    const g = new BusinessGuess({ apiKey: "k", home: QTH, cacheDir: dir,
      fetcher: async () => place("Menards", 41.6, -93.6) }); // Des Moines — >40 km
    expect(await g.lookup(464_487_500)).toBeNull();
  }));

  it("walks candidates and returns the first that is genuinely in-area", () => withDir(async (dir) => {
    // 467.850 → [Home Depot, Dick's, ...]; Home Depot query returns a fuzzy
    // non-match, Dick's returns a real nearby store → Dick's wins.
    const g = new BusinessGuess({ apiKey: "k", home: QTH, cacheDir: dir,
      fetcher: async (_u, init) => {
        const q = (JSON.parse(init.body) as { textQuery: string }).textQuery;
        if (q.includes("Home Depot")) return place("Hardware Surplus LLC", 39.25, -94.45);
        if (q.includes("Dick's")) return place("DICK'S Sporting Goods", 39.2477, -94.4485);
        return emptyPlaces;
      } });
    const hit = await g.lookup(467_850_000);
    expect(hit?.tag).toBe("Dick's Sporting Goods (likely)");
  }));

  it("caches per chain — a second lookup makes no network call", () => withDir(async (dir) => {
    let calls = 0;
    const g = new BusinessGuess({ apiKey: "k", home: QTH, cacheDir: dir,
      fetcher: async () => { calls++; return place("The Home Depot", 39.2479, -94.4576); } });
    await g.lookup(467_762_500);
    await g.lookup(467_762_500);
    expect(calls).toBe(1);
    expect(existsSync(join(dir, "places-cache.json"))).toBe(true);
  }));

  it("returns null for a non-business frequency without calling Places", () => withDir(async (dir) => {
    let calls = 0;
    const g = new BusinessGuess({ apiKey: "k", home: QTH, cacheDir: dir,
      fetcher: async () => { calls++; return emptyPlaces; } });
    expect(await g.lookup(155_340_000)).toBeNull(); // Liberty Hospital — not in the retail table
    expect(calls).toBe(0);
  }));

  it("disables itself on a hard Places error and never throws", () => withDir(async (dir) => {
    let calls = 0;
    const g = new BusinessGuess({ apiKey: "k", home: QTH, cacheDir: dir,
      fetcher: async () => { calls++; return { json: async () => ({ error: { status: "PERMISSION_DENIED", message: "Places API (New) has not been used" } }) }; } });
    expect(await g.lookup(467_762_500)).toBeNull();
    expect(await g.lookup(469_562_500)).toBeNull(); // different freq
    expect(calls).toBe(1); // latched after the first hard error — no further round-trips
  }));

  it("survives a network throw without caching a transient miss", () => withDir(async (dir) => {
    let calls = 0;
    const g = new BusinessGuess({ apiKey: "k", home: QTH, cacheDir: dir,
      fetcher: async () => { calls++; if (calls === 1) throw new Error("ECONNRESET"); return place("The Home Depot", 39.2479, -94.4576); } });
    expect(await g.lookup(467_762_500)).toBeNull();   // first: network blip
    const hit = await g.lookup(467_762_500);          // retried, not cached as absent
    expect(hit?.tag).toBe("Home Depot (likely)");
    expect(calls).toBe(2);
  }));
});
