# Aircraft Overlay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a live aircraft overlay to the kiosk map, fed from the public airplanes.live ADS-B HTTP API, polled by the backend and pushed to the frontend over the existing `/ws`.

**Architecture:** A backend `AircraftFeed` poller fetches airborne targets within a radius of the QTH on an interval, parses/filters/caps them, and emits snapshots. The server subscribes and broadcasts each snapshot as a new `aircraft` WS event; a frontend `AircraftLayer` reconciles Google Maps markers imperatively on each event (snap, not animate). Off by default behind a config flag; no SDR or DSP involved.

**Tech Stack:** TypeScript (ESM, Node ≥24), zod config schema, `ws` WebSockets, Google Maps JS API (frontend), vitest + `FakeEngine`/injected-fetcher tests.

## Global Constraints

- **Never commit to `main`.** All work lands on branch `feat/aircraft-overlay` (already created); ships via PR.
- **All commands run from `kiosk/`.** `cd kiosk` first. Tests: `npm test`. Build: `npm run build`.
- **ESM with `.js` import extensions** even from `.ts` source (e.g. `import { distKm } from "./powerEstimator.js"`). Omitting the extension breaks the build.
- **`tsconfig` is `strict` + `noUncheckedIndexedAccess`.** Indexed access is `T | undefined` — handle it.
- **`build:backend` copies `wideband_helper.py`** — run `npm run build`, never bare `tsc`.
- **Feature is OFF by default.** No `AircraftFeed` is constructed unless `config.aircraft.enabled` is true; disabled means zero added cost.
- **Data source is non-commercial-use-only** (airplanes.live). Endpoint default: `http://api.airplanes.live/v2/point`; rate limit 1 req/sec (5s poll default stays well under).
- **Spec:** `docs/superpowers/specs/2026-06-18-aircraft-overlay-design.md`.

---

### Task 1: Config schema — `aircraft` block

**Files:**
- Modify: `src/backend/config/schema.ts` (add the `aircraft` block inside `configSchema`, after the `display` block)
- Test: `test/schema.test.ts` (add cases)

**Interfaces:**
- Produces: `config.aircraft` shaped as `{ enabled: boolean; radiusKm: number; pollIntervalMs: number; maxTargets: number; url: string } | undefined`. All inner fields have defaults, so `aircraft: {}` parses to the full default block. `Config` type (`z.infer<typeof configSchema>`) gains the optional `aircraft` field automatically.

- [ ] **Step 1: Write the failing tests**

Add to `test/schema.test.ts` inside the existing `describe("configSchema", ...)`:

```ts
it("defaults the aircraft block fields when given an empty object", () => {
  const cfg = configSchema.parse({ ...defaultConfig(), aircraft: {} });
  expect(cfg.aircraft).toEqual({
    enabled: false,
    radiusKm: 75,
    pollIntervalMs: 5000,
    maxTargets: 60,
    url: "http://api.airplanes.live/v2/point",
  });
});

it("accepts an enabled aircraft block with overrides", () => {
  const cfg = configSchema.parse({
    ...defaultConfig(),
    aircraft: { enabled: true, radiusKm: 40, maxTargets: 30 },
  });
  expect(cfg.aircraft?.enabled).toBe(true);
  expect(cfg.aircraft?.radiusKm).toBe(40);
  expect(cfg.aircraft?.maxTargets).toBe(30);
  expect(cfg.aircraft?.pollIntervalMs).toBe(5000); // still defaulted
});

it("rejects a non-URL aircraft url", () => {
  expect(() => configSchema.parse({
    ...defaultConfig(),
    aircraft: { url: "not-a-url" },
  })).toThrow();
});

it("omits aircraft entirely when not provided", () => {
  const cfg = configSchema.parse(defaultConfig());
  expect(cfg.aircraft).toBeUndefined();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- schema`
Expected: FAIL — the new cases error because `aircraft` is stripped/undefined (e.g. `expected undefined to equal { enabled: false, ... }`).

- [ ] **Step 3: Add the schema block**

In `src/backend/config/schema.ts`, immediately after the `display: z.object({ ... }).optional(),` block and before the next top-level key, add:

```ts
  // Aircraft overlay (network ADS-B): plots airborne targets near the QTH on
  // the kiosk map from the airplanes.live public feed (no SDR, no DSP). Off by
  // default; see docs/superpowers/specs/2026-06-18-aircraft-overlay-design.md.
  aircraft: z.object({
    enabled: z.boolean().default(false),
    // Coverage radius around the QTH (km). airplanes.live /v2/point takes
    // nautical miles; the poller converts. 75 km ≈ 40 nm.
    radiusKm: z.number().positive().default(75),
    pollIntervalMs: z.number().int().positive().default(5000),
    // Nearest-N cap: with "all within radius" a busy metro can return many
    // targets; keep the nearest this-many to bound marker churn.
    maxTargets: z.number().int().positive().default(60),
    // airplanes.live REST base. The poller appends /{lat}/{lon}/{radiusNm}.
    url: z.string().url().default("http://api.airplanes.live/v2/point"),
  }).optional(),
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- schema`
Expected: PASS (all four new cases plus the existing ones).

