# Weather-Only Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Designate one channel as the weather channel (stored separately in config) and add a runtime scan ⇄ weather-only mode toggle, controlled from the admin UI and API; weather-only holds the weather channel with audio always on.

**Architecture:** The mode is expressed purely as which channel set the engine runs — no `RtlFmEngine` internals change (a lone channel is already held with continuous audio). `server.ts` holds a runtime `mode` ("scan" | "weather", not persisted), `toScanConfig(cfg, mode)` selects the channel list, new endpoints set the weather channel and switch mode, and the admin/dashboard reflect it.

**Tech Stack:** TypeScript, Zod, Node http, Vitest + supertest, FakeEngine.

---

## Verified facts (from the code, do not re-litigate)

- `toScanConfig(cfg)` is at `src/backend/server.ts:25`; call sites pass only `config`
  (lines 58, 94, 128). Default channel list = `cfg.channels`.
- Routes are added as `if (method === ... && path === ...) { ... }` inside
  `handleApi` (`server.ts:84-151`); 404 fallthrough at line 151.
- Channel id convention: `randomUUID().slice(0, 8)` with a prefix (channels use
  `ch_`). Weather channel will use `wx_`.
- Tests use supertest + `FakeEngine` via a `makeApp()` helper
  (`test/api.test.ts:13-21`). The "restarts the scanner" test (line 43) shows how
  to count `engine.start` calls by monkeypatching.
- Admin form helpers `mhzToHz` / `formToChannel` live in
  `src/frontend/admin/admin.ts` and are unit-tested in `test/adminForm.test.ts`.
- `lib/api.ts` `getStatus` currently returns `{ state: string; config: Config }`.

## File Structure

- **Modify** `src/backend/config/schema.ts` — add optional `weatherChannel`.
- **Modify** `src/backend/server.ts` — runtime `mode`, `toScanConfig(cfg, mode)`,
  3 new endpoints, `mode` in `/api/status`.
- **Modify** `src/frontend/lib/api.ts` — `setMode`, `getWeatherChannel`,
  `setWeatherChannel`, widen `getStatus` type.
- **Modify** `src/frontend/admin/admin.ts` — weather-channel form + mode toggle.
- **Modify** `src/frontend/dashboard/dashboard.ts` — WEATHER badge.
- **Tests:** `test/schema.test.ts`, `test/api.test.ts`, `test/adminForm.test.ts`.

---

## Task 1: Add `weatherChannel` to the config schema

**Files:**
- Modify: `src/backend/config/schema.ts`
- Test: `test/schema.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `test/schema.test.ts` (inside the existing top-level `describe`, or append
a new one — match the file's existing import of `configSchema`/`defaultConfig`):
```ts
import { configSchema, defaultConfig } from "../src/backend/config/schema.js";