- [ ] **Step 5: Commit**

```bash
git add src/backend/config/schema.ts test/schema.test.ts
git commit -m "feat(aircraft): add aircraft overlay config block"
```

---

### Task 2: `AircraftTarget` type, `aircraft` WS event, and replay

**Files:**
- Modify: `src/backend/engine/ScannerEngine.ts` (add `AircraftTarget` + the `aircraft` `EngineEvent` variant)
- Modify: `src/backend/ws.ts` (stash + replay the last `aircraft` event)
- Test: `test/ws.test.ts` (add a describe block)

**Interfaces:**
- Produces: `export interface AircraftTarget { hex: string; callsign: string; lat: number; lon: number; heading: number | null }` and the union member `{ type: "aircraft"; targets: AircraftTarget[]; ts: number }`. Consumed by Task 3 (poller), Task 4 (server), Task 6/7 (frontend).
- Consumes: existing `WsHub` (`src/backend/ws.ts`) `add()`/`broadcast()` and `EngineEvent` union.

- [ ] **Step 1: Write the failing tests**

Add to `test/ws.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- ws`
Expected: FAIL — TypeScript error that `"aircraft"` is not assignable to the `EngineEvent` type, and the assertions fail because there is no replay.

- [ ] **Step 3: Add the type and event variant**

In `src/backend/engine/ScannerEngine.ts`, add the interface just above `export type EngineEvent =` (after the `EngineState` type):

```ts
/** One airborne aircraft as plotted on the kiosk map (network ADS-B, not RF). */
export interface AircraftTarget {
  hex: string;          // ICAO 24-bit address — stable identity for reconcile
  callsign: string;     // flight / registration, trimmed; never empty
  lat: number;
  lon: number;
  heading: number | null; // degrees true (track); null when unknown
}
```

Then add this member to the `EngineEvent` union (e.g. just before the final `error` member):

```ts
  // Aircraft overlay snapshot (network ADS-B via AircraftFeed). Full snapshot
  // each poll — the frontend reconciles its markers against it. Synthesized by
  // the server from the poller, like "alert"; rides the union so the WS hub
  // and dashboards treat it like any other event.
  | { type: "aircraft"; targets: AircraftTarget[]; ts: number }
```

- [ ] **Step 4: Add replay to WsHub**

In `src/backend/ws.ts`, add a field next to `lastNowPlaying`:

```ts
  // Last non-empty aircraft snapshot, replayed to late clients so a reconnecting
  // kiosk isn't blank for one poll interval. A separate slot from lastNowPlaying
  // so aircraft never interact with the now-playing replay reset.
  private lastAircraft: EngineEvent | null = null;
```

In `add()`, after the existing `lastNowPlaying` replay block, add:

```ts
    if (this.lastAircraft && ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(this.lastAircraft));
    }
```

In `broadcast()`, add a branch to the `if/else if` chain (e.g. after the `status` branch):

```ts
    } else if (event.type === "aircraft") {
      // An empty snapshot means "no aircraft" — clear the replay so a late
      // client doesn't get stale planes.
      this.lastAircraft = event.targets.length ? event : null;
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -- ws`
Expected: PASS (new aircraft cases + all existing WsHub cases).

- [ ] **Step 6: Commit**

```bash
git add src/backend/engine/ScannerEngine.ts src/backend/ws.ts test/ws.test.ts
git commit -m "feat(aircraft): AircraftTarget type, aircraft WS event, replay"
```

---

### Task 3: `AircraftFeed` poller

**Files:**
- Create: `src/backend/aircraft.ts`
- Test: `test/aircraft.test.ts`

**Interfaces:**
- Consumes: `AircraftTarget` from `./engine/ScannerEngine.js` (Task 2); `distKm` from `./powerEstimator.js` (signature: `distKm(a: {lat,lon}, b: {lat,lon}): number`).
- Produces:
  - `export interface AircraftSource { onUpdate(cb: (t: AircraftTarget[]) => void): void; start(): void; stop(): void }` — the DI surface the server depends on (Task 4).
  - `export function parseAircraft(body: unknown, home: {lat,lon}, maxTargets: number): AircraftTarget[]`
  - `export interface AircraftFeedOpts { home: {lat,lon}; radiusKm?: number; pollIntervalMs?: number; maxTargets?: number; url?: string; maxStaleTicks?: number; fetcher?: (url: string) => Promise<{ json(): Promise<unknown> }> }`
  - `export class AircraftFeed implements AircraftSource` with an extra public `pollOnce(): Promise<void>` for tests.

- [ ] **Step 1: Write the failing tests**

Create `test/aircraft.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { AircraftFeed, parseAircraft } from "../src/backend/aircraft.js";

const QTH = { lat: 39.29, lon: -94.5 };

// A trimmed airplanes.live /v2/point body.
function body(ac: unknown[]) {
  return { json: async () => ({ ac }) };
}
const plane = (over: Record<string, unknown> = {}) => ({
  hex: "add10d", flight: "N99HV   ", r: "N99HV", t: "C172",
  alt_baro: 1900, track: 155.56, lat: 39.0, lon: -94.6, ...over,
});

describe("parseAircraft", () => {
  it("maps fields and trims the callsign", () => {
    const out = parseAircraft({ ac: [plane()] }, QTH, 60);
    expect(out).toEqual([
      { hex: "add10d", callsign: "N99HV", lat: 39.0, lon: -94.6, heading: 155.56 },
    ]);
  });

  it("drops on-ground targets (alt_baro === 'ground')", () => {
    const out = parseAircraft({ ac: [plane({ alt_baro: "ground" })] }, QTH, 60);
    expect(out).toEqual([]);
  });

  it("keeps targets with missing/numeric altitude", () => {
    const out = parseAircraft({ ac: [plane({ alt_baro: undefined })] }, QTH, 60);
    expect(out).toHaveLength(1);
  });

  it("falls back to registration then hex when flight is blank", () => {
    expect(parseAircraft({ ac: [plane({ flight: "   ", r: "N1234" })] }, QTH, 60)[0]!.callsign).toBe("N1234");
    expect(parseAircraft({ ac: [plane({ flight: "", r: "" })] }, QTH, 60)[0]!.callsign).toBe("ADD10D");
  });

  it("sets heading null when track is absent", () => {
    expect(parseAircraft({ ac: [plane({ track: undefined })] }, QTH, 60)[0]!.heading).toBeNull();
  });

  it("skips entries without numeric lat/lon", () => {
    expect(parseAircraft({ ac: [plane({ lat: undefined })] }, QTH, 60)).toEqual([]);
  });

  it("keeps the nearest maxTargets, sorted by distance from home", () => {
    const near = plane({ hex: "near", lat: 39.30, lon: -94.5 });   // ~1 km
    const far = plane({ hex: "far", lat: 40.5, lon: -94.5 });      // ~130 km
    const out = parseAircraft({ ac: [far, near] }, QTH, 1);
    expect(out.map((t) => t.hex)).toEqual(["near"]);
  });

  it("returns [] when the body has no ac array", () => {
    expect(parseAircraft({}, QTH, 60)).toEqual([]);
  });
});

describe("AircraftFeed", () => {
  it("queries {url}/{lat}/{lon}/{radiusNm} and emits parsed targets", async () => {
    const urls: string[] = [];
    const feed = new AircraftFeed({
      home: QTH, radiusKm: 75,
      fetcher: async (u) => { urls.push(u); return body([plane()]); },
    });
    let got: unknown = null;
    feed.onUpdate((t) => { got = t; });
    await feed.pollOnce();
    expect(urls[0]).toBe("http://api.airplanes.live/v2/point/39.29/-94.5/40"); // 75 km → 40 nm
    expect(got).toHaveLength(1);
  });

  it("retains the last good snapshot for maxStaleTicks failures, then clears", async () => {
    let mode: "ok" | "fail" = "ok";
    const feed = new AircraftFeed({
      home: QTH, maxStaleTicks: 2,
      fetcher: async () => { if (mode === "fail") throw new Error("boom"); return body([plane()]); },
    });
    const seen: number[] = [];
    feed.onUpdate((t) => seen.push(t.length));
    await feed.pollOnce();          // ok → 1
    mode = "fail";
    await feed.pollOnce();          // fail 1 → retain (1)
    await feed.pollOnce();          // fail 2 → retain (1)
    await feed.pollOnce();          // fail 3 → clear (0)
    expect(seen).toEqual([1, 1, 1, 0]);
  });

  it("polls repeatedly while started and stops on stop()", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const feed = new AircraftFeed({
        home: QTH, pollIntervalMs: 1000,
        fetcher: async () => { calls++; return body([]); },
      });
      feed.onUpdate(() => {});
      feed.start();
      await vi.advanceTimersByTimeAsync(0);     // first poll runs immediately
      expect(calls).toBe(1);
      await vi.advanceTimersByTimeAsync(1000);  // next interval
      expect(calls).toBe(2);
      feed.stop();
      await vi.advanceTimersByTimeAsync(5000);  // no further polls after stop
      expect(calls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- aircraft`