describe("weatherChannel", () => {
  it("is optional — a config without it still parses", () => {
    expect(configSchema.safeParse(defaultConfig()).success).toBe(true);
  });

  it("accepts a valid weather channel", () => {
    const cfg = { ...defaultConfig(), weatherChannel: { id: "wx_1", freq: 162550000, alphaTag: "NOAA", mode: "nfm", enabled: true } };
    expect(configSchema.safeParse(cfg).success).toBe(true);
  });

  it("rejects a weather channel with a bad mode", () => {
    const cfg = { ...defaultConfig(), weatherChannel: { id: "wx_1", freq: 162550000, alphaTag: "NOAA", mode: "ssb", enabled: true } };
    expect(configSchema.safeParse(cfg).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `cd kiosk && npx vitest run test/schema.test.ts -t weatherChannel`
Expected: the "accepts a valid weather channel" test FAILS (currently
`weatherChannel` is stripped/ignored, but the bad-mode test may already pass
because unknown keys are ignored — the valid-case assertion is the real driver).
If all three already pass, the field may already exist — STOP and report.

- [ ] **Step 3: Add the field**

In `src/backend/config/schema.ts`, inside `configSchema`, after the `audio`
object and before `channels`, add:
```ts
  // One channel designated as "the weather channel", stored separately from the
  // scan list. Weather-only mode (server runtime) holds this channel.
  weatherChannel: channelSchema.optional(),
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `cd kiosk && npx vitest run test/schema.test.ts`
Expected: PASS (all weatherChannel tests + existing schema tests).

- [ ] **Step 5: Commit**

```bash
cd /Users/jeremyfuksa/Dev/kerchunk-kiosk
git add kiosk/src/backend/config/schema.ts kiosk/test/schema.test.ts
git commit -m "feat(config): add optional weatherChannel to config schema"
```

---

## Task 2: `toScanConfig(cfg, mode)` + runtime mode in server

**Files:**
- Modify: `src/backend/server.ts`
- Test: `test/api.test.ts`

This task makes `toScanConfig` mode-aware and threads a runtime `mode` through
the server, but does NOT add the new endpoints yet (Task 3). The existing call
sites must keep working in `"scan"` mode.

- [ ] **Step 1: Write the failing test**

Add to `test/api.test.ts` inside `describe("HTTP API", ...)`:
```ts
  it("GET /api/status includes the current mode (defaults to scan)", async () => {
    const { server } = makeApp();
    const res = await request(server).get("/api/status");
    expect(res.status).toBe(200);
    expect(res.body.mode).toBe("scan");
  });
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `cd kiosk && npx vitest run test/api.test.ts -t "current mode"`
Expected: FAIL — `res.body.mode` is `undefined`.

- [ ] **Step 3: Add the runtime mode and mode-aware toScanConfig**

In `src/backend/server.ts`:

(a) Change the `toScanConfig` function (currently lines 25-34) to take a mode:
```ts
function toScanConfig(cfg: Config, mode: "scan" | "weather"): ScanConfig {
  const channels =
    mode === "weather"
      ? (cfg.weatherChannel ? [{ ...cfg.weatherChannel, enabled: true }] : [])
      : cfg.channels;
  return {
    channels,
    sampleRate: cfg.scan.sampleRate,
    squelchLevel: cfg.scan.squelchLevel,
    dwellMs: cfg.scan.dwellMs,
    gain: cfg.scan.gain,
    audioSink: cfg.audio.sink,
  };
}
```

(b) Inside `createServer`, just after `let config = configStore.load();`
(line 51), add the runtime mode (NOT persisted — always starts "scan"):
```ts
  // Runtime scan/weather mode. Deliberately not read from or written to config:
  // the kiosk always boots into scan mode.
  let mode: "scan" | "weather" = "scan";
```

(c) Update every existing `toScanConfig(config)` call to pass `mode`. There are
three: in `persistAndReload` (~line 58), in `PUT /api/config` (~line 94), and in
`POST /api/scan/start` (~line 128). Change each `toScanConfig(config)` to
`toScanConfig(config, mode)`.

(d) Update the status route (line 148) to include mode:
```ts
    if (method === "GET" && path === "/api/status") return json(res, 200, { state: engine.state, mode, config });
```

- [ ] **Step 4: Run tests to confirm pass**

Run: `cd kiosk && npx vitest run test/api.test.ts`
Expected: PASS — the new mode test plus all existing API tests still green.
Also run `npm run build:backend` (tsc) — expect no type errors (the
`toScanConfig` signature change must be reflected at all call sites).

- [ ] **Step 5: Commit**

```bash
cd /Users/jeremyfuksa/Dev/kerchunk-kiosk
git add kiosk/src/backend/server.ts kiosk/test/api.test.ts
git commit -m "feat(server): runtime scan/weather mode + mode-aware toScanConfig"
```

---

## Task 3: Weather-channel + mode endpoints

**Files:**
- Modify: `src/backend/server.ts`
- Test: `test/api.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `test/api.test.ts` inside `describe("HTTP API", ...)`:
```ts
  const WX = { freq: 162550000, alphaTag: "NOAA WX", mode: "nfm", enabled: true };

  it("PUT /api/weather-channel saves and assigns an id", async () => {
    const { server } = makeApp();
    const res = await request(server).put("/api/weather-channel").send(WX);
    expect(res.status).toBe(200);
    expect(res.body.weatherChannel.id).toMatch(/^wx_/);
    expect(res.body.weatherChannel.freq).toBe(162550000);
    // Persisted into config.
    const cfg = await request(server).get("/api/config");
    expect(cfg.body.weatherChannel.freq).toBe(162550000);
  });

  it("PUT /api/weather-channel rejects an invalid body with 400", async () => {
    const { server } = makeApp();
    const res = await request(server).put("/api/weather-channel").send({ freq: -1, alphaTag: "x", mode: "fm", enabled: true });
    expect(res.status).toBe(400);
  });

  it("POST /api/mode weather holds the weather channel (engine restarted, single channel)", async () => {
    const { server, engine } = makeApp();
    await request(server).put("/api/weather-channel").send(WX);
    let lastStartChannels: any[] | null = null;
    const realStart = engine.start.bind(engine);
    engine.start = async (cfg) => { lastStartChannels = cfg.channels; return realStart(cfg); };
    const res = await request(server).post("/api/mode").send({ mode: "weather" });
    expect(res.status).toBe(200);
    expect(res.body.mode).toBe("weather");
    expect(lastStartChannels).toHaveLength(1);
    expect(lastStartChannels![0].freq).toBe(162550000);
    expect(lastStartChannels![0].enabled).toBe(true);
  });

  it("POST /api/mode weather with NO weather channel returns 400 and does not switch", async () => {
    const { server } = makeApp();
    const res = await request(server).post("/api/mode").send({ mode: "weather" });
    expect(res.status).toBe(400);
    const st = await request(server).get("/api/status");
    expect(st.body.mode).toBe("scan");
  });

  it("POST /api/mode scan restarts the engine with the scan channel list", async () => {
    const { server, engine } = makeApp();
    await request(server).post("/api/channels").send({ freq: 145130000, alphaTag: "A", mode: "nfm", enabled: true });
    let lastStartChannels: any[] | null = null;
    const realStart = engine.start.bind(engine);
    engine.start = async (cfg) => { lastStartChannels = cfg.channels; return realStart(cfg); };
    const res = await request(server).post("/api/mode").send({ mode: "scan" });
    expect(res.status).toBe(200);
    expect(res.body.mode).toBe("scan");
    expect(lastStartChannels![0].freq).toBe(145130000);
  });

  it("POST /api/mode rejects an invalid mode value with 400", async () => {
    const { server } = makeApp();
    const res = await request(server).post("/api/mode").send({ mode: "banana" });
    expect(res.status).toBe(400);
  });
```

- [ ] **Step 2: Run to confirm they fail**

Run: `cd kiosk && npx vitest run test/api.test.ts -t "weather-channel|/api/mode"`
Expected: FAIL (routes return 404 / undefined).

- [ ] **Step 3: Add the endpoints**

In `src/backend/server.ts`, add these routes inside `handleApi`, immediately
before the `/api/status` line (~line 148):
```ts
    if (method === "GET" && path === "/api/weather-channel") {
      return json(res, 200, { weatherChannel: config.weatherChannel ?? null });
    }
    if (method === "PUT" && path === "/api/weather-channel") {
      const body = await readBody(req);
      const parsed = channelSchema.omit({ id: true }).safeParse(body);
      if (!parsed.success) return json(res, 400, { error: "invalid weather channel", issues: parsed.error.issues });
      const weatherChannel: Channel = { id: `wx_${randomUUID().slice(0, 8)}`, ...parsed.data };
      config = { ...config, weatherChannel };
      configStore.save(config);
      return json(res, 200, { weatherChannel });
    }
    if (method === "POST" && path === "/api/mode") {
      const body = await readBody(req);
      const next = body?.mode;
      if (next !== "scan" && next !== "weather") return json(res, 400, { error: "invalid mode" });
      if (next === "weather" && !config.weatherChannel) {
        return json(res, 400, { error: "no weather channel configured" });
      }
      mode = next;
      await engine.stop();
      await engine.start(toScanConfig(config, mode));
      return json(res, 200, { mode, state: engine.state });
    }
```

- [ ] **Step 4: Run to confirm pass**

Run: `cd kiosk && npx vitest run test/api.test.ts`
Expected: PASS (all new + existing). Then `npm run build:backend` — no type errors.

- [ ] **Step 5: Commit**

```bash
cd /Users/jeremyfuksa/Dev/kerchunk-kiosk
git add kiosk/src/backend/server.ts kiosk/test/api.test.ts
git commit -m "feat(api): weather-channel get/put + scan/weather mode endpoints"
```

---

## Task 4: Frontend API client

**Files:**
- Modify: `src/frontend/lib/api.ts`

No new test file — these are thin `fetch` wrappers exercised via the admin tests
in Task 5 and at runtime. (The existing `api.ts` has no direct unit test.)

- [ ] **Step 1: Add the client methods**

In `src/frontend/lib/api.ts`, widen `getStatus` and add three methods. Find the
`getStatus` line and replace it, then add the new methods alongside `setVolume`:
```ts
  getStatus: () => fetch("/api/status").then(j<{ state: string; mode: "scan" | "weather"; config: Config }>),
  getWeatherChannel: () => fetch("/api/weather-channel").then(j<{ weatherChannel: Channel | null }>),
  setWeatherChannel: (c: Omit<Channel, "id">) =>
    fetch("/api/weather-channel", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(c) }).then(j<{ weatherChannel: Channel }>),
  setMode: (mode: "scan" | "weather") =>
    fetch("/api/mode", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode }) }).then(j<{ mode: "scan" | "weather"; state: string }>),
```
Ensure `Channel` is imported at the top of `api.ts` (it imports `Config` from the
schema already; add `Channel` to that import if not present):
```ts
import type { Config, Channel } from "../../backend/config/schema.js";
```

- [ ] **Step 2: Typecheck**

Run: `cd kiosk && npm run build:backend`
Expected: no type errors. (The frontend lib is type-checked by `tsc` via the
`src/frontend/lib/**` include in tsconfig.)

- [ ] **Step 3: Commit**

```bash
cd /Users/jeremyfuksa/Dev/kerchunk-kiosk
git add kiosk/src/frontend/lib/api.ts
git commit -m "feat(api-client): weather-channel + setMode methods, status mode type"
```

---

## Task 5: Admin UI — weather channel form + mode toggle

**Files:**
- Modify: `src/frontend/admin/admin.ts`
- Test: `test/adminForm.test.ts`

The pure form→payload mapping is unit-tested (reusing the `formToChannel`
pattern). The DOM wiring follows the existing `renderAdmin` style and is verified
at runtime.

- [ ] **Step 1: Write the failing test**

Add to `test/adminForm.test.ts`:
```ts
import { weatherFormToChannel } from "../src/frontend/admin/admin.js";

describe("weather form helper", () => {
  it("weatherFormToChannel builds a valid weather-channel payload", () => {
    const payload = weatherFormToChannel({ mhz: "162.550", alphaTag: "NOAA WX", mode: "nfm" });
    expect(payload).toEqual({ freq: 162550000, alphaTag: "NOAA WX", mode: "nfm", enabled: true });
  });

  it("weatherFormToChannel throws on a non-numeric frequency", () => {
    expect(() => weatherFormToChannel({ mhz: "x", alphaTag: "y", mode: "fm" })).toThrow();
  });
});
```

- [ ] **Step 2: Run to confirm fail**

Run: `cd kiosk && npx vitest run test/adminForm.test.ts -t "weather form"`
Expected: FAIL — `weatherFormToChannel` is not exported.

- [ ] **Step 3: Add the helper (reusing formToChannel) and DOM wiring**

In `src/frontend/admin/admin.ts`:

(a) Add the exported helper near `formToChannel` — it has the same shape, so
delegate to keep it DRY:
```ts
export function weatherFormToChannel(form: { mhz: string; alphaTag: string; mode: string }): Omit<Channel, "id"> {
  return formToChannel(form);
}
```

(b) In `renderAdmin`, add a Weather section to the markup and wire it. Inside the
`root.innerHTML` template add a block:
```html
      <section class="weather">
        <h2>Weather</h2>
        <label>Freq (MHz) <input id="wxMhz" type="text" placeholder="162.550" /></label>
        <label>Tag <input id="wxTag" type="text" placeholder="NOAA WX" /></label>
        <select id="wxMode"><option value="nfm">nfm</option><option value="fm">fm</option><option value="am">am</option></select>
        <button id="wxSave">Save weather channel</button>
        <label class="modeToggle"><input id="wxToggle" type="checkbox" /> Weather-only mode</label>
        <span id="modeLabel"></span>
      </section>
```
Then after the existing query/wiring code, add:
```ts
  const wxMhz = root.querySelector<HTMLInputElement>("#wxMhz")!;
  const wxTag = root.querySelector<HTMLInputElement>("#wxTag")!;
  const wxMode = root.querySelector<HTMLSelectElement>("#wxMode")!;
  const wxSave = root.querySelector<HTMLButtonElement>("#wxSave")!;
  const wxToggle = root.querySelector<HTMLInputElement>("#wxToggle")!;
  const modeLabel = root.querySelector<HTMLElement>("#modeLabel")!;

  function paintMode(mode: "scan" | "weather"): void {
    wxToggle.checked = mode === "weather";
    modeLabel.textContent = mode === "weather" ? "WEATHER-ONLY" : "scanning";
  }

  api.getWeatherChannel().then(({ weatherChannel }) => {
    if (weatherChannel) {
      wxMhz.value = (weatherChannel.freq / 1e6).toFixed(3);
      wxTag.value = weatherChannel.alphaTag;
      wxMode.value = weatherChannel.mode;
    }
  }).catch(() => {});
  api.getStatus().then((s) => paintMode(s.mode)).catch(() => {});

  wxSave.addEventListener("click", () => {
    try {
      api.setWeatherChannel(weatherFormToChannel({ mhz: wxMhz.value, alphaTag: wxTag.value, mode: wxMode.value }));
    } catch { /* invalid freq: leave as-is */ }
  });
  wxToggle.addEventListener("change", () => {
    api.setMode(wxToggle.checked ? "weather" : "scan")
      .then((r) => paintMode(r.mode))
      .catch(() => { wxToggle.checked = !wxToggle.checked; }); // revert on failure (e.g. no weather channel)
  });
```
Ensure `Channel` is imported in `admin.ts` (it imports from `../../backend/config/schema.js`
already; add `Channel` if needed).

- [ ] **Step 4: Run tests + typecheck + build**

Run: `cd kiosk && npx vitest run test/adminForm.test.ts && npm run build:backend && npm run build:frontend`
Expected: tests PASS, tsc clean, vite build succeeds.

- [ ] **Step 5: Commit**

```bash
cd /Users/jeremyfuksa/Dev/kerchunk-kiosk
git add kiosk/src/frontend/admin/admin.ts kiosk/test/adminForm.test.ts
git commit -m "feat(admin): weather-channel form + scan/weather mode toggle"
```

---

## Task 6: Dashboard WEATHER badge

**Files:**
- Modify: `src/frontend/dashboard/dashboard.ts`

The dashboard reads mode once on load via `GET /api/status` and shows a badge.
No new WS event type (per spec). Pure-render logic is light; verified at runtime.

- [ ] **Step 1: Add the badge**

In `src/frontend/dashboard/dashboard.ts`, inside `renderDashboard`, after the
`root.innerHTML = ...` template, add a badge element to the `.now` section markup
(add `<div id="modeBadge" class="modeBadge"></div>` inside the `<section class="now">`),
then after the element queries add:
```ts
  const modeBadge = root.querySelector<HTMLElement>("#modeBadge")!;
  api.getStatus()
    .then((s) => { modeBadge.textContent = s.mode === "weather" ? "WEATHER" : ""; })
    .catch(() => {});
```
(`api` is already imported in dashboard.ts.)

- [ ] **Step 2: Typecheck + build**

Run: `cd kiosk && npm run build:backend && npm run build:frontend`
Expected: tsc clean, vite build succeeds.

- [ ] **Step 3: Run the full suite**

Run: `cd kiosk && npx vitest run`
Expected: all tests PASS (78 existing + the new weather tests).

- [ ] **Step 4: Commit**

```bash
cd /Users/jeremyfuksa/Dev/kerchunk-kiosk
git add kiosk/src/frontend/dashboard/dashboard.ts
git commit -m "feat(dashboard): show WEATHER badge in weather-only mode"
```

---

## Final verification

- [ ] `cd kiosk && npm run build:backend && npm test && npm run build:frontend` — all green.
- [ ] Spec coverage: weatherChannel schema (T1), runtime mode + toScanConfig (T2),
  endpoints incl. 400 guards (T3), api client (T4), admin form+toggle (T5),
  dashboard badge (T6).
- [ ] No mode persistence (the runtime `let mode` is never written to config) —
  matches the spec's "always boots into scan".