Expected: FAIL — `Cannot find module '../src/backend/aircraft.js'`.

- [ ] **Step 3: Write the implementation**

Create `src/backend/aircraft.ts`:

```ts
import type { AircraftTarget } from "./engine/ScannerEngine.js";
import { distKm } from "./powerEstimator.js";

// Airplanes.live network ADS-B feed → airborne targets near the QTH. No SDR,
// no DSP: a plain HTTP poll. Off unless config.aircraft.enabled. The endpoint
// is non-commercial-use only and rate limited to 1 req/sec (the 5s default
// poll stays well under). See the design spec for the thermal rationale
// (snap-on-poll, no per-frame animation).

export interface AircraftSource {
  onUpdate(cb: (targets: AircraftTarget[]) => void): void;
  start(): void;
  stop(): void;
}

export interface AircraftFeedOpts {
  home: { lat: number; lon: number };
  radiusKm?: number;        // default 75 (≈ 40 nm)
  pollIntervalMs?: number;  // default 5000
  maxTargets?: number;      // default 60 (nearest-N cap)
  url?: string;             // default http://api.airplanes.live/v2/point
  /** Retain the last good snapshot for this many consecutive failed polls
   *  before clearing the map. Default 2. */
  maxStaleTicks?: number;
  /** Injected for tests; defaults to global fetch. */
  fetcher?: (url: string) => Promise<{ json(): Promise<unknown> }>;
}

// Only the airplanes.live fields we read. alt_baro is a number while airborne
// and the string "ground" on the ramp.
interface RawAc {
  hex?: string;
  flight?: string;
  r?: string;
  lat?: number;
  lon?: number;
  track?: number;
  alt_baro?: number | string;
}

/** Map a /v2/point body to airborne targets, nearest `maxTargets` from home. */
export function parseAircraft(
  body: unknown,
  home: { lat: number; lon: number },
  maxTargets: number,
): AircraftTarget[] {
  const ac = (body as { ac?: unknown } | null)?.ac;
  if (!Array.isArray(ac)) return [];
  const out: Array<AircraftTarget & { dist: number }> = [];
  for (const raw of ac as RawAc[]) {
    // Airborne only: a grounded target reports alt_baro === "ground". A missing
    // or numeric altitude is treated as airborne.
    if (raw.alt_baro === "ground") continue;
    if (typeof raw.lat !== "number" || typeof raw.lon !== "number") continue;
    const hex = (raw.hex ?? "").trim();
    if (!hex) continue;
    const callsign =
      (raw.flight ?? "").trim() || (raw.r ?? "").trim() || hex.toUpperCase();
    out.push({
      hex,
      callsign,
      lat: raw.lat,
      lon: raw.lon,
      heading: typeof raw.track === "number" ? raw.track : null,
      dist: distKm(home, { lat: raw.lat, lon: raw.lon }),
    });
  }
  out.sort((a, b) => a.dist - b.dist);
  return out.slice(0, maxTargets).map(({ dist: _dist, ...t }) => t);
}

export class AircraftFeed implements AircraftSource {
  private readonly home: { lat: number; lon: number };
  private readonly radiusNm: number;
  private readonly pollIntervalMs: number;
  private readonly maxTargets: number;
  private readonly maxStaleTicks: number;
  private readonly url: string;
  private readonly fetcher: NonNullable<AircraftFeedOpts["fetcher"]>;
  private cb: ((t: AircraftTarget[]) => void) | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private last: AircraftTarget[] = [];
  private failStreak = 0;

  constructor(opts: AircraftFeedOpts) {
    this.home = opts.home;
    this.radiusNm = Math.max(1, Math.round((opts.radiusKm ?? 75) / 1.852));
    this.pollIntervalMs = opts.pollIntervalMs ?? 5000;
    this.maxTargets = opts.maxTargets ?? 60;
    this.maxStaleTicks = opts.maxStaleTicks ?? 2;
    this.url = opts.url ?? "http://api.airplanes.live/v2/point";
    this.fetcher = opts.fetcher ?? ((u) => fetch(u));
  }

  onUpdate(cb: (t: AircraftTarget[]) => void): void {
    this.cb = cb;
  }

  start(): void {
    this.stopped = false;
    void this.loop();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** One fetch + emit cycle. Public for deterministic tests. */
  async pollOnce(): Promise<void> {
    const endpoint = `${this.url}/${this.home.lat}/${this.home.lon}/${this.radiusNm}`;
    try {
      const res = await this.fetcher(endpoint);
      const targets = parseAircraft(await res.json(), this.home, this.maxTargets);
      this.failStreak = 0;
      this.last = targets;
      this.emit(targets);
    } catch (err) {
      this.failStreak++;
      if (this.failStreak === 1) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[aircraft] feed error: ${msg}`.slice(0, 200));
      }
      // Retain the last good snapshot briefly so a single network blip doesn't
      // blank the map; after maxStaleTicks consecutive failures, clear it.
      this.emit(this.failStreak <= this.maxStaleTicks ? this.last : []);
    }
  }

  private emit(targets: AircraftTarget[]): void {
    this.cb?.(targets);
  }

  private async loop(): Promise<void> {
    if (this.stopped) return;
    await this.pollOnce();
    if (this.stopped) return;
    // Back off when the feed is failing (cap 6×) so an offline feed doesn't
    // hammer the endpoint; healthy cadence (failStreak 0 → 1×) resumes on success.
    const delay = this.pollIntervalMs * Math.min(2 ** this.failStreak, 6);
    this.timer = setTimeout(() => void this.loop(), delay);
    this.timer.unref?.();
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- aircraft`
Expected: PASS (all `parseAircraft` and `AircraftFeed` cases).

- [ ] **Step 5: Commit**

```bash
git add src/backend/aircraft.ts test/aircraft.test.ts
git commit -m "feat(aircraft): AircraftFeed poller for airplanes.live"
```

---

### Task 4: Server wiring — subscribe + lifecycle

**Files:**
- Modify: `src/backend/server.ts` (`ServerDeps.aircraftFeed`; subscribe/start in `createServer`; stop on `server` close)
- Test: `test/api.test.ts` (add a case)

**Interfaces:**
- Consumes: `AircraftSource` from `./aircraft.js` (Task 3); `WsHub` and the `aircraft` `EngineEvent` (Task 2).
- Produces: `ServerDeps` gains `aircraftFeed?: AircraftSource`. When present, `createServer` calls `aircraftFeed.onUpdate(...)` → `wsHub.broadcast({ type:"aircraft", targets, ts })`, then `aircraftFeed.start()`, and `server.on("close", () => aircraftFeed.stop())`.

- [ ] **Step 1: Write the failing test**

Add to `test/api.test.ts`. First extend the imports at the top:

```ts
import type { AircraftSource } from "../src/backend/aircraft.js";
import type { AircraftTarget } from "../src/backend/engine/ScannerEngine.js";
```

Then add this fake near the top of the file (after the imports):

```ts
class FakeAircraftFeed implements AircraftSource {
  started = false;
  private cb: ((t: AircraftTarget[]) => void) | null = null;
  onUpdate(cb: (t: AircraftTarget[]) => void) { this.cb = cb; }
  start() { this.started = true; }
  stop() { /* no-op */ }
  fire(targets: AircraftTarget[]) { this.cb?.(targets); }
}
```

And add this test inside the `describe("HTTP API", ...)` block:

```ts
it("broadcasts aircraft snapshots from the feed over the WS hub", () => {
  dir = mkdtempSync(join(tmpdir(), "ksrv-"));
  const configStore = new ConfigStore(join(dir, "config.json"));
  const engine = new FakeEngine();
  const activityLog = new ActivityLog(100);
  const wsHub = new WsHub();
  const aircraftFeed = new FakeAircraftFeed();
  createServer({ configStore, engine, activityLog, wsHub, staticDir: dir, aircraftFeed });

  expect(aircraftFeed.started).toBe(true);

  const client = { readyState: 1, OPEN: 1, send: vi.fn() } as any;
  wsHub.add(client);
  const targets = [{ hex: "abc123", callsign: "N99HV", lat: 39, lon: -94.6, heading: 155 }];
  aircraftFeed.fire(targets);

  const sent = client.send.mock.calls.map((c: any[]) => JSON.parse(c[0]));
  const ac = sent.find((m: any) => m.type === "aircraft");
  expect(ac.targets).toEqual(targets);
});
```

Add `vi` to the vitest import at the top of `test/api.test.ts` if not already present:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- api`
Expected: FAIL — TypeScript error that `aircraftFeed` is not a known `ServerDeps` property (and `aircraftFeed.started`/broadcast assertions never run).

- [ ] **Step 3: Add the dependency and wiring**

In `src/backend/server.ts`, add the import near the other engine imports:

```ts
import type { AircraftSource } from "./aircraft.js";
```

Add to the `ServerDeps` interface (after `selfProtect?`):

```ts
  /** Optional network ADS-B aircraft overlay feed (off unless configured). */
  aircraftFeed?: AircraftSource;
```

Inside `createServer`, after the engine `on(...)` wiring and before `return { server }` (anywhere in the body is fine; put it near the other broadcast wiring), add:

```ts
  // Aircraft overlay: the poller emits a full snapshot each tick; rebroadcast
  // it verbatim and tie its lifecycle to the server so tests/shutdown clean up.
  if (deps.aircraftFeed) {
    deps.aircraftFeed.onUpdate((targets) => {
      deps.wsHub.broadcast({ type: "aircraft", targets, ts: Date.now() });
    });
    deps.aircraftFeed.start();
    server.on("close", () => deps.aircraftFeed?.stop());
  }
```

(Note: `server` is the `http.Server` already created in `createServer`. Confirm the local variable name by reading the function — it is returned as `{ server }`.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- api`
Expected: PASS (new aircraft broadcast case + all existing API cases).

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS — no regressions.

- [ ] **Step 6: Commit**

```bash
git add src/backend/server.ts test/api.test.ts
git commit -m "feat(aircraft): wire AircraftFeed into the server WS broadcast"
```

---

### Task 5: Construct the feed in `index.ts` from config

**Files:**
- Modify: `src/backend/index.ts` (construct `AircraftFeed` when enabled; pass to `createServer`; stop on signals)

**Interfaces:**
- Consumes: `AircraftFeed` from `./aircraft.js` (Task 3); `config.aircraft` (Task 1); `createServer` `ServerDeps.aircraftFeed` (Task 4); `config.display.weatherLat/weatherLon` for the QTH (same source `BusinessGuess` uses).
- Produces: a wired runtime. No new exports.

This task touches the composition root (`index.ts`), which has no unit tests in this repo. Verification is a clean build plus a documented boot check.

- [ ] **Step 1: Add the import**

In `src/backend/index.ts`, add near the other provider imports (e.g. by `import { BusinessGuess } from "./businessGuess.js";`):

```ts
import { AircraftFeed } from "./aircraft.js";
```

- [ ] **Step 2: Construct the feed from config**

Before the `const { server } = createServer({ ... })` call, add:

```ts
// Aircraft overlay (network ADS-B): only when enabled AND a QTH is configured
// (it reuses display.weatherLat/Lon, like the other QTH-anchored providers).
const aircraftFeed = config.aircraft?.enabled && config.display
  ? new AircraftFeed({
      home: { lat: config.display.weatherLat, lon: config.display.weatherLon },
      radiusKm: config.aircraft.radiusKm,
      pollIntervalMs: config.aircraft.pollIntervalMs,
      maxTargets: config.aircraft.maxTargets,
      url: config.aircraft.url,
    })
  : undefined;
```

- [ ] **Step 3: Pass it into createServer**

Add `aircraftFeed` to the `createServer({ ... })` argument object (alongside `lookup, weather, history`):

```ts
const { server } = createServer({
  configStore, engine, weatherEngine, activityLog, wsHub, staticDir: STATIC_DIR,
  lookup, weather, history, aircraftFeed,
  selfProtect: true,
  restartBackend: () => {
    void Promise.all([engine.stop(), weatherEngine?.stop() ?? Promise.resolve()])
      .finally(() => process.exit(1));
  },
});
```

- [ ] **Step 4: Stop the feed on shutdown**

Update the two signal handlers at the bottom of `index.ts` to stop the feed:

```ts
process.on("SIGTERM", async () => { aircraftFeed?.stop(); await engine.stop(); server.close(); process.exit(0); });
process.on("SIGINT", async () => { aircraftFeed?.stop(); await engine.stop(); server.close(); process.exit(0); });
```

- [ ] **Step 5: Build to verify it compiles**

Run: `npm run build`
Expected: build succeeds (frontend vite build + backend tsc + helper copy), no TypeScript errors.

- [ ] **Step 6: Manual boot check (documented, on the appliance)**

With the feature enabled in the live config (`aircraft.enabled: true`) and `display.weatherLat/Lon` set, start the backend and confirm in the browser devtools/Network that `/ws` carries `{"type":"aircraft", ...}` frames every ~5s. With `aircraft.enabled` absent/false, confirm no aircraft frames appear and no polling occurs. (No automated test — `index.ts` is the composition root.)

- [ ] **Step 7: Commit**

```bash
git add src/backend/index.ts
git commit -m "feat(aircraft): construct the feed from config in index.ts"
```

---

### Task 6: Frontend `AircraftLayer` + reconcile helper + icon

**Files:**
- Create: `src/frontend/map/aircraft.ts`
- Test: `test/aircraftLayer.test.ts`

**Interfaces:**
- Consumes: `AircraftTarget` from `../../backend/engine/ScannerEngine.js`; the global `google` Maps namespace (declared, loaded at runtime).
- Produces:
  - `export function removedHexes(prev: Iterable<string>, next: ReadonlyArray<{ hex: string }>): string[]` — pure; the markers whose hex vanished from the new snapshot.
  - `export function planeIconRotation(heading: number | null): number` — pure; degrees to rotate the glyph (0 when heading unknown).
  - `export class AircraftLayer` with constructor `(map: any, scale: number)` and `update(targets: AircraftTarget[]): void`.

The pure helpers are unit-tested. The `AircraftLayer` marker code depends on the `google` global (no DOM/Maps harness in this repo, mirroring `map.ts`), so it is exercised on the real kiosk in Task 7, not unit-tested.

- [ ] **Step 1: Write the failing tests**

Create `test/aircraftLayer.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { removedHexes, planeIconRotation } from "../src/frontend/map/aircraft.js";

describe("removedHexes", () => {
  it("returns hexes present before but absent from the new snapshot", () => {
    const prev = ["a", "b", "c"];
    const next = [{ hex: "b" }, { hex: "d" }];
    expect(removedHexes(prev, next).sort()).toEqual(["a", "c"]);
  });

  it("returns nothing when every previous hex is still present", () => {
    expect(removedHexes(["a", "b"], [{ hex: "a" }, { hex: "b" }])).toEqual([]);
  });

  it("returns all previous hexes for an empty snapshot", () => {
    expect(removedHexes(["a", "b"], []).sort()).toEqual(["a", "b"]);
  });
});

describe("planeIconRotation", () => {
  it("passes a known heading through", () => {
    expect(planeIconRotation(155.5)).toBe(155.5);
  });
  it("defaults to 0 when heading is unknown", () => {
    expect(planeIconRotation(null)).toBe(0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- aircraftLayer`
Expected: FAIL — `Cannot find module '../src/frontend/map/aircraft.js'`.

- [ ] **Step 3: Write the implementation**

Create `src/frontend/map/aircraft.ts`:

```ts
import type { AircraftTarget } from "../../backend/engine/ScannerEngine.js";

declare const google: any; // loaded dynamically with the configured Maps key

// Aircraft overlay layer (network ADS-B). Each WS "aircraft" event delivers a
// FULL snapshot; update() reconciles the marker set against it by hex — move
// the ones still present, add new ones, remove vanished ones. Markers update
// imperatively (snap), so this adds NO per-frame animation: cost is one
// reconcile per poll (~5s), independent of the blip rAF idle loop.

// Cyan so aircraft read as a distinct layer that never competes with the
// service-colored site pins or Close Call blips.
const PLANE_COLOR = "#5bd6ff";

/** Markers whose hex is no longer in the snapshot — pure for testability. */
export function removedHexes(
  prev: Iterable<string>,
  next: ReadonlyArray<{ hex: string }>,
): string[] {
  const live = new Set(next.map((t) => t.hex));
  const gone: string[] = [];
  for (const hex of new Set(prev)) if (!live.has(hex)) gone.push(hex);
  return gone;
}

/** Degrees to rotate the glyph; 0 when heading is unknown. */
export function planeIconRotation(heading: number | null): number {
  return heading ?? 0;
}

export class AircraftLayer {
  private readonly markers = new Map<string, any>();
  constructor(private readonly map: any, private readonly scale: number) {}

  update(targets: AircraftTarget[]): void {
    for (const t of targets) {
      const pos = { lat: t.lat, lng: t.lon };
      let marker = this.markers.get(t.hex);
      if (!marker) {
        marker = new google.maps.Marker({
          map: this.map,
          position: pos,
          icon: this.icon(t.heading),
          label: this.label(t.callsign),
          clickable: false,
          zIndex: 2, // above site pins (zIndex 1), below info windows
        });
        this.markers.set(t.hex, marker);
      } else {
        marker.setPosition(pos);
        marker.setIcon(this.icon(t.heading));
      }
    }
    for (const hex of removedHexes(this.markers.keys(), targets)) {
      this.markers.get(hex)?.setMap(null);
      this.markers.delete(hex);
    }
  }

  // A heading-rotated plane glyph as a Google Maps Symbol. FORWARD_CLOSED_ARROW
  // points "up" (north) at rotation 0, so the track angle rotates it directly.
  private icon(heading: number | null): any {
    return {
      path: google.maps.SymbolPath.FORWARD_CLOSED_ARROW,
      scale: 4 * this.scale,
      rotation: planeIconRotation(heading),
      fillColor: PLANE_COLOR,
      fillOpacity: 0.95,
      strokeColor: "#0a2230",
      strokeWeight: 1,
    };
  }

  private label(callsign: string): any {
    return {
      text: callsign,
      color: PLANE_COLOR,
      fontSize: `${Math.round(11 * this.scale)}px`,
      fontWeight: "600",
      className: "acLabel",
    };
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- aircraftLayer`
Expected: PASS (`removedHexes` and `planeIconRotation` cases).

- [ ] **Step 5: Commit**

```bash
git add src/frontend/map/aircraft.ts test/aircraftLayer.test.ts
git commit -m "feat(aircraft): frontend AircraftLayer + reconcile helpers"
```

---

### Task 7: Mount the layer in `map.ts` and dispatch WS events

**Files:**
- Modify: `src/frontend/map/map.ts` (instantiate `AircraftLayer` inside `start()`; handle `aircraft` events in the `ReconnectingWs` callback)
- Modify: `src/frontend/map/map.css` (label nudge for `.acLabel`, if needed)

**Interfaces:**
- Consumes: `AircraftLayer` from `./aircraft.js` (Task 6); the existing `map`, `mk` (marker scale), and the `ReconnectingWs` handler in `map.ts start()`.
- Produces: aircraft markers on the live map. No new exports.

The kiosk frontend has no DOM test harness (tests cover pure modules only), so verification is a clean build plus a manual check on the real kiosk display — consistent with how the rest of `map.ts` is validated.

- [ ] **Step 1: Import the layer**

In `src/frontend/map/map.ts`, add to the imports at the top:

```ts
import { AircraftLayer } from "./aircraft.js";
```

- [ ] **Step 2: Instantiate the layer inside `start()`**

Inside the `start(...)` function, after the `map` is created (after the `const map = new google.maps.Map(...)` block, near the other layer setup), add:

```ts
    // Aircraft overlay layer: fed by "aircraft" WS snapshots below. Markers
    // snap on each poll (no per-frame animation), so this never wakes the blip
    // idle loop. The layer is inert until the first snapshot arrives.
    const aircraft = new AircraftLayer(map, geo);
```

(`geo` is the existing scale factor — 1 interactive, 1.6 kiosk — already in scope in `start()`.)

- [ ] **Step 3: Dispatch aircraft events**

In the `new ReconnectingWs(...)` event handler, add a branch to the existing `if/else if` chain (e.g. after the `audible` branch):

```ts
      } else if (ev.type === "aircraft") {
        // Full snapshot each poll — reconcile the marker set. No wake(): the
        // aircraft layer manages its own Google Maps markers and is independent
        // of the blip render loop.
        aircraft.update(ev.targets);
```

- [ ] **Step 4: Add the label style (if labels overlap the glyph)**

In `src/frontend/map/map.css`, add:

```css
/* Aircraft callsign labels sit just below the heading glyph so they don't
   overprint it. Subtle shadow keeps them legible over the dark basemap. */
.acLabel {
  transform: translateY(14px);
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.8);
}
```

- [ ] **Step 5: Build to verify it compiles**

Run: `npm run build`
Expected: build succeeds, no TypeScript errors.

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS — no regressions across the suite.

- [ ] **Step 7: Manual verification on the kiosk**

Deploy to the appliance (`git pull && (cd kiosk && npm run build) && sudo systemctl restart kerchunk-kiosk`) with `aircraft.enabled: true`. On the kiosk map confirm: cyan heading-arrow markers with callsign labels appear within ~75 km of the QTH, snap to new positions every ~5s, do not overprint the site pins, and disappear when traffic leaves the radius. Confirm the map still idle-suspends its blip loop when there's no RF activity (aircraft markers update without holding the rAF loop open). Verify with `aircraft.enabled` off that no markers and no `/ws` aircraft frames appear.

- [ ] **Step 8: Commit**

```bash
git add src/frontend/map/map.ts src/frontend/map/map.css
git commit -m "feat(aircraft): render the aircraft overlay on the kiosk map"
```

---

## Self-Review

**Spec coverage:**
- Backend `AircraftFeed` poller (poll, airborne filter, distance cap, mapping, failure retain-then-clear, backoff, no disk cache) → Task 3. ✓
- Server DI wiring + lifecycle → Task 4; `index.ts` construction from config → Task 5. ✓
- WS contract (`AircraftTarget`, `aircraft` event) + reconnect replay → Task 2. ✓
- Config block (off by default, radius/poll/cap/url) → Task 1. ✓
- Frontend `AircraftLayer` (hex-keyed reconcile, heading icon + callsign, display-only, no expiry timer, distinct color, snap not animate) → Tasks 6–7. ✓
- Testing (fake fetcher parse/filter/cap/error; server broadcast; pure frontend helpers) → Tasks 3, 4, 6. ✓
- "Airborne only" and "snap on poll" choices honored throughout. ✓
- QTH reuses `display.weatherLat/weatherLon` (no new field) → Tasks 5, design. ✓

**Placeholder scan:** No TBD/TODO/"handle edge cases"/"similar to Task N" — every code step shows the actual code. ✓

**Type consistency:** `AircraftTarget` defined once (Task 2, `ScannerEngine.ts`) and imported everywhere. `AircraftSource` DI interface (Task 3) is what `ServerDeps` and the api-test fake implement (Task 4). `AircraftFeed`/`parseAircraft`/`removedHexes`/`planeIconRotation`/`AircraftLayer` names match across tasks and tests. `distKm` reused from `powerEstimator.ts` (signature verified). ✓

**Scope:** One subsystem (a single map overlay) — appropriate for one plan. ✓
